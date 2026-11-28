import type { HostToPhone, HostToRemote } from '@enso/pair';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  desktopMain: null as { id: number } | null,
  headless: false,
  setPairHeadless: vi.fn((active: boolean) => {
    mocks.headless = active;
  }),
}));

vi.mock('@platform', () => ({
  app: {
    getAppPath: () => '/tmp/enso-app',
    getVersion: () => '1.0.0',
    getPath: () => '/tmp',
  },
  images: {},
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../ipc/agent', () => ({
  getSourceAuthorityRegistry: () => null,
}));
vi.mock('../../ipc/settings', () => ({
  readSettings: () => ({}),
  settingsRevision: () => 1,
}));
vi.mock('../localImageProtocol', () => ({
  handleLocalImageRequest: vi.fn(),
}));
vi.mock('../pairSessionHost', () => ({
  isPairHeadless: () => mocks.headless,
  setPairHeadless: (active: boolean) => mocks.setPairHeadless(active),
}));
vi.mock('../renderers', () => ({
  localMainContents: () => mocks.desktopMain,
}));
vi.mock('../uiHost', () => ({
  localUi: () => null,
}));
vi.mock('./assets', () => ({
  bundleManifest: async () => null,
  downloadEstimate: async () => 0,
  readRendererAsset: async () => ({ status: 404, mime: 'text/plain', body: new Uint8Array() }),
  rendererBuildId: async () => 'build-1',
}));
vi.mock('./ipcRegistry', () => ({
  installIpcRegistry: vi.fn(),
  registeredHandler: (ch: string) => mocks.handlers.get(ch),
  registeredListeners: () => [],
}));

import { handleRemoteCommand, type RemoteLink, remoteLinkDown } from './index';

