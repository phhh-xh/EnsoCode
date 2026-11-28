import { formatReminderClock, formatReminderTooltip } from '@shared/reminders';
import { queuedStartOf, queuePositions } from '@shared/secretary/queuedSession';
import {
  NEEDS_YOU_RESULTS,
  type PendingDispatch,
  type SecretaryBoard,
  type SecretaryBoardTodo,
  type SecretaryTodoMutate,
  type TodoProblemCode,
} from '@shared/types/secretary';
import { formatRetryClock } from '@shared/upstreamRecovery';
import {
  ArrowUpRight,
  CheckCircle2,
  Coffee,
  Pencil,
  Plus,
  Send,
  ShieldAlert,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { QueuedSessionButtons } from '@/components/chat/QueuedSessionCard';
import { HOVER_ROW_CLASS, HoverActions } from '@/components/ui/hover-actions';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { openSessionFromSecretary } from '@/stores/secretaryReturn';
import { openSessionPeek } from '@/stores/sessionPeek';
import { useSessionsStore } from '@/stores/sessions';
import { DependencyNote } from './SecretaryDependencyLinks';
import { SecretaryFace } from './SecretaryFace';
import { SecretaryProposalRow } from './SecretaryProposalRow';
import { RunningCards } from './SecretaryRunningList';
import { type SecretarySessionCard, sessionFeed } from './secretaryDigest';
import { useSecretaryFace } from './useSecretaryFace';

function mutateTodo(request: SecretaryTodoMutate, secretaryId?: string): void {
  void window.electronAPI.secretary.mutateTodo(request, secretaryId);
}

const ACTION_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

const SESSION_STATE_LABEL = {
  running: 'Running',
  waiting: 'Waiting for you',
  idle: 'Idle',
  error: 'Failed',
  'not-started': 'Not started',
  gone: 'The session was deleted',
  queued: 'Queued',
} as const;

function todoStateText(
  todo: SecretaryBoardTodo,
  conversations: Record<string, unknown>,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  if (todo.pendingReminder) {
    return t('Waiting for reminder · {{time}}', {
      time: formatReminderClock(todo.pendingReminder.dueAt),
    });
  }
  if (!todo.sessionState) return '';
  if (todo.sessionState !== 'queued') return t(SESSION_STATE_LABEL[todo.sessionState]);
  const row = todo.conversationId ? conversations[todo.conversationId] : undefined;
  const failed = queuedStartOf(row)?.failed?.error;
  if (failed) return `${t('Queued')} · ${failed}`;
  const position = todo.conversationId
    ? queuePositions(conversations).get(todo.conversationId)
    : undefined;
  return position ? t('Queued · #{{n}}', { n: position }) : t('Queued');
}

const PROBLEM_LABEL: Record<TodoProblemCode, string> = {
  failed: 'The session failed',
  stopped: 'The session was stopped',
  deleted: 'The session was deleted',
};

const PENDING_PROBLEM_LABELS: Record<NonNullable<PendingDispatch['problem']>, string> = {
  'dependency-failed': 'A dependency failed',
  'dependency-stopped': 'A dependency was stopped',
  'dependency-deleted': 'A dependency was deleted',
  'dispatch-failed': 'The dispatch could not start',
  cancelled: 'The dispatch was cancelled',
};

/** 等依赖的派发出问题：没有会话可打开，只说明原因并可忽略 */
function PendingProblemCard({ pending }: { pending: PendingDispatch }) {
  const { t } = useI18n();
  const title = pending.draft.title?.trim() || pending.draft.prompt.split('\n')[0]?.trim() || '';
  return (
    <div
      data-enso="secretary-pending-problem"
      data-problem={pending.problem ?? 'dispatch-failed'}
      className="rounded-xl border border-warning/40 bg-warning/5 px-3 py-2.5"
    >
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-warning">
        <ShieldAlert className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {t(PENDING_PROBLEM_LABELS[pending.problem ?? 'dispatch-failed'])}
        </span>
      </div>
      <p className="mt-1 text-[13px] font-medium">{title}</p>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        <DependencyNote template="Waited for {{ids}}" ids={pending.after} />
      </p>
      {pending.status === 'failed' && (
        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            data-enso="secretary-dismiss-pending"
            onClick={() => void window.electronAPI.secretary.dismissPending(pending.id)}
            className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t('Ignore')}
          </button>
        </div>
      )}
    </div>
  );
}

