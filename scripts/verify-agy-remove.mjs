// agy cli 移除验收。隔离 dev 实例（临时 userData、ENSO_VERIFY=1、假 agy 二进制），拍两张：
//   1. /tmp/agy-delete-before.png  旧版设置（agy 对象无 added）：服务商列表里有 agy cli 和移除按钮
//   2. /tmp/agy-delete-after.png   点移除并确认后：agy cli 行消失，重载后也不回来，探测落盘被删
// 最后从「添加模型或服务商」重新添加，确认行回来。不调用真实 agy，不碰真实 userData。
// 整体 170s 硬超时，跑完清理进程与临时目录。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { uiElementElectron } from './verify-electron.mjs';
import { mergeOwnedPids, ownedProcessGroups } from './verify-secretary-isolation.mjs';

const KEEP = process.argv.includes('--keep');
const ROOT = path.resolve(import.meta.dirname, '..');
const HARD_LIMIT = setTimeout(() => {
  console.error('verify-agy-remove: 170s 硬超时');
  void finish(124);
}, 170_000);
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
  window.__stores?.settings?.getState &&
  window.__stores?.settingsView?.open &&
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
    { timeout: 90_000, interval: 400, label: 'renderer 就绪' }
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
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(300);
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

const OPEN_PROVIDERS = `(() => {
  window.__stores.settingsView.open({ category: 'providers', rowId: 'providers.providers' });
  return true;
})()`;

const READ = `(() => {
  const row = document.querySelector('[data-settings-row="providers.agy-cli"]');
  const list = document.querySelector('[data-settings-row="providers.providers"]');
  return {
    listPresent: !!list,
    agyRow: !!row,
    removeButton: !!row?.querySelector('button[aria-label="移除"]'),
    added: window.__stores.settings.getState().agy?.added ?? null,
  };
})()`;

const SCROLL_LIST = `(() => {
  const el = document.querySelector('[data-settings-row="providers.providers"]');
  el?.scrollIntoView({ block: 'start' });
  return !!el;
})()`;

const CLICK_REMOVE = `(() => {
  const row = document.querySelector('[data-settings-row="providers.agy-cli"]');
  const button = row?.querySelector('button[aria-label="移除"]');
  if (!button) return 'missing';
  button.click();
  return 'ok';
})()`;

const CONFIRM = `(() => {
  const dialog = document.querySelector('[role="alertdialog"]');
  const button = [...(dialog?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent.trim() === '移除'
  );
  if (!button) return 'missing';
  button.click();
  return 'ok';
})()`;

const ADD_AGAIN = `(() => {
  const open = [...document.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === '添加模型或服务商'
  );
  if (!open) return 'no-add-button';
  open.click();
  return 'ok';
})()`;

const PICK_AGY_CARD = `(() => {
  const dialog = document.querySelector('[role="dialog"]');
  const card = [...(dialog?.querySelectorAll('button') ?? [])].find((b) =>
    b.textContent.includes('agy cli')
  );
  if (!card) return 'missing';
  card.click();
  return 'ok';
})()`;

async function openProviders(cdp) {
  await cdp.eval(DISABLE_MOTION);
  await cdp.eval(OPEN_PROVIDERS);
  await waitFor(async () => (await cdp.eval(READ)).listPresent, {
    timeout: 20_000,
    label: '服务商列表',
  });
  await cdp.eval(SCROLL_LIST);
  await sleep(400);
}

function persistedAgy(userData) {
  try {
    const raw = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    return raw['enso-settings']?.state?.agy ?? null;
  } catch {
    return null;
  }
}

async function main() {
  artDir = mkdtempSync('/tmp/enso-agy-remove-');
  const userData = path.join(artDir, 'user-data');
  mkdirSync(userData, { recursive: true });
  // 假 agy：探测拉起后立刻退出，绝不碰真实 agy 与 ~/.gemini
  const fakeAgy = path.join(artDir, 'agy');
  writeFileSync(fakeAgy, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const cache = path.join(userData, 'agy-models-cache.json');
  writeFileSync(cache, JSON.stringify({ models: [{ id: 'gemini-fake', name: 'Gemini Fake' }] }));
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
          theme: 'system',
          language: 'zh-CN',
          // 升级前的形状：没有 added 字段
          agy: { binaryPath: fakeAgy, skipPermissions: false },
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
    { timeout: 90_000, interval: 500, label: '隔离 CDP 页面' }
  );
  let cdp = await waitForStablePage(cdpPort);

  await openProviders(cdp);
  const before = await cdp.eval(READ);
  log(`before: ${JSON.stringify(before)}`);
  assert.equal(before.agyRow, true, '旧设置应仍列出 agy cli');
  assert.equal(before.removeButton, true, 'agy cli 行应有移除按钮');
  await shoot(cdp, '/tmp/agy-delete-before.png');

  assert.equal(await cdp.eval(CLICK_REMOVE), 'ok');
  await sleep(300);
  assert.equal(await cdp.eval(CONFIRM), 'ok', '应弹出移除确认框');
  await waitFor(async () => !(await cdp.eval(READ)).agyRow, { label: 'agy 行消失' });
  await waitFor(() => persistedAgy(userData)?.added === false, {
    timeout: 10_000,
    label: 'settings.json 落盘 added=false',
  });
  await waitFor(() => !existsSync(cache), { timeout: 10_000, label: '探测落盘被删' });
  const persisted = persistedAgy(userData);
  log(`persisted agy: ${JSON.stringify(persisted)}`);
  assert.deepEqual(persisted, { added: false, binaryPath: '', skipPermissions: false });

  await cdp.send('Page.reload');
  cdp.close();
  await sleep(1500);
  cdp = await waitForStablePage(cdpPort);
  await openProviders(cdp);
  const after = await cdp.eval(READ);
  log(`after reload: ${JSON.stringify(after)}`);
  assert.equal(after.agyRow, false, '重载后 agy cli 不应回来');
  assert.equal(existsSync(cache), false);
  await shoot(cdp, '/tmp/agy-delete-after.png');

  assert.equal(await cdp.eval(ADD_AGAIN), 'ok');
  await waitFor(async () => (await cdp.eval(PICK_AGY_CARD)) === 'ok', {
    label: '向导里的 agy 卡片',
  });
  await waitFor(async () => (await cdp.eval(READ)).added === true, { label: '重新添加' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await waitFor(async () => (await cdp.eval(READ)).agyRow, { label: '重新添加后 agy 行回来' });
  log(`re-added: ${JSON.stringify(await cdp.eval(READ))}`);
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