describe('remoteRenderer rpc-hello 1-RTT prefetch', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.desktopMain = null;
    mocks.headless = false;
    mocks.setPairHeadless.mockClear();
  });

  it('发送带 prefetch 的 rpc-ready 并在后端并行执行允许的只读查询后推送一帧 rpc-prefetch', async () => {
    mocks.handlers.set(IPC_CHANNELS.SETTINGS_READ, async () => ({
      'enso-settings': { state: { theme: 'dark' } },
    }));
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    mocks.handlers.set(IPC_CHANNELS.MODEL_DIRECTORY_GET, async () => {
      await slowGate;
      return { providers: [] };
    });
    const windowSpy = vi.fn(async () => 'should-not-run');
    mocks.handlers.set(IPC_CHANNELS.WINDOW_MINIMIZE, windowSpy);

    const sent: HostToPhone[] = [];
    const link: RemoteLink = {
      pairId: 'pair-prefetch',
      gzip: true,
      v2: true,
      send: (frame) => sent.push(frame),
    };

    await handleRemoteCommand(link, {
      type: 'rpc-hello',
      cid: 'cid-1',
      kind: 'main',
      prefetch: [
        { ch: IPC_CHANNELS.SETTINGS_READ, args: [], h: 'nonexistent' },
        { ch: IPC_CHANNELS.MODEL_DIRECTORY_GET, args: [], h: 'nonexistent-2' },
        { ch: IPC_CHANNELS.WINDOW_MINIMIZE, args: [], h: 'bad' },
      ],
    });

    // 核心读（settings:read）先单独发第一帧并带 more: true，不等慢的次级通道
    await vi.waitFor(() => {
      expect(sent.filter((f) => f.type === 'rpc-prefetch')).toHaveLength(1);
    });

    expect(windowSpy).not.toHaveBeenCalled();
    const ready = sent.find((f) => f.type === 'rpc-ready');
    expect(ready).toMatchObject({
      type: 'rpc-ready',
      cid: 'cid-1',
      ok: true,
      prefetch: true,
    });

    const firstBatch = sent.find(
      (f): f is Extract<HostToRemote, { type: 'rpc-prefetch' }> => f.type === 'rpc-prefetch'
    )!;
    expect(firstBatch.more).toBe(true);
    expect(firstBatch.items.map((i) => i.ch)).toEqual([IPC_CHANNELS.SETTINGS_READ]);

    // 放行次级读后发收尾帧（不带 more）
    releaseSlow();
    await vi.waitFor(() => {
      expect(sent.filter((f) => f.type === 'rpc-prefetch')).toHaveLength(2);
    });
    const secondBatch = sent.filter(
      (f): f is Extract<HostToRemote, { type: 'rpc-prefetch' }> => f.type === 'rpc-prefetch'
    )[1]!;
    expect(secondBatch.more).toBeUndefined();
    expect(secondBatch.items.map((i) => i.ch)).toEqual([IPC_CHANNELS.MODEL_DIRECTORY_GET]);

    // 携带匹配 hash 再连一次，回 same: 1
    const firstHash = (firstBatch.items[0].data as { __ensoCached: { h: string } }).__ensoCached.h;
    sent.length = 0;
    await handleRemoteCommand(link, {
      type: 'rpc-hello',
      cid: 'cid-2',
      kind: 'main',
      prefetch: [{ ch: IPC_CHANNELS.SETTINGS_READ, args: [], h: firstHash }],
    });
    await vi.waitFor(() => {
      expect(sent.some((f) => f.type === 'rpc-prefetch')).toBe(true);
    });
    const secondFrame = sent.find(
      (f): f is Extract<HostToRemote, { type: 'rpc-prefetch' }> => f.type === 'rpc-prefetch'
    )!;
    expect(secondFrame.items[0].data).toEqual({
      __ensoCached: { h: firstHash, same: 1 },
    });

    await handleRemoteCommand(link, { type: 'rpc-bye', cid: 'cid-1' });
    await handleRemoteCommand(link, { type: 'rpc-bye', cid: 'cid-2' });
  });

  it('无桌面窗口下断链续连：补发旧 leader=false 之后必须追加权威 leader=true', async () => {
    const sent: HostToPhone[] = [];
    const link: RemoteLink = {
      pairId: 'pair-resume-leader',
      gzip: false,
      v2: false,
      send: (frame) => sent.push(frame),
    };

    // 1. 首次冷接入：成为 leader
    await handleRemoteCommand(link, { type: 'rpc-hello', cid: 'cid-leader', kind: 'main' });
    expect(sent.find((f) => f.type === 'rpc-ready')).toMatchObject({
      type: 'rpc-ready',
      cid: 'cid-leader',
      ok: true,
      resumed: false,
      leader: true,
    });
    expect(mocks.headless).toBe(false);

    // 2. 切后台/断链：挂起 sender，切 headless，并向保留窗口写入 REMOTE_LEADER_CHANGED(false)
    sent.length = 0;
    remoteLinkDown('pair-resume-leader');
    expect(mocks.headless).toBe(true);

    // 3. 回到前台续连（seq=0，尚未应用断链期间的 leader=false）
    await handleRemoteCommand(link, {
      type: 'rpc-hello',
      cid: 'cid-leader',
      kind: 'main',
      seq: 0,
    });
    expect(mocks.headless).toBe(false);

    // 按客户端顺序模拟应用 rpc-ready 与后续按序 rpc-event：最终 leader 必须为 true
    let clientLeader = false;
    const leaderEvents: { seq: number | undefined; value: unknown }[] = [];
    for (const frame of sent) {
      if (frame.type === 'rpc-ready' && frame.ok) {
        clientLeader = frame.leader;
      } else if (frame.type === 'rpc-event' && frame.ch === IPC_CHANNELS.REMOTE_LEADER_CHANGED) {
        const value = Array.isArray(frame.args) ? frame.args[0] : undefined;
        leaderEvents.push({ seq: frame.seq, value });
        clientLeader = value === true;
      }
    }
    expect(leaderEvents.map((e) => e.value)).toEqual([false, true]);
    expect((leaderEvents[1]?.seq ?? 0) > (leaderEvents[0]?.seq ?? 0)).toBe(true);
    expect(clientLeader).toBe(true);

    await handleRemoteCommand(link, { type: 'rpc-bye', cid: 'cid-leader' });
  });
});
