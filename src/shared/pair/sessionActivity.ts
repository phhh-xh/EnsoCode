import { conversationDotTone } from '@shared/conversationDotTone';

/**
 * 手机 / iOS 各出口（抽屉、小组件、灵动岛、画中画）共用的会话活跃态。
 * 判定与桌面侧栏圆点同源（conversationDotTone），只把桌面的 running 拆成两档：
 * 自身回合在跑是 running；回合已结束但后台命令 / 子代理 / coworker 还在跑是 background（等待后台任务）。
 * 待审批与待回答一样算 waiting（与桌面 Dock 角标同口径）。
 */
export type PairSessionActivity =
  | 'running'
  | 'background'
  | 'waiting'
  | 'reminder'
  | 'queued'
  | 'failed'
  | 'unread'
  | 'idle';

export interface PairActivityEntry {
  status: string;
  unread?: boolean;
  pendingAskCount?: number;
  pendingApprovalCount?: number;
  queueFailed?: string;
  parked?: 'reminder' | 'upstream';
  /** 桌面按 conversationHasRunningChild 算好下发；旧桌面缺省 */
  backgroundRunning?: boolean;
}

/** childRunning：调用方另知的子活（目录里 coworker 子会话在跑、订阅会话视图里的任务），兼容旧桌面 */
export function pairSessionActivity(
  entry: PairActivityEntry,
  childRunning = false
): PairSessionActivity {
  const tone = conversationDotTone({
    status: entry.queueFailed ? 'failed' : entry.status,
    unread: entry.unread,
    pendingAskCount: (entry.pendingAskCount ?? 0) + (entry.pendingApprovalCount ?? 0),
    hasRunningChild: entry.backgroundRunning === true || childRunning,
    queued: (entry.status === 'queued' && !entry.queueFailed) || entry.parked === 'upstream',
    hasPendingReminder: entry.parked === 'reminder',
  });
  return tone === 'running' && entry.status !== 'running' ? 'background' : tone;
}

/** 灵动岛 / 实时活动该留着的态：还在干活或在等你 */
export function activityKeepsLive(activity: PairSessionActivity): boolean {
  return activity === 'running' || activity === 'background' || activity === 'waiting';
}

/**
 * 旧桌面不发 backgroundRunning：用目录里 coworker 子会话的运行态补上父会话。
 * 新桌面已按完整口径算好（含后台命令与子代理），true 原样保留。
 */
export function withChildBackground<
  T extends { id: string; parentId?: string; status: string; backgroundRunning?: boolean },
>(catalog: readonly T[]): T[] {
  const parents = new Set(
    catalog.filter((c) => c.parentId && c.status === 'running').map((c) => c.parentId)
  );
  return catalog.map((c) =>
    c.backgroundRunning !== true && parents.has(c.id) ? { ...c, backgroundRunning: true } : c
  );
}

/**
 * Main 侧：会话树里是否还有活（子代理 / coworker 在跑或在等你、后台命令在跑）。
 * treeState 是 SessionStateTracker 对整棵树的汇总；回合结束时根会话自身已先报 idle。
 */
export function treeWorkRunning(treeState: string, tasks: readonly { status: string }[]): boolean {
  return (
    treeState === 'running' || treeState === 'waiting' || tasks.some((t) => t.status === 'running')
  );
}
