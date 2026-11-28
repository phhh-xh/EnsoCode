import Foundation
import Network
import Security

public struct EnsoQuicConfig: Sendable {
    public let id: String
    public let host: String
    public let port: UInt16
    public let alpn: String
    public let hello: EnsoQuicHello
    /// 仅用于本机自签证书联调/单测；生产默认 false（严格系统信任链校验证书）
    public let allowInsecureSelfSigned: Bool

    public init(
        id: String,
        host: String,
        port: UInt16,
        alpn: String = QuicFrameCodec.alpn,
        hello: EnsoQuicHello,
        allowInsecureSelfSigned: Bool = false
    ) {
        self.id = id
        self.host = host
        self.port = port
        self.alpn = alpn
        self.hello = hello
        self.allowInsecureSelfSigned = allowInsecureSelfSigned
    }
}

public protocol QuicRelayConnectionDelegate: AnyObject {
    func quicConnectionDidOpen(_ id: String)
    func quicConnection(_ id: String, didReceiveControlText text: String)
    func quicConnection(_ id: String, didReceiveBinaryFrame data: Data, lane: EnsoQuicLane)
    func quicConnection(_ id: String, didCloseWithCode code: Int, reason: String)
    func quicConnection(_ id: String, didUpdateDiagnostic detail: String)
}

public extension QuicRelayConnectionDelegate {
    func quicConnection(_ id: String, didUpdateDiagnostic detail: String) {}
}

/// 基于 Apple 原生 `Network.framework` (`NWProtocolQUIC` + `NWMultiplexGroup` + `NWConnectionGroup`)
/// 的多流 QUIC 中继连接：
/// - 自动复用单一 UDP/QUIC 关联与 0-RTT / Wi-Fi↔5G 连接迁移；
/// - 在同一连接上建立 3 条独立双向流：`control (0x00)`、`ctrl (0x01)`、`bulk (0x02)`，
///   消除大包与小 RPC 控制帧之间的传输层队头阻塞。
@available(iOS 16.0, macOS 13.0, *)
public final class QuicRelayConnection: @unchecked Sendable {
    public let config: EnsoQuicConfig
    public weak var delegate: QuicRelayConnectionDelegate?

    private let queue: DispatchQueue
    private let lock = NSLock()

    private var group: NWConnectionGroup?
    private var controlStream: NWConnection?
    private var ctrlStream: NWConnection?
    private var bulkStream: NWConnection?
    private var streamsOpened = false

    private var controlReady = false
    private var ctrlReady = false
    private var openedEmitted = false
    private var closed = false

    public init(config: EnsoQuicConfig, delegate: QuicRelayConnectionDelegate? = nil) {
        self.config = config
        self.delegate = delegate
        self.queue = DispatchQueue(label: "com.ensocode.quic.\(config.id)")
    }

    public func start() {
        guard let nwPort = NWEndpoint.Port(rawValue: config.port) else {
            finishClose(code: 1006, reason: "invalid-port")
            return
        }
        let quicOptions = NWProtocolQUIC.Options(alpn: [config.alpn])
        quicOptions.direction = .bidirectional
        quicOptions.idleTimeout = 60_000
        quicOptions.initialMaxData = 4 * 1024 * 1024
        quicOptions.initialMaxStreamDataBidirectionalLocal = 2 * 1024 * 1024
        quicOptions.initialMaxStreamDataBidirectionalRemote = 2 * 1024 * 1024
        quicOptions.initialMaxStreamsBidirectional = 16

        let secOptions = quicOptions.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(secOptions, .TLSv13)
        // 设置 SNI：当 host 是域名时按 RFC 9001 透传 server_name；IP 字面量则跳过
        if !config.host.allSatisfy({ $0.isNumber || $0 == "." || $0 == ":" }) {
            config.host.withCString { cstr in
                sec_protocol_options_set_tls_server_name(secOptions, cstr)
            }
        }
        if config.allowInsecureSelfSigned {
            sec_protocol_options_set_verify_block(
                secOptions,
                { _, _, completion in
                    completion(true)
                },
                queue
            )
        }

        let parameters = NWParameters(quic: quicOptions)
        let endpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host(config.host),
            port: nwPort
        )
        let descriptor = NWMultiplexGroup(to: endpoint)
        let connGroup = NWConnectionGroup(with: descriptor, using: parameters)
        self.group = connGroup

