import { describe, expect, it } from 'vitest';
import {
  beginSwipe,
  cancelSwipe,
  classifyMove,
  EDGE_SWIPE_SLOP_PX,
  moveSwipe,
  releaseSwipe,
  resolveSwipeIntent,
  type SwipeContext,
  type SwipeState,
} from './edgeSwipe';

const VW = 400;
const DRAWER = 300;
const closed: SwipeContext = {
  viewportWidth: VW,
  leftOpen: false,
  rightOpen: false,
  canOpenRight: true,
  leftWidth: DRAWER,
};

type Point = [t: number, x: number, y?: number];

/** 从 (x0, 100) 起手，按 [t, x, y] 依次移动 */
function drag(ctx: SwipeContext, x0: number, points: Point[]): SwipeState {
  let state = beginSwipe(ctx, x0, 100);
  for (const [t, x, y = 100] of points) state = moveSwipe(state, x, y, t);
  return state;
}

function progressOf(state: SwipeState): number | null {
  return state.phase === 'dragging' ? state.progress : null;
}

describe('resolveSwipeIntent 起手区', () => {
  it('左缘 20px 内开左抽屉，21px 起不认', () => {
    for (const x of [0, 19, 20]) {
      expect(resolveSwipeIntent({ ...closed, x })).toEqual({ panel: 'left', mode: 'open' });
    }
    expect(resolveSwipeIntent({ ...closed, x: 21 })).toBeNull();
  });

  it('右缘 20px 内开右侧面板，距右缘 21px 不认', () => {
    for (const x of [VW, VW - 19, VW - 20]) {
      expect(resolveSwipeIntent({ ...closed, x })).toEqual({ panel: 'right', mode: 'open' });
    }
    expect(resolveSwipeIntent({ ...closed, x: VW - 21 })).toBeNull();
  });

  it('没有当前会话时右缘不开面板，左缘照常', () => {
    const noConversation = { ...closed, canOpenRight: false };
    expect(resolveSwipeIntent({ ...noConversation, x: VW - 5 })).toBeNull();
    expect(resolveSwipeIntent({ ...noConversation, x: 5 })).toEqual({
      panel: 'left',
      mode: 'open',
    });
  });

  it('左抽屉开着时任意位置都是关抽屉', () => {
    const leftOpen = { ...closed, leftOpen: true };
    for (const x of [0, 150, VW - 5]) {
      expect(resolveSwipeIntent({ ...leftOpen, x })).toEqual({ panel: 'left', mode: 'close' });
    }
  });

  it('右侧面板开着时只有左缘能关它，右缘和中间不认', () => {
    const rightOpen = { ...closed, rightOpen: true };
    expect(resolveSwipeIntent({ ...rightOpen, x: 20 })).toEqual({ panel: 'right', mode: 'close' });
    expect(resolveSwipeIntent({ ...rightOpen, x: 21 })).toBeNull();
    expect(resolveSwipeIntent({ ...rightOpen, x: VW - 5 })).toBeNull();
  });
});

describe('classifyMove 认领', () => {
  const openLeft = { panel: 'left', mode: 'open' } as const;

  it('首次移动竖向为主即放行滚动', () => {
    expect(classifyMove(openLeft, 1, 2)).toBe('reject');
    expect(drag(closed, 5, [[0, 8, 110]]).phase).toBe('idle');
  });

  it('不足 5px 保持待定，达到 5px 认领', () => {
    expect(EDGE_SWIPE_SLOP_PX).toBe(5);
    expect(drag(closed, 5, [[0, 9]]).phase).toBe('pending');
    expect(drag(closed, 5, [[0, 10]]).phase).toBe('dragging');
  });

  it('反方向越过阈值即放弃（不劫持页面内横向滚动）', () => {
    // 左缘起手却往左划
    expect(drag(closed, 15, [[0, 10]]).phase).toBe('idle');
    // 右缘起手却往右划
    expect(drag(closed, VW - 15, [[0, VW - 10]]).phase).toBe('idle');
    // 抽屉开着往右划
    expect(drag({ ...closed, leftOpen: true }, 100, [[0, 110]]).phase).toBe('idle');
    // 面板开着从左缘往左划
    expect(drag({ ...closed, rightOpen: true }, 15, [[0, 5]]).phase).toBe('idle');
  });

  it('起手区外不进入手势', () => {
    expect(beginSwipe(closed, 200, 100).phase).toBe('idle');
  });
});

