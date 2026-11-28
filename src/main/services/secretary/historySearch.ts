import { readFile } from 'node:fs/promises';
import { isSecretaryFlushText } from '@shared/secretary/silence';
import { wrapUntrusted } from '@shared/secretary/transcript';
import { redactSecrets } from '../memory/distill';
import { resolveParentHistoryFile } from '../sessionHistoryTail';

export const HISTORY_SEARCH_LIMIT_DEFAULT = 10;
export const HISTORY_SEARCH_LIMIT_MAX = 10;
export const HISTORY_SEARCH_SNIPPET_CONTEXT = 300;
const INDEX_CACHE_MAX_FILES = 200;

export interface IndexedHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  /** 方便不区分大小写匹配，随旧代缓存一起只算一次 */
  lower: string;
  timestamp: number;
}

export interface HistorySearchMatch {
  /** 代序号：1 为最早一代，最大为当前代 */
  generation: number;
  current: boolean;
  role: 'user' | 'assistant';
  timestamp: number;
  /** 已脱敏并包 untrusted 的前后 300 字片段 */
  snippet: string;
}

export interface HistorySearchResult {
  query: string;
  totalGenerations: number;
  matches: HistorySearchMatch[];
  hasMore: boolean;
}

export interface SearchSecretaryHistoryOptions {
  sessionDir: string;
  previousSessionFiles: readonly string[];
  currentSessionFile?: string;
  query: string;
  limit?: number;
  /** 仅单测注入以统计读取次数；默认读磁盘 */
  readText?: (resolvedFile: string) => Promise<string | null>;
}

/** 旧代文件不可变：按绝对路径缓存只含正文的轻量索引，二次查询不重读磁盘 */
const priorIndexCache = new Map<string, IndexedHistoryMessage[]>();

export function clearHistorySearchCache(): void {
  priorIndexCache.clear();
}

function setCachedIndex(file: string, messages: IndexedHistoryMessage[]): void {
  if (priorIndexCache.has(file)) priorIndexCache.delete(file);
  priorIndexCache.set(file, messages);
  if (priorIndexCache.size > INDEX_CACHE_MAX_FILES) {
    const oldest = priorIndexCache.keys().next().value;
    if (oldest !== undefined) priorIndexCache.delete(oldest);
  }
}

interface RawEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    timestamp?: unknown;
  };
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      const text = (part as { text: string }).text;
      if (text) parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

function parseEntryTimestamp(entry: RawEntry): number {
  const msgTs = entry.message?.timestamp;
  if (typeof msgTs === 'number' && Number.isFinite(msgTs) && msgTs > 0) return msgTs;
  const rawTs = entry.timestamp;
  if (typeof rawTs === 'number' && Number.isFinite(rawTs) && rawTs > 0) return rawTs;
  if (typeof rawTs === 'string') {
    const parsed = Date.parse(rawTs);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/**
 * 轻量解析单个会话 jsonl：
 * - 支持按 id/parentId 回溯活跃分支，避免命中已回退的废分支
 * - 只保留 user / assistant 正文，跳过工具结果、custom/brief 及整轮 <secretary-flush>
 */
export function indexSessionJsonl(raw: string): IndexedHistoryMessage[] {
  const entries: RawEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RawEntry;
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch {
      // 跳过损坏或半截写入行
    }
  }

  let activeBranch: RawEntry[];
  const byId = new Map<string, RawEntry>();
  let lastId: string | undefined;
  for (const entry of entries) {
    if (typeof entry.id === 'string' && entry.id) {
      byId.set(entry.id, entry);
      lastId = entry.id;
    }
  }
  if (lastId && byId.size > 0) {
    const chain: RawEntry[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = lastId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = byId.get(cursor);
      if (!node) break;
      chain.push(node);
      cursor = typeof node.parentId === 'string' && node.parentId ? node.parentId : undefined;
    }
    chain.reverse();
    activeBranch = chain;
  } else {
    activeBranch = entries;
  }

  const out: IndexedHistoryMessage[] = [];
  let inFlushTurn = false;
  for (const entry of activeBranch) {
    if (entry.type !== 'message' || !entry.message) continue;
    const role = entry.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = extractMessageText(entry.message.content);
    if (!text) continue;
    if (text.includes('<secretary-brief>')) continue;
    if (role === 'user') {
      if (isSecretaryFlushText(text)) {
        inFlushTurn = true;
        continue;
      }
      inFlushTurn = false;
    } else if (inFlushTurn) {
      continue;
    }
    // 先整条脱敏再建索引：片段截取不会把密钥切成认不出的半截，搜索也命中不了密钥本身
    const safe = redactSecrets(text);
    out.push({
      role,
      text: safe,
      lower: safe.toLowerCase(),
      timestamp: parseEntryTimestamp(entry),
    });
  }
  return out;
}

function buildExcerpt(text: string, matchIndex: number, queryLength: number): string {
  const start = Math.max(0, matchIndex - HISTORY_SEARCH_SNIPPET_CONTEXT);
  const end = Math.min(text.length, matchIndex + queryLength + HISTORY_SEARCH_SNIPPET_CONTEXT);
  const core = text.slice(start, end);
  return `${start > 0 ? '…' : ''}${core}${end < text.length ? '…' : ''}`;
}

async function defaultReadText(resolvedFile: string): Promise<string | null> {
  try {
    return await readFile(resolvedFile, 'utf8');
  } catch {
    return null;
  }
}

export async function searchSecretaryHistory(
  options: SearchSecretaryHistoryOptions
): Promise<HistorySearchResult> {
  const query = options.query.trim();
  const limit = Math.min(
    HISTORY_SEARCH_LIMIT_MAX,
    Math.max(1, Math.floor(options.limit ?? HISTORY_SEARCH_LIMIT_DEFAULT))
  );
  const needle = query.toLowerCase();
  const readText = options.readText ?? defaultReadText;

  const generations: Array<{ file: string; generation: number; current: boolean }> = [
    ...options.previousSessionFiles.map((file, idx) => ({
      file,
      generation: idx + 1,
      current: false,
    })),
    ...(options.currentSessionFile
      ? [
          {
            file: options.currentSessionFile,
            generation: options.previousSessionFiles.length + 1,
            current: true,
          },
        ]
      : []),
  ];

  const matches: HistorySearchMatch[] = [];
  let hasMore = false;

  // 从最新代到最早代、每代内从最新消息到最早消息扫描；集满 limit 后再探 1 条设 hasMore 即停
  outer: for (let g = generations.length - 1; g >= 0; g -= 1) {
    const gen = generations[g];
    const resolved = resolveParentHistoryFile(options.sessionDir, gen.file);
    if (!resolved) continue;

    let messages: IndexedHistoryMessage[];
    if (!gen.current && priorIndexCache.has(resolved)) {
      messages = priorIndexCache.get(resolved)!;
    } else {
      const raw = await readText(resolved);
      if (raw === null) continue;
      messages = indexSessionJsonl(raw);
      if (!gen.current) setCachedIndex(resolved, messages);
    }

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      const hitAt = msg.lower.indexOf(needle);
      if (hitAt === -1) continue;
      if (matches.length >= limit) {
        hasMore = true;
        break outer;
      }
      const excerpt = buildExcerpt(msg.text, hitAt, needle.length);
      const safe = wrapUntrusted('secretary-history', excerpt);
      matches.push({
        generation: gen.generation,
        current: gen.current,
        role: msg.role,
        timestamp: msg.timestamp,
        snippet: safe,
      });
    }
  }

  return {
    query,
    totalGenerations: generations.length,
    matches,
    hasMore,
  };
}
