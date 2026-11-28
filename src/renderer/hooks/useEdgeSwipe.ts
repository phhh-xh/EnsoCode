import { animate, type MotionValue, type Transition } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import {
  beginSwipe,
  cancelSwipe,
  IDLE_SWIPE,
  moveSwipe,
  releaseSwipe,
  type SwipePanel,
  type SwipeSettle,
  type SwipeState,
} from '@/lib/edgeSwipe';
import { springStandard } from '@/lib/motion';

const animTargets = new WeakMap<MotionValue<number>, number>();

/**
 * 把开合进度推向目标值。已在朝同一目标动画时不重启：
 * 手势松手启动的弹簧带着手指初速度，随后的状态 effect 不能把它打断重来。
 */
export function settleProgress(
  progress: MotionValue<number>,
  target: number,
  transition: Transition
): void {
  const settled = progress.isAnimating()
    ? animTargets.get(progress) === target
    : progress.get() === target;
  if (settled) return;
  animTargets.set(progress, target);
  animate(progress, target, transition);
}

// 这些浮层打开时手势让位给它们
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

function overlayOpen(): boolean {
  for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
    if (el.closest('[data-enso="mobile-drawer"]')) continue;
    if (el.getClientRects().length > 0) return true;
  }
  return false;
}

function selectingText(): boolean {
  const selection = document.getSelection();
  return Boolean(selection && !selection.isCollapsed);
}

function blurEditable(): void {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable) {
    el.blur();
  }
}

export type EdgeSwipeOptions = {
  enabled: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  canOpenRight: boolean;
  leftWidth: number;
  leftProgress: MotionValue<number>;
  rightProgress: MotionValue<number>;
  /** 手势让面板开合状态变化时调用（与当前状态相同时不调） */
  onSettle: (panel: SwipePanel, open: boolean) => void;
};

/**
 * 触屏边缘滑动跟手开合左右侧栏。拖动中直接写进度 MotionValue，不触发 React 渲染；
 * 返回正在拖动的面板，只在认领和松手时变化。
 */
export function useEdgeSwipe(options: EdgeSwipeOptions): SwipePanel | null {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [dragging, setDragging] = useState<SwipePanel | null>(null);
  const { enabled } = options;

  useEffect(() => {
    if (!enabled) return;
    let state: SwipeState = IDLE_SWIPE;
    const progressOf = (panel: SwipePanel) =>
      panel === 'left' ? optionsRef.current.leftProgress : optionsRef.current.rightProgress;

    const finish = (settle: SwipeSettle | null) => {
      state = IDLE_SWIPE;
      if (!settle) return;
      setDragging(null);
      settleProgress(progressOf(settle.panel), settle.open ? 1 : 0, {
        ...springStandard,
        velocity: settle.velocity,
      });
      if (settle.open) blurEditable();
      const opts = optionsRef.current;
      const current = settle.panel === 'left' ? opts.leftOpen : opts.rightOpen;
      if (settle.open !== current) opts.onSettle(settle.panel, settle.open);
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        finish(cancelSwipe(state));
        return;
      }
      state = IDLE_SWIPE;
      if (overlayOpen() || selectingText()) return;
      const touch = e.touches[0];
      const opts = optionsRef.current;
      state = beginSwipe(
        {
          viewportWidth: window.innerWidth,
          leftOpen: opts.leftOpen,
          rightOpen: opts.rightOpen,
          canOpenRight: opts.canOpenRight,
          leftWidth: opts.leftWidth,
        },
        touch.clientX,
        touch.clientY
      );
    };

    const onMove = (e: TouchEvent) => {
      if (state.phase === 'idle') return;
      if (e.touches.length !== 1) {
        finish(cancelSwipe(state));
        return;
      }
      const touch = e.touches[0];
      const wasPending = state.phase === 'pending';
      state = moveSwipe(state, touch.clientX, touch.clientY, e.timeStamp);
      if (state.phase === 'idle') return;
      // 待定也拦：不让页面内横向滚动抢先起步
      if (e.cancelable) e.preventDefault();
      if (state.phase !== 'dragging') return;
      const progress = progressOf(state.intent.panel);
      if (wasPending) {
        progress.stop();
        setDragging(state.intent.panel);
      }
      progress.set(state.progress);
    };

    const onEnd = (e: TouchEvent) => finish(releaseSwipe(state, e.timeStamp));
    const onCancel = () => finish(cancelSwipe(state));
    // dnd-kit 的 PointerSensor 在 document 上监听：手势待定/拖动中截住触摸 pointermove，免得会话行被拖起来排序
    const onPointerMove = (e: PointerEvent) => {
      if (state.phase !== 'idle' && e.pointerType === 'touch') e.stopImmediatePropagation();
    };

    const opts: AddEventListenerOptions = { passive: false, capture: true };
    window.addEventListener('touchstart', onStart, opts);
    window.addEventListener('touchmove', onMove, opts);
    window.addEventListener('touchend', onEnd, opts);
    window.addEventListener('touchcancel', onCancel, opts);
    window.addEventListener('pointermove', onPointerMove, true);
    return () => {
      window.removeEventListener('touchstart', onStart, opts);
      window.removeEventListener('touchmove', onMove, opts);
      window.removeEventListener('touchend', onEnd, opts);
      window.removeEventListener('touchcancel', onCancel, opts);
      window.removeEventListener('pointermove', onPointerMove, true);
      finish(cancelSwipe(state));
    };
  }, [enabled]);

  return dragging;
}
