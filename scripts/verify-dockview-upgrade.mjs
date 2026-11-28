// dockview 8.2 → 8.10 升级证据：普通会话右侧栏开 3 个 tab，真实拖拽一个 tab 到内容区下半部分
// 分出第二个分组，断言两个分组内容都可见、tab 标题可见、分隔条存在、控制台无 error，并截侧栏。
// 隔离 dev 实例（临时 userData、ENSO_VERIFY=1、拒绝 9222）；启动/清理/隔离逻辑复制自
// verify-secretary-panel-blank.mjs，开侧栏/开 tab 的真实点击复制自 verify-sidepanel-newtab-prompt.mjs。
//
//   node scripts/verify-dockview-upgrade.mjs [--out <png>] [--root <repo>] [--keep] [--timeout <秒>]
//     [--drag auto|mouse|intercept]
//
// 拖拽：mouse = 只用 Input.dispatchMouseEvent；intercept = Input.setInterceptDrags 拦下
// 鼠标拖起的 HTML5 drag，再用 Input.dispatchDragEvent 投递 dragEnter/dragOver/drop；
// auto（默认）= 先 mouse，没分出分组再 intercept。默认截图 /tmp/dockview-upgrade-after.png。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { uiElementElectron } from './verify-electron.mjs';
import { mergeOwnedPids, ownedProcessGroups } from './verify-secretary-isolation.mjs';

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const ROOT = path.resolve(flag('--root') ?? path.resolve(import.meta.dirname, '..'));
const OUT = path.resolve(flag('--out') ?? '/tmp/dockview-upgrade-after.png');
const HARD_TIMEOUT_MS = Number(flag('--timeout') ?? 180) * 1000;

const VIEWPORT = { width: 1400, height: 900 };
const DRAG = flag('--drag') ?? 'auto';
const TOGGLE_LABELS = ['Toggle side panel', '折叠/展开右侧面板'];
// zh-CN 下 Changes / Files / Terminal 的菜单文案；拖走「文件」
const TAB_LABELS = ['改动', '文件', '终端'];
const DRAGGED = '文件';

const children = [];
const trackedPids = [];
const consoleErrors = [];
let artDir = null;
let devLogTail = '';

function flag(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数`);
  return value;
}

function log(line) {
  console.log(line);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listProcesses() {
  const listed = spawnSync('ps', ['-ax', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  if (listed.status !== 0) return [];
  const processes = [];
  for (const line of listed.stdout.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid || !pgid) continue;
    processes.push({ pid, ppid, pgid });
  }
  return processes;
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
    } catch {
      // 进程组已经没了
    }
  }
  for (const pid of owned) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // 已经退出
    }
  }
}

function isFatalIsolation(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /不属于|对不上|拒绝连接 9222/.test(message);
}

async function waitFor(fn, { timeout = 30_000, interval = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      if (isFatalIsolation(error)) throw error;
      last = error;
    }
    await sleep(interval);
  }
  const detail = last instanceof Error ? last.message : JSON.stringify(last);
  throw new Error(`等待超时 ${label}${detail ? `: ${detail}` : ''}`);
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

async function reservePort(rejectPort) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await freePort();
    if (port !== rejectPort) return port;
  }
  throw new Error(`挑不到端口（拒绝 ${rejectPort}）`);
}

function listenPids(port) {
  const listed = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  });
  if (listed.status !== 0) return [];
  return [
    ...new Set(
      listed.stdout
        .split('\n')
        .map((line) => Number(line.trim()))
        .filter(Boolean)
    ),
  ];
}

function processEnvText(pid) {
  const listed = spawnSync('ps', ['-Eww', '-p', String(pid)], { encoding: 'utf8' });
  return listed.status === 0 ? listed.stdout : '';
}

function processHasUserData(pid, userData) {
  if (processEnvText(pid).includes(userData)) return true;
  const opened = spawnSync('lsof', ['-nP', '-p', String(pid)], { encoding: 'utf8' });
  return opened.status === 0 && opened.stdout.includes(userData);
}

function assertIsolatedListener(port, userData) {
  if (port === 9222) throw new Error('拒绝连接 9222');
  const pids = listenPids(port);
  if (pids.length === 0) throw new Error(`端口 ${port} 没有监听进程`);
  const { processes, owned } = rememberOwned();
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  for (const pid of pids) {
    if (!owned.has(pid)) throw new Error(`端口 ${port} 的监听进程 ${pid} 不属于本次实例`);
    const chain = [];
    let current = pid;
    const seen = new Set();
    while (current && owned.has(current) && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      current = byPid.get(current)?.ppid;
    }
    if (!chain.some((candidate) => processHasUserData(candidate, userData))) {
      throw new Error(`端口 ${port} 的进程 ${pid} 对不上临时 userData`);
    }
  }
  return pids;
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
    this.listeners = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        for (const fn of this.listeners.get(message.method) ?? []) fn(message.params);
        return;
      }
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

  on(method, fn) {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
    return () => list.splice(list.indexOf(fn), 1);
  }

  once(method, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待 ${method} 超时`));
      }, timeout);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
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

