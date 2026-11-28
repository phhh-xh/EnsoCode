import { formatReminderClock, formatReminderTooltip } from '@shared/reminders';
import { type ContactBadge, sessionBadge } from '@shared/secretary/commands';
import type { PendingDispatch, SecretaryCard } from '@shared/types/secretary';
import { formatRetryClock } from '@shared/upstreamRecovery';
import { ArrowUpRight, Check, Clock, RotateCcw } from 'lucide-react';
import { HOVER_ROW_CLASS, HoverActions } from '@/components/ui/hover-actions';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { openSessionPeek } from '@/stores/sessionPeek';

type SessionCard = Extract<SecretaryCard, { kind: 'session' }>;

/**
 * 精简状态样式：只保留人一眼能看懂的短状态与指示点色。
 * 分支、模型、子代理细节与最后正文下沉到 SessionPeekDialog，不再铺在主列表上。
 */
const BADGE_STYLE: Record<ContactBadge, { label: string; dot: string; text: string }> = {
  failed: { label: 'Failed', dot: 'bg-destructive', text: 'text-destructive' },
  waiting: { label: 'Waiting for you', dot: 'bg-warning', text: 'text-warning' },
  running: { label: 'Running', dot: 'bg-success', text: 'text-muted-foreground' },
  background: {
    label: 'Waiting on a background task',
    dot: 'bg-warning',
    text: 'text-muted-foreground',
  },
  reminder: {
    label: 'Waiting for reminder',
    dot: 'bg-sky-500',
    text: 'text-sky-600 dark:text-sky-400',
  },
  persistent: { label: 'Service running', dot: 'bg-warning', text: 'text-muted-foreground' },
  subagent: { label: 'Waiting on subagent', dot: 'bg-success', text: 'text-muted-foreground' },
  continuing: { label: 'Continuing', dot: 'bg-success', text: 'text-muted-foreground' },
  interrupted: { label: 'Interrupted', dot: 'bg-warning', text: 'text-warning' },
  stalled: { label: 'Stalled, no activity', dot: 'bg-destructive', text: 'text-destructive' },
  idle: { label: 'Idle', dot: 'bg-subtle-foreground', text: 'text-muted-foreground' },
};

function badgeOf(card: SessionCard): { label: string; dot: string; text: string } {
  return BADGE_STYLE[sessionBadge({ ...card, stalled: card.stalled !== undefined })];
}

