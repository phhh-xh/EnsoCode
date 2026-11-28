#!/usr/bin/env node
// 手机 /desk（PWA 完整模式）触屏下插件通知 toast 能否关掉。
//   pnpm build:server && node scripts/verify-mobile-toast-close.mjs [--shot /tmp/x.png]
// 390x844、iPhone UA、触屏仿真、减弱动画。宿主推两条「插件 X 已更新到 Y」后：
//   expanded 先点一下 toast（iOS 上第一下点 × 也只会展开），两条展开后从上往下点每条的 × 各一次
//   close    收起状态下点最前面那条的 ×，两条依次消失
//   edge     手指稍偏：点在 × 左侧 12px 处也算点中
//   auto     不碰它，按时自动消失
//   tapped   点一下 toast 正文、再点别处后，仍会自动消失
//   swipe    向右滑动关闭
//   view     点「查看」打开插件设置并关掉 toast
// --shot 存 expanded 用例里点完上面那条 × 之后的画面。3 分钟硬超时，结束时清掉子进程与隔离目录。
// 退出码：全过 0，否则 1。

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shotArg = process.argv.indexOf('--shot');
const SHOT = shotArg > 0 ? process.argv[shotArg + 1] : null;
const OUT = mkdtempSync(path.join(os.tmpdir(), 'enso-mobile-toast-'));
const USER_DATA = path.join(OUT, 'userData');
const PROJ = path.join(OUT, 'proj');
const CHROME_DIR = path.join(OUT, 'chrome');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(PROJ, { recursive: true });
mkdirSync(CHROME_DIR, { recursive: true });

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const NOTICE_CHANNEL = 'extension-plugins:notice';
const CLOSE_LABEL = 'Close notification';
/** success 类 toast 的超时（src/renderer/components/ui/toast.tsx addToast） */
const SUCCESS_TIMEOUT = 5000;

const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(line);

function shutdown(code) {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  try {
    rmSync(OUT, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}

const hardTimeout = setTimeout(() => {
  console.error('hard timeout (180s)');
  shutdown(1);
}, 180_000);
hardTimeout.unref();

async function waitFor(fn, { timeout = 30_000, interval = 250, label = 'condition' } = {}) {
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

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(data, 'base64'));
    log(`shot ${file}`);
  }
}

const HEADLESS_SHELL = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
);

/** 宿主推送插件通知的监听：包住 /desk 父页面的隧道桥，记下 iframe 订阅通知通道的回调 */
const NOTICE_PROBE = `(() => {
  let bridge;
  Object.defineProperty(window, '__ensoRemote', {
    configurable: true,
    get() { return bridge; },
    set(value) {
      const attach = value.attach.bind(value);
      value.attach = (kind) => {
        const frame = attach(kind);
        if (kind !== 'main') return frame;
        const on = frame.on;
        return { ...frame, on(channel, cb) {
          if (channel === ${JSON.stringify(NOTICE_CHANNEL)}) (window.__noticeProbe ??= new Set()).add(cb);
          const off = on(channel, cb);
          return () => { window.__noticeProbe?.delete(cb); off(); };
        } };
      };
      bridge = value;
    },
  });
})();`;

