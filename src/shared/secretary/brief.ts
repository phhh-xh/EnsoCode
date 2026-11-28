import { isPureSessionUpdate } from './silence';
import { wrapUntrusted } from './transcript';

/** 简报总预算与常驻规则子预算（token） */
export const SECRETARY_BRIEF_MAX_TOKENS = 6_000;
export const SECRETARY_BRIEF_RULES_MAX_COUNT = 20;
export const SECRETARY_BRIEF_RULES_MAX_TOKENS = 1_500;
export const SECRETARY_BRIEF_RECENT_TURNS = 3;

export interface BriefTodoItem {
  id: string;
  text: string;
  status: string;
  projectName?: string;
  dueAt?: number;
}

export interface BriefDispatchItem {
  conversationId: string;
  title: string;
  projectName?: string;
  state: string;
  goal?: string;
  lastText?: string;
}

export interface BriefScheduleItem {
  id: string;
  name: string;
  spec: string;
  prompt?: string;
}

export interface BriefDailyItem {
  at: number;
  kind: string;
  title: string;
  summary?: string;
}

export interface BriefTurnMessage {
  role: 'user' | 'assistant' | 'custom' | string;
  text: string;
  customType?: string;
}

export interface BriefRuleMemory {
  id: string;
  spaceId: string;
  unitType: string;
  title?: string;
  content: string;
  importance: number;
  updatedAt: number;
}

export interface GenerationBriefInput {
  snapshotAt: number;
  todos: readonly BriefTodoItem[];
  dispatches: readonly BriefDispatchItem[];
  schedules: readonly BriefScheduleItem[];
  daily: readonly BriefDailyItem[];
  recentMessages: readonly BriefTurnMessage[];
  rules: readonly BriefRuleMemory[];
  /** 可选覆盖总 token 上限（测试用） */
  maxTokens?: number;
}

/** 轻量估算 token 数：ASCII ~0.25 token/字，CJK 等非 ASCII ~0.7 token/字 */
export function estimateBriefTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i += 1) {
    tokens += text.charCodeAt(i) <= 0x7f ? 0.25 : 0.7;
  }
  return Math.ceil(tokens);
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateBriefTokens(text) <= maxTokens) return text;
  let tokens = 0;
  let cut = 0;
  const target = Math.max(0, maxTokens - 4);
  for (let i = 0; i < text.length; i += 1) {
    tokens += text.charCodeAt(i) <= 0x7f ? 0.25 : 0.7;
    if (tokens > target) break;
    cut = i + 1;
  }
  return `${text.slice(0, cut).trimEnd()}\n…（已按预算截断）`;
}

/**
 * 提取最近 N 轮用户与秘书正文：
 * - 跳过 flush 回合、系统回传与简报本身；
 * - 不含工具结果；
 * - 明确保留外部渠道原始 <untrusted-content> 包裹，不剥壳。
 */
export function extractRecentBriefTurns(
  messages: readonly BriefTurnMessage[],
  maxTurns = SECRETARY_BRIEF_RECENT_TURNS
): Array<{ user: string; assistant: string }> {
  const turns: Array<{ user: string; assistant: string }> = [];
  let currentUser: string | null = null;
  let currentReplies: string[] = [];

  const flush = (): void => {
    if (currentUser !== null && currentReplies.length > 0) {
      turns.push({ user: currentUser, assistant: currentReplies.join('\n\n') });
    }
    currentUser = null;
    currentReplies = [];
  };

  for (const message of messages) {
    if (message.role === 'custom' || message.customType === 'secretary-brief') continue;
    if (message.role === 'user') {
      flush();
      const raw = message.text.trim();
      if (!raw || isPureSessionUpdate(raw)) continue;
      currentUser = raw;
      continue;
    }
    if (message.role === 'assistant') {
      const reply = message.text.trim();
      if (currentUser !== null && reply) currentReplies.push(reply);
    }
  }
  flush();
  return turns.slice(-Math.max(1, maxTurns));
}

function formatTodosSection(todos: readonly BriefTodoItem[]): string {
  const active = todos.filter((item) => item.status !== 'done');
  if (active.length === 0) return '';
  const lines = active.map((item) => {
    const project = item.projectName ? ` [${item.projectName}]` : '';
    const due = item.dueAt ? ` (due ${new Date(item.dueAt).toISOString()})` : '';
    const body = wrapUntrusted(`todo:${item.id}`, item.text);
    return `- (${item.status})${project}${due} ${body}`;
  });
  return `## 未完成待办 (${active.length})\n${lines.join('\n')}`;
}

