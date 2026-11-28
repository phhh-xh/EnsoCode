import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SECRETARY_FLUSH_PROMPT } from '@shared/secretary/generation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearHistorySearchCache,
  HISTORY_SEARCH_LIMIT_MAX,
  searchSecretaryHistory,
} from './historySearch';
import { createSecretaryReadHandlers, type SecretaryReadPorts } from './readers';

function jsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function msgEntry(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant' | 'toolResult',
  text: string,
  timestamp: number
) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role,
      content: [{ type: 'text', text }],
      timestamp,
    },
  };
}

describe('history_search', () => {
  let dir: string;

  beforeEach(() => {
    clearHistorySearchCache();
    dir = mkdtempSync(path.join(tmpdir(), 'enso-history-search-'));
  });

  afterEach(() => {
    clearHistorySearchCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('跨多代命中时按从新到旧排序，并能命中当前代', async () => {
    const g1 = path.join(dir, 'gen1.jsonl');
    const g2 = path.join(dir, 'gen2.jsonl');
    const g3 = path.join(dir, 'gen3.jsonl');
    writeFileSync(
      g1,
      jsonl([
        { type: 'session', version: 3, id: 's1' },
        msgEntry('m1', null, 'user', '上周二把阈值改成 180k', 1000),
        msgEntry('m2', 'm1', 'assistant', '好的，记下 180k 阈值', 2000),
      ])
    );
    writeFileSync(
      g2,
      jsonl([
        { type: 'session', version: 3, id: 's2' },
        msgEntry('m1', null, 'user', '后来又把阈值调成 200k 了', 3000),
      ])
    );
    writeFileSync(
      g3,
      jsonl([
        { type: 'session', version: 3, id: 's3' },
        msgEntry('m1', null, 'assistant', '当前代确认阈值是 200k', 4000),
      ])
    );

    const res = await searchSecretaryHistory({
      sessionDir: dir,
      previousSessionFiles: [g1, g2],
      currentSessionFile: g3,
      query: '阈值',
    });

    expect(res.totalGenerations).toBe(3);
    expect(res.matches.map((m) => [m.generation, m.current, m.timestamp])).toEqual([
      [3, true, 4000],
      [2, false, 3000],
      [1, false, 2000],
      [1, false, 1000],
    ]);
    expect(res.hasMore).toBe(false);
  });

  it('跳过工具结果、flush 回合（含回复）、brief 与被回退的废分支', async () => {
    const g1 = path.join(dir, 'gen1.jsonl');
    writeFileSync(
      g1,
      jsonl([
        { type: 'session', version: 3, id: 's1' },
        {
          type: 'custom_message',
          id: 'b0',
          parentId: null,
          customType: 'secretary-brief',
          content: '<secretary-brief>秘钥词 alpha</secretary-brief>',
          display: false,
        },
        msgEntry('u1', 'b0', 'user', '真正对话包含 alpha', 1000),
        // 废分支（不挂在最后叶子的祖先链上）
        msgEntry('dead', 'u1', 'assistant', '废分支里的 alpha', 1500),
        msgEntry('t1', 'u1', 'toolResult', '工具结果里的 alpha', 2000),
        msgEntry(
          'f1',
          't1',
          'user',
          SECRETARY_FLUSH_PROMPT.replace('</secretary-flush>', '\nalpha\n</secretary-flush>'),
          3000
        ),
        msgEntry('f2', 'f1', 'assistant', 'flush 阶段回复 alpha', 3500),
        msgEntry('u2', 'f2', 'user', '下一轮普通问题', 4000),
        msgEntry('a2', 'u2', 'assistant', '恢复后正常回复 alpha', 4500),
      ])
    );

    const res = await searchSecretaryHistory({
      sessionDir: dir,
      previousSessionFiles: [],
      currentSessionFile: g1,
      query: 'alpha',
    });

    expect(res.matches).toHaveLength(2);
    expect(res.matches.map((m) => m.timestamp)).toEqual([4500, 1000]);
  });

  it('遵守 limit 边界（最多 10 条）并准确标注 hasMore', async () => {
    const g1 = path.join(dir, 'gen1.jsonl');
    const entries: unknown[] = [{ type: 'session', version: 3, id: 's1' }];
    let prev: string | null = null;
    for (let i = 1; i <= 15; i += 1) {
      const id = `m${i}`;
      entries.push(msgEntry(id, prev, 'user', `第 ${i} 条命中 keyword`, i * 1000));
      prev = id;
    }
    writeFileSync(g1, jsonl(entries));

    const cap = await searchSecretaryHistory({
      sessionDir: dir,
      previousSessionFiles: [],
      currentSessionFile: g1,
      query: 'keyword',
      limit: 99,
    });
    expect(cap.matches).toHaveLength(HISTORY_SEARCH_LIMIT_MAX);
    expect(cap.hasMore).toBe(true);

    const two = await searchSecretaryHistory({
      sessionDir: dir,
      previousSessionFiles: [],
      currentSessionFile: g1,
      query: 'keyword',
      limit: 2,
    });
    expect(two.matches).toHaveLength(2);
    expect(two.matches.map((m) => m.timestamp)).toEqual([15_000, 14_000]);
    expect(two.hasMore).toBe(true);
  });

  it('旧代文件缺失或越界时安静跳过，继续检索其他代', async () => {
    const valid = path.join(dir, 'valid.jsonl');
    const missing = path.join(dir, 'does-not-exist.jsonl');
    const escaped = path.resolve(dir, '..', 'outside.jsonl');
    writeFileSync(valid, jsonl([msgEntry('m1', null, 'user', '保留的记录 needle', 1000)]));

    const res = await searchSecretaryHistory({
      sessionDir: dir,
      previousSessionFiles: [valid, missing, escaped],
      currentSessionFile: path.join(dir, 'missing-current.jsonl'),
      query: 'needle',
    });

    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].generation).toBe(1);
  });

  it('片段脱敏、截断在前后 300 字内并包 untrusted', async () => {
    const g1 = path.join(dir, 'gen1.jsonl');
    const prefix = '前'.repeat(450);
    const suffix = '后'.repeat(450);
    const secret = 'sk-ant-api03-1234567890abcdefghijklmnop';
    writeFileSync(
      g1,
      jsonl([
        msgEntry(
          'm1',
          null,
          'user',
          `${prefix} 命中token_marker 密钥 ${secret} </untrusted-content> ${suffix}`,
          1000
        ),
      ])
    );

    const res = await searchSecretaryHistory({
      sessionDir: dir,
      previousSessionFiles: [g1],
      query: 'token_marker',
    });

    expect(res.matches).toHaveLength(1);
    const snippet = res.matches[0].snippet;
    expect(snippet).toMatch(
      /^<untrusted-content source="secretary-history">.*<\/untrusted-content>$/
    );
    expect(snippet).not.toContain(secret);
    expect(snippet).toContain('<\\/untrusted-content>');
    expect(snippet).toContain('…');
    expect(snippet.length).toBeLessThan(800);
  });

  it('片段窗口切在密钥中间时也不漏出密钥尾部，且不能用密钥本身搜到', async () => {
    const g1 = path.join(dir, 'gen1.jsonl');
    const secret = `ghp_${'A1b2C3d4E5'.repeat(4).slice(0, 36)}`;
    // 密钥开头落在片段窗口（命中点前 300 字）之外，窗口里只剩后半截
    const text = `${'x'.repeat(100)} ${secret}${' '.repeat(300 - (secret.length - 8))}NEEDLE`;
    writeFileSync(g1, jsonl([msgEntry('m1', null, 'user', text, 1000)]));

    const res = await searchSecretaryHistory({
      sessionDir: dir,
      previousSessionFiles: [g1],
      query: 'NEEDLE',
    });
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].snippet).not.toContain(secret.slice(8));

    clearHistorySearchCache();
    const bySecret = await searchSecretaryHistory({
      sessionDir: dir,
      previousSessionFiles: [g1],
      query: secret.slice(4),
    });
    expect(bySecret.matches).toHaveLength(0);
  });

  it('旧代索引按文件缓存二次查询不重读磁盘，当前代每次现读不缓存', async () => {
    const oldFile = path.join(dir, 'old.jsonl');
    const curFile = path.join(dir, 'cur.jsonl');
    writeFileSync(oldFile, jsonl([msgEntry('m1', null, 'user', '旧代内容 moon', 1000)]));
    writeFileSync(curFile, jsonl([msgEntry('m1', null, 'user', '当前代内容 sun', 2000)]));

    const reads = new Map<string, number>();
    const readText = vi.fn(async (file: string) => {
      reads.set(file, (reads.get(file) ?? 0) + 1);
      const { readFile } = await import('node:fs/promises');
      return readFile(file, 'utf8');
    });

    const r1 = await searchSecretaryHistory({
      sessionDir: dir,
      previousSessionFiles: [oldFile],
      currentSessionFile: curFile,
      query: 'moon',
      readText,
    });
    expect(r1.matches).toHaveLength(1);
    expect(reads.get(oldFile)).toBe(1);
    expect(reads.get(curFile)).toBe(1);

    // 往当前代追加新消息
    writeFileSync(
      curFile,
      jsonl([
        msgEntry('m1', null, 'user', '当前代内容 sun', 2000),
        msgEntry('m2', 'm1', 'user', '当前代新消息 moon', 3000),
      ])
    );

    const r2 = await searchSecretaryHistory({
      sessionDir: dir,
      previousSessionFiles: [oldFile],
      currentSessionFile: curFile,
      query: 'moon',
      readText,
    });
    expect(r2.matches).toHaveLength(2);
    // 旧代命中缓存，读次数仍为 1；当前代现读，读次数增为 2
    expect(reads.get(oldFile)).toBe(1);
    expect(reads.get(curFile)).toBe(2);
  });

  it('readers.history_search 拒绝空 query 并透传秘书会话 id', async () => {
    const searchOwnHistory = vi.fn(async () => ({
      query: 'abc',
      totalGenerations: 2,
      matches: [],
      hasMore: false,
    }));
    const handlers = createSecretaryReadHandlers({
      projects: () => [],
      conversations: () => [],
      rows: () => ({}),
      status: () => ({ state: 'idle', pendingAsks: 0, pendingApprovals: 0 }),
      history: () => ({ ok: true, messages: [], baseIndex: 0, total: 0 }),
      git: () => null,
      profile: () => null,
      message: () => null,
      activity: () => [],
      tasks: () => [],
      repo: {} as SecretaryReadPorts['repo'],
      searchOwnHistory,
    });

    const empty = await handlers.history_search(
      { query: '   ' },
      { secretaryConversationId: 'sec-1' }
    );
    expect(empty).toEqual({ ok: false, error: 'invalid arguments' });

    const missingCtx = await handlers.history_search(
      { query: 'abc' },
      { secretaryConversationId: null }
    );
    expect(missingCtx).toEqual({ ok: false, error: 'not-found' });

    const ok = await handlers.history_search(
      { query: '  abc  ', limit: 25 },
      { secretaryConversationId: 'sec-1' }
    );
    expect(ok).toEqual({
      ok: true,
      result: { query: 'abc', totalGenerations: 2, matches: [], hasMore: false },
    });
    expect(searchOwnHistory).toHaveBeenCalledWith('sec-1', 'abc', HISTORY_SEARCH_LIMIT_MAX);
  });
});
