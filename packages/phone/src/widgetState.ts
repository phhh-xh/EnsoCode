import type { CatalogEntry } from '@enso/pair';
import {
  activityKeepsLive,
  type PairSessionActivity,
  pairSessionActivity,
} from '@shared/pair/sessionActivity';
import type { NativeWidgetSessionItem, NativeWidgetSnapshot } from './nativeBridge';

/** 前端推送到 iOS 小组件 / 灵动岛的状态快照聚合器（纯函数，便于单测） */
export interface PhoneWidgetInput {
  deviceLabel: string;
  connectionState: string;
  transport: string;
  rttMs: number | null;
  catalog: CatalogEntry[];
  activeId: string | null;
  activeDetail?: string | null;
  now?: number;
}

function pendingOf(entry: CatalogEntry): number {
  return (entry.pendingApprovalCount ?? 0) + (entry.pendingAskCount ?? 0);
}

/** 原生侧的会话状态词：waiting / running / background / reminder / failed / queued / idle（未知词按已完成画） */
function nativeStatus(activity: PairSessionActivity): string {
  return activity === 'unread' ? 'idle' : activity;
}

const RANK: Record<PairSessionActivity, number> = {
  waiting: 5,
  running: 4,
  background: 3,
  reminder: 2,
  unread: 1,
  failed: 1,
  queued: 0,
  idle: 0,
};

export function buildWidgetSnapshotFromCatalog(input: PhoneWidgetInput): NativeWidgetSnapshot {
  const now = input.now ?? Date.now();
  const visible = input.catalog
    .filter((c) => !c.archived && !c.parentId)
    .map((entry) => ({ entry, activity: pairSessionActivity(entry) }));

  // runningCount 含等后台任务：旧 App 按它决定灵动岛是否收起，等后台时不能被当成已完成
  let runningCount = 0;
  let ownRunning = 0;
  let pendingCount = 0;
  let unreadCount = 0;
  let reminderCount = 0;
  for (const { entry, activity } of visible) {
    // 待确认的会话自身也在跑（卡在审批上），与原口径一样计入运行数
    if (entry.status === 'running' || activity === 'background') runningCount += 1;
    if (entry.status === 'running') ownRunning += 1;
    if (activity === 'reminder') reminderCount += 1;
    pendingCount += pendingOf(entry);
    if (entry.unread) unreadCount += 1;
  }

  const sorted = [...visible].sort((a, b) => {
    const diff = RANK[b.activity] - RANK[a.activity];
    if (diff !== 0) return diff;
    return (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0);
  });

  const focusRow =
    sorted.find((c) => activityKeepsLive(c.activity)) ??
    visible.find((c) => c.entry.id === input.activeId) ??
    sorted[0];
  const focus = focusRow?.entry ?? null;

  const sessions: NativeWidgetSessionItem[] = sorted.slice(0, 6).map(({ entry: c, activity }) => ({
    id: c.id,
    title: c.title || '未命名会话',
    projectName: c.projectName || input.deviceLabel,
    status: nativeStatus(activity),
    pendingCount: pendingOf(c),
    unread: Boolean(c.unread),
    updatedAt: c.updatedAt ?? now,
  }));

  const activeStatus =
    pendingCount > 0
      ? 'pending'
      : ownRunning > 0
        ? 'running'
        : runningCount > 0
          ? 'background'
          : input.connectionState !== 'online'
            ? 'offline'
            : reminderCount > 0
              ? 'reminder'
              : 'idle';

  const activeDetail =
    input.activeDetail ??
    (pendingCount > 0
      ? `有 ${pendingCount} 项待确认`
      : activeStatus === 'running'
        ? runningCount > 1
          ? `${runningCount} 个会话运行中`
          : 'Agent 执行中'
        : activeStatus === 'background'
          ? '等待后台任务'
          : activeStatus === 'offline'
            ? '等待重连桌面端'
            : activeStatus === 'reminder'
              ? '等待提醒'
              : '已连接，暂无运行中任务');

  return {
    deviceLabel: input.deviceLabel || 'EnsoCode',
    connectionState: input.connectionState,
    transport: input.transport,
    rttMs:
      typeof input.rttMs === 'number' && Number.isFinite(input.rttMs)
        ? Math.round(input.rttMs)
        : null,
    runningCount,
    pendingCount,
    unreadCount,
    activeTitle: focus?.title ?? null,
    activeProject: focus?.projectName ?? null,
    activeSessionId: focus?.id ?? null,
    activeStatus,
    activeDetail,
    startedAt: runningCount > 0 ? (focus?.updatedAt ?? now) : null,
    sessions,
    updatedAt: now,
  };
}