function writeSettings(userData) {
  mkdirSync(userData, { recursive: true });
  const state = {
    providers: [],
    onboarded: true,
    theme: 'system',
    language: 'zh-CN',
    titleSummaryEnabled: false,
    secretaryEnabled: false,
  };
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 18 } })
  );
}

function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
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
  cdp.targetId = target.id;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return cdp;
}

async function waitForStablePage(port) {
  let page = null;
  let targetId = null;
  let streak = 0;
  try {
    return await waitFor(
      async () => {
        rememberOwned();
        const target = await pageTarget(port);
        if (!target) {
          streak = 0;
          return null;
        }
        if (!page || target.id !== targetId) {
          page?.close();
          page = await connectPage(port);
          targetId = target.id;
          streak = 0;
        }
        const ready = await page.eval(`(() => Boolean(
          window.__stores?.sessions?.getState &&
          window.__stores?.settings?.getState &&
          window.__stores?.sidePanel?.getState &&
          window.__stores?.secretary?.getState &&
          window.electronAPI &&
          document.readyState === 'complete' &&
          document.getElementById('root')
        ))()`);
        streak = ready === true ? streak + 1 : 0;
        return streak >= 3 ? page : null;
      },
      { timeout: 120_000, interval: 400, label: 'renderer 就绪' }
    );
  } catch (error) {
    page?.close();
    throw error;
  }
}

async function applyViewport(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return waitFor(
    async () => {
      const size = await cdp.eval(`(() => {
        window.dispatchEvent(new Event('resize'));
        return { w: window.innerWidth, h: window.innerHeight, v: document.visibilityState };
      })()`);
      const close =
        Math.abs(size.w - VIEWPORT.width) <= 2 && Math.abs(size.h - VIEWPORT.height) <= 2;
      return close ? size : null;
    },
    { timeout: 8_000, label: `视口 ${VIEWPORT.width}x${VIEWPORT.height}` }
  );
}

async function freezeMotion(cdp) {
  await cdp.eval(`(() => {
    let style = document.getElementById('enso-verify-freeze');
    if (!style) {
      style = document.createElement('style');
      style.id = 'enso-verify-freeze';
      document.documentElement.appendChild(style);
    }
    style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    return true;
  })()`);
}

/** 截侧栏区域；拿不到侧栏就截整窗 */
async function shootSide(cdp, file, rect) {
  const clip =
    rect && rect.w > 8 && rect.h > 8
      ? { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 }
      : { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 };
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip,
  });
  writeFileSync(file, Buffer.from(data, 'base64'));
  return pngSize(file);
}

function startDev(userData, cdpPort, rendererPort) {
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
      ENSO_RENDERER_PORT: String(rendererPort),
      ENSO_VERIFY: '1',
      ELECTRON_EXEC_PATH: electron,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  const collect = (buf) => {
    chunks.push(buf);
    if (chunks.length > 400) chunks.shift();
    devLogTail = Buffer.concat(chunks).toString('utf8').slice(-4000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  children.push(child);
  return child;
}

async function cleanup() {
  signalOwned('SIGTERM');
  await sleep(800);
  signalOwned('SIGKILL');
  await sleep(200);
  if (!artDir) return;
  if (KEEP) {
    log(`保留 ${artDir}`);
    return;
  }
  rmSync(artDir, { recursive: true, force: true });
  log(`已删除 ${artDir}`);
}

function watchConsole(cdp) {
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error') return;
    const text = params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
    consoleErrors.push(text.slice(0, 300));
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    const detail = params.exceptionDetails;
    consoleErrors.push(
      `exception: ${String(detail.exception?.description ?? detail.text).slice(0, 300)}`
    );
  });
}

