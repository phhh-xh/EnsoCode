import { setThemeColor, toRgb } from '../themeColor';

/** desk.html 头部内联脚本按同一 key 在首帧前读出 */
export const DESK_CHROME_KEY = 'enso-desk-chrome';
const RGB = /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/;

export interface DeskChrome {
  top: string;
  bottom: string;
}

export const serializeDeskChrome = (chrome: DeskChrome): string => JSON.stringify(chrome);

export function parseDeskChrome(raw: string | null): DeskChrome | null {
  try {
    const value = JSON.parse(raw ?? '') as Partial<DeskChrome> | null;
    return value && RGB.test(value.top ?? '') && RGB.test(value.bottom ?? '')
      ? { top: value.top as string, bottom: value.bottom as string }
      : null;
  } catch {
    return null;
  }
}

function parseAlpha(token: string): number {
  const trimmed = token.trim();
  if (!trimmed) return Number.NaN;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value)) return Number.NaN;
  return trimmed.endsWith('%') ? value / 100 : value;
}

/**
 * 只有完全不透明（alpha === 1）的颜色才适合铺安全区底色：
 * 侧栏/弹窗遮罩（如 Tailwind v4 `bg-black/40` → `oklab(0 0 0 / 0.4)` 或 `rgba(0, 0, 0, 0.4)`）
 * 与壁纸半透明层都带 alpha < 1，不能当实底采样。
 */
export function isOpaqueColor(color: string): boolean {
  const raw = color.trim().toLowerCase();
  if (!raw || raw === 'transparent') return false;
  if (raw.startsWith('#')) {
    const hex = raw.slice(1);
    if (hex.length === 4) return hex[3] === 'f';
    if (hex.length === 8) return hex.slice(6) === 'ff';
    return hex.length === 3 || hex.length === 6;
  }
  const slash = raw.lastIndexOf('/');
  if (slash !== -1 && raw.endsWith(')')) {
    return parseAlpha(raw.slice(slash + 1, -1)) >= 1;
  }
  const legacy = /^(?:rgba|hsla)\(([^)]+)\)$/.exec(raw);
  if (legacy) {
    const parts = legacy[1].split(',');
    if (parts.length === 4) return parseAlpha(parts[3]) >= 1;
  }
  return true;
}

function isElementOpaque(view: Window, el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const opacity = view.getComputedStyle(cur).opacity;
    if (opacity !== '' && Number.parseFloat(opacity) < 1) return false;
  }
  return true;
}

export function edgeColor(doc: Document, y: number): string | null {
  const view = doc.defaultView;
  if (!view) return null;
  const x = view.innerWidth / 2;
  const stack: Element[] =
    typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(x, y) : [];
  const seen = new Set<Element>();
  const candidates: Element[] = [];
  const add = (el: Element | null) => {
    if (el && !seen.has(el)) {
      seen.add(el);
      candidates.push(el);
    }
  };
  for (const el of stack) add(el);
  for (let el: Element | null = stack[0] ?? doc.elementFromPoint(x, y); el; el = el.parentElement) {
    add(el);
  }
  for (const el of candidates) {
    const color = view.getComputedStyle(el).backgroundColor;
    if (!isOpaqueColor(color) || !isElementOpaque(view, el)) continue;
    const rgb = toRgb(color);
    if (isOpaqueColor(rgb)) return rgb;
  }
  return null;
}

/**
 * 安全区（状态栏、Home 条）由壳铺底：取当前可见 renderer 上下边缘的实际底色，
 * 主题、壁纸、终端配色变化后都能对上；不然就是两条写死的深色边。
 *
 * iOS 独立 PWA 的状态栏底色只在启动时采样页面顶边，之后改底色或 theme-color 都不重采
 * （见 big-question/ios-pwa-header-blur.md、手机版放弃主题热更新）。所以记下本次颜色，
 * 下次启动由 desk.html 在首帧前铺上。html 也要铺底：键盘弹起时页面上推，露出的是画布色。
 */
export function paintDeskChrome(iframe: HTMLIFrameElement | undefined): void {
  const doc = iframe?.contentDocument;
  const view = doc?.defaultView;
  if (!iframe || !doc?.body || !view) return;
  const fallback = view
    .getComputedStyle(doc.documentElement)
    .getPropertyValue('--background')
    .trim();
  const baseRaw = fallback ? toRgb(fallback) : null;
  const base = baseRaw && isOpaqueColor(baseRaw) ? baseRaw : null;
  const top = edgeColor(doc, 1) ?? base;
  const bottom = edgeColor(doc, view.innerHeight - 1) ?? base;
  if (!top || !bottom) return;
  document.documentElement.style.background = bottom;
  document.body.style.background = `linear-gradient(${top} 50%, ${bottom} 50%)`;
  if (base) iframe.style.background = base;
  setThemeColor(top);
  const chrome = serializeDeskChrome({ top, bottom });
  try {
    if (RGB.test(top) && RGB.test(bottom) && localStorage.getItem(DESK_CHROME_KEY) !== chrome)
      localStorage.setItem(DESK_CHROME_KEY, chrome);
  } catch {}
}

/** 帧文档在 Safari 首帧前可能还没有 html/body，DOM 类型没这么声明 */
export interface FrameChromeDoc {
  documentElement: Node | null;
  body: HTMLElement | null;
}

export interface FrameChromeBinding {
  observer: MutationObserver;
  /** body 比 documentElement 晚出现，补绑一次就够 */
  body: boolean;
}

/**
 * 给帧文档绑 MutationObserver。没有 documentElement 时先不绑（等下次 tick），
 * 否则 Safari 会因目标不是 Node 抛错，把整个启动流程打断。
 */
export function bindFrameChrome(
  doc: FrameChromeDoc,
  existing: FrameChromeBinding | undefined,
  onMutation: MutationCallback
): FrameChromeBinding | null {
  const root = doc.documentElement;
  if (!root) return existing ?? null;
  const bound =
    existing ??
    (() => {
      const observer = new MutationObserver(onMutation);
      observer.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
      return { observer, body: false };
    })();
  const body = doc.body;
  if (body && !bound.body) {
    bound.observer.observe(body, { childList: true });
    bound.body = true;
  }
  return bound;
}

/** 主题切换改 html 的 class/style；窗口尺寸与抽屉开合改边缘元素：合并到下一帧重取 */
export function watchDeskChrome(current: () => HTMLIFrameElement | undefined): () => void {
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paintDeskChrome(current());
    });
  };
  const binding = new Map<Document, FrameChromeBinding>();
  const observe = () => {
    const doc = current()?.contentDocument;
    if (!doc) return;
    const bound = bindFrameChrome(doc, binding.get(doc), schedule);
    if (bound) binding.set(doc, bound);
  };
  const tick = () => {
    observe();
    schedule();
  };
  window.addEventListener('resize', tick);
  document.addEventListener('visibilitychange', tick);
  // 抽屉、弹层开合不一定改 html 属性；低频兜底
  const timer = setInterval(tick, 2000);
  tick();
  return () => {
    window.removeEventListener('resize', tick);
    document.removeEventListener('visibilitychange', tick);
    clearInterval(timer);
    for (const bound of binding.values()) bound.observer.disconnect();
  };
}
