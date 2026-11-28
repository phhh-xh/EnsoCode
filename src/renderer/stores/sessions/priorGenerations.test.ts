import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  chatSurfaceBusy,
  chatTimelineActivity,
  evictColdMessages,
  MESSAGE_CACHE_TTL_MS,
  needsHistoryHydration,
} from './messageCache';
import {
  applyAgentEvent,
  emptyProjection,
  prependPriorGenerationPage,
  type SessionProjection,
} from './reducer';
import { buildTimeline } from './timeline';

const msg = (role: 'user' | 'assistant', text: string, timestamp = 1000): ProjectedMessage => ({
  role,
  content: [{ type: 'text', text }],
  timestamp,
});

describe('PR4 renderer 跨代投影与冷缓存边界', () => {
  it('snapshot(baseIndex:0) 只替换当前代，不碰 priorGenerations', () => {
    const initial: SessionProjection = {
      ...emptyProjection,
      generation: 'g1',
      priorGenerations: {
        pages: [msg('user', 'old', 100), { kind: 'generation', at: 200 }],
        cursor: { genIndex: 0 },
      },
    };
    const next = applyAgentEvent(initial, 'sec-1', {
      type: 'snapshot',
      sessions: [
        {
          identity: { sessionId: 'sec-1', generation: 'g1' },
          status: 'idle',
          messages: [msg('user', 'new', 300)],
          commands: [],
          baseIndex: 0,
        },
      ],
    });
    expect(next.messages).toHaveLength(1);
    expect(next.priorGenerations).toEqual(initial.priorGenerations);
  });

  it('收到 session-rotated 后原地并入当前代权威消息并追加分隔行，不闪空', () => {
    const state: SessionProjection = {
      ...emptyProjection,
      generation: 'g1',
      lastSeq: 5,
      messages: [msg('user', 'hi', 100), msg('assistant', 'hello', 120)],
    };
    const rotated = applyAgentEvent(state, 'sec-1', {
      type: 'session-rotated',
      identity: { sessionId: 'sec-1', generation: 'g1' },
      seq: 6,
      sessionFile: '/tmp/g2.jsonl',
      previousSessionFile: '/tmp/g1.jsonl',
      at: 500,
    });
    expect(rotated.messages).toEqual([]);
    expect(rotated.historyBaseIndex).toBeUndefined();
    expect(rotated.priorGenerations?.pages).toEqual([
      msg('user', 'hi', 100),
      msg('assistant', 'hello', 120),
      { kind: 'generation', at: 500 },
    ]);
  });

  it('prependPriorGenerationPage 前置旧代页，buildTimeline 拼接两段且渲染 generation 分隔行', () => {
    let state: SessionProjection = {
      ...emptyProjection,
      messages: [msg('user', 'current', 300)],
      priorGenerations: { pages: [], cursor: { genIndex: 0 } },
    };
    state = prependPriorGenerationPage(
      state,
      [msg('user', 'old', 100), { kind: 'generation', at: 200, generationIndex: 1 }],
      null
    );
    expect(state.priorGenerations?.cursor).toBeNull();

    const timeline = buildTimeline(state.messages, false, [], undefined, {
      priorGenerations: state.priorGenerations?.pages,
    });
    expect(timeline.map((item) => item.kind)).toEqual(['user', 'generation', 'user']);
    expect(new Set(timeline.map((item) => item.key)).size).toBe(3);
  });

  it('当前代 0 条可见消息但已有 priorGenerations 时不卡 Preparing、不锁输入，冷驱逐同步清空 priorGenerations', () => {
    const priorGenerations = {
      pages: [msg('user', 'old', 100), { kind: 'generation' as const, at: 200 }],
      cursor: null,
    };
    expect(
      needsHistoryHydration({
        started: true,
        sessionFile: '/tmp/g2.jsonl',
        messages: [],
        priorGenerations,
        spawning: false,
      })
    ).toBe(false);
    expect(
      chatSurfaceBusy({
        started: true,
        sessionFile: '/tmp/g2.jsonl',
        messages: [],
        priorGenerations,
        spawning: false,
        status: 'idle',
      })
    ).toBe(false);
    expect(
      chatTimelineActivity({
        started: true,
        sessionFile: '/tmp/g2.jsonl',
        messages: [],
        priorGenerations,
        spawning: false,
        status: 'idle',
      })
    ).toBeNull();

    const evicted = evictColdMessages(
      {
        sec: {
          messages: [],
          customEntries: [],
          priorGenerations,
          lastActiveAt: 100,
        },
      },
      'other',
      { sec: 0 },
      MESSAGE_CACHE_TTL_MS + 1
    );
    expect(evicted.sec.priorGenerations).toBeUndefined();
  });
});
