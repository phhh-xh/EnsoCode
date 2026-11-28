import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { transcriptMessages } from '../../agent/transcript';
import { removeConversationSessionFiles } from './sessionFileCleanup';
import {
  displayMessages,
  projectWindow,
  readPriorGenerationPageFromFiles,
} from './sessionHistoryTail';
import { SourceAuthorityRegistry } from './sourceAuthorityRegistry';

const temps: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'enso-gen-pr4-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function userEntry(id: string, text: string, timestamp: number): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp,
    },
  } as unknown as SessionEntry;
}

function hiddenBriefEntry(id: string, text: string, timestamp: number): SessionEntry {
  return {
    type: 'custom_message',
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    customType: 'secretary-brief',
    content: text,
    display: false,
  } as unknown as SessionEntry;
}

describe('PR4 分代数据模型与隐藏简报过滤', () => {
  it('SourceAuthorityRegistry 的 rotateSessionFile 与 markReady 均幂等，并持久化 previousSessionFiles', () => {
    const root = makeTempDir();
    const projectDir = path.join(root, 'proj');
    mkdirSync(projectDir, { recursive: true });
    const registryFile = path.join(root, 'authority.json');

    const registry = new SourceAuthorityRegistry({ registryFile });
    const createdProject = registry.createProject({ requestId: 'r1', path: projectDir });
    expect(createdProject.accepted).toBe(true);
    if (!createdProject.accepted) return;

    const createdConv = registry.createConversation({
      requestId: 'r2',
      projectId: createdProject.value.projectId,
      projectVersion: createdProject.value.version,
    });
    expect(createdConv.accepted).toBe(true);
    if (!createdConv.accepted) return;

    const id = createdConv.value.conversationId;
    const f1 = path.join(root, 'g1.jsonl');
    const f2 = path.join(root, 'g2.jsonl');
    const f3 = path.join(root, 'g3.jsonl');
    const model = { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' };

    registry.markReady(id, f1, model);
    const revAfterReady = registry.revision;
    // 相同 sessionFile 再次 markReady 幂等
    registry.markReady(id, f1, model);
    expect(registry.revision).toBe(revAfterReady);

    expect(registry.rotateSessionFile(id, f2)).toBe(true);
    // 相同新文件再次 rotate 幂等
    expect(registry.rotateSessionFile(id, f2)).toBe(false);
    expect(registry.rotateSessionFile(id, f3)).toBe(true);

    const conv = registry.conversation(id);
    expect(conv?.sessionFile).toBe(f3);
    expect(conv?.previousSessionFiles).toEqual([f1, f2]);

    // 重新从磁盘加载，previousSessionFiles 完整保留
    const reloaded = new SourceAuthorityRegistry({ registryFile });
    expect(reloaded.conversation(id)?.sessionFile).toBe(f3);
    expect(reloaded.conversation(id)?.previousSessionFiles).toEqual([f1, f2]);
  });

  it('display:false 的 custom_message 在读盘 displayMessages 与 worker transcriptMessages 两条路径均被过滤且下标对齐', () => {
    const branch: SessionEntry[] = [
      hiddenBriefEntry('e0', 'brief body', 1000),
      userEntry('e1', 'hello', 2000),
      userEntry('e2', 'world', 3000),
    ];
    const fromDisk = displayMessages(branch);
    const fromWorker = transcriptMessages({ getBranch: () => branch }, [
      {
        role: 'custom',
        customType: 'secretary-brief',
        content: 'brief body',
        display: false,
        timestamp: 1000,
      },
      { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 2000 },
      { role: 'user', content: [{ type: 'text', text: 'world' }], timestamp: 3000 },
    ]);

    expect(fromDisk).toHaveLength(2);
    expect(fromWorker).toHaveLength(2);
    expect(projectWindow(fromDisk, fromDisk.length).baseIndex).toBe(0);
    expect(projectWindow(fromWorker, fromWorker.length).baseIndex).toBe(0);
  });

  it('跨两代分页游标正确、跳过缺失或越界文件，并在代交界插入 generation 分隔项', async () => {
    const sessionDir = makeTempDir();
    const g1 = path.join(sessionDir, 'g1.jsonl');
    const missing = path.join(sessionDir, 'missing.jsonl');
    const escaped = path.join(sessionDir, '..', 'escape.jsonl');
    const g2 = path.join(sessionDir, 'g2.jsonl');
    writeFileSync(g1, '');
    writeFileSync(g2, '');

    const store = new Map<string, unknown[]>([
      [g1, [{ role: 'user', content: [{ type: 'text', text: 'gen1-msg' }], timestamp: 100 }]],
      [g2, [{ role: 'user', content: [{ type: 'text', text: 'gen2-msg' }], timestamp: 200 }]],
    ]);
    const readDisplay = async (file: string) => store.get(file) ?? [];

    const currentFile = path.join(sessionDir, 'g3.jsonl');
    writeFileSync(currentFile, '');
    const previousSessionFiles = [g1, missing, escaped, g2];
    const p1 = await readPriorGenerationPageFromFiles(
      sessionDir,
      previousSessionFiles,
      { genIndex: previousSessionFiles.length - 1 },
      readDisplay,
      { currentSessionFile: currentFile, fileTime: () => 500 }
    );
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.entries).toHaveLength(2);
    expect(p1.entries[0]).toMatchObject({ role: 'user' });
    expect(p1.entries[1]).toMatchObject({ kind: 'generation', at: 500 });
    expect(p1.cursor).toEqual({ genIndex: 2 });

    // 第二页自动跳过 escaped 和 missing，直接读到 g1，之后游标归 null（nextFile 指向缺失文件时回落到消息末时间戳 100）
    const p2 = await readPriorGenerationPageFromFiles(
      sessionDir,
      previousSessionFiles,
      p1.cursor!,
      readDisplay,
      { currentSessionFile: currentFile, fileTime: (f) => (f === missing ? undefined : 400) }
    );
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    expect(p2.entries).toHaveLength(2);
    expect(p2.entries[1]).toMatchObject({ kind: 'generation', at: 100 });
    expect(p2.cursor).toBeNull();
  });

  it('removeConversationSessionFiles 连同 previousSessionFiles 一并清理，越界文件不动', () => {
    const root = makeTempDir();
    const sessionDir = path.join(root, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const f1 = path.join(sessionDir, 'g1.jsonl');
    const f2 = path.join(sessionDir, 'g2.jsonl');
    const outside = path.join(root, 'outside.jsonl');
    writeFileSync(f1, 'a');
    writeFileSync(f2, 'b');
    writeFileSync(outside, 'keep');

    removeConversationSessionFiles({
      sessionDir,
      conversationId: 'conv-1',
      sessionFile: f2,
      previousSessionFiles: [f1, outside],
    });

    expect(existsSync(f1)).toBe(false);
    expect(existsSync(f2)).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });
});