/** 普通会话（git 项目），侧栏收着、没有任何 tab；复制自 verify-sidepanel-newtab-prompt.mjs */
async function bootSession(cdp, projectPath) {
  const raw = await cdp.eval(`(async () => {
    localStorage.removeItem('enso-side-panel');
    const settings = window.__stores.settings;
    const sessions = window.__stores.sessions;
    const side = window.__stores.sidePanel;
    settings.setState({
      onboarded: true,
      language: 'zh-CN',
      titleSummaryEnabled: false,
      secretaryEnabled: false,
    });
    side.setState({
      fullscreen: false,
      lastWidth: 560,
      layouts: {},
      pinnedTabs: [],
      globalTabs: [],
      uiByConversation: {},
      fullscreenByConversation: {},
      newTabMenuPrompt: null,
    });
    const project = await settings.getState().addProject(${JSON.stringify(projectPath)});
    const id = await sessions.getState().newConversation(project.id);
    if (!id) return JSON.stringify({ ok: false, error: 'newConversation 返回空' });
    side.setState((state) => ({
      fullscreen: false,
      lastWidth: 560,
      layouts: { ...state.layouts, [id]: undefined },
      pinnedTabs: [],
      globalTabs: [],
      newTabMenuPrompt: null,
      uiByConversation: {
        ...state.uiByConversation,
        [id]: { ...(state.uiByConversation[id] ?? {}), open: false, width: 560 },
      },
      fullscreenByConversation: { ...state.fullscreenByConversation, [id]: false },
    }));
    const panels = Object.keys(side.getState().layouts[id]?.panels ?? {});
    return JSON.stringify({ ok: true, id, cwd: project.path, panels });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error || '建会话失败');
  if (parsed.panels.length !== 0) throw new Error(`新会话已有 tab: ${parsed.panels.join(',')}`);
  return parsed;
}

function sideOpen(cdp) {
  return cdp.eval(`(() => {
    const id = window.__stores.sessions.getState().activeId;
    return window.__stores.sidePanel.getState().uiByConversation[id]?.open === true;
  })()`);
}

function panelCount(cdp) {
  return cdp.eval(`(window.__dockviewApi?.panels ?? []).length`);
}

function visibleMenus(cdp) {
  return cdp.eval(`[...document.querySelectorAll('[data-slot="menu-popup"]')].filter((popup) => {
    const rect = popup.getBoundingClientRect();
    return rect.width > 20 && rect.height > 20;
  }).length`);
}

async function togglePoint(cdp) {
  const labels = JSON.stringify(TOGGLE_LABELS);
  return cdp.eval(`(() => {
    const labels = new Set(${labels});
    const buttons = [...document.querySelectorAll('button')].filter((node) => {
      const label = node.getAttribute('aria-label') || '';
      if (!labels.has(label) && !/side panel/i.test(label)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    });
    const button = buttons.find((node) => {
      const rect = node.getBoundingClientRect();
      const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return top && (top === node || node.contains(top));
    }) ?? buttons[0];
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, label: button.getAttribute('aria-label') };
  })()`);
}

function moveTo(cdp, x, y, buttons = 0) {
  return cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: buttons ? 'left' : 'none',
    buttons,
  });
}

async function clickAt(cdp, point) {
  await moveTo(cdp, point.x, point.y);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1,
    });
  }
}

/** 真实点击右上角「展开右侧栏」按钮；空态展开会自动弹出新建菜单 */
async function clickToggle(cdp) {
  const before = await sideOpen(cdp);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const point = await togglePoint(cdp);
    if (!point) throw new Error('找不到展开/收起右侧栏按钮');
    await clickAt(cdp, point);
    const flipped = await waitFor(async () => ((await sideOpen(cdp)) !== before ? true : null), {
      timeout: 2_000,
      interval: 80,
      label: '侧栏开关生效',
    }).catch(() => null);
    if (flipped) return;
  }
  throw new Error('点击没有切换侧栏');
}

/** 顶栏右端收纳按钮组：平时只露「…」，hover 展开 +；复制自 verify-sidepanel-newtab-prompt.mjs */
const actionsExpr = `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const groups = [...document.querySelectorAll('[data-side-actions]')].filter((g) => {
    const btns = g.querySelectorAll('button');
    const last = btns[btns.length - 1];
    return g.isConnected && last && last.getBoundingClientRect().width > 0;
  });
  const g = groups[0];
  if (!g) return { found: false };
  const btns = [...g.querySelectorAll('button')];
  return { found: true, plus: box(btns[0]), toggle: box(btns[btns.length - 1]) };
})()`;

const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** 光标从「…」沿按钮组左移到 + 再点，弹出新建菜单 */
async function openPlusMenu(cdp) {
  await moveTo(cdp, 300, 450);
  await sleep(200);
  const rest = await cdp.eval(actionsExpr);
  if (!rest.found) throw new Error('找不到顶栏按钮组');
  const toggle = center(rest.toggle);
  await moveTo(cdp, toggle.x, toggle.y);
  const hover = await waitFor(
    async () => {
      const a = await cdp.eval(actionsExpr);
      return a.found && a.plus.w > 0 ? a : null;
    },
    { timeout: 3_000, interval: 80, label: 'hover 展开 +' }
  );
  const plus = center(hover.plus);
  for (let x = toggle.x; x >= plus.x; x -= 4) await moveTo(cdp, x, plus.y);
  await sleep(150);
  const onPlus = await cdp.eval(actionsExpr);
  if (!onPlus.found || onPlus.plus.w === 0) throw new Error(`移到 + 途中按钮组收起了`);
  await clickAt(cdp, center(onPlus.plus));
}

function menuItemPoint(cdp, label) {
  return cdp.eval(`(() => {
    const popup = [...document.querySelectorAll('[data-slot="menu-popup"]')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 20 && rect.height > 20;
    });
    const item = popup && [...popup.querySelectorAll('[data-slot="menu-item"]')].find(
      (node) => (node.innerText || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)}
    );
    if (!item) return null;
    const rect = item.getBoundingClientRect();
    return { x: rect.x + Math.min(rect.width / 2, 48), y: rect.y + rect.height / 2 };
  })()`);
}

/** 菜单开着就直接点；否则走顶栏 + 打开菜单，再真实点击菜单项 */
async function openTab(cdp, label) {
  const before = await panelCount(cdp);
  if ((await visibleMenus(cdp)) === 0) await openPlusMenu(cdp);
  const point = await waitFor(() => menuItemPoint(cdp, label), {
    timeout: 5_000,
    interval: 100,
    label: `菜单项 ${label}`,
  });
  await clickAt(cdp, point);
  await waitFor(async () => ((await panelCount(cdp)) > before ? true : null), {
    timeout: 10_000,
    interval: 150,
    label: `打开 ${label} tab`,
  });
  await waitFor(async () => ((await visibleMenus(cdp)) === 0 ? true : null), {
    timeout: 3_000,
    interval: 100,
    label: `${label} 菜单关闭`,
  });
}

function groupCount(cdp) {
  return cdp.eval(`(window.__dockviewApi?.groups ?? []).length`);
}

/** 被拖 tab 的标题点（避开关闭按钮）和它所在分组内容区的底部落点 */
function dragPoints(cdp, label) {
  return cdp.eval(`(() => {
    const dock = [...document.querySelectorAll('.enso-side-dock')].find((el) => el.getBoundingClientRect().width > 0);
    const tab = dock && [...dock.querySelectorAll('.dv-tab')].find(
      (node) => (node.innerText || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)}
    );
    if (!tab) return null;
    const content = tab.closest('.dv-groupview')?.querySelector('.dv-content-container');
    if (!content) return null;
    const t = tab.getBoundingClientRect();
    const c = content.getBoundingClientRect();
    return {
      from: { x: t.x + Math.min(t.width * 0.35, 24), y: t.y + t.height / 2 },
      to: { x: c.x + c.width / 2, y: c.y + c.height * 0.9 },
    };
  })()`);
}

async function mouseSteps(cdp, from, to, steps) {
  for (let i = 1; i <= steps; i += 1) {
    await moveTo(
      cdp,
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
      1
    );
    await sleep(30);
  }
}

async function press(cdp, type, point) {
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: 1,
  });
}

/** 只用 Input.dispatchMouseEvent：按下 → 分步移动 → 松开 */
async function mouseDrag(cdp, { from, to }) {
  await moveTo(cdp, from.x, from.y);
  await press(cdp, 'mousePressed', from);
  await mouseSteps(cdp, from, to, 16);
  await sleep(200);
  await press(cdp, 'mouseReleased', to);
}

/** 鼠标拖起后 Chromium 把 HTML5 drag 交给 CDP，再用 dispatchDragEvent 投递到落点 */
async function interceptDrag(cdp, { from, to }) {
  await cdp.send('Input.setInterceptDrags', { enabled: true });
  try {
    const intercepted = cdp.once('Input.dragIntercepted', 8_000);
    await moveTo(cdp, from.x, from.y);
    await press(cdp, 'mousePressed', from);
    await mouseSteps(cdp, from, { x: from.x + 6, y: from.y + 30 }, 6);
    const { data } = await intercepted;
    const send = (type, x, y) =>
      cdp.send('Input.dispatchDragEvent', { type, x, y, data, modifiers: 0 });
    await send('dragEnter', to.x, to.y - 20);
    for (let i = 0; i < 4; i += 1) {
      await send('dragOver', to.x, to.y - 12 + i * 4);
      await sleep(60);
    }
    await send('drop', to.x, to.y);
    await press(cdp, 'mouseReleased', to);
  } finally {
    await cdp.send('Input.setInterceptDrags', { enabled: false });
  }
}

async function dragToSplit(cdp, label) {
  const methods = DRAG === 'auto' ? ['mouse', 'intercept'] : [DRAG];
  for (const method of methods) {
    const points = await dragPoints(cdp, label);
    if (!points) throw new Error(`找不到 ${label} tab 或其内容区`);
    log(`拖拽(${method}) ${label} ${JSON.stringify(points)}`);
    if (method === 'mouse') await mouseDrag(cdp, points);
    else if (method === 'intercept') await interceptDrag(cdp, points);
    else throw new Error(`未知 --drag ${method}`);
    const split = await waitFor(async () => ((await groupCount(cdp)) === 2 ? true : null), {
      timeout: 3_000,
      interval: 100,
      label: `${method} 拖拽分组`,
    }).catch(() => null);
    log(`拖拽(${method}) 后分组数 ${await groupCount(cdp)}`);
    if (split) return method;
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
    }
    await sleep(300);
  }
  return null;
}

function measureExpr() {
  return `(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const api = window.__dockviewApi;
    const dock = [...document.querySelectorAll('.enso-side-dock')].find(visible) ?? null;
    const aside = dock?.closest('[data-enso="side-panel"]') ?? document.querySelector('[data-enso="side-panel"]');
    const groups = (api?.groups ?? []).map((group) => {
      const content = group.element.querySelector('.dv-content-container');
      return {
        id: group.id,
        active: group.activePanel?.id ?? null,
        panels: group.panels.map((panel) => panel.id),
        content: content ? box(content) : null,
        filled: content ? [...content.children].filter(visible).map(box) : [],
        tabs: [...group.element.querySelectorAll('.dv-tab')].map((tab) => ({
          text: (tab.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
          ...box(tab),
        })),
      };
    });
    return {
      aside: aside ? box(aside) : null,
      groups,
      sashes: dock ? [...dock.querySelectorAll('.dv-sash')].map(box) : [],
    };
  })()`;
}

function splitErrors(m) {
  const errors = [];
  if (!m.aside || m.aside.w < 200) errors.push(`右侧栏没展开 aside=${JSON.stringify(m.aside)}`);
  if (m.groups.length !== 2) errors.push(`分组数=${m.groups.length}，应为 2`);
  for (const group of m.groups) {
    if (!group.active) errors.push(`分组 ${group.id} 没有激活面板`);
    if (!group.filled.some((b) => b.w > 0 && b.h > 0)) {
      errors.push(`分组 ${group.id}(${group.active}) 内容区空白 ${JSON.stringify(group.content)}`);
    }
    for (const tab of group.tabs) {
      if (!tab.text || tab.w <= 0 || tab.h <= 0) {
        errors.push(`分组 ${group.id} tab 不可见 ${JSON.stringify(tab)}`);
      }
    }
  }
  const titles = m.groups.flatMap((group) => group.tabs.map((tab) => tab.text));
  if (titles.length < TAB_LABELS.length)
    errors.push(`tab 数=${titles.length} ${JSON.stringify(titles)}`);
  if (m.sashes.length === 0) errors.push('侧栏里没有 .dv-sash 分隔条');
  if (consoleErrors.length > 0) errors.push(`控制台 error ${JSON.stringify(consoleErrors)}`);
  return errors;
}

async function main() {
  if (!existsSync(path.join(ROOT, 'package.json'))) throw new Error(`找不到仓库 ${ROOT}`);
  if (!existsSync(path.join(ROOT, 'node_modules/.bin/electron-vite'))) {
    throw new Error(`缺少 ${path.join(ROOT, 'node_modules/.bin/electron-vite')}`);
  }
  artDir = mkdtempSync('/tmp/enso-dockview-upgrade-');
  const userData = path.join(artDir, 'user-data');
  const projectPath = path.join(artDir, 'project');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(path.join(projectPath, 'README.md'), 'dockview upgrade\n');
  spawnSync('git', ['init', '-q'], { cwd: projectPath });
  writeSettings(userData);
  const cdpPort = await reservePort(9222);
  const rendererPort = await reservePort(9222);
  log(`root ${ROOT}`);
  log(`userData ${userData}`);
  log(`cdp ${cdpPort} renderer ${rendererPort}`);
  startDev(userData, cdpPort, rendererPort);

  await waitFor(
    async () => {
      rememberOwned();
      try {
        const target = await pageTarget(cdpPort);
        if (!target) return null;
        assertIsolatedListener(cdpPort, userData);
        return target;
      } catch (error) {
        if (String(error.message).includes('不属于') || String(error.message).includes('对不上'))
          throw error;
        return null;
      }
    },
    { timeout: 120_000, interval: 500, label: '隔离 CDP 页面' }
  );

  const cdp = await waitForStablePage(cdpPort);
  watchConsole(cdp);
  try {
    const size = await applyViewport(cdp);
    if (size.v !== 'visible') throw new Error(`visibility=${size.v}，焦点模拟没生效`);
    await freezeMotion(cdp);
    const session = await bootSession(cdp, projectPath);
    log(`会话 ${session.id} cwd=${session.cwd}`);
    await sleep(400);

    await clickToggle(cdp);
    for (const label of TAB_LABELS) {
      await openTab(cdp, label);
      log(`已开 ${label}，面板数 ${await panelCount(cdp)}`);
    }
    await sleep(400);
    const before = await cdp.eval(measureExpr());
    log(`拖拽前 ${JSON.stringify(before)}`);
    if (before.groups.length !== 1) throw new Error(`拖拽前分组数=${before.groups.length}`);

    const method = await dragToSplit(cdp, DRAGGED);
    if (!method) throw new Error('真实拖拽没能分出第二个分组');
    await moveTo(cdp, 300, 450);
    await sleep(800);
    const final = await cdp.eval(measureExpr());
    log(`拖拽方式=${method}`);
    log(`最终 ${JSON.stringify(final)}`);
    const png = await shootSide(cdp, OUT, final.aside);
    log(`截图 ${OUT} ${png.width}x${png.height}`);
    const errors = splitErrors(final);
    if (errors.length > 0) {
      for (const line of errors) console.error(`FAIL: ${line}`);
      return 1;
    }
    log(`PASS: 拖拽(${method})分出 2 个分组，内容/标题/分隔条可见，控制台无 error`);
    return 0;
  } finally {
    cdp.close();
  }
}
let finishing = null;
function finish(code) {
  if (!finishing) {
    finishing = cleanup()
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
  if (devLogTail) console.error(devLogTail);
  void finish(1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  if (devLogTail) console.error(devLogTail);
  void finish(1);
});

setTimeout(() => {
  console.error(`硬超时 ${HARD_TIMEOUT_MS / 1000}s`);
  if (devLogTail) console.error(devLogTail);
  void finish(124);
}, HARD_TIMEOUT_MS);

main()
  .then((code) => finish(code))
  .catch((error) => {
    console.error(error);
    if (devLogTail) console.error(devLogTail);
    return finish(2);
  });