interface DeskConversationRow {
  id?: unknown;
  title?: unknown;
  projectName?: unknown;
  projectId?: unknown;
  cwd?: unknown;
  status?: unknown;
  unread?: unknown;
  archived?: unknown;
  parentId?: unknown;
  btwParentId?: unknown;
  pendingApprovalCount?: unknown;
  pendingAskCount?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
}

interface LiveSessionRuntime {
  status: string;
  approvals: Set<string>;
  asks: Set<string>;
  /** 运行中的后台命令 / 子代理：回合结束后它们还在跑，会话算等后台任务 */
  tasks: Set<string>;
  subagents: Set<string>;
  detail?: string;
  startedAt?: number;
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 列表里 status === 'running' 的条目 id（idKey：任务是 taskId，子代理是 id） */
function runningIds(list: unknown, idKey: 'taskId' | 'id'): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (isRecord(item) && item.status === 'running' && typeof item[idKey] === 'string')
      out.add(item[idKey]);
  }
  return out;
}

/** 把一个 id 按是否仍在跑写进集合，返回集合是否变了 */
function toggle(set: Set<string>, id: unknown, running: boolean): boolean {
  if (typeof id !== 'string' || !id) return false;
  if (running === set.has(id)) return false;
  if (running) set.add(id);
  else set.delete(id);
  return true;
}

function basenameOfPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

function extractConversationRows(parsed: unknown): DeskConversationRow[] {
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord);
  }
  if (!isRecord(parsed)) return [];
  // 真实 conversations:read 结构：{ seq, value: { state: { conversations: Record<id, Row> } } }
  const value = isRecord(parsed.value) ? parsed.value : parsed;
  const state = isRecord(value.state) ? value.state : value;
  const convs = state.conversations ?? parsed.conversations ?? parsed.items;
  if (Array.isArray(convs)) {
    return convs.filter(isRecord);
  }
  if (isRecord(convs)) {
    const out: DeskConversationRow[] = [];
    for (const [id, row] of Object.entries(convs)) {
      if (!isRecord(row)) continue;
      out.push(typeof row.id === 'string' ? row : { ...row, id });
    }
    return out;
  }
  return [];
}