describe('跟手进度', () => {
  it('开左抽屉：按抽屉宽 ×1.05 换算并夹在 0..1', () => {
    expect(progressOf(drag(closed, 0, [[0, 157.5]]))).toBeCloseTo(0.5);
    expect(progressOf(drag(closed, 0, [[0, 400]]))).toBe(1);
    expect(
      progressOf(
        drag(closed, 0, [
          [0, 63],
          [16, -50],
        ])
      )
    ).toBe(0);
  });

  it('关左抽屉：从 1 往回减', () => {
    const open = { ...closed, leftOpen: true };
    expect(progressOf(drag(open, 300, [[0, 300 - 63]]))).toBeCloseTo(0.8);
    expect(
      progressOf(
        drag(open, 300, [
          [0, 290],
          [16, 360],
        ])
      )
    ).toBe(1);
  });

  it('开右侧面板：按视口宽换算', () => {
    expect(progressOf(drag(closed, VW, [[0, VW - 100]]))).toBeCloseTo(0.25);
    expect(
      progressOf(
        drag(closed, VW, [
          [0, VW - 10],
          [16, -100],
        ])
      )
    ).toBe(1);
  });

  it('关右侧面板：从左缘往右滑减少', () => {
    const open = { ...closed, rightOpen: true };
    expect(progressOf(drag(open, 0, [[0, 100]]))).toBeCloseTo(0.75);
    expect(
      progressOf(
        drag(open, 0, [
          [0, 10],
          [16, VW + 50],
        ])
      )
    ).toBe(0);
  });
});

describe('releaseSwipe 松手结论', () => {
  it('慢速松手按进度过半决定', () => {
    // 只到 0.3 停住 200ms 再松手：收回
    const short = drag(closed, 0, [
      [0, 30],
      [50, 94.5],
    ]);
    expect(releaseSwipe(short, 300)).toEqual({ panel: 'left', open: false, velocity: 0 });
    // 过半停住再松手：打开
    const long = drag(closed, 0, [
      [0, 30],
      [50, 200],
    ]);
    expect(releaseSwipe(long, 300)).toMatchObject({ panel: 'left', open: true });
  });

  it('快速甩向打开方向时，没过半也打开，并带上初速度', () => {
    // 最后 100ms 内 50px/50ms = 1px/ms，进度仅约 0.25
    const flick = drag(closed, 0, [
      [0, 30],
      [50, 80],
    ]);
    const settle = releaseSwipe(flick, 60);
    expect(settle).toMatchObject({ panel: 'left', open: true });
    expect(settle?.velocity).toBeCloseTo((1 * 1000) / (DRAWER * 1.05));
  });

  it('快速往回甩时，即使已过半也收回', () => {
    // 右侧面板拉过半后快速往右甩回
    const back = drag(closed, VW, [
      [0, VW - 350],
      [50, VW - 300],
      [80, VW - 270],
    ]);
    expect(progressOf(back)).toBeGreaterThan(0.5);
    const settle = releaseSwipe(back, 90);
    expect(settle).toMatchObject({ panel: 'right', open: false });
    expect(settle?.velocity).toBeLessThan(0);
  });

  it('关抽屉甩动同样优先于位置', () => {
    const open = { ...closed, leftOpen: true };
    const flickClose = drag(open, 300, [
      [0, 290],
      [40, 250],
    ]);
    expect(progressOf(flickClose)).toBeGreaterThan(0.5);
    expect(releaseSwipe(flickClose, 45)).toMatchObject({ panel: 'left', open: false });
  });

  it('touchmove 稀疏（主线程忙）时甩动仍按速度判定', () => {
    // 采样间隔约 50ms、末次移动到松手又隔 48ms：按松手时刻截窗只剩一个采样
    const sparse = drag(closed, 4, [
      [46, 34],
      [77, 49],
      [130, 64],
    ]);
    expect(progressOf(sparse)).toBeLessThan(0.5);
    expect(releaseSwipe(sparse, 178)).toMatchObject({ panel: 'left', open: true });
  });

  it('手指停住超过速度窗口再松手视为静止', () => {
    const rested = drag(closed, 4, [
      [0, 34],
      [30, 64],
    ]);
    expect(releaseSwipe(rested, 200)).toEqual({ panel: 'left', open: false, velocity: 0 });
  });

  it('未认领（轻点、竖滑）松手不动面板', () => {
    expect(releaseSwipe(beginSwipe(closed, 5, 100), 10)).toBeNull();
    expect(releaseSwipe(drag(closed, 5, [[0, 6, 140]]), 10)).toBeNull();
  });
});

describe('cancelSwipe', () => {
  it('拖动中取消退回起手时的状态', () => {
    expect(cancelSwipe(drag(closed, 0, [[0, 250]]))).toEqual({
      panel: 'left',
      open: false,
      velocity: 0,
    });
    expect(cancelSwipe(drag({ ...closed, rightOpen: true }, 0, [[0, 300]]))).toEqual({
      panel: 'right',
      open: true,
      velocity: 0,
    });
  });

  it('未认领时取消无事发生', () => {
    expect(cancelSwipe(beginSwipe(closed, 5, 100))).toBeNull();
  });
});