        connGroup.stateUpdateHandler = { [weak self] state in
            self?.handleGroupState(state)
        }
        connGroup.newConnectionHandler = { incoming in
            // 客户端主动发起全部三条双向流，忽略意外的远端入站流
            incoming.cancel()
        }
        connGroup.start(queue: queue)
    }

    public func sendControlText(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        queue.async { [weak self] in
            guard let self, !self.closed, let stream = self.controlStream else { return }
            self.sendFrame(data, on: stream)
        }
    }

    public func sendBinary(_ data: Data, lane: EnsoQuicLane) {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            let target = (lane == .bulk ? self.bulkStream : self.ctrlStream) ?? self.ctrlStream
            guard let stream = target else { return }
            self.sendFrame(data, on: stream)
        }
    }

    public func close(code: Int = 1000, reason: String = "closed") {
        queue.async { [weak self] in
            self?.finishClose(code: code, reason: reason)
        }
    }

    private func handleGroupState(_ state: NWConnectionGroup.State) {
        switch state {
        case .ready:
            delegate?.quicConnection(config.id, didUpdateDiagnostic: "group-ready")
            if !streamsOpened {
                openAllStreams()
            }
        case .waiting(let error):
            delegate?.quicConnection(config.id, didUpdateDiagnostic: "group-waiting:\(error)")
        case .failed(let error):
            finishClose(code: 1006, reason: "quic-failed:\(error)")
        case .cancelled:
            finishClose(code: 1000, reason: "cancelled")
        default:
            break
        }
    }

    private func openAllStreams() {
        guard !closed, !streamsOpened, let connGroup = group else { return }
        streamsOpened = true
        // iOS 16-18 的 NWConnectionGroup 禁止在 NWConnection(from:using:) 里再传入带 alpn 的新
        // NWProtocolQUIC.Options（会触发 failed to clone from flow -> POSIXErrorCode 50 Network is down）。
        // 组级 NWParameters 已声明 bidirectional 与 alpn，直接 NWConnection(from: connGroup) 复用即可。
        guard let ctrl = NWConnection(from: connGroup),
              let bulk = NWConnection(from: connGroup),
              let control = NWConnection(from: connGroup)
        else {
            finishClose(code: 1006, reason: "quic-open-streams-failed")
            return
        }
        ctrlStream = ctrl
        bulkStream = bulk
        controlStream = control

        wireStream(ctrl, kind: .ctrl)
        wireStream(bulk, kind: .bulk)
        wireStream(control, kind: .control)

        ctrl.start(queue: queue)
        bulk.start(queue: queue)
        control.start(queue: queue)
    }

    private func wireStream(_ stream: NWConnection, kind: EnsoQuicStreamKind) {
        stream.stateUpdateHandler = { [weak self] state in
            guard let self, !self.closed else { return }
            switch state {
            case .waiting(let error):
                self.delegate?.quicConnection(
                    self.config.id,
                    didUpdateDiagnostic: "stream-\(kind.rawValue)-waiting:\(error)"
                )
            case .ready:
                switch kind {
                case .control:
                    // 把 1 字节流头与 hello 帧合并进单次 send，减少一次往返/调度延迟
                    self.sendControlHeaderAndHello(on: stream)
                case .ctrl, .bulk:
                    let header = Data([kind.rawValue])
                    stream.send(content: header, completion: .contentProcessed { [weak self] error in
                        guard let self, !self.closed else { return }
                        if let error {
                            if kind != .bulk {
                                self.finishClose(code: 1006, reason: "stream-header:\(error)")
                            }
                            return
                        }
                        if kind == .ctrl {
                            self.ctrlReady = true
                            self.receiveNextFrame(from: stream, kind: .ctrl)
                            self.maybeEmitOpen()
                        } else {
                            self.receiveNextFrame(from: stream, kind: .bulk)
                        }
                    })
                }
            case .failed(let error):
                if kind != .bulk {
                    self.finishClose(code: 1006, reason: "stream-failed:\(error)")
                }
            case .cancelled:
                if kind != .bulk {
                    self.finishClose(code: 1000, reason: "stream-cancelled")
                }
            default:
                break
            }
        }
    }

    private func sendControlHeaderAndHello(on stream: NWConnection) {
        do {
            let helloBytes = try JSONEncoder().encode(config.hello)
            let framed = try QuicFrameCodec.encodeFrame(helloBytes)
            var combined = Data(capacity: 1 + framed.count)
            combined.append(EnsoQuicStreamKind.control.rawValue)
            combined.append(framed)
            stream.send(content: combined, completion: .contentProcessed { [weak self] error in
                guard let self, !self.closed else { return }
                if let error {
                    self.finishClose(code: 1006, reason: "hello-send:\(error)")
                    return
                }
                self.controlReady = true
                self.receiveNextFrame(from: stream, kind: .control)
                self.maybeEmitOpen()
            })
        } catch {
            finishClose(code: 1006, reason: "hello-encode:\(error)")
        }
    }

    private func maybeEmitOpen() {
        guard !closed, !openedEmitted, controlReady, ctrlReady else { return }
        openedEmitted = true
        delegate?.quicConnectionDidOpen(config.id)
    }

    private func sendFrame(_ payload: Data, on stream: NWConnection) {
        do {
            let framed = try QuicFrameCodec.encodeFrame(payload)
            stream.send(content: framed, completion: .contentProcessed { [weak self] error in
                if let error {
                    self?.finishClose(code: 1006, reason: "send-error:\(error)")
                }
            })
        } catch {
            finishClose(code: 1009, reason: "frame-too-large")
        }
    }

    private func receiveNextFrame(from stream: NWConnection, kind: EnsoQuicStreamKind) {
        guard !closed else { return }
        stream.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] content, _, isComplete, error in
            guard let self, !self.closed else { return }
            if let error {
                if kind != .bulk {
                    self.finishClose(code: 1006, reason: "read-hdr:\(error)")
                }
                return
            }
            guard let header = content, header.count == 4 else {
                if isComplete && kind != .bulk {
                    self.finishClose(code: 1000, reason: "eof")
                }
                return
            }
            do {
                let payloadLen = try QuicFrameCodec.decodeLengthPrefix(header)
                if payloadLen == 0 {
                    self.receiveNextFrame(from: stream, kind: kind)
                    return
                }
                self.receiveExact(length: payloadLen, from: stream, kind: kind)
            } catch {
                self.finishClose(code: 1009, reason: "bad-frame-len")
            }
        }
    }

    private func receiveExact(length: Int, from stream: NWConnection, kind: EnsoQuicStreamKind) {
        var buffer = Data()
        buffer.reserveCapacity(length)
        receiveChunk(remaining: length, buffer: buffer, from: stream, kind: kind)
    }

    private func receiveChunk(
        remaining: Int,
        buffer: Data,
        from stream: NWConnection,
        kind: EnsoQuicStreamKind
    ) {
        guard !closed else { return }
        let maxRead = min(remaining, 65_536)
        stream.receive(minimumIncompleteLength: 1, maximumLength: maxRead) { [weak self] content, _, isComplete, error in
            guard let self, !self.closed else { return }
            if let error {
                if kind != .bulk {
                    self.finishClose(code: 1006, reason: "read-body:\(error)")
                }
                return
            }
            guard let chunk = content, !chunk.isEmpty else {
                if isComplete && kind != .bulk {
                    self.finishClose(code: 1000, reason: "eof-body")
                }
                return
            }
            var nextBuffer = buffer
            nextBuffer.append(chunk)
            let left = remaining - chunk.count
            if left > 0 {
                if isComplete {
                    if kind != .bulk {
                        self.finishClose(code: 1000, reason: "eof-body")
                    }
                    return
                }
                self.receiveChunk(remaining: left, buffer: nextBuffer, from: stream, kind: kind)
                return
            }
            switch kind {
            case .control:
                if let text = String(data: nextBuffer, encoding: .utf8) {
                    self.delegate?.quicConnection(self.config.id, didReceiveControlText: text)
                }
            case .ctrl:
                self.delegate?.quicConnection(self.config.id, didReceiveBinaryFrame: nextBuffer, lane: .ctrl)
            case .bulk:
                self.delegate?.quicConnection(self.config.id, didReceiveBinaryFrame: nextBuffer, lane: .bulk)
            }
            self.receiveNextFrame(from: stream, kind: kind)
        }
    }

    private func finishClose(code: Int, reason: String) {
        lock.lock()
        if closed {
            lock.unlock()
            return
        }
        closed = true
        lock.unlock()

        controlStream?.cancel()
        ctrlStream?.cancel()
        bulkStream?.cancel()
        group?.cancel()
        controlStream = nil
        ctrlStream = nil
        bulkStream = nil
        group = nil
        delegate?.quicConnection(config.id, didCloseWithCode: code, reason: reason)
    }
}