async function launchBrowser() {
  if (!existsSync(HEADLESS_SHELL)) throw new Error(`missing chromium ${HEADLESS_SHELL}`);
  const debugPort = await freePort();
  const logFd = openSync(path.join(OUT, 'chromium.log'), 'a');
  const child = spawn(
    HEADLESS_SHELL,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${CHROME_DIR}`,
      '--window-size=390,844',
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
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: NOTICE_PROBE });
  return cdp;
}

const FRAME_DOC = `(() => {
  const main = document.querySelector('iframe.main');
  if (main?.contentDocument) return main.contentDocument;
  return document;
})()`;

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

/** 元素在顶层页面里的中心点，以及该点真实命中的元素 */
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
    return {
      x: fr.left + cx,
      y: fr.top + cy,
      w: Math.round(r.width),
      h: Math.round(r.height),
      hitsTarget: !!hit && (hit === el || el.contains(hit)),
      hit: hit ? hit.tagName.toLowerCase() + (hit.getAttribute('aria-label') ? '[' + hit.getAttribute('aria-label') + ']' : '') : null,
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
}

async function swipeRight(cdp, point) {
  const touch = (type, x) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y: point.y, id: 1 }],
    });
  await touch('touchStart', point.x);
  for (let dx = 15; dx <= 165; dx += 15) {
    await touch('touchMove', point.x + dx);
    await sleep(16);
  }
  await touch('touchEnd', point.x + 165);
}

const TOAST_STATE = `
  const roots = [...doc.querySelectorAll('[data-slot="toast-viewport"] [role="dialog"]')];
  return roots
    .filter((r) => !r.hasAttribute('data-ending-style'))
    .map((r) => ({
      title: r.querySelector('[data-slot="toast-title"]')?.textContent ?? '',
      expanded: r.hasAttribute('data-expanded'),
    }));
`;
const toasts = (cdp) => frame(cdp, TOAST_STATE);
/** 当前 DOM 里的 toast 根（含退场中） */
const toastNodes = (cdp) =>
  frame(cdp, `return doc.querySelectorAll('[data-slot="toast-viewport"] [role="dialog"]').length;`);

let noticeSeq = 0;
async function pushNotices(cdp, names) {
  const notices = names.map((name) => ({
    kind: 'auto-updated',
    pluginId: `enso.verify-${++noticeSeq}`,
    name,
    version: `1.${noticeSeq}.0`,
  }));
  const delivered = await cdp.eval(`(() => {
    const probes = [...(window.__noticeProbe ?? [])];
    for (const notice of ${JSON.stringify(notices)}) {
      for (const cb of probes) cb(JSON.stringify([notice]));
    }
    return probes.length;
  })()`);
  if (!delivered) throw new Error('notice channel not subscribed');
  await waitFor(async () => (await toasts(cdp)).length === names.length, {
    label: `${names.length} toast(s) shown`,
    timeout: 5000,
  });
  return notices;
}

/** 每个用例结束清场：toast 全部卸载，避免串到下一步 */
async function clearToasts(cdp) {
  const tapOutside = { x: 195, y: 120 };
  for (let i = 0; i < 8 && (await toastNodes(cdp)) > 0; i++) {
    const close = await locate(
      cdp,
      `return doc.querySelector('[data-slot="toast-viewport"] [role="dialog"]:not([data-ending-style]) [aria-label="${CLOSE_LABEL}"]');`
    );
    await tap(cdp, close ?? tapOutside);
    await sleep(400);
  }
  // 没关掉的残留直接卸掉（不计入结果），后续用例从干净状态开始
  await frame(
    cdp,
    `doc.querySelectorAll('[data-slot="toast-viewport"] [aria-label="${CLOSE_LABEL}"]').forEach((b) => b.click()); return true;`
  );
  await waitFor(async () => (await toastNodes(cdp)) === 0, {
    label: 'toasts cleared',
    timeout: 5000,
  }).catch(() => {});
}

function prepareProject() {
  writeFileSync(path.join(PROJ, 'README.md'), 'mobile toast target\n');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: PROJ, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} ${result.stderr}`);
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

function writeSettings() {
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
    projects: [{ id: randomUUID(), name: 'mobile-toast', path: PROJ }],
  };
  writeFileSync(
    path.join(USER_DATA, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 18 } })
  );
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
  await waitFor(() => cdp.eval(`!!document.querySelector('input')`), { label: 'pair input' }).catch(
    async (error) => {
      log(`page: ${await cdp.eval('location.href + " " + document.body.innerText.slice(0, 400)')}`);
      throw error;
    }
  );
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
  await waitFor(() => cdp.eval(`!document.querySelector('iframe.snapshot')`), {
    timeout: 40_000,
    label: 'snapshot gone',
  });
  await waitFor(async () => (await cdp.eval('window.__noticeProbe?.size ?? 0')) > 0, {
    label: 'notice subscription',
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

const closeButtonOf = (title) =>
  `return [...doc.querySelectorAll('[data-slot="toast-viewport"] [role="dialog"]:not([data-ending-style])')]
    .find((r) => r.querySelector('[data-slot="toast-title"]')?.textContent === ${JSON.stringify(title)})
    ?.querySelector('[aria-label="${CLOSE_LABEL}"]') ?? null;`;

const frontBody = `return doc.querySelector('[data-slot="toast-viewport"] [role="dialog"]:not([data-ending-style]) [data-slot="toast-title"]');`;

/** 展开后按屏幕从上到下点每条的 × 一次，看它是否消失 */
async function caseExpanded(cdp) {
  await pushNotices(cdp, ['Swarm', 'Telegram Bot']);
  await sleep(600);
  const body = await locate(cdp, frontBody);
  if (body) await tap(cdp, body);
  await sleep(800);
  const shown = await toasts(cdp);
  const taps = [];
  for (let i = 0; i < shown.length; i++) {
    const current = await toasts(cdp);
    const points = [];
    for (const { title } of current) {
      const button = await locate(cdp, closeButtonOf(title));
      if (button) points.push({ title, button });
    }
    points.sort((a, b) => a.button.y - b.button.y);
    const top = points[0];
    if (!top) break;
    await tap(cdp, top.button);
    await sleep(1200);
    if (i === 0 && SHOT) await cdp.shot(SHOT);
    const after = await toasts(cdp);
    taps.push({ ...top, closed: !after.some((t) => t.title === top.title), left: after.length });
    if (!taps.at(-1).closed) break;
  }
  return {
    expanded: shown.every((t) => t.expanded),
    taps,
    pass:
      shown.every((t) => t.expanded) && taps.length === shown.length && taps.every((t) => t.closed),
  };
}

/** 收起状态下点最前面那条的 ×，看它是否消失 */
async function caseClose(cdp) {
  await pushNotices(cdp, ['Swarm', 'Telegram Bot']);
  await sleep(600);
  const shown = await toasts(cdp);
  const taps = [];
  for (const { title } of shown) {
    const button = await locate(cdp, closeButtonOf(title));
    if (button) await tap(cdp, button);
    await sleep(1200);
    const after = await toasts(cdp);
    taps.push({ title, button, closed: !after.some((t) => t.title === title), left: after.length });
  }
  const left = await toastNodes(cdp);
  return {
    shown,
    taps,
    domLeft: left,
    pass: taps.every((t) => t.button && t.closed) && left === 0,
  };
}

/** 手指没落在 16px 图标上：点 × 中心左侧 12px */
async function caseEdge(cdp) {
  const [notice] = await pushNotices(cdp, ['Swarm']);
  await sleep(600);
  const title = (await toasts(cdp))[0]?.title;
  const button = await locate(cdp, closeButtonOf(title));
  if (button) await tap(cdp, { x: button.x - 12, y: button.y });
  await sleep(1200);
  const left = await toasts(cdp);
  return { notice: notice.name, button, left, pass: !!button && left.length === 0 };
}

/** 不碰 toast，按超时自动消失 */
async function caseAuto(cdp) {
  await pushNotices(cdp, ['Swarm', 'Telegram Bot']);
  await sleep(SUCCESS_TIMEOUT + 2000);
  const left = await toasts(cdp);
  return { left, pass: left.length === 0 };
}

/** 点一下 toast 正文（不拖动），再点别处，之后仍按超时自动消失 */
async function caseTapped(cdp) {
  await pushNotices(cdp, ['Swarm', 'Telegram Bot']);
  await sleep(600);
  const body = await locate(cdp, frontBody);
  if (body) await tap(cdp, body);
  await sleep(400);
  await tap(cdp, { x: 195, y: 120 });
  await sleep(SUCCESS_TIMEOUT + 2000);
  const left = await toasts(cdp);
  return { body, left, pass: !!body && left.length === 0 };
}

/** 向右滑动关闭 */
async function caseSwipe(cdp) {
  await pushNotices(cdp, ['Swarm']);
  await sleep(600);
  const body = await locate(cdp, frontBody);
  if (body) await swipeRight(cdp, body);
  await sleep(1200);
  const left = await toasts(cdp);
  return { body, left, pass: !!body && left.length === 0 };
}

/** 点「查看」：toast 关掉并打开插件设置 */
async function caseView(cdp) {
  await pushNotices(cdp, ['Swarm']);
  await sleep(600);
  const button = await locate(
    cdp,
    `return [...doc.querySelectorAll('[data-slot="toast-viewport"] [data-slot="toast-action"]')].find((b) => b.textContent === '查看') ?? null;`
  );
  if (button) await tap(cdp, button);
  await sleep(1500);
  const left = await toasts(cdp);
  const settings = await frame(
    cdp,
    `return !!doc.querySelector('[data-enso="settings-content"]');`
  );
  // 回到工作台，留给后续用例
  await frame(cdp, `doc.querySelector('[data-enso="settings-back"]')?.click(); return true;`);
  await sleep(600);
  return { button, left, settings, pass: !!button && left.length === 0 && settings };
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
  const results = {};
  for (const [name, run] of [
    ['expanded', caseExpanded],
    ['close', caseClose],
    ['edge', caseEdge],
    ['auto', caseAuto],
    ['tapped', caseTapped],
    ['swipe', caseSwipe],
    ['view', caseView],
  ]) {
    try {
      results[name] = await run(cdp);
    } catch (error) {
      results[name] = { error: String(error?.message ?? error), pass: false };
    }
    log(`RESULT ${name} ${JSON.stringify(results[name])}`);
    await clearToasts(cdp);
  }
  const ok = Object.values(results).every((r) => r.pass);
  log(ok ? 'PASS' : 'FAIL');
  shutdown(ok ? 0 : 1);
}

process.on('SIGINT', () => shutdown(130));
main().catch((error) => {
  console.error(error);
  shutdown(1);
});
