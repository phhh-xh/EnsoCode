// 秘书会话右侧栏「只剩秘书标签、内容区整块空白」的隔离复现。
// dockview 恢复布局时，激活的秘书面板（onlyWhenVisible）后面排着一个 renderer:'always'
// 的插件面板：恢复完内容区挂的是插件面板、秘书面板的内容被移走；随后插件标签被清掉，
// 只剩秘书标签 + 空白内容区。隔离 dev 实例（临时 userData、拒绝 9222）。
// 启动/清理/隔离逻辑复制自 verify-sidepanel-newtab-prompt.mjs，秘书启用走真 IPC。
//
//   node scripts/verify-secretary-panel-blank.mjs [--out <png>] [--root <repo>] [--keep] [--timeout <秒>]
//
// 默认截图 /tmp/secretary-panel-blank.png（侧栏区域）。断言「秘书面板内容可见」失败时
// 仍保存截图并以 1 退出。--keep 保留临时 userData。

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
const OUT = path.resolve(flag('--out') ?? '/tmp/secretary-panel-blank.png');
const HARD_TIMEOUT_MS = Number(flag('--timeout') ?? 180) * 1000;

const VIEWPORT = { width: 1400, height: 900 };
const GHOST = 'plugin:enso.ghost:ghost';

const children = [];
const trackedPids = [];
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

