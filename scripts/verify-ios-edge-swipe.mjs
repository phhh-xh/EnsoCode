#!/usr/bin/env node
// 触屏（iOS App / PWA 的 /desk）边缘滑动开合左右侧栏：跟手、按速度/位移落定、不误触发。
//   pnpm build:server && node scripts/verify-ios-edge-swipe.mjs
// 390x844 触屏视口，用 CDP Input.dispatchTouchEvent 合成真实 touch 序列。
// 截图写到 /tmp/ios-edge-swipe-*.png。退出码：全部用例通过为 0，否则 1。3 分钟硬超时。
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = '/tmp';
const OUT = mkdtempSync(path.join(os.tmpdir(), 'enso-edge-swipe-'));
const USER_DATA = path.join(OUT, 'userData');
const PROJ = path.join(OUT, 'proj');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(PROJ, { recursive: true });

const VIEWPORTS = [{ name: 'phone', width: 390, height: 844 }];

const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(line);

function shutdown(code) {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  process.exit(code);
}

const hardTimeout = setTimeout(() => {
  console.error('hard timeout');
  shutdown(1);
}, 180_000);
hardTimeout.unref();

async function waitFor(fn, { timeout = 30_000, interval = 300, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(
    `timeout waiting for ${label}${last instanceof Error ? `: ${last.message}` : last ? `: ${JSON.stringify(last).slice(0, 400)}` : ''}`
  );
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

class Cdp {
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`ws open failed ${wsUrl}`));
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
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp ${method} timeout`));
      }, 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
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
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
      );
    }
    return result.result?.value;
  }

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOTS, `ios-edge-swipe-${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    log(`shot ${file}`);
    return file;
  }
}

const HEADLESS_SHELL = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
);

async function viewport(cdp, { width, height }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

async function launchBrowser() {
  if (!existsSync(HEADLESS_SHELL)) throw new Error(`missing chromium ${HEADLESS_SHELL}`);
  const debugPort = await freePort();
  const userDir = mkdtempSync(path.join(os.tmpdir(), 'enso-edge-swipe-chrome-'));
  const logFd = openSync(path.join(OUT, 'chromium.log'), 'a');
  const child = spawn(
    HEADLESS_SHELL,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDir}`,
      '--window-size=1180,844',
      '--touch-events=enabled',
      '--no-first-run',
      'about:blank',
    ],
    { stdio: ['ignore', logFd, logFd] }
  );
  children.push(child);
  const pageTarget = await waitFor(
    async () => {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return list.find((t) => t.type === 'page');
    },
    { label: 'chromium page target' }
  );
  const cdp = await Cdp.open(pageTarget.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await viewport(cdp, VIEWPORTS[0]);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return cdp;
}

const FRAME_DOC = `(() => {
  const main = document.querySelector('iframe.main');
  if (main?.contentDocument) return main.contentDocument;
  return document;
})()`;

/** 在 /desk 的 iframe 里跑一段代码（doc / view 可用） */
async function frame(cdp, source) {
  return cdp.eval(`(async () => {
    const doc = ${FRAME_DOC};
    const view = doc.defaultView;
    if (!view) return { error: 'no view' };
    try {
      return await (async () => {
        ${source}
      })();
    } catch (error) {
      return { error: String(error && error.stack ? error.stack : error) };
    }
  })()`);
}

/**
 * 找到元素在顶层页面里的中心点，并记下该点真实命中的元素（pointer-events:none 会让命中落到别处）。
 * pick 是在 iframe 里返回目标元素的表达式。
 */
async function locate(cdp, pick) {
  return frame(
    cdp,
    `
    const el = (() => { ${pick} })();
    if (!el) return null;
    const fr = view.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = doc.elementFromPoint(cx, cy);
    const style = view.getComputedStyle(el);
    return {
      x: fr.left + cx,
      y: fr.top + cy,
      w: r.width,
      h: r.height,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      display: style.display,
      hitsTarget: !!hit && (hit === el || el.contains(hit)),
      hit: hit ? hit.tagName.toLowerCase() + (hit.getAttribute('aria-label') ? '[' + hit.getAttribute('aria-label') + ']' : '') + (hit.hasAttribute('data-side-tab') ? '[data-side-tab]' : '') : null,
    };
  `
  );
}

async function tap(cdp, point) {
  await cdp.send('Input.synthesizeTapGesture', {
    x: point.x,
    y: point.y,
    gestureSourceType: 'touch',
  });
  await sleep(900);
}

function prepareProject() {
  writeFileSync(path.join(PROJ, 'README.md'), 'edge swipe target\n');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: PROJ, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} ${result.stderr}`);
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

function writeSettings() {
  const projectId = randomUUID();
  const state = {
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
    language: 'zh',
    theme: 'light',
    projects: [{ id: projectId, name: 'edge-swipe', path: PROJ }],
  };
  writeFileSync(
    path.join(USER_DATA, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 18 } })
  );
  return projectId;
}

