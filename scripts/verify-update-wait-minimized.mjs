// 安装更新等待条验收。隔离 dev 实例（临时 userData、ENSO_VERIFY=1、关动画），模拟「安装更新、有 3 个会话在跑」的等待态，拍两张：
//   1. /tmp/update-wait-minimized.png  进入等待：顶部小条（loading + 等当前命令结束后安装更新 · 等 3 个会话 + 强制退出 + 展开），无模态
//   2. /tmp/update-wait-expanded.png   点小条展开：完整弹层（会话列表 + 最小化 + 强制退出）
// 等待态直接写进渲染端弹层 store（默认收起的判断由 RestartWaitDialog.test.tsx 覆盖），不触发真实更新安装。
// 整体 180s 硬超时，跑完清理进程与临时目录。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { uiElementElectron } from './verify-electron.mjs';
import { mergeOwnedPids, ownedProcessGroups } from './verify-secretary-isolation.mjs';

const KEEP = process.argv.includes('--keep');
const ROOT = path.resolve(import.meta.dirname, '..');
const HARD_LIMIT = setTimeout(() => {
  console.error('verify-update-wait-minimized: 180s 硬超时');
  void finish(124);
}, 180_000);
HARD_LIMIT.unref?.();

const children = [];
const trackedPids = [];
let artDir = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => console.log(line);