/** 等你拍板的会话卡：只留标题、一句话摘要/待决项与直接动作，细节交由 Peek 或会话承载 */
function AttentionCard({ card }: { card: SecretarySessionCard }) {
  const { t, locale } = useI18n();
  const face = useSecretaryFace(card.conversationId);
  const approvals = useSessionsStore((s) => s.conversations[card.conversationId]?.pendingApprovals);
  const asks = useSessionsStore((s) => s.conversations[card.conversationId]?.pendingAsks);
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    setStopping(true);
    void window.electronAPI.agent
      .abort(card.conversationId, { stopSubagents: true, cancelReminders: true })
      .finally(() => setStopping(false));
  };
  // 实时审批与提问由会话状态决定，清结果不会让它消失，所以只在原因是结果时给「知道了」
  const dismissible =
    card.state !== 'waiting' &&
    card.result !== undefined &&
    (NEEDS_YOU_RESULTS.has(card.result) ||
      card.result === 'goal-complete' ||
      card.result === 'goal-blocked');
  const feed = sessionFeed(card);
  const decisionNeeds =
    card.state !== 'waiting' &&
    card.result === 'goal-complete' &&
    card.needsUser &&
    card.needsUser.length > 0
      ? card.needsUser
      : undefined;

  return (
    <div
      data-enso="secretary-card"
      data-kind="session"
      data-state={card.state}
      data-tone={decisionNeeds ? 'decision' : undefined}
      className={cn(
        'rounded-xl border px-3 py-2.5',
        decisionNeeds ? 'border-brand/30 bg-brand/[0.04]' : 'border-warning/40 bg-warning/5'
      )}
    >
      <div
        className={cn(
          'flex items-center gap-1.5 text-[11.5px] font-medium',
          decisionNeeds ? 'text-foreground' : 'text-warning'
        )}
      >
        {face && (
          <SecretaryFace
            name={face.name}
            color={face.color}
            image={face.image}
            enso="secretary-card-avatar"
            className="size-4 rounded-[5px] text-[9px]"
          />
        )}
        {decisionNeeds ? (
          <CheckCircle2 className="size-3.5 shrink-0 text-success" />
        ) : (
          <ShieldAlert className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{t(feed.label)}</span>
        <span className="shrink-0 font-normal text-subtle-foreground">
          {formatRelativeTime(feed.at, locale)}
        </span>
      </div>
      <div className="mt-1 flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[13px] font-medium leading-snug">{card.title}</p>
        <button
          type="button"
          title={t('Open session')}
          aria-label={t('Open session')}
          onClick={() => openSessionPeek(card.conversationId)}
          className={ACTION_CLASS}
        >
          <ArrowUpRight className="size-3.5" />
        </button>
      </div>
      {decisionNeeds && (
        <div className="mt-1 flex flex-col gap-1 text-[12px]">
          {card.summary && (
            <p
              data-enso="secretary-card-needs-user-summary"
              title={card.summary}
              className="line-clamp-1 break-words text-muted-foreground"
            >
              {card.summary}
            </p>
          )}
          <ul
            data-enso="secretary-card-needs-user"
            className="flex flex-col gap-0.5 text-foreground/90"
          >
            {decisionNeeds.map((item, index) => {
              const answered = card.needsUserAnswers?.find((entry) => entry.index === index);
              return (
                <li
                  key={item}
                  data-enso="secretary-card-needs-user-item"
                  data-answered={answered ? 'true' : undefined}
                  title={item}
                  className="break-words"
                >
                  <span
                    className={cn('line-clamp-2', answered && 'text-muted-foreground line-through')}
                  >
                    {t('Needs you: {{item}}', { item })}
                  </span>
                  {answered && (
                    <span
                      data-enso="secretary-card-needs-user-answer"
                      title={answered.answer}
                      className="line-clamp-1 text-success"
                    >
                      {t('Answered: {{answer}}', { answer: answered.answer })}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {(card.state === 'queued' || card.queueFailed) && (
        <div className="mt-2 flex flex-col gap-1.5">
          <p data-enso="secretary-queued-card" className="text-[12.5px] text-orange-600">
            {card.queueFailed
              ? `${t('Queued')} · ${card.queueFailed}`
              : card.queuePosition
                ? t('Queued · #{{n}}', { n: card.queuePosition })
                : t('Queued')}
          </p>
          <QueuedSessionButtons
            conversationId={card.conversationId}
            failed={Boolean(card.queueFailed)}
          />
        </div>
      )}
      {approvals && approvals.length > 0 && (
        <div className="mt-2">
          <ApprovalBar
            approvals={approvals}
            onRespond={(requestId, decision) =>
              void window.electronAPI.agent.respondApproval(
                card.conversationId,
                requestId,
                decision
              )
            }
          />
        </div>
      )}
      {asks && asks.length > 0 && (
        <div className="mt-2">
          <AskBar
            asks={asks}
            autoFocus={false}
            onAnswer={(requestId, answer) =>
              void window.electronAPI.agent.respondAsk(card.conversationId, requestId, answer)
            }
          />
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          data-enso="secretary-card-open"
          onClick={() => openSessionFromSecretary(card.conversationId)}
          className="rounded-md bg-primary px-2.5 py-1 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('Open session')}
        </button>
        {dismissible && (
          <button
            type="button"
            data-enso="secretary-dismiss-result"
            onClick={() => void window.electronAPI.secretary.dismissResult(card.conversationId)}
            className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t('Got it')}
          </button>
        )}
        {card.state === 'running' && (
          <button
            type="button"
            disabled={stopping}
            onClick={stop}
            className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {t('Stop')}
          </button>
        )}
        {card.projectName && (
          <span className="ml-auto truncate text-[11px] text-subtle-foreground">
            {card.projectName}
          </span>
        )}
      </div>
    </div>
  );
}

function TodoRow({ todo, secretaryId }: { todo: SecretaryBoardTodo; secretaryId?: string }) {
  const { t, locale } = useI18n();
  const conversations = useSessionsStore((state) => state.conversations);
  const [draft, setDraft] = useState<string | null>(null);
  const phase = todo.phase ?? 'todo';
  // 会话已删也打开弹窗：由弹窗说明原因，而不是一个点不动的按钮
  const openable = Boolean(todo.conversationId);
  if (draft !== null) {
    return (
      <div className="rounded-lg border border-border px-2.5 py-1.5">
        <input
          // biome-ignore lint/a11y/noAutofocus: 点编辑就是要改这条
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setDraft(null);
            if (event.key !== 'Enter') return;
            const text = draft.trim();
            if (text) mutateTodo({ action: 'update', todoId: todo.id, text }, secretaryId);
            setDraft(null);
          }}
          className="w-full bg-transparent text-[13px] outline-none"
        />
      </div>
    );
  }
  return (
    <div
      data-enso="secretary-todo"
      data-phase={phase}
      data-session={todo.conversationId}
      className={cn(HOVER_ROW_CLASS, 'flex items-start gap-2.5 rounded-lg px-2 py-1.5')}
    >
      <button
        type="button"
        data-enso="secretary-todo-done"
        aria-label={t('Mark done')}
        onClick={() => mutateTodo({ action: 'update', todoId: todo.id, done: true }, secretaryId)}
        className={cn(
          'mt-[3px] size-3.5 shrink-0 rounded-full border-[1.5px] transition-colors hover:border-success hover:bg-success/20',
          phase === 'problem' ? 'border-destructive/60' : 'border-foreground/30'
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px]">{todo.text}</p>
        {phase === 'problem' && todo.problem && (
          <p data-enso="secretary-todo-problem" className="mt-0.5 text-[11.5px] text-destructive">
            {t(PROBLEM_LABEL[todo.problem])}
          </p>
        )}
        {phase !== 'todo' && (
          <button
            type="button"
            data-enso="secretary-todo-session"
            disabled={!openable}
            title={
              todo.pendingReminder
                ? formatReminderTooltip(todo.pendingReminder, Date.now(), t)
                : undefined
            }
            onClick={() => {
              if (todo.conversationId) openSessionPeek(todo.conversationId);
            }}
            className="mt-0.5 block max-w-full truncate text-left text-[11.5px] text-muted-foreground hover:text-foreground disabled:cursor-default"
          >
            {todo.sessionTitle || t('Open session')}
            {todo.sessionState || todo.pendingReminder
              ? ` · ${todoStateText(todo, conversations, t)}`
              : ''}
          </button>
        )}
        {todo.dueAt !== undefined && (
          <p className="mt-0.5 text-[11.5px] text-subtle-foreground">
            {formatRelativeTime(todo.dueAt, locale)}
          </p>
        )}
      </div>
      <HoverActions>
        {phase === 'todo' ? (
          <button
            type="button"
            data-enso="secretary-todo-dispatch"
            title={t('Dispatch')}
            aria-label={t('Dispatch')}
            onClick={() => mutateTodo({ action: 'dispatch', todoId: todo.id }, secretaryId)}
            className={ACTION_CLASS}
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            data-enso="secretary-todo-reopen"
            title={t('Back to to-do')}
            aria-label={t('Back to to-do')}
            onClick={() => mutateTodo({ action: 'reopen', todoId: todo.id }, secretaryId)}
            className={ACTION_CLASS}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          title={t('Edit')}
          aria-label={t('Edit')}
          onClick={() => setDraft(todo.text)}
          className={ACTION_CLASS}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={t('Delete')}
          aria-label={t('Delete')}
          onClick={() => mutateTodo({ action: 'remove', todoId: todo.id }, secretaryId)}
          className={ACTION_CLASS}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </HoverActions>
    </div>
  );
}

function TodoComposer({ onClose, secretaryId }: { onClose: () => void; secretaryId?: string }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const submit = () => {
    const trimmed = text.trim();
    if (trimmed) mutateTodo({ action: 'add', text: trimmed }, secretaryId);
    onClose();
  };
  return (
    <div className="rounded-lg border border-border px-2.5 py-1.5">
      <input
        // biome-ignore lint/a11y/noAutofocus: 点了新增就是要输入
        autoFocus
        value={text}
        placeholder={t('Add a to-do')}
        onChange={(event) => setText(event.target.value)}
        onBlur={submit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          if (event.key === 'Enter') submit();
        }}
        className="w-full bg-transparent text-[13px] outline-none"
      />
    </div>
  );
}

function EmptyState({ name, onAdd }: { name: string; onAdd: () => void }) {
  const { t } = useI18n();
  return (
    <div
      data-enso="secretary-empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-14 text-center"
    >
      <span className="flex size-11 items-center justify-center rounded-[14px] bg-muted text-subtle-foreground">
        <Coffee className="size-5" />
      </span>
      <p className="text-[13.5px] font-medium">{t('Nothing on your plate')}</p>
      <p className="text-[12px] text-muted-foreground">
        {t('Ask {{name}} for work in the chat, or note a to-do first', { name })}
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-2 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] transition-colors hover:bg-muted"
      >
        <Plus className="size-3.5" />
        {t('Add a to-do')}
      </button>
    </div>
  );
}

/** 极简工作台：只保留「等你处理 / 进行中 / 待办」三块，去掉流水账与给 Agent 看的内部信息 */
export function SecretaryWorkbench({ name, secretaryId }: { name: string; secretaryId?: string }) {
  const { t } = useI18n();
  const ownBoard = useSecretaryStore((s) =>
    secretaryId ? (s.states[secretaryId]?.board ?? s.secretary.board) : s.secretary.board
  );
  const upstreamHealth = useSessionsStore((s) => s.upstreamHealth) ?? [];
  const secretaries = useSecretaryStore((s) => s.secretaries);
  /** 多个秘书时保留一个极简范围下拉：默认当前秘书，可切到全部或指定秘书 */
  const [filterId, setFilterId] = useState<string>('own');
  const [overviewBoards, setOverviewBoards] = useState<
    { secretaryId: string; name: string | null; board: SecretaryBoard }[] | null
  >(null);
  useEffect(() => {
    if (filterId === 'own') return;
    let alive = true;
    const load = () => {
      void window.electronAPI.secretary.overview().then((result) => {
        if (alive && result.ok) setOverviewBoards(result.boards);
      });
    };
    load();
    const off = window.electronAPI.secretary.onStateChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [filterId]);
  const board = useMemo(() => {
    if (filterId === 'own' || !overviewBoards) return ownBoard;
    const picked =
      filterId === 'all'
        ? overviewBoards
        : overviewBoards.filter((entry) => entry.secretaryId === filterId);
    return {
      needsYou: picked.flatMap((entry) => entry.board.needsYou),
      running: picked.flatMap((entry) => entry.board.running),
      todos: picked.flatMap((entry) => entry.board.todos),
      done: picked.flatMap((entry) => entry.board.done),
    };
  }, [filterId, overviewBoards, ownBoard]);

  const focusProposal = useSecretaryStore((s) => s.focusProposal);
  const [adding, setAdding] = useState(false);
  /** 深链定位过来的那张卡：滚到它并闪一下，2.4 秒后恢复 */
  const [highlight, setHighlight] = useState<string | null>(null);

  useEffect(() => {
    if (!focusProposal) return;
    setHighlight(focusProposal.proposalId);
    const node = document.querySelector(
      `[data-enso=secretary-proposal-focus][data-proposal-id="${focusProposal.proposalId}"]`
    );
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // 定位只做一次：高亮收掉时把这个请求清掉，下次打开面板不会又跳回来
    const timer = setTimeout(() => {
      setHighlight(null);
      useSecretaryStore.getState().clearFocusProposal();
    }, 2_400);
    return () => clearTimeout(timer);
  }, [focusProposal]);

  // 已在「进行中」列表展示的派发待办不再重复铺在待办里；出问题和未派发（以及脱离进行中的 active）合并成单一待办列表
  const runningIds = useMemo(
    () =>
      new Set(
        board.running.flatMap((card) => (card.kind === 'session' ? [card.conversationId] : []))
      ),
    [board.running]
  );
  const visibleTodos = useMemo(() => {
    const problem = board.todos.filter((todo) => todo.phase === 'problem');
    const open = board.todos.filter((todo) => (todo.phase ?? 'todo') === 'todo');
    const detachedActive = board.todos.filter(
      (todo) =>
        todo.phase === 'active' && (!todo.conversationId || !runningIds.has(todo.conversationId))
    );
    return [...problem, ...detachedActive, ...open];
  }, [board.todos, runningIds]);

  const empty =
    board.needsYou.length + board.running.length + visibleTodos.length === 0 &&
    upstreamHealth.length === 0;

  if (empty) {
    return adding ? (
      <div className="px-3 py-3">
        <TodoComposer onClose={() => setAdding(false)} secretaryId={secretaryId} />
      </div>
    ) : (
      <EmptyState name={name} onAdd={() => setAdding(true)} />
    );
  }

  return (
    <div data-enso="secretary-workbench" className="flex flex-col gap-4 px-3 py-3">
      {upstreamHealth.length > 0 && (
        <div
          data-enso="secretary-upstream-health"
          className="flex flex-col gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-700 dark:text-amber-300"
        >
          {upstreamHealth.map((item) => (
            <div key={item.provider} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                {t('Upstream unavailable ({{provider}}), retrying automatically', {
                  provider: item.providerName ?? item.provider,
                })}
              </span>
              {item.nextProbeAt && (
                <span className="shrink-0 font-mono text-[11px] tabular-nums">
                  {formatRetryClock(item.nextProbeAt)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {secretaries.length > 1 && (
        <div className="flex items-center justify-end">
          <select
            data-enso="secretary-board-filter"
            aria-label={t('All secretaries')}
            value={filterId}
            onChange={(event) => setFilterId(event.target.value)}
            className="rounded-md border border-border/70 bg-transparent px-2 py-0.5 text-[11.5px] text-muted-foreground outline-none hover:text-foreground"
          >
            <option value="own">{name}</option>
            <option value="all">{t('All secretaries')}</option>
            {secretaries
              .filter((entry) => entry.id !== secretaryId)
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name ?? t('Secretary')}
                </option>
              ))}
          </select>
        </div>
      )}
      {board.needsYou.length > 0 && (
        <section data-enso="secretary-needs-you" className="flex flex-col gap-2">
          <h3 className="px-1 text-[12px] font-medium text-warning">
            {t('Waiting on you')}
            <span className="ml-1 tabular-nums">{board.needsYou.length}</span>
          </h3>
          {board.needsYou.map((card) =>
            card.kind === 'proposal' ? (
              <div
                key={card.proposal.id}
                data-enso="secretary-proposal-focus"
                data-proposal-id={card.proposal.id}
                className={cn(
                  'rounded-lg transition-shadow',
                  highlight === card.proposal.id && 'ring-2 ring-warning'
                )}
              >
                <SecretaryProposalRow proposalId={card.proposal.id} prominent />
              </div>
            ) : card.kind === 'pending' ? (
              <PendingProblemCard key={card.pending.id} pending={card.pending} />
            ) : (
              <AttentionCard key={card.conversationId} card={card} />
            )
          )}
        </section>
      )}
      {board.running.length > 0 && (
        <section data-enso="secretary-workbench-running" className="flex flex-col gap-0.5">
          <h3 className="px-1 pb-0.5 text-[12px] text-subtle-foreground">
            {t('In progress')}
            <span className="ml-1 tabular-nums">{board.running.length}</span>
          </h3>
          <RunningCards running={board.running} />
        </section>
      )}
      <section data-enso="secretary-todos" className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between px-1 pb-0.5">
          <h3 className="text-[12px] text-subtle-foreground">
            {t('To do')}
            {visibleTodos.length > 0 && (
              <span className="ml-1 tabular-nums">{visibleTodos.length}</span>
            )}
          </h3>
          {!adding && (
            <button
              type="button"
              data-enso="secretary-todo-add"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11.5px] text-subtle-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="size-3" />
              {t('Add a to-do')}
            </button>
          )}
        </div>
        {adding && <TodoComposer onClose={() => setAdding(false)} secretaryId={secretaryId} />}
        {visibleTodos.map((todo) => (
          <TodoRow key={todo.id} todo={todo} secretaryId={secretaryId} />
        ))}
      </section>
    </div>
  );
}