async function startServer() {
  const webPort = await freePort();
  const serverLog = openSync(path.join(OUT, 'server.log'), 'a');
  const env = { ...process.env, ENSO_VERIFY: '1', ENSO_PACKAGED: '0', ENSO_DATA_DIR: USER_DATA };
  delete env.ELECTRON_RUN_AS_NODE;
  const server = spawn(
    process.execPath,
    [
      path.join(ROOT, 'out/server/index.js'),
      'start',
      '--web-host',
      '127.0.0.1',
      '--web-port',
      String(webPort),
    ],
    { env, stdio: ['ignore', serverLog, serverLog], cwd: ROOT }
  );
  children.push(server);
  await waitFor(
    async () => {
      try {
        await fetch(`http://127.0.0.1:${webPort}/`);
        return true;
      } catch {
        return false;
      }
    },
    { label: 'enso-server web' }
  );
  const invite = await new Promise((resolve, reject) => {
    const pair = spawn(process.execPath, [path.join(ROOT, 'out/server/index.js'), 'pair'], {
      env,
      cwd: ROOT,
    });
    children.push(pair);
    let buf = '';
    const timer = setTimeout(() => reject(new Error('pair invite timeout')), 20_000);
    pair.stdout.on('data', (chunk) => {
      buf += chunk;
      const match = buf.match(/enso-pair:\/\/\S+|https?:\/\/[^\s#]+#\S+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0].replace(/[)\].,，。]+$/, ''));
      }
    });
    pair.on('error', reject);
  });
  return { origin: `http://127.0.0.1:${webPort}`, invite };
}

async function openDesk(cdp, { origin, invite }) {
  await cdp.send('Page.navigate', { url: `${origin}/?mode=phone` });
  await waitFor(() => cdp.eval('document.readyState === "complete"'), { label: 'index' });
  await cdp.eval(`localStorage.setItem('enso-phone-ui-mode', 'desk'); true`);
  await cdp.send('Page.navigate', { url: `${origin}/?mode=phone` });
  await waitFor(() => cdp.eval(`!!document.querySelector('input')`), { label: 'pair input' });
  await cdp.eval(`(() => {
    const input = document.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(invite)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => /配对/.test(b.textContent ?? '') && b.offsetParent !== null)?.click();
    return true;
  })()`);
  await waitFor(async () => !!(await cdp.eval('localStorage.getItem("enso-phone-devices")')), {
    label: 'pairing',
  });
  await cdp.eval(`localStorage.setItem('enso-phone-ui-mode', 'desk'); true`);
  await cdp.send('Page.navigate', { url: `${origin}/` });
  await waitFor(async () => (await cdp.eval('location.pathname')).startsWith('/desk'), {
    label: 'redirect to /desk',
  });
  await waitFor(
    () =>
      cdp.eval(`(() => {
        const doc = document.querySelector('iframe.main')?.contentDocument;
        return !!doc?.querySelector('[data-enso="workbench"]');
      })()`),
    { timeout: 40_000, label: 'remote renderer' }
  );
  // 快照层淡出前会盖在 iframe 上
  await waitFor(() => cdp.eval(`!document.querySelector('iframe.snapshot')`), {
    timeout: 40_000,
    label: 'snapshot gone',
  });
}

async function newConversation(cdp) {
  await frame(
    cdp,
    `doc.querySelector('[data-enso="project-row"] svg.lucide-message-square-plus')?.closest('button')?.click(); return true;`
  );
  await waitFor(
    () => frame(cdp, `return !doc.body.innerText.includes('创建或选择一个项目以开始对话');`),
    { label: 'active conversation' }
  );
}

/** 两侧开合度：左抽屉露出比例、右面板盖住比例（0 关 ~ 1 开），以及 React 落定状态 */
const SWIPE_STATE = `
  const vw = view.innerWidth;
  const drawer = doc.querySelector('[data-enso="mobile-drawer"]');
  const d = drawer?.getBoundingClientRect();
  const aside = doc.querySelector('[data-slot="side-panel"]');
  const a = aside?.getBoundingClientRect();
  const main = doc.querySelector('[data-enso="main"]');
  const visibleMenu = [...doc.querySelectorAll('[role="menu"],[role="dialog"]')].some((m) => m.getClientRects().length > 0);
  return {
    vw,
    left: d ? Math.max(0, Math.min(1, d.right / d.width)) : null,
    leftOpen: drawer ? !drawer.hasAttribute('inert') : null,
    right: a && a.width > 0 ? Math.max(0, Math.min(1, (vw - Math.max(0, a.left)) / vw)) : 0,
    rightLeft: a ? Math.round(a.left) : null,
    rightWidth: a ? Math.round(a.width) : null,
    mainHidden: main ? view.getComputedStyle(main).visibility === 'hidden' : null,
    menu: visibleMenu,
  };
`;
const swipeState = (cdp) => frame(cdp, SWIPE_STATE);

let frameOrigin = { left: 0, top: 0 };

async function touch(cdp, type, point) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints:
      type === 'touchEnd' || type === 'touchCancel'
        ? []
        : [{ x: frameOrigin.left + point.x, y: frameOrigin.top + point.y, id: 1 }],
  });
}

