import type { AppExitReason, RestartOverlayState } from '@shared/types/ipc';
import { create } from 'zustand';

// 进入等待时直接收成小条的路径：安装更新多由横幅 / 菜单 / 秘书 / 手机端随手触发，等待可能很久，不该拿模态挡住界面；
// 重启与退出是用户此刻要离开，弹层照旧
const STARTS_MINIMIZED: Record<AppExitReason, boolean> = {
  restart: false,
  update: true,
  quit: false,
};

interface RestartOverlayView {
  state: RestartOverlayState | null;
  // 关弹层的淡出期间文案保持关前那一态，不闪成别的
  shown: RestartOverlayState;
  forcing: boolean;
  minimized: boolean;
}

/** 弹层与最小化条共用的视图状态；最小化只在渲染端，Main 的等待与重启不受影响 */
export const useRestartOverlayStore = create<RestartOverlayView>(() => ({
  state: null,
  shown: { phase: 'restarting' },
  forcing: false,
  minimized: false,
}));

export function applyOverlay(next: RestartOverlayState | null, pushed: boolean): void {
  useRestartOverlayStore.setState((view) => {
    const prev = view.state;
    // 同一路径等待中重推（会话列表变化）保留用户的展开 / 收起；新进入等待按路径取默认；
    // 进入正在重启 / 恢复或关掉时回到全屏
    const sameWait =
      prev?.phase === 'waiting' && next?.phase === 'waiting' && prev.exit === next.exit;
    return {
      state: next,
      shown: next ?? view.shown,
      forcing: pushed ? false : view.forcing,
      minimized:
        next?.phase === 'waiting' && (sameWait ? view.minimized : STARTS_MINIMIZED[next.exit]),
    };
  });
}

export const setMinimized = (minimized: boolean) => useRestartOverlayStore.setState({ minimized });
