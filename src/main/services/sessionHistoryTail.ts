import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { takeSnapshotTail } from '@shared/snapshotTail';
import type {
  PriorGenerationCursor,
  PriorGenerationEntry,
  PriorGenerationPageResult,
  ProjectedMessage,
} from '@shared/types/agent';
import { projectMessage } from '../../agent/projection';
import { sessionEntryToContextMessages } from '../../agent/sessionEntryMessages';
import {
  stripSecretaryBriefMessages,
  withPrivacyMask,
  withUserEntryIds,
} from '../../agent/transcript';

export interface HistoryProjectionOptions {
  /** 每条消息带上 jsonl entry id（任意角色）；秘书跨分页定位用，渲染层历史不带 */
  messageIds?: boolean;
}

/** jsonl 分支 → 显示用消息（脱敏、带 user entryId、过滤 display:false）；分页按它的绝对下标切 */
export function displayMessages(
  branch: readonly SessionEntry[],
  options: HistoryProjectionOptions = {}
): unknown[] {
  const raw = branch.flatMap(sessionEntryToContextMessages);
  const shown = withPrivacyMask(withUserEntryIds(raw, branch), branch);
  if (!options.messageIds) return stripSecretaryBriefMessages(shown);
  const ids = new Map<unknown, string>();
  for (const entry of branch)
    if (entry.type === 'message' && entry.id) ids.set(entry.message, entry.id);
  // 上面两步都是逐条 map，按位置对回原始消息对象再查 id，再统一过滤隐藏 custom_message
  const withIds = shown.map((message, i) => {
    const messageId = ids.get(raw[i]);
    return messageId && typeof message === 'object' && message !== null
      ? { ...message, messageId }
      : message;
  });
  return stripSecretaryBriefMessages(withIds);
}

export function resolveParentHistoryFile(
  sessionDir: string,
  sessionFile: string | undefined
): string | null {
  if (!sessionFile) return null;
  const root = path.resolve(sessionDir);
  const resolved = path.resolve(sessionFile);
  const within = resolved === root || resolved.startsWith(`${root}${path.sep}`);
  return within ? resolved : null;
}

export function projectWindow(
  raw: readonly unknown[],
  endIndex: number
): {
  messages: ProjectedMessage[];
  baseIndex: number;
} {
  const end = Math.max(0, Math.min(endIndex, raw.length));
  if (end === 0) return { messages: [], baseIndex: 0 };
  const window = takeSnapshotTail(raw as unknown[], end);
  return {
    messages: window.messages
      .map(projectMessage)
      .filter((message): message is ProjectedMessage => message !== null),
    baseIndex: window.baseIndex,
  };
}

export function projectParentHistoryPage(
  branch: readonly SessionEntry[],
  beforeIndex: number,
  options?: HistoryProjectionOptions
): {
  messages: ProjectedMessage[];
  baseIndex: number;
} {
  return projectWindow(displayMessages(branch, options), beforeIndex);
}

export function projectParentHistoryTail(
  branch: readonly SessionEntry[],
  options?: HistoryProjectionOptions
): {
  messages: ProjectedMessage[];
  baseIndex: number;
} {
  const raw = displayMessages(branch, options);
  return projectWindow(raw, raw.length);
}

/** 全量投影：worker 无投影的会话合成快照用（分页由快照链路按绝对 index 切） */
export function projectParentHistoryAll(
  branch: readonly SessionEntry[],
  options?: HistoryProjectionOptions
): ProjectedMessage[] {
  return projectAll(displayMessages(branch, options));
}

export function projectAll(raw: readonly unknown[]): ProjectedMessage[] {
  return raw.map(projectMessage).filter((message): message is ProjectedMessage => message !== null);
}

/** 全量投影里按 jsonl entry id（优先）或绝对下标取一条；取不到返回 null */
export function findHistoryMessage(
  messages: readonly ProjectedMessage[],
  target: { entryId: string } | { index: number }
): { index: number; message: ProjectedMessage } | null {
  const index =
    'entryId' in target
      ? messages.findIndex((message) => message.messageId === target.entryId)
      : target.index;
  const message = messages[index];
  return message ? { index, message } : null;
}

/**
 * 跨旧代分页读取：损坏、缺失或越界的旧代文件会被跳过，不阻断更早代的读取。
 * 在每代尾部（beforeIndex 缺省）末尾追加一条 kind:'generation' 分隔项。
 */
export async function readPriorGenerationPageFromFiles(
  sessionDir: string,
  previousSessionFiles: readonly string[],
  cursor: PriorGenerationCursor,
  readDisplay: (resolvedFile: string) => Promise<unknown[]>,
  options: {
    currentSessionFile?: string;
    fileTime?: (resolvedFile: string) => number | undefined;
    now?: () => number;
  } = {}
): Promise<PriorGenerationPageResult> {
  if (previousSessionFiles.length === 0) {
    return { ok: true, entries: [], cursor: null };
  }
  let genIndex = Math.min(Math.floor(cursor.genIndex), previousSessionFiles.length - 1);
  let beforeIndex =
    cursor.beforeIndex !== undefined &&
    Number.isFinite(cursor.beforeIndex) &&
    cursor.beforeIndex >= 0
      ? Math.floor(cursor.beforeIndex)
      : undefined;

  const fileMtime =
    options.fileTime ??
    ((file: string): number | undefined => {
      try {
        return statSync(file).mtimeMs;
      } catch {
        return undefined;
      }
    });
  const now = options.now ?? Date.now;

  while (genIndex >= 0) {
    const rawPath = previousSessionFiles[genIndex];
    const resolved = resolveParentHistoryFile(sessionDir, rawPath);
    if (!resolved || !existsSync(resolved)) {
      genIndex -= 1;
      beforeIndex = undefined;
      continue;
    }
    let raw: unknown[];
    try {
      raw = await readDisplay(resolved);
    } catch {
      genIndex -= 1;
      beforeIndex = undefined;
      continue;
    }
    const endIndex = beforeIndex ?? raw.length;
    const page = projectWindow(raw, endIndex);
    const isTailOfGeneration = beforeIndex === undefined;

    if (page.messages.length === 0) {
      genIndex -= 1;
      beforeIndex = undefined;
      continue;
    }

    const entries: PriorGenerationEntry[] = [...page.messages];
    if (isTailOfGeneration) {
      const nextFile =
        genIndex + 1 < previousSessionFiles.length
          ? previousSessionFiles[genIndex + 1]
          : options.currentSessionFile;
      const nextResolved = nextFile ? resolveParentHistoryFile(sessionDir, nextFile) : null;
      const dividerAt =
        (nextResolved ? fileMtime(nextResolved) : undefined) ??
        page.messages.at(-1)?.timestamp ??
        fileMtime(resolved) ??
        now();
      entries.push({
        kind: 'generation',
        at: dividerAt,
        generationIndex: genIndex + 1,
      });
    }

    const nextCursor: PriorGenerationCursor | null =
      page.baseIndex > 0
        ? { genIndex, beforeIndex: page.baseIndex }
        : genIndex > 0
          ? { genIndex: genIndex - 1 }
          : null;

    return { ok: true, entries, cursor: nextCursor };
  }

  return { ok: true, entries: [], cursor: null };
}
