import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  initialGenerationState,
  SECRETARY_FLUSH_PROMPT,
  type SecretaryGenerationState,
} from '@shared/secretary/generation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushRotatedSessionFile } from '../../../agent/supervisor';
import { createSecretaryHost, type SecretaryHostPorts } from './host';

const temps: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'enso-gen-pr5-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PR5 换代集成防线', () => {
  it('flushRotatedSessionFile 落盘后追加第一条真实 user 消息不会触发 wx 报 EEXIST', () => {
    const sessionDir = makeTempDir();
    const cwd = makeTempDir();
    const manager = SessionManager.create(cwd, sessionDir);
    const oldFile = manager.getSessionFile();

    const newFile = manager.newSession({ ...(oldFile ? { parentSession: oldFile } : {}) });
    expect(newFile).toBeTruthy();
    manager.appendCustomMessageEntry(
      'secretary-brief',
      '<secretary-brief>snap</secretary-brief>',
      false
    );
    flushRotatedSessionFile(
      manager as unknown as Parameters<typeof flushRotatedSessionFile>[0],
      newFile!
    );

    // 紧接着追加第一条真实用户消息：不能抛 EEXIST
    expect(() =>
      manager.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: '新一代第一条消息' }],
        timestamp: Date.now(),
      })
    ).not.toThrow();

    const lines = readFileSync(newFile!, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; customType?: string });
    expect(lines.map((item) => item.type)).toEqual(['session', 'custom_message', 'message']);
    expect(lines[1]?.customType).toBe('secretary-brief');

    // buildSessionContext 包含简报与第一条用户消息
    const ctx = manager.buildSessionContext();
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0]).toMatchObject({ role: 'custom', customType: 'secretary-brief' });
  });

  it('forwardToContact 在 status:idle 清空 lastUserText 后仍按 flushTurns 硬屏蔽 onToolCall 和 onTurnReply', async () => {
    let genState: SecretaryGenerationState = initialGenerationState(0);
    let enabled = true;
    const contact = {
      onTurnStart: vi.fn(),
      onTurnEnd: vi.fn(),
      onTurnSilent: vi.fn(),
      onTurnReply: vi.fn(),
      onToolCall: vi.fn(),
      onAskRequest: vi.fn(),
      onAskResolved: vi.fn(),
    };
    const sendFlush = vi.fn(() => ({ ok: true }));
    const rotate = vi.fn(async () => ({ ok: true }));
    const promptOutbox = vi.fn(() => ({ ok: true }));

    const dispatchFile = {
      version: 1 as const,
      dispatched: {},
      outbox: [],
      activity: [],
      proposals: {},
      relays: {},
      pending: {},
      named: [] as string[],
    };

    const ports: SecretaryHostPorts = {
      enabled: () => true,
      file: () => structuredClone(dispatchFile),
      peekFile: () => dispatchFile,
      save: () => {},
      rows: () => ({}),
      conversations: () => [],
      projects: () => [],
      status: () => ({ state: 'idle', pendingAsks: 0, pendingApprovals: 0 }),
      alive: () => true,
      prompt: promptOutbox,
      resume: async () => ({ ok: true }),
      newId: () => 'flush-delivery-1',
      profile: () => null,
      todos: () => [],
      saveTodos: () => {},
      schedules: () => [],
      saveSchedules: () => {},
      notify: () => {},
      contact: contact as unknown as SecretaryHostPorts['contact'],
      isSecretaryConversation: (id) => id === 'sec-home',
      publish: () => {},
      now: () => 10_000,
      generation: {
        enabled: () => enabled,
        state: () => genState,
        saveState: (next) => {
          genState = next;
        },
        occupancy: () => ({ used: 250_000, contextWindow: 1_000_000 }),
        sendFlush,
        buildBrief: async () => '<secretary-brief>ok</secretary-brief>',
        rotate,
      },
    };

    const host = createSecretaryHost(ports);
    const id = { sessionId: 'sec-home', generation: 'g1' };

    // 1. 普通轮次结束且超阈值 -> 触发 flush
    host.onAgentEvent({ type: 'turn-completed', identity: id, seq: 1, turnId: 't1' }, []);
    expect(sendFlush).toHaveBeenCalledWith('sec-home', 'flush-delivery-1');
    expect(genState.phase).toBe('flushing');

    // 2. flush 回合开始、调工具、status:idle 先到（清空 lastUserText）、然后模型忘了调 silence_turn 直接回了正文
    host.onAgentEvent(
      { type: 'delivery-settled', identity: id, seq: 2, deliveryId: 'flush-delivery-1' },
      []
    );
    host.onAgentEvent(
      {
        type: 'message-upsert',
        identity: id,
        seq: 3,
        index: 0,
        message: { role: 'user', content: [{ type: 'text', text: SECRETARY_FLUSH_PROMPT }] },
      },
      []
    );
    host.onAgentEvent({ type: 'status', identity: id, seq: 4, status: 'running' }, []);
    host.onAgentEvent(
      {
        type: 'message-upsert',
        identity: id,
        seq: 5,
        index: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc1', name: 'memory_capture', arguments: {} }],
        },
      },
      []
    );
    // status:idle 先于 turn-completed 到达
    host.onAgentEvent({ type: 'status', identity: id, seq: 6, status: 'idle' }, []);
    host.onAgentEvent(
      {
        type: 'turn-completed',
        identity: id,
        seq: 7,
        turnId: 't2',
        digest: {
          firstUserText: SECRETARY_FLUSH_PROMPT,
          userText: SECRETARY_FLUSH_PROMPT,
          assistantText: '我整理好了记忆！',
        },
      },
      []
    );

    // 手机收不到 typing、收不到 memory_capture 工具进度、也收不到忘调 silence_turn 的正文回复！
    expect(contact.onTurnStart).not.toHaveBeenCalled();
    expect(contact.onToolCall).not.toHaveBeenCalled();
    expect(contact.onTurnReply).not.toHaveBeenCalled();
    expect(contact.onTurnSilent).toHaveBeenCalledWith('sec-home');

    // 等异步 buildBrief + rotate 完成
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rotate).toHaveBeenCalledWith('sec-home', '<secretary-brief>ok</secretary-brief>');
    expect(genState.phase).toBe('idle');
    expect(genState.failures).toBe(0);

    // 3. 关闭开关后再推超阈值，不再触发 flush
    enabled = false;
    sendFlush.mockClear();
    host.onAgentEvent({ type: 'turn-completed', identity: id, seq: 8, turnId: 't3' }, []);
    expect(sendFlush).not.toHaveBeenCalled();
  });

  it('flush 回合中排进来的用户消息照常回到手机，不被当成 flush 屏蔽', () => {
    const { host, contact } = flushHarness();
    const id = { sessionId: 'sec-home', generation: 'g1' };
    host.onAgentEvent({ type: 'turn-completed', identity: id, seq: 1, turnId: 't1' }, []);
    host.onAgentEvent(
      { type: 'delivery-settled', identity: id, seq: 2, deliveryId: 'flush-1' },
      []
    );
    host.onAgentEvent(
      {
        type: 'message-upsert',
        identity: id,
        seq: 3,
        index: 4,
        message: { role: 'user', content: [{ type: 'text', text: SECRETARY_FLUSH_PROMPT }] },
      },
      []
    );
    host.onAgentEvent({ type: 'status', identity: id, seq: 4, status: 'running' }, []);
    // 主人从手机发来的话被 followUp 并进同一轮
    host.onAgentEvent(
      {
        type: 'message-upsert',
        identity: id,
        seq: 5,
        index: 5,
        message: { role: 'user', content: [{ type: 'text', text: '帮我看下 #700 合了没' }] },
      },
      []
    );
    host.onAgentEvent(
      {
        type: 'message-upsert',
        identity: id,
        seq: 6,
        index: 6,
        message: { role: 'assistant', content: [{ type: 'text', text: '#700 已合并' }] },
      },
      []
    );
    host.onAgentEvent({ type: 'status', identity: id, seq: 7, status: 'idle' }, []);
    host.onAgentEvent(
      {
        type: 'turn-completed',
        identity: id,
        seq: 8,
        turnId: 't2',
        digest: {
          firstUserText: SECRETARY_FLUSH_PROMPT,
          userText: '帮我看下 #700 合了没',
          assistantText: '#700 已合并',
        },
      },
      []
    );
    expect(contact.onTurnReply).toHaveBeenCalledWith('sec-home', '#700 已合并', expect.anything());
    expect(contact.onTurnSilent).not.toHaveBeenCalled();
  });
});