/** 极简进行中行：状态圆点 + 标题 + 项目·短状态；整行点击打开 SessionPeek 查看详情 */
function RunningRow({ card }: { card: SessionCard }) {
  const { t } = useI18n();
  const badge = badgeOf(card);
  const upstreamRetry = card.upstreamRetry;
  const upstreamLabel = upstreamRetry
    ? upstreamRetry.kind === 'quota'
      ? t('Quota exhausted · next {{time}}', { time: formatRetryClock(upstreamRetry.at) })
      : t('Waiting for upstream recovery · next {{time}}', {
          time: formatRetryClock(upstreamRetry.at),
        })
    : null;
  const queuedLabel =
    card.state === 'queued'
      ? card.queueFailed
        ? `${t('Queued')} · ${card.queueFailed}`
        : card.queuePosition
          ? t('Queued · #{{n}}', { n: card.queuePosition })
          : t('Queued')
      : null;
  const reminder = !upstreamLabel && !queuedLabel ? card.pendingReminder : undefined;
  const reminderLabel = reminder
    ? t('Waiting for reminder · {{time}}', { time: formatReminderClock(reminder.dueAt) })
    : null;
  const reminderTooltip = reminder ? formatReminderTooltip(reminder, Date.now(), t) : undefined;

  const dotClass = upstreamLabel
    ? 'bg-amber-500'
    : queuedLabel
      ? 'bg-orange-500'
      : reminderLabel
        ? 'bg-sky-500'
        : badge.dot;

  const statusTextClass = upstreamLabel
    ? 'text-amber-600 dark:text-amber-400'
    : queuedLabel
      ? 'text-orange-600'
      : reminderLabel
        ? 'inline-flex items-center gap-1 text-sky-600 tabular-nums dark:text-sky-400'
        : badge.text;

  return (
    <div
      data-enso="secretary-running-row"
      data-conversation={card.conversationId}
      className={cn(HOVER_ROW_CLASS, 'flex items-center gap-2 rounded-lg px-2 py-1.5')}
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', dotClass)} />
      <button
        type="button"
        data-enso="secretary-running-open"
        onClick={() => openSessionPeek(card.conversationId)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate text-[13px] text-foreground">
          {card.title || t('Unnamed')}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11.5px] text-muted-foreground">
          {card.projectName && <span className="shrink-0 truncate">{card.projectName}</span>}
          {card.projectName && <span aria-hidden>·</span>}
          <span
            data-enso={
              upstreamLabel
                ? 'secretary-upstream-waiting'
                : queuedLabel
                  ? 'secretary-queued-card'
                  : reminderLabel
                    ? 'secretary-reminder-waiting'
                    : 'secretary-running-badge'
            }
            title={reminderTooltip}
            className={cn('min-w-0 truncate', statusTextClass)}
          >
            {reminderLabel && (
              <Clock className="inline size-2.5 shrink-0 align-[-1px]" aria-hidden />
            )}
            {upstreamLabel ?? queuedLabel ?? reminderLabel ?? t(badge.label)}
          </span>
          {card.takeover && (
            <>
              <span aria-hidden>·</span>
              <span data-enso="secretary-running-takeover" className="shrink-0 text-primary">
                {t('Taken over')}
              </span>
            </>
          )}
        </span>
      </button>
      <HoverActions>
        {upstreamRetry && (
          <button
            type="button"
            data-enso="secretary-upstream-retry-now"
            title={t('Retry now')}
            aria-label={t('Retry now')}
            onClick={(event) => {
              event.stopPropagation();
              void window.electronAPI.agent.retryUpstreamNow?.(card.conversationId);
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-amber-600 transition-colors hover:bg-amber-500/15 dark:text-amber-400"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          data-enso="secretary-running-mark-done"
          title={t('Mark done')}
          aria-label={t('Mark done')}
          onClick={(event) => {
            event.stopPropagation();
            void window.electronAPI.secretary.markResult(card.conversationId, 'done');
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-success/10 hover:text-success"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={t('Open session')}
          aria-label={t('Open session')}
          onClick={(event) => {
            event.stopPropagation();
            openSessionPeek(card.conversationId);
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
      </HoverActions>
    </div>
  );
}

/** 等依赖的派发：极简一行，只报标题 + 项目·等待依赖 */
function PendingRow({ pending, projectName }: { pending: PendingDispatch; projectName: string }) {
  const { t } = useI18n();
  const title = pending.draft.title?.trim() || pending.draft.prompt.split('\n')[0]?.trim() || '';
  return (
    <div
      data-enso="secretary-running-pending"
      data-pending={pending.id}
      className="flex items-center gap-2 rounded-lg px-2 py-1.5"
    >
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{title || t('Unnamed')}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11.5px] text-muted-foreground">
          <span className="shrink-0 truncate">{projectName || pending.projectId}</span>
          <span aria-hidden>·</span>
          <span data-enso="secretary-running-badge" className="truncate text-warning">
            {t('Waiting for dependencies')}
          </span>
        </span>
      </div>
    </div>
  );
}

/** 进行中的每一行：会话卡和等依赖的派发 */
export function RunningCards({ running }: { running: readonly SecretaryCard[] }) {
  return running.map((card) =>
    card.kind === 'session' ? (
      <RunningRow key={card.conversationId} card={card} />
    ) : card.kind === 'pending' ? (
      <PendingRow key={card.pending.id} pending={card.pending} projectName={card.projectName} />
    ) : null
  );
}

/** 进行中列表组件（保留独立导出供调用与测试） */
export function SecretaryRunningList({ secretaryId }: { secretaryId?: string } = {}) {
  const { t } = useI18n();
  const running = useSecretaryStore(
    (state) =>
      (secretaryId
        ? (state.states[secretaryId] ??
          (state.focusedId === secretaryId ? state.secretary : undefined))
        : state.secretary
      )?.board.running ?? []
  );
  return (
    <section data-enso="secretary-running" className="flex flex-col px-3 pt-2">
      <h3 className="px-1.5 pb-1 text-[12px] text-subtle-foreground">
        {t('In progress')}
        <span className="ml-1 tabular-nums">{running.length}</span>
      </h3>
      {running.length === 0 ? (
        <p
          data-enso="secretary-running-empty"
          className="px-1.5 py-1 text-[12px] text-muted-foreground"
        >
          {t('Nothing running')}
        </p>
      ) : (
        <RunningCards running={running} />
      )}
    </section>
  );
}