function formatDispatchesSection(dispatches: readonly BriefDispatchItem[]): string {
  if (dispatches.length === 0) return '';
  const lines = dispatches.map((item) => {
    const project = item.projectName ? `[${item.projectName}] ` : '';
    const title = wrapUntrusted(
      `session:${item.conversationId}`,
      item.title || item.conversationId
    );
    const goal = item.goal
      ? ` | goal: ${wrapUntrusted(`session:${item.conversationId}`, item.goal)}`
      : '';
    const last = item.lastText
      ? ` | last: ${wrapUntrusted(`session:${item.conversationId}`, item.lastText.slice(0, 160))}`
      : '';
    return `- session:${item.conversationId} (${item.state}) ${project}${title}${goal}${last}`;
  });
  return `## 在途派发 (${dispatches.length})\n${lines.join('\n')}`;
}

function formatSchedulesSection(schedules: readonly BriefScheduleItem[]): string {
  if (schedules.length === 0) return '';
  const lines = schedules.map((item) => {
    const label = wrapUntrusted(`schedule:${item.id}`, item.name || item.id);
    return `- ${label} (${item.spec})`;
  });
  return `## 已启用的定时 (${schedules.length})\n${lines.join('\n')}`;
}

function formatDailySection(daily: readonly BriefDailyItem[]): string {
  if (daily.length === 0) return '';
  const lines = daily.slice(-15).map((item) => {
    const time = new Date(item.at).toISOString().slice(11, 16);
    const title = wrapUntrusted('daily', item.title);
    const summary = item.summary ? ` — ${wrapUntrusted('daily', item.summary.slice(0, 160))}` : '';
    return `- ${time} [${item.kind}] ${title}${summary}`;
  });
  return `## 当天看板摘要\n${lines.join('\n')}`;
}

function formatRecentTurnsSection(messages: readonly BriefTurnMessage[]): string {
  const turns = extractRecentBriefTurns(messages, SECRETARY_BRIEF_RECENT_TURNS);
  if (turns.length === 0) return '';
  const blocks = turns.map(
    (turn, index) => `### 第 ${index + 1} 轮\n用户：${turn.user}\n秘书：${turn.assistant}`
  );
  return `## 最近 ${turns.length} 轮对话\n${blocks.join('\n\n')}`;
}

function formatRulesSection(rules: readonly BriefRuleMemory[]): string {
  if (rules.length === 0) return '';
  const picked: string[] = [];
  let usedTokens = 20;
  for (const rule of rules.slice(0, SECRETARY_BRIEF_RULES_MAX_COUNT)) {
    const title = rule.title?.trim() ? `${rule.title.trim()}: ` : '';
    const body = wrapUntrusted(`memory:${rule.id}`, `${title}${rule.content.trim()}`);
    const line = `- [${rule.unitType}] ${body}`;
    const lineTokens = estimateBriefTokens(line) + 1;
    if (usedTokens + lineTokens > SECRETARY_BRIEF_RULES_MAX_TOKENS) break;
    picked.push(line);
    usedTokens += lineTokens;
  }
  if (picked.length === 0) return '';
  return `## 常驻规则 (${picked.length})\n${picked.join('\n')}`;
}

/**
 * 组装换代简报：严格按「待办 → 派发 → 定时 → 当天看板 → 最近 3 轮 → 常驻规则」排序；
 * 超过总 token 上限时从后往前截断，保留高优先级状态。
 */
export function buildGenerationBrief(input: GenerationBriefInput): string {
  const maxTokens = input.maxTokens ?? SECRETARY_BRIEF_MAX_TOKENS;
  const isoTime = new Date(input.snapshotAt).toISOString();
  const header = [
    '<secretary-brief>',
    `快照时间：${isoTime}`,
    '说明：此简报生成于上一代上下文结束时刻，仅反映当时磁盘状态；需要最新待办、派发或仓库状态时请调用对应工具查询。',
  ].join('\n');
  const footer = '</secretary-brief>';

  const sections = [
    formatTodosSection(input.todos),
    formatDispatchesSection(input.dispatches),
    formatSchedulesSection(input.schedules),
    formatDailySection(input.daily),
    formatRecentTurnsSection(input.recentMessages),
    formatRulesSection(input.rules),
  ].filter(Boolean);

  if (sections.length === 0) {
    return `${header}\n\n（暂无待办、在途派发、定时、近期对话或常驻规则。）\n${footer}`;
  }

  const fixedTokens = estimateBriefTokens(`${header}\n\n${footer}`) + 4;
  let remaining = Math.max(0, maxTokens - fixedTokens);
  const kept: string[] = [];

  for (const section of sections) {
    if (remaining <= 12) break;
    const cost = estimateBriefTokens(section) + 2;
    if (cost <= remaining) {
      kept.push(section);
      remaining -= cost;
    } else {
      const clipped = truncateToTokenBudget(section, remaining);
      if (clipped) kept.push(clipped);
      remaining = 0;
      break;
    }
  }

  return `${header}\n\n${kept.join('\n\n')}\n${footer}`;
}