function flushHarness() {
  let genState: SecretaryGenerationState = initialGenerationState(0);
  const contact = {
    onTurnStart: vi.fn(),
    onTurnEnd: vi.fn(),
    onTurnSilent: vi.fn(),
    onTurnReply: vi.fn(),
    onToolCall: vi.fn(),
    onAskRequest: vi.fn(),
    onAskResolved: vi.fn(),
  };
  const dispatchFile = {
    version: 1 as const,
    dispatched: {},
    outbox: [],
    activity: [],
    proposals: {},
    relays: {},
    pending: {},
    named: [] as string[],
  };
  const ports: SecretaryHostPorts = {
    enabled: () => true,
    file: () => structuredClone(dispatchFile),
    peekFile: () => dispatchFile,
    save: () => {},
    rows: () => ({}),
    conversations: () => [],
    projects: () => [],
    status: () => ({ state: 'idle', pendingAsks: 0, pendingApprovals: 0 }),
    alive: () => true,
    prompt: vi.fn(() => ({ ok: true })),
    resume: async () => ({ ok: true }),
    newId: () => 'flush-1',
    profile: () => null,
    todos: () => [],
    saveTodos: () => {},
    schedules: () => [],
    saveSchedules: () => {},
    notify: () => {},
    contact: contact as unknown as SecretaryHostPorts['contact'],
    isSecretaryConversation: (id) => id === 'sec-home',
    publish: () => {},
    now: () => 10_000,
    generation: {
      enabled: () => true,
      state: () => genState,
      saveState: (next) => {
        genState = next;
      },
      occupancy: () => ({ used: 250_000, contextWindow: 1_000_000 }),
      sendFlush: vi.fn(() => ({ ok: true })),
      buildBrief: async () => '<secretary-brief>ok</secretary-brief>',
      rotate: vi.fn(async () => ({ ok: true })),
    },
  };
  return { host: createSecretaryHost(ports), contact, state: () => genState };
}
