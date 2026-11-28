import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  type MaskReport,
  mergeMaskReports,
  PRIVACY_MASK_ENTRY,
  parsePrivacyMaskRecord,
} from '@shared/privacyMask/report';
import { SECRETARY_BRIEF_CUSTOM_TYPE } from '@shared/secretary/generation';
import { OM_FOLDED } from './continuousMemory/vendor/session-ledger/types';
import { sessionEntryToContextMessages } from './sessionEntryMessages';

/**
 * 换代简报：rotate 时直接写进 SessionManager，worker 不发任何消息事件，实时投影里没有它；
 * 读盘投影也必须去掉，两边下标才对齐。其他 display:false 的 custom_message（输出超限续写、
 * 分支上下文等）实时路径会发 message_start，两条路径都保留，时间线自己隐藏。
 */
export function isSecretaryBriefMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const record = message as { role?: unknown; customType?: unknown };
  return record.role === 'custom' && record.customType === SECRETARY_BRIEF_CUSTOM_TYPE;
}

/** 读盘投影去掉换代简报，与 worker 实时投影的 baseIndex 对齐 */
export function stripSecretaryBriefMessages<T>(messages: readonly T[]): T[] {
  if (!messages.some(isSecretaryBriefMessage)) return [...messages];
  return messages.filter((message) => !isSecretaryBriefMessage(message));
}

/**
 * 渲染层要的是完整对话记录，而 pi 的 `session.messages` 是 LLM 上下文视图：
 * compaction 之后只剩 summary + 保留段 + 新消息，之前的历史被丢掉。
 * 这里把被摘要掉的那段从分支路径补回到 context 前面；更早的 compaction
 * 也按 pi 的映射变成 compactionSummary 消息留在原位。
 * 后半段沿用 context 本身，保证与运行中 message_start/update 的下标对齐。
 */
export function transcriptMessages(
  sessionManager: { getBranch(): SessionEntry[] },
  contextMessages: unknown[]
): unknown[] {
  const branch = sessionManager.getBranch();
  let compactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === 'compaction') {
      compactionIndex = i;
      break;
    }
  }
  if (compactionIndex < 0) {
    return stripSecretaryBriefMessages(
      withPrivacyMask(withUserEntryIds(contextMessages, branch), branch)
    );
  }
  const compaction = branch[compactionIndex] as Extract<SessionEntry, { type: 'compaction' }>;
  const keptIndex = compaction.firstKeptEntryId
    ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
    : -1;
  const cut = keptIndex >= 0 && keptIndex < compactionIndex ? keptIndex : compactionIndex;
  const summarized = branch.slice(0, cut).flatMap(sessionEntryToContextMessages);
  return stripSecretaryBriefMessages(
    withPrivacyMask(
      withUserEntryIds(
        stampCompactionFromHook([...summarized, ...contextMessages], branch),
        branch
      ),
      branch
    )
  );
}

/** 脱敏记录写在请求发出时，挂到分支上紧随其后的 assistant 消息；重试的多次请求合并 */
export function withPrivacyMask(messages: unknown[], branch: readonly SessionEntry[]): unknown[] {
  const reports = new Map<unknown, MaskReport>();
  let pending: MaskReport | undefined;
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === PRIVACY_MASK_ENTRY) {
      const record = parsePrivacyMaskRecord(entry.data);
      if (record) pending = mergeMaskReports(pending, record.report);
    } else if (entry.type === 'message' && entry.message.role === 'assistant' && pending) {
      reports.set(entry.message, pending);
      pending = undefined;
    }
  }
  if (!reports.size) return messages;
  return messages.map((message) => {
    const privacyMask = reports.get(message);
    return privacyMask && typeof message === 'object' && message !== null
      ? { ...message, privacyMask }
      : message;
  });
}

/** 按源对象匹配，绝不按文本：重复的 prompt 与未持久化的消息不能共用同一个 ID。 */
export function withUserEntryIds(messages: unknown[], branch: readonly SessionEntry[]): unknown[] {
  const ids = new Map<unknown, string>();
  for (const entry of branch) {
    if (entry.type === 'message' && entry.message.role === 'user' && entry.id) {
      ids.set(entry.message, entry.id);
    }
  }
  return messages.map((message) => {
    const entryId = ids.get(message);
    return entryId && typeof message === 'object' && message !== null
      ? { ...message, entryId }
      : message;
  });
}

function isMemoryFolded(details: unknown): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    (details as { type?: unknown }).type === OM_FOLDED
  );
}

/** 按 compaction 条目顺序给 compactionSummary 打标：fromHook = Enso hook 产出；compactionSource='memory' = 持续记忆渲染。 */
function stampCompactionFromHook(messages: unknown[], branch: SessionEntry[]): unknown[] {
  const flags = branch
    .filter(
      (entry): entry is Extract<SessionEntry, { type: 'compaction' }> => entry.type === 'compaction'
    )
    .map((entry) => ({
      fromHook: entry.fromHook === true,
      memory: entry.fromHook === true && isMemoryFolded(entry.details),
    }));
  if (!flags.some((flag) => flag.fromHook)) return messages;
  let i = 0;
  return messages.map((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      (message as { role?: unknown }).role !== 'compactionSummary'
    ) {
      return message;
    }
    const flag = flags[i++];
    if (!flag?.fromHook) return message;
    return {
      ...(message as object),
      fromHook: true,
      ...(flag.memory ? { compactionSource: 'memory' } : {}),
    };
  });
}