function listProcesses() {
  const listed = spawnSync('ps', ['-ax', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  if (listed.status !== 0) return [];
  return listed.stdout.split('\n').flatMap((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    return pid && ppid && pgid ? [{ pid, ppid, pgid }] : [];
  });
}

function rememberOwned() {
  const processes = listProcesses();
  const roots = children.flatMap((child) => (Number.isInteger(child.pid) ? [child.pid] : []));
  const owned = mergeOwnedPids(trackedPids, processes, roots);
  trackedPids.length = 0;
  trackedPids.push(...owned);
  return { processes, owned: new Set(owned) };
}

function signalOwned(signal) {
  const { processes, owned } = rememberOwned();
  const selfGroup = processes.find((proc) => proc.pid === process.pid)?.pgid;
  for (const pgid of ownedProcessGroups(processes, [...owned])) {
    if (pgid === selfGroup) continue;
    try {
      process.kill(-pgid, signal);
    } catch {}
  }
  for (const pid of owned) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function waitFor(fn, { timeout = 30_000, interval = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await sleep(interval);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function reserveCdpPort() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await freePort();
    if (port !== 9222) return port;
  }
  throw new Error('挑不到 CDP 端口（拒绝 9222）');
}

/** CDP 端口的监听进程必须是本次拉起的、带临时 userData 的实例，否则不连。 */
function assertIsolatedListener(port, userData) {
  const listed = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  });
  const pids = listed.status === 0 ? listed.stdout.split('\n').map(Number).filter(Boolean) : [];
  if (pids.length === 0) throw new Error(`端口 ${port} 没有监听进程`);
  const { processes, owned } = rememberOwned();
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  for (const pid of pids) {
    if (!owned.has(pid)) throw new Error(`端口 ${port} 的监听进程 ${pid} 不属于本次实例`);
    let current = pid;
    let matched = false;
    const seen = new Set();
    while (current && owned.has(current) && !seen.has(current)) {
      seen.add(current);
      const env = spawnSync('ps', ['-Eww', '-p', String(current)], { encoding: 'utf8' });
      if (env.status === 0 && env.stdout.includes(userData)) matched = true;
      current = byPid.get(current)?.ppid;
    }
    if (!matched) throw new Error(`端口 ${port} 的进程 ${pid} 对不上临时 userData`);
  }
}

class Cdp {
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`ws 连接失败 ${wsUrl}`));
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const done = message.id && this.pending.get(message.id);
      if (!done) return;
      this.pending.delete(message.id);
      done(message);
    };
    ws.onclose = () => {
      for (const done of this.pending.values()) done({ error: { message: 'CDP socket closed' } });
      this.pending.clear();
    };
  }

  send(method, params = {}, timeout = 30_000) {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`CDP 已关闭 ${method}`));
        return;
      }
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp ${method} 超时`));
      }, timeout);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result ?? {});
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'evaluate 失败'
      );
    }
    return result.result?.value;
  }

  close() {
    this.ws.close();
  }
}

async function pageTarget(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return (
    list.find((entry) => entry.type === 'page' && String(entry.url).includes('index.html')) ?? null
  );
}

async function connectPage(port) {
  const target = await pageTarget(port);
  if (!target?.webSocketDebuggerUrl) throw new Error('没有 index.html 页面目标');
  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return cdp;
}

const READY = `(() => Boolean(
  window.__stores?.restartOverlay?.setState &&
  window.electronAPI &&
  document.readyState === 'complete' &&
  document.getElementById('root')
))()`;

async function waitForStablePage(port) {
  let page = null;
  let streak = 0;
  return waitFor(
    async () => {
      rememberOwned();
      if (!page) page = await connectPage(port).catch(() => null);
      if (!page) return null;
      const ready = await page.eval(READY).catch(() => false);
      streak = ready === true ? streak + 1 : 0;
      return streak >= 3 ? page : null;
    },
    { timeout: 120_000, interval: 400, label: 'renderer 就绪' }
  );
}

function startDev(userData, cdpPort) {
  const electron = uiElementElectron(createRequire(path.join(ROOT, 'package.json'))('electron'));
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(ENSO_|ELECTRON_)/.test(key))
  );
  const child = spawn('pnpm', ['dev'], {
    cwd: ROOT,
    detached: true,
    env: {
      ...clean,
      ENSO_USER_DATA_DIR: userData,
      ENSO_CDP_PORT: String(cdpPort),
      ENSO_VERIFY: '1',
      ELECTRON_EXEC_PATH: electron,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  children.push(child);
}

async function shoot(cdp, file) {
  await sleep(400);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
  log(file);
}

const DISABLE_MOTION = `(() => {
  if (document.getElementById('enso-verify-no-motion')) return true;
  const style = document.createElement('style');
  style.id = 'enso-verify-no-motion';
  style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
  document.head.appendChild(style);
  return true;
})()`;

// 与 Main 安装更新时推来的等待态同形；进入等待默认收成小条
const WAITING = {
  phase: 'waiting',
  reason: 'tool',
  exit: 'update',
  blockers: [
    { sessionId: '5f3a91c2-0d4e-4b7a-9c1e-2a6b8d0e4f13', kind: 'tool', tools: ['bash'] },
    { sessionId: 'b8e27d40-61a9-4c3f-8e52-7d1c9a3b5e06', kind: 'reply' },
    { sessionId: 'c41f0a93-2b7e-4d58-a6c9-3e8f1b2d7a40::child-1', kind: 'tool', tools: ['grep'] },
  ],
};

const ENTER_WAIT = `(() => {
  window.__stores.restartOverlay.setState({
    state: ${JSON.stringify(WAITING)},
    shown: ${JSON.stringify(WAITING)},
    forcing: false,
    minimized: true,
  });
  return true;
})()`;

const READ = `(() => {
  const dialog = document.querySelector('[role="alertdialog"]');
  const expand = document.querySelector('button[title="展开"], button[title="Expand"]');
  const strip = expand?.parentElement;
  return {
    dialog: dialog?.textContent ?? null,
    strip: strip?.textContent ?? null,
    tooltip: strip?.querySelector('button[title]:not([title="展开"]):not([title="Expand"])')?.getAttribute('title') ?? null,
  };
})()`;

const CLICK_EXPAND = `(() => {
  const expand = document.querySelector('button[title="展开"], button[title="Expand"]');
  if (!expand) return 'missing';
  expand.click();
  return 'ok';
})()`;

async function main() {
  artDir = mkdtempSync('/tmp/enso-update-wait-');
  const userData = path.join(artDir, 'user-data');
  mkdirSync(userData, { recursive: true });
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      'enso-settings': {
        version: 18,
        state: {
          providers: [
            {
              id: 'pv-A',
              name: 'Provider A',
              api: 'anthropic-messages',
              apiKey: 'sk-fake-A',
              baseUrl: 'http://127.0.0.1:9',
              enabled: true,
              models: [{ id: 'fake-model-1' }],
            },
          ],
          defaultModel: { providerId: 'pv-A', modelId: 'fake-model-1' },
          onboarded: true,
          theme: 'light',
          language: 'zh-CN',
        },
      },
    })
  );

  const cdpPort = await reserveCdpPort();
  log(`userData ${userData} cdp ${cdpPort}`);
  startDev(userData, cdpPort);
  await waitFor(
    async () => {
      rememberOwned();
      const target = await pageTarget(cdpPort).catch(() => null);
      if (!target) return null;
      assertIsolatedListener(cdpPort, userData);
      return target;
    },
    { timeout: 120_000, interval: 500, label: '隔离 CDP 页面' }
  );
  const cdp = await waitForStablePage(cdpPort);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 2,
    mobile: false,
  });
  // 关动画：CSS 过渡用样式表关掉；framer-motion 的高度动画走 prefers-reduced-motion 的瞬时路径
  // （ENSO_VERIFY 窗口不显示，rAF 被节流，退出动画会一直挂着）
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await cdp.eval(DISABLE_MOTION);
  await sleep(1500);

  await cdp.eval(ENTER_WAIT);
  const minimized = await waitFor(
    async () => {
      const view = await cdp.eval(READ);
      return view.strip ? view : null;
    },
    { label: '等待小条' }
  );
  log(`minimized: ${JSON.stringify(minimized)}`);
  assert.equal(minimized.dialog, null, '进入等待不应弹模态');
  assert.match(minimized.strip, /等当前命令结束后安装更新 · 等 3 个会话/);
  assert.match(minimized.strip, /强制退出/);
  await shoot(cdp, '/tmp/update-wait-minimized.png');

  assert.equal(await cdp.eval(CLICK_EXPAND), 'ok');
  const expanded = await waitFor(
    async () => {
      const view = await cdp.eval(READ);
      return view.dialog && !view.strip ? view : null;
    },
    { label: '展开弹层' }
  );
  log(`expanded: ${JSON.stringify(expanded)}`);
  assert.match(expanded.dialog, /正在等当前命令结束/);
  assert.match(expanded.dialog, /强制退出/);
  assert.match(expanded.dialog, /最小化/);
  await shoot(cdp, '/tmp/update-wait-expanded.png');
  cdp.close();
  log('PASS');
}

let finishing = null;
function finish(code) {
  if (!finishing) {
    clearTimeout(HARD_LIMIT);
    finishing = (async () => {
      signalOwned('SIGTERM');
      await sleep(800);
      signalOwned('SIGKILL');
      await sleep(200);
      if (artDir && !KEEP) rmSync(artDir, { recursive: true, force: true });
    })()
      .catch((error) => {
        console.error(error);
        code = 1;
      })
      .finally(() => process.exit(code));
  }
  return finishing;
}

process.on('SIGINT', () => void finish(130));
process.on('SIGTERM', () => void finish(143));
process.on('uncaughtException', (error) => {
  console.error(error);
  void finish(1);
});

main()
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    void finish(1);
  });