function activeIdOf(parsed: unknown): string | null {
  if (!isRecord(parsed)) return null;
  const value = isRecord(parsed.value) ? parsed.value : parsed;
  const state = isRecord(value.state) ? value.state : value;
  const id = state.activeConversationId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * 完整版（Desk 模式）小组件与灵动岛状态追踪器：
 * - 从 `conversations:read` / `settings:read` / `source-authority:read` / `conversations:patch` 维护会话与项目元数据
 * - 从 `agent:event`（snapshot / status / approval-* / ask-* / turn-*）实时跟踪运行中与待确认状态
 */
export class DeskWidgetTracker {
  private projects = new Map<string, string>();
  private conversations = new Map<string, DeskConversationRow>();
  private live = new Map<string, LiveSessionRuntime>();
  /** conversations:read 里桌面当前选中的会话 */
  activeConversationId: string | null = null;

  ingestSettingsJson(json: string | undefined): boolean {
    if (!json) return false;
    try {
      const parsed: unknown = JSON.parse(json);
      if (!isRecord(parsed)) return false;
      const ensoSettings = isRecord(parsed['enso-settings']) ? parsed['enso-settings'] : parsed;
      const state = isRecord(ensoSettings.state) ? ensoSettings.state : ensoSettings;
      const projects = state.projects;
      if (!Array.isArray(projects)) return false;
      let changed = false;
      for (const proj of projects) {
        if (!isRecord(proj) || typeof proj.id !== 'string') continue;
        const name =
          (typeof proj.name === 'string' && proj.name.trim()) ||
          (typeof proj.path === 'string' ? basenameOfPath(proj.path) : '');
        if (name && this.projects.get(proj.id) !== name) {
          this.projects.set(proj.id, name);
          changed = true;
        }
      }
      return changed;
    } catch {
      return false;
    }
  }

  ingestSourceAuthorityJson(json: string | undefined): boolean {
    if (!json) return false;
    try {
      const parsed: unknown = JSON.parse(json);
      if (!isRecord(parsed) || !Array.isArray(parsed.projects)) return false;
      let changed = false;
      for (const proj of parsed.projects) {
        if (!isRecord(proj) || typeof proj.projectId !== 'string') continue;
        if (this.projects.has(proj.projectId)) continue;
        const name =
          typeof proj.canonicalPath === 'string' ? basenameOfPath(proj.canonicalPath) : '';
        if (name) {
          this.projects.set(proj.projectId, name);
          changed = true;
        }
      }
      return changed;
    } catch {
      return false;
    }
  }

  ingestConversationsJson(json: string | undefined): boolean {
    if (!json) return false;
    try {
      const parsed: unknown = JSON.parse(json);
      const rows = extractConversationRows(parsed);
      this.conversations.clear();
      for (const row of rows) {
        if (typeof row.id !== 'string' || !row.id) continue;
        this.conversations.set(row.id, row);
      }
      this.activeConversationId = activeIdOf(parsed);
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  applyConversationsPatchPayload(payloadJson: string): boolean {
    try {
      const args: unknown = JSON.parse(payloadJson);
      const patch = Array.isArray(args) ? args[0] : args;
      if (!isRecord(patch)) return false;
      let changed = false;
      if (isRecord(patch.upserts)) {
        for (const [id, rowPatch] of Object.entries(patch.upserts)) {
          if (!isRecord(rowPatch)) continue;
          const prev: DeskConversationRow = { ...(this.conversations.get(id) ?? { id }) };
          if (isRecord(rowPatch.set)) {
            Object.assign(prev, rowPatch.set);
          }
          if (Array.isArray(rowPatch.unset)) {
            for (const key of rowPatch.unset) {
              if (typeof key === 'string') delete (prev as Record<string, unknown>)[key];
            }
          }
          prev.id = id;
          this.conversations.set(id, prev);
          changed = true;
        }
      }
      if (Array.isArray(patch.removes)) {
        for (const id of patch.removes) {
          if (typeof id === 'string') {
            if (this.conversations.delete(id)) changed = true;
            if (this.live.delete(id)) changed = true;
          }
        }
      }
      return changed;
    } catch {
      return false;
    }
  }

  applyAgentEventPayload(payloadJson: string, now = Date.now()): boolean {
    try {
      const args: unknown = JSON.parse(payloadJson);
      const event = Array.isArray(args) ? args[0] : args;
      if (!isRecord(event) || typeof event.type !== 'string') return false;
      return this.applyAgentEvent(event, now);
    } catch {
      return false;
    }
  }

  private applyAgentEvent(event: Record<string, unknown>, now: number): boolean {
    const type = event.type;
    if (type === 'worker-crashed' || type === 'worker-restarted') {
      const hadAny = this.live.size > 0;
      this.live.clear();
      return hadAny;
    }

    if (type === 'snapshot' && Array.isArray(event.sessions)) {
      const isFull = event.partial !== true && typeof event.sessionId !== 'string';
      const next = isFull ? new Map<string, LiveSessionRuntime>() : new Map(this.live);
      for (const snap of event.sessions) {
        if (!isRecord(snap) || !isRecord(snap.identity)) continue;
        const sid = snap.identity.sessionId;
        if (typeof sid !== 'string' || !sid) continue;
        if (typeof snap.identity.parentSessionId === 'string' && snap.identity.parentSessionId) {
          continue;
        }
        const status = typeof snap.status === 'string' ? snap.status : 'idle';
        const approvals = new Set<string>();
        let detail: string | undefined;
        if (Array.isArray(snap.pendingApprovals)) {
          for (const req of snap.pendingApprovals) {
            if (!isRecord(req) || typeof req.requestId !== 'string') continue;
            approvals.add(req.requestId);
            const tool =
              typeof req.tool === 'string' && req.tool
                ? req.tool
                : typeof req.toolName === 'string'
                  ? req.toolName
                  : '';
            if (!detail && tool) {
              detail = `等待审批 ${tool}`;
            }
          }
        }
        const asks = new Set<string>();
        if (Array.isArray(snap.pendingAsks)) {
          for (const ask of snap.pendingAsks) {
            if (!isRecord(ask) || typeof ask.requestId !== 'string') continue;
            if (ask.answered) continue;
            asks.add(ask.requestId);
            if (!detail && typeof ask.question === 'string' && ask.question.trim()) {
              detail = ask.question.trim();
            }
          }
        }
        const prev = this.live.get(sid);
        next.set(sid, {
          status,
          approvals,
          asks,
          tasks: runningIds(snap.backgroundTasks, 'taskId'),
          subagents: runningIds(snap.subagents, 'id'),
          detail,
          startedAt: status === 'running' ? (prev?.startedAt ?? now) : undefined,
          updatedAt: now,
        });
      }
      this.live = next;
      return true;
    }

    const identity = isRecord(event.identity) ? event.identity : null;
    const sid = identity && typeof identity.sessionId === 'string' ? identity.sessionId : '';
    if (!sid) return false;
    if (identity && typeof identity.parentSessionId === 'string' && identity.parentSessionId) {
      return false;
    }

    const ensure = (): LiveSessionRuntime => {
      const existing = this.live.get(sid);
      if (existing) return existing;
      const created: LiveSessionRuntime = {
        status: 'idle',
        approvals: new Set(),
        asks: new Set(),
        tasks: new Set(),
        subagents: new Set(),
        updatedAt: now,
      };
      this.live.set(sid, created);
      return created;
    };

    switch (type) {
      case 'task-started': {
        const task = isRecord(event.task) ? event.task : null;
        return toggle(ensure().tasks, task?.taskId, task?.status === 'running');
      }
      case 'task-output':
      case 'task-ended': {
        const rt = this.live.get(sid);
        if (!rt || typeof event.status !== 'string') return false;
        return toggle(rt.tasks, event.taskId, event.status === 'running');
      }
      case 'background-tasks-level': {
        const rt = ensure();
        const next = runningIds(event.tasks, 'taskId');
        const changed = next.size !== rt.tasks.size || [...next].some((id) => !rt.tasks.has(id));
        rt.tasks = next;
        return changed;
      }
      case 'subagent-update': {
        const agent = isRecord(event.agent) ? event.agent : null;
        return toggle(ensure().subagents, agent?.id, agent?.status === 'running');
      }
      case 'status': {
        if (typeof event.status !== 'string') return false;
        const rt = ensure();
        const prevStatus = rt.status;
        rt.status = event.status;
        rt.updatedAt = now;
        if (event.status === 'running') {
          rt.startedAt ??= now;
        } else {
          rt.startedAt = undefined;
        }
        return prevStatus !== rt.status;
      }
      case 'approval-request': {
        const req = isRecord(event.request) ? event.request : null;
        const reqId = req && typeof req.requestId === 'string' ? req.requestId : '';
        if (!reqId) return false;
        const rt = ensure();
        rt.approvals.add(reqId);
        const tool =
          req && typeof req.tool === 'string' && req.tool
            ? req.tool
            : req && typeof req.toolName === 'string'
              ? req.toolName
              : '';
        if (tool) {
          rt.detail = `等待审批 ${tool}`;
        }
        rt.updatedAt = now;
        return true;
      }
      case 'approval-resolved': {
        const reqId = typeof event.requestId === 'string' ? event.requestId : '';
        const rt = this.live.get(sid);
        if (!rt || !reqId) return false;
        const deleted = rt.approvals.delete(reqId);
        if (rt.approvals.size === 0 && rt.asks.size === 0) rt.detail = undefined;
        rt.updatedAt = now;
        return deleted;
      }
      case 'ask-request': {
        const ask = isRecord(event.ask) ? event.ask : null;
        const reqId = ask && typeof ask.requestId === 'string' ? ask.requestId : '';
        if (!reqId) return false;
        const rt = ensure();
        rt.asks.add(reqId);
        if (ask && typeof ask.question === 'string' && ask.question.trim()) {
          rt.detail = ask.question.trim();
        }
        rt.updatedAt = now;
        return true;
      }
      case 'ask-resolved': {
        const reqId = typeof event.requestId === 'string' ? event.requestId : '';
        const rt = this.live.get(sid);
        if (!rt || !reqId) return false;
        const deleted = rt.asks.delete(reqId);
        if (rt.approvals.size === 0 && rt.asks.size === 0) rt.detail = undefined;
        rt.updatedAt = now;
        return deleted;
      }
      case 'turn-completed':
      case 'turn-failed': {
        const rt = this.live.get(sid);
        if (!rt) return false;
        const changed = rt.status !== 'idle' || rt.approvals.size > 0 || rt.asks.size > 0;
        rt.status = 'idle';
        rt.startedAt = undefined;
        rt.approvals.clear();
        rt.asks.clear();
        rt.detail = undefined;
        rt.updatedAt = now;
        return changed;
      }
      case 'parent-ended':
      case 'child-ended': {
        return this.live.delete(sid);
      }
      default:
        return false;
    }
  }

  private projectNameOf(row: DeskConversationRow | undefined, fallback: string): string {
    const projectId = typeof row?.projectId === 'string' ? row.projectId : '';
    return (
      (typeof row?.projectName === 'string' && row.projectName.trim()) ||
      (projectId ? this.projects.get(projectId) : undefined) ||
      (typeof row?.cwd === 'string' ? basenameOfPath(row.cwd) : '') ||
      fallback
    );
  }

  /** 回合之外仍有后台命令 / 子代理在跑（实时事件口径） */
  backgroundRunning(id: string): boolean {
    const rt = this.live.get(id);
    return rt ? rt.tasks.size + rt.subagents.size > 0 : false;
  }

  /** 会话目录里的标题与项目名；目录里没有这一行时为 null */
  describeSession(
    id: string,
    fallbackProject: string
  ): { title: string | null; projectName: string } | null {
    const row = this.conversations.get(id);
    if (!row) return null;
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null;
    return { title, projectName: this.projectNameOf(row, fallbackProject) };
  }

  buildSnapshot(params: {
    deviceLabel: string;
    connectionState: string;
    transport: string;
    rttMs: number | null;
    now?: number;
  }): NativeWidgetSnapshot {
    const now = params.now ?? Date.now();
    const ids = new Set<string>([...this.conversations.keys(), ...this.live.keys()]);
    const catalog: CatalogEntry[] = [];
    let focusDetail: string | null = null;
    let focusStartedAt: number | null = null;

    for (const id of ids) {
      const row = this.conversations.get(id);
      const rt = this.live.get(id);
      if (row?.archived === true && !rt) continue;
      if (typeof row?.parentId === 'string' && row.parentId) continue;
      if (typeof row?.btwParentId === 'string' && row.btwParentId) continue;

      const projectId = typeof row?.projectId === 'string' ? row.projectId : '';
      const projectName = this.projectNameOf(row, params.deviceLabel);

      const pendingApprovalCount =
        rt?.approvals.size ??
        (typeof row?.pendingApprovalCount === 'number' ? row.pendingApprovalCount : 0);
      const pendingAskCount =
        rt?.asks.size ?? (typeof row?.pendingAskCount === 'number' ? row.pendingAskCount : 0);
      const status =
        rt?.status ?? (typeof row?.status === 'string' && row.status ? row.status : 'idle');
      const rowUpdatedAt =
        typeof row?.updatedAt === 'number'
          ? row.updatedAt
          : typeof row?.createdAt === 'number'
            ? row.createdAt
            : 0;
      const updatedAt = Math.max(rowUpdatedAt, rt?.updatedAt ?? 0) || now;

      catalog.push({
        id,
        title:
          typeof row?.title === 'string' && row.title.trim()
            ? row.title.trim()
            : rt
              ? '活跃会话'
              : '未命名会话',
        projectName,
        projectId,
        status,
        unread: row?.unread === true,
        archived: row?.archived === true,
        pendingApprovalCount,
        pendingAskCount,
        updatedAt,
        ...(this.backgroundRunning(id) ? { backgroundRunning: true } : {}),
      });
    }

    const base = buildWidgetSnapshotFromCatalog({
      deviceLabel: params.deviceLabel,
      connectionState: params.connectionState,
      transport: params.transport,
      rttMs: params.rttMs,
      catalog,
      activeId: null,
      now,
    });

    if (base.activeSessionId) {
      const activeRt = this.live.get(base.activeSessionId);
      if (activeRt?.detail) focusDetail = activeRt.detail;
      if (activeRt?.startedAt) focusStartedAt = activeRt.startedAt;
    }

    return {
      ...base,
      activeDetail: focusDetail ?? base.activeDetail,
      startedAt: focusStartedAt ?? base.startedAt,
    };
  }
}

/** 完整版（Desk 模式）下从已缓存的 `conversations:read` 载荷提取小组件快照 */
export function buildWidgetSnapshotFromDeskReads(params: {
  deviceLabel: string;
  connectionState: string;
  transport: string;
  rttMs: number | null;
  conversationsJson?: string;
  settingsJson?: string;
  authorityJson?: string;
  now?: number;
}): NativeWidgetSnapshot {
  const tracker = new DeskWidgetTracker();
  tracker.ingestSettingsJson(params.settingsJson);
  tracker.ingestSourceAuthorityJson(params.authorityJson);
  tracker.ingestConversationsJson(params.conversationsJson);
  return tracker.buildSnapshot(params);
}
