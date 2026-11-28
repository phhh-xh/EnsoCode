import { conversationHasRunningChild } from '@shared/conversationDotTone';
import { hasPendingReminder } from '@shared/reminders';
import { queuedStartOf } from '@shared/secretary/queuedSession';
import type { PairCatalogPayload, PairCreatedSession } from '@shared/types/pair';
import { type GoalUpstreamRetry, isUpstreamWaitingGoal } from '@shared/upstreamRecovery';

type CatalogEntry = PairCatalogPayload['catalog'][number];

export function patchCatalogEntry(
  catalog: CatalogEntry[],
  sessionId: string,
  patch: Partial<CatalogEntry>
): CatalogEntry[] {
  return catalog.map((entry) => (entry.id === sessionId ? { ...entry, ...patch } : entry));
}

export function upsertCatalogEntry(catalog: CatalogEntry[], entry: CatalogEntry): CatalogEntry[] {
  const index = catalog.findIndex((candidate) => candidate.id === entry.id);
  if (index < 0) return [entry, ...catalog];
  const next = catalog.slice();
  next[index] = { ...catalog[index], ...entry };
  return next;
}

export function catalogEntryFromPairSession(
  session: PairCreatedSession,
  projectName: string
): CatalogEntry {
  return {
    id: session.sessionId,
    title: '',
    projectName,
    projectId: session.projectId,
    status: 'idle',
    updatedAt: Date.now(),
    providerId: session.providerId,
    modelId: session.modelId,
    reasoningEnabled: session.reasoningEnabled,
    ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
  };
}

export function catalogQueued(
  queued: { id: string; text: string; images?: unknown[] }[] | undefined
): CatalogEntry['queued'] {
  if (!queued?.length) return undefined;
  return queued.map((item) => ({
    id: item.id,
    text: item.text,
    ...(item.images?.length ? { hasImages: true as const } : {}),
  }));
}

/** 带 queuedStart 的目录行是 queued。失败不改 status，原因放 queueFailed，旧客户端仍能显示。 */
export function catalogQueueOverride(
  row: unknown,
  position: number | undefined
):
  | { status: 'queued'; queuePosition: number }
  | { status: 'queued'; queueFailed: string }
  | undefined {
  const queued = queuedStartOf(row);
  if (!queued) return undefined;
  if (queued.failed) return { status: 'queued', queueFailed: queued.failed.error };
  return { status: 'queued', queuePosition: position ?? 1 };
}

/** 空闲挂起原因：等上游恢复优先（与桌面侧栏图标同序），其次未到点提醒；运行中不标 */
export function catalogParked(
  row: {
    status?: string;
    spawning?: boolean;
    goal?: { status?: string; retry?: GoalUpstreamRetry };
  },
  reminders: readonly { dueAt: number }[] | undefined,
  now: number
): CatalogEntry['parked'] {
  if (row.status === 'running' || row.spawning) return undefined;
  if (isUpstreamWaitingGoal(row.goal)) return 'upstream';
  return reminders && hasPendingReminder(reminders, now) ? 'reminder' : undefined;
}

type ChildRunningRow = Parameters<typeof conversationHasRunningChild>[0] & object;

/**
 * 后台命令 / 子代理 / coworker 子会话还在跑（桌面侧栏 conversationHasRunningChild 同口径）。
 * 只有 true 才下发：手机据此把「回合已结束」判成等待后台任务而不是已完成。
 */
export function catalogBackgroundRunning(
  row: Omit<ChildRunningRow, 'status'> & { status?: string },
  conversations: Parameters<typeof conversationHasRunningChild>[1]
): true | undefined {
  return conversationHasRunningChild({ ...row, status: row.status ?? 'idle' }, conversations)
    ? true
    : undefined;
}