function writeSettings(userData) {
  mkdirSync(userData, { recursive: true });
  const state = {
    providers: [],
    onboarded: true,
    theme: 'system',
    language: 'zh-CN',
    titleSummaryEnabled: false,
    secretaryEnabled: true,
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

/** 真 IPC 启用秘书、存档案、建秘书会话并打开右侧栏；秘书面板由 SidePanel 自己补上并激活 */
async function bootSecretaryConversation(cdp) {
  const raw = await cdp.eval(`(async () => {
    const until = async (fn, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try { const value = await fn(); if (value) return value; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return null;
    };
    const S = window.__stores;
    localStorage.removeItem('enso-side-panel');
    S.settings.setState({ onboarded: true, language: 'zh-CN', titleSummaryEnabled: false, secretaryEnabled: true });
    const secretaryProject = () => S.settings.getState().projects.find((p) => p.kind === 'secretary');
    let createdVia = 'auto';
    let secretaryId;
    if (!(await until(secretaryProject, 20000))) {
      const created = await window.electronAPI.secretary.create();
      if (!created?.ok) return JSON.stringify({ ok: false, error: 'secretary.create: ' + JSON.stringify(created) });
      secretaryId = created.secretaryId;
      createdVia = 'create';
      if (!(await until(secretaryProject, 20000))) return JSON.stringify({ ok: false, error: '秘书隐藏项目没出现' });
    }
    const saved = await window.electronAPI.secretary.saveProfile({
      name: '爱酱',
      avatar: { color: '#7c6af7' },
      visibleProjectIds: 'all',
      maxRunningDispatches: 3,
      patrolEnabled: false,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'off',
      addressAs: null,
      dailyBriefAt: null,
    }, secretaryId);
    if (!saved?.ok) return JSON.stringify({ ok: false, error: 'saveProfile: ' + JSON.stringify(saved) });
    const ready = await until(() => {
      const sec = S.secretary.getState().secretary;
      return sec?.projectId && sec.profile ? sec : null;
    }, 20000);
    if (!ready) return JSON.stringify({ ok: false, error: '秘书档案没推到 renderer' });
    const id = await S.secretary.getState().newSecretaryConversation();
    if (!id) return JSON.stringify({ ok: false, error: 'newSecretaryConversation 返回空' });
    await until(() => S.sessions.getState().activeId === id, 10000);
    S.sidePanel.setState((state) => ({
      fullscreen: false,
      lastWidth: 560,
      uiByConversation: {
        ...state.uiByConversation,
        [id]: { ...(state.uiByConversation[id] ?? {}), open: true, width: 560 },
      },
      fullscreenByConversation: { ...state.fullscreenByConversation, [id]: false },
    }));
    return JSON.stringify({
      ok: true,
      id,
      createdVia,
      projectId: ready.projectId,
      pluginIds: ready.profile.pluginIds ?? [],
    });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error || '建秘书会话失败');
  return parsed;
}

/** 当前可见 dock 的 dockview 状态与秘书内容是否真的在内容区里可见 */
function measureExpr() {
  return `(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const api = window.__dockviewApi;
    const docks = [...document.querySelectorAll('.enso-side-dock')].filter(visible);
    const dock = docks[0] ?? null;
    const aside = dock?.closest('[data-enso="side-panel"]') ?? document.querySelector('[data-enso="side-panel"]');
    const tabs = dock
      ? [...dock.querySelectorAll('.dv-tab')].map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40))
      : [];
    const containers = dock
      ? [...dock.querySelectorAll('.dv-content-container')].filter(visible).map((c) => {
          const kids = [...c.children];
          const sec = c.querySelector('[data-enso="secretary-panel"],[data-enso="secretary-panel-pending"]');
          return {
            box: box(c),
            children: kids.length,
            visibleChildren: kids.filter(visible).length,
            textLength: (c.innerText || '').trim().length,
            secretary: sec ? box(sec) : null,
          };
        })
      : [];
    return {
      docks: docks.length,
      aside: aside ? box(aside) : null,
      activePanel: api?.activePanel?.id ?? null,
      panels: api ? api.panels.map((p) => p.id) : null,
      tabs,
      containers,
    };
  })()`;
}

function blankErrors(m) {
  const errors = [];
  if (m.docks !== 1) errors.push(`可见 dock 数=${m.docks}`);
  if (!m.aside || m.aside.w < 200) errors.push(`右侧栏没展开 aside=${JSON.stringify(m.aside)}`);
  if (m.activePanel !== 'secretary') errors.push(`dockview 激活面板=${m.activePanel}`);
  if (JSON.stringify(m.panels) !== JSON.stringify(['secretary'])) {
    errors.push(`面板应只有 secretary，实际 ${JSON.stringify(m.panels)}`);
  }
  if (m.tabs.length !== 1) errors.push(`标签应只有秘书一个，实际 ${JSON.stringify(m.tabs)}`);
  const shown = m.containers.some(
    (c) =>
      c.visibleChildren > 0 &&
      c.textLength > 0 &&
      c.secretary &&
      c.secretary.w > 0 &&
      c.secretary.h > 0
  );
  if (!shown) {
    errors.push(`秘书面板内容不可见 .dv-content-container=${JSON.stringify(m.containers)}`);
  }
  return errors;
}

async function main() {
  if (!existsSync(path.join(ROOT, 'package.json'))) throw new Error(`找不到仓库 ${ROOT}`);
  if (!existsSync(path.join(ROOT, 'node_modules/.bin/electron-vite'))) {
    throw new Error(`缺少 ${path.join(ROOT, 'node_modules/.bin/electron-vite')}`);
  }
  artDir = mkdtempSync('/tmp/enso-secretary-blank-');
  const userData = path.join(artDir, 'user-data');
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
  try {
    const size = await applyViewport(cdp);
    if (size.v !== 'visible') throw new Error(`visibility=${size.v}，焦点模拟没生效`);
    await freezeMotion(cdp);
    const scene = await bootSecretaryConversation(cdp);
    log(
      `秘书会话 ${scene.id} via=${scene.createdVia} project=${scene.projectId} pluginIds=${JSON.stringify(scene.pluginIds)}`
    );

    // 基线：秘书面板已激活且内容可见，否则场景本身不成立
    const baseline = await waitFor(
      async () => {
        const m = await cdp.eval(measureExpr());
        return blankErrors(m).length === 0 ? m : null;
      },
      { timeout: 20_000, interval: 300, label: '基线：秘书面板激活且可见' }
    ).catch(async (error) => {
      log(`基线 ${JSON.stringify(await cdp.eval(measureExpr()).catch(String))}`);
      throw error;
    });
    log(
      `基线 tabs=${JSON.stringify(baseline.tabs)} containers=${JSON.stringify(baseline.containers)}`
    );

    // 真实恢复链路：布局里秘书面板激活、同组排在它后面一个 renderer:'always' 的插件面板
    const restored = await cdp.eval(`(() => {
      const api = window.__dockviewApi;
      const json = api.toJSON();
      const leaves = [];
      const walk = (node) => {
        if (!node) return;
        if (node.type === 'leaf') leaves.push(node);
        else if (Array.isArray(node.data)) node.data.forEach(walk);
      };
      walk(json.grid.root);
      const leaf = leaves.find((l) => l.data.views.includes('secretary'));
      if (!leaf) return { ok: false, error: 'toJSON 里找不到秘书所在 group' };
      leaf.data.views.push(${JSON.stringify(GHOST)});
      leaf.data.activeView = 'secretary';
      json.panels[${JSON.stringify(GHOST)}] = {
        id: ${JSON.stringify(GHOST)},
        contentComponent: 'plugin',
        title: 'Ghost',
        renderer: 'always',
        params: {
          conversationId: ${JSON.stringify(scene.id)},
          projectId: ${JSON.stringify(scene.projectId)},
          pluginId: 'enso.ghost',
          viewId: 'ghost',
        },
      };
      // fromJSON 先清空 dock，会触发「关掉最后一个 tab 收起侧栏」；同一同步块里立刻恢复 open，
      // React 合批后看不到这次收起，秘书面板的 reveal 不会重跑（重跑会 focus 秘书面板、掩盖白屏）
      const conversationId = ${JSON.stringify(scene.id)};
      api.fromJSON(json);
      window.__stores.sidePanel.setState((state) => ({
        uiByConversation: {
          ...state.uiByConversation,
          [conversationId]: { ...(state.uiByConversation[conversationId] ?? {}), open: true, width: 560 },
        },
      }));
      return { ok: true, views: leaf.data.views, activeView: leaf.data.activeView };
    })()`);
    if (!restored.ok) throw new Error(restored.error);
    await sleep(300);
    log(
      `fromJSON views=${JSON.stringify(restored.views)} → ${JSON.stringify(await cdp.eval(measureExpr()))}`
    );

    // 真实清理链路：globalTabs 换个新引用，让 SidePanel 的 secretaryPluginPanelsToClose effect 重跑；
    // enso.ghost 不在档案 pluginIds 里，它会把插件标签关掉。关不掉才退回直接 close
    await cdp.eval(`(() => {
      window.__stores.sidePanel.setState((s) => ({ globalTabs: [...s.globalTabs] }));
      return true;
    })()`);
    let closedBy = 'secretaryPluginPanelsToClose';
    const gone = await waitFor(
      async () =>
        (await cdp.eval(`!window.__dockviewApi.getPanel(${JSON.stringify(GHOST)})`)) ? true : null,
      { timeout: 5_000, interval: 150, label: '插件标签被清掉' }
    ).catch(() => null);
    if (!gone) {
      closedBy = 'api.close';
      await cdp.eval(
        `(() => { window.__dockviewApi.getPanel(${JSON.stringify(GHOST)})?.api.close(); return true; })()`
      );
    }
    await sleep(600);
    const final = await cdp.eval(measureExpr());
    log(`插件标签关闭方式=${closedBy}`);
    log(`最终 ${JSON.stringify(final)}`);
    const png = await shootSide(cdp, OUT, final.aside);
    log(`截图 ${OUT} ${png.width}x${png.height}`);
    const errors = blankErrors(final);
    if (errors.length > 0) {
      for (const line of errors) console.error(`FAIL: ${line}`);
      return 1;
    }
    log('PASS: 只剩秘书标签且秘书面板内容可见');
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
