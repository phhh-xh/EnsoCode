/**
 * 触屏边缘滑动开合左右侧栏的纯状态机：左缘右滑开左抽屉、右缘左滑开右侧面板，反向滑动关闭。
 * 只算意图、跟手进度（0 关 ~ 1 开）与松手结论；事件监听和动画在 useEdgeSwipe。
 */

/** 起手判定区：距屏幕左/右边缘的像素 */
export const EDGE_SWIPE_EDGE_PX = 20;
/** 横向认领阈值；须小于 dnd-kit PointerSensor 的 6px 激活距离，手势先于拖拽排序判定 */
export const EDGE_SWIPE_SLOP_PX = 5;
/** 甩动速度阈值（px/ms，约 300px/s），超过即按方向决定开合，不看位置 */
export const EDGE_SWIPE_VELOCITY = 0.3;
/** 慢速松手时按进度过半决定开合 */
export const EDGE_SWIPE_SETTLE_RATIO = 0.5;
/** 松手速度取最后这段时间内的采样 */
export const EDGE_SWIPE_VELOCITY_WINDOW_MS = 100;
/** 抽屉收起时平移到自身宽度的 -105%，按这个比例换算才与手指严格同步 */
export const DRAWER_HIDDEN_RATIO = 1.05;

export type SwipePanel = 'left' | 'right';
export type SwipeIntent = { panel: SwipePanel; mode: 'open' | 'close' };
type SwipeSample = { t: number; x: number };

export type SwipeState =
  | { phase: 'idle' }
  | { phase: 'pending'; intent: SwipeIntent; x0: number; y0: number; size: number }
  | {
      phase: 'dragging';
      intent: SwipeIntent;
      x0: number;
      size: number;
      progress: number;
      samples: SwipeSample[];
    };

export type SwipeContext = {
  viewportWidth: number;
  leftOpen: boolean;
  rightOpen: boolean;
  /** 右侧面板依附当前会话，没有会话时开不了 */
  canOpenRight: boolean;
  /** 左抽屉宽度（px） */
  leftWidth: number;
};

/** 手势结束后面板应停在的状态；velocity 为进度单位/秒，交给弹簧作初速度 */
export type SwipeSettle = { panel: SwipePanel; open: boolean; velocity: number };

export const IDLE_SWIPE: SwipeState = { phase: 'idle' };

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function openDirection(panel: SwipePanel): 1 | -1 {
  return panel === 'left' ? 1 : -1;
}

export function resolveSwipeIntent(
  input: { x: number } & Omit<SwipeContext, 'leftWidth'>
): SwipeIntent | null {
  const { x, viewportWidth } = input;
  // 抽屉 + 遮罩铺满全屏：任意位置都能往回滑
  if (input.leftOpen) return { panel: 'left', mode: 'close' };
  // 面板全屏盖住聊天：同 iOS 返回，只认左缘
  if (input.rightOpen) return x <= EDGE_SWIPE_EDGE_PX ? { panel: 'right', mode: 'close' } : null;
  if (x <= EDGE_SWIPE_EDGE_PX) return { panel: 'left', mode: 'open' };
  if (x >= viewportWidth - EDGE_SWIPE_EDGE_PX && input.canOpenRight) {
    return { panel: 'right', mode: 'open' };
  }
  return null;
}

export function classifyMove(
  intent: SwipeIntent,
  dx: number,
  dy: number
): 'pending' | 'claim' | 'reject' {
  // 竖向为主：放行给页面滚动
  if (Math.abs(dy) > Math.abs(dx)) return 'reject';
  if (Math.abs(dx) < EDGE_SWIPE_SLOP_PX) return 'pending';
  const toward = dx * openDirection(intent.panel);
  const rightWay = intent.mode === 'open' ? toward > 0 : toward < 0;
  return rightWay ? 'claim' : 'reject';
}

export function swipeProgress(intent: SwipeIntent, dx: number, size: number): number {
  const start = intent.mode === 'open' ? 0 : 1;
  return clamp01(start + (openDirection(intent.panel) * dx) / size);
}

/**
 * 松手前最后一段移动的横向速度（px/ms）。窗口以最后一个采样为终点而不是以松手时刻：
 * 主线程忙时 touchmove 会被合并、间隔拉长，按松手时刻截窗会只剩一个采样，甩动被误判成静止。
 * 手指停住超过一个窗口再松手才算静止。
 */
export function swipeVelocity(samples: readonly SwipeSample[], now: number): number {
  const last = samples[samples.length - 1];
  if (!last || now - last.t > EDGE_SWIPE_VELOCITY_WINDOW_MS) return 0;
  const recent = samples.filter((s) => s.t >= last.t - EDGE_SWIPE_VELOCITY_WINDOW_MS);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/** 先看甩动方向，再看位置 */
export function settleSwipe(intent: SwipeIntent, progress: number, vx: number): boolean {
  const vOpen = vx * openDirection(intent.panel);
  if (vOpen > EDGE_SWIPE_VELOCITY) return true;
  if (vOpen < -EDGE_SWIPE_VELOCITY) return false;
  return progress >= EDGE_SWIPE_SETTLE_RATIO;
}

export function beginSwipe(ctx: SwipeContext, x: number, y: number): SwipeState {
  const intent = resolveSwipeIntent({ ...ctx, x });
  if (!intent) return IDLE_SWIPE;
  const size = intent.panel === 'left' ? ctx.leftWidth * DRAWER_HIDDEN_RATIO : ctx.viewportWidth;
  if (!(size > 0)) return IDLE_SWIPE;
  return { phase: 'pending', intent, x0: x, y0: y, size };
}

export function moveSwipe(state: SwipeState, x: number, y: number, t: number): SwipeState {
  switch (state.phase) {
    case 'idle':
      return state;
    case 'pending': {
      const verdict = classifyMove(state.intent, x - state.x0, y - state.y0);
      if (verdict === 'pending') return state;
      if (verdict === 'reject') return IDLE_SWIPE;
      return {
        phase: 'dragging',
        intent: state.intent,
        x0: state.x0,
        size: state.size,
        progress: swipeProgress(state.intent, x - state.x0, state.size),
        samples: [{ t, x }],
      };
    }
    case 'dragging':
      return {
        ...state,
        progress: swipeProgress(state.intent, x - state.x0, state.size),
        samples: [
          ...state.samples.filter((s) => s.t >= t - EDGE_SWIPE_VELOCITY_WINDOW_MS),
          { t, x },
        ],
      };
  }
}

/** 松手：未认领（轻点、竖滑）返回 null，不动面板 */
export function releaseSwipe(state: SwipeState, t: number): SwipeSettle | null {
  if (state.phase !== 'dragging') return null;
  const vx = swipeVelocity(state.samples, t);
  return {
    panel: state.intent.panel,
    open: settleSwipe(state.intent, state.progress, vx),
    velocity: (openDirection(state.intent.panel) * vx * 1000) / state.size,
  };
}

/** touchcancel / 第二根手指：退回起手时的状态 */
export function cancelSwipe(state: SwipeState): SwipeSettle | null {
  if (state.phase !== 'dragging') return null;
  return { panel: state.intent.panel, open: state.intent.mode === 'close', velocity: 0 };
}