/**
 * 合成一次拖动：from → to，steps 段、每段 stepMs。
 * holdAt（0~1）处停住截图 shot；holdMs 为松手前静止时长（让速度归零，测位移阈值）。
 */
async function drag(cdp, from, to, { steps = 20, stepMs = 16, holdAt, shot, holdMs = 0 } = {}) {
  await touch(cdp, 'touchStart', from);
  let mid = null;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await touch(cdp, 'touchMove', {
      x: from.x + (to.x - from.x) * k,
      y: from.y + (to.y - from.y) * k,
    });
    await sleep(stepMs);
    if (holdAt !== undefined && mid === null && k >= holdAt) {
      await sleep(120);
      mid = await swipeState(cdp);
      if (shot) await cdp.shot(shot);
    }
  }
  if (holdMs) await sleep(holdMs);
  await touch(cdp, 'touchEnd');
  await sleep(700);
  return { mid, after: await swipeState(cdp) };
}

async function dismissMenus(cdp) {
  for (let i = 0; i < 3; i++) {
    if (!(await swipeState(cdp)).menu) return;
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await sleep(400);
  }
}

async function runViewport(cdp, vp) {
  await viewport(cdp, vp);
  await sleep(1500);
  frameOrigin = await cdp.eval(`(() => {
    const r = document.querySelector('iframe.main')?.getBoundingClientRect();
    return r ? { left: r.left, top: r.top } : { left: 0, top: 0 };
  })()`);
  await frame(
    cdp,
    `view.__touchLog = [];
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      view.addEventListener(type, (e) => {
        const t = e.changedTouches[0];
        view.__touchLog.push([type.slice(5), Math.round(e.timeStamp), t ? Math.round(t.clientX) : null, e.defaultPrevented, e.target?.tagName]);
      }, { passive: true });
    }
    return true;`
  );
  const init = await swipeState(cdp);
  const W = init.vw;
  const y = 420;
  const cases = {};
  const record = async (name, pass, detail) => {
    const touches = await frame(cdp, 'const l = view.__touchLog; view.__touchLog = []; return l;');
    cases[name] = { pass, ...detail };
    if (!pass) detail = { ...detail, touches };
    log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
  };
  await record('initial closed', init.leftOpen === false && init.right === 0, { init });

  // 左：慢拖到约 35% 静止松手 → 回弹关闭
  let r = await drag(
    cdp,
    { x: 6, y },
    { x: 6 + 0.35 * 336, y },
    { steps: 24, stepMs: 40, holdMs: 250 }
  );
  await record(
    'left short slow drag snaps back',
    r.after.leftOpen === false && r.after.left < 0.05,
    r
  );

  // 左：慢拖，过半截图（跟手），拖到约 75% 静止松手 → 打开
  r = await drag(
    cdp,
    { x: 6, y },
    { x: 6 + 0.75 * 336, y },
    {
      steps: 30,
      stepMs: 40,
      holdAt: 0.66,
      shot: 'left-half',
      holdMs: 250,
    }
  );
  await record(
    'left drag follows finger then opens',
    r.mid.left > 0.3 &&
      r.mid.left < 0.7 &&
      r.mid.leftOpen === false &&
      r.after.leftOpen === true &&
      r.after.left > 0.97,
    r
  );
  await cdp.shot('left-open');

  // 左已开：在抽屉里往左慢拖到一半以上静止松手 → 关闭
  r = await drag(cdp, { x: 250, y }, { x: 40, y }, { steps: 20, stepMs: 40, holdMs: 250 });
  await record(
    'left open → swipe left closes',
    r.after.leftOpen === false && r.after.left < 0.05,
    r
  );

  // 左：短而快的甩动（约 60px / 48ms）→ 按速度打开
  r = await drag(cdp, { x: 4, y }, { x: 64, y }, { steps: 4, stepMs: 12 });
  await record('left quick flick opens by velocity', r.after.leftOpen === true, r);
  // 在遮罩区快速往左甩 → 关闭
  r = await drag(cdp, { x: 370, y }, { x: 300, y }, { steps: 4, stepMs: 12 });
  await record('left flick on backdrop closes', r.after.leftOpen === false, r);

  // 非边缘起点（x=60）横滑 → 不打开
  r = await drag(cdp, { x: 60, y }, { x: 300, y }, { steps: 20, stepMs: 20 });
  await record('non-edge start ignored', r.after.leftOpen === false && r.after.right === 0, r);
  // 边缘起点但竖滑 → 不打开
  r = await drag(cdp, { x: 6, y: 600 }, { x: 14, y: 250 }, { steps: 20, stepMs: 20 });
  await record('vertical swipe from edge ignored', r.after.leftOpen === false, r);

  // 右：从右边缘往左慢拖，过半截图，拖到约 80% 静止松手 → 打开
  r = await drag(
    cdp,
    { x: W - 5, y },
    { x: W - 5 - 0.8 * W, y },
    {
      steps: 30,
      stepMs: 40,
      holdAt: 0.62,
      shot: 'right-half',
      holdMs: 250,
    }
  );
  await record(
    'right drag follows finger then opens',
    r.mid.right > 0.3 && r.mid.right < 0.7 && r.mid.mainHidden === false && r.after.right > 0.97,
    r
  );
  await dismissMenus(cdp);
  await sleep(300);
  await cdp.shot('right-open');

  // 右已开：非边缘起点往右拖 → 不关（面板里的横向内容不误触发）
  r = await drag(cdp, { x: 100, y }, { x: 360, y }, { steps: 20, stepMs: 20 });
  await record('right open, non-edge drag ignored', r.after.right > 0.97, r);

  // 右已开：从左边缘往右拖，中途主区必须可见（下面露出对话），静止松手于约 70% → 关闭
  r = await drag(
    cdp,
    { x: 6, y },
    { x: 6 + 0.7 * W, y },
    {
      steps: 24,
      stepMs: 40,
      holdAt: 0.5,
      shot: 'right-closing',
      holdMs: 250,
    }
  );
  await record(
    'right open → swipe right from left edge closes',
    r.mid.right < 0.8 && r.mid.right > 0.4 && r.mid.mainHidden === false && r.after.right < 0.03,
    r
  );

  // 按钮点击仍然正常（touch 监听不吞点击）
  const menuBtn = await locate(cdp, `return doc.querySelector('[data-enso="sidebar-toggle"]');`);
  if (menuBtn) {
    await tap(cdp, { x: menuBtn.x, y: menuBtn.y });
    const s = await swipeState(cdp);
    await record('hamburger tap still opens drawer', s.leftOpen === true && s.left > 0.97, { s });
    await tap(cdp, { x: 370, y });
    const s2 = await swipeState(cdp);
    await record('backdrop tap still closes drawer', s2.leftOpen === false, { s2 });
  } else {
    await record('hamburger tap still opens drawer', false, { error: 'sidebar-toggle not found' });
  }
  return cases;
}

async function main() {
  log(`out ${OUT}`);
  prepareProject();
  writeSettings();
  const server = await startServer();
  log(`server ${server.origin}`);
  const cdp = await launchBrowser();
  await openDesk(cdp, server);
  log('desk ready');
  await newConversation(cdp);
  let ok = true;
  for (const vp of VIEWPORTS) {
    const cases = await runViewport(cdp, vp);
    ok = ok && Object.values(cases).every((c) => c.pass);
  }
  log(ok ? 'PASS' : 'FAIL');
  shutdown(ok ? 0 : 1);
}

process.on('SIGINT', () => shutdown(130));
main().catch((error) => {
  console.error(error);
  shutdown(1);
});
