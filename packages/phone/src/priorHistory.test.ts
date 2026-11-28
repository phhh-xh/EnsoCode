import { isPhoneCommand } from '@enso/pair';
import {
  applyGuestEvent,
  applyGuestPriorHistory,
  applyGuestSnapshot,
  emptyGuestView,
} from '@shared/pair/guestProjection';
import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';

const text = (role: 'user' | 'assistant', body: string, timestamp = 1000): ProjectedMessage => ({
  role,
  content: [{ type: 'text', text: body }],
  timestamp,
});

describe('PR4b 手机端跨代分页与就地换代投影', () => {
  it('history 帧带可选 cursor 通过协议白名单校验', () => {
    expect(
      isPhoneCommand({
        type: 'history',
        sessionId: 'sec-1',
        beforeIndex: 0,
        cursor: { genIndex: 1, beforeIndex: 20 },
      })
    ).toBe(true);
  });

  it('applyGuestPriorHistory 支持 replace 覆盖与翻页前置，且 applyGuestSnapshot 保留已有旧代', () => {
    let view = emptyGuestView();
    // 首屏补齐
    view = applyGuestPriorHistory(view, {
      entries: [text('user', 'gen2', 200), { kind: 'generation', at: 300, generationIndex: 2 }],
      cursor: { genIndex: 0 },
      replace: true,
    });
    expect(view.priorGenerations?.pages).toHaveLength(2);
    expect(view.priorGenerations?.cursor).toEqual({ genIndex: 0 });

    // 上翻拉出更早一代，前置到已有旧代之前
    view = applyGuestPriorHistory(view, {
      entries: [text('user', 'gen1', 100), { kind: 'generation', at: 150, generationIndex: 1 }],
      cursor: null,
    });
    expect(view.priorGenerations?.pages).toHaveLength(4);
    expect(view.priorGenerations?.cursor).toBeNull();

    // 快照更新当前代，不破坏已加载的旧代
    const [snapped] = applyGuestSnapshot(new Map([['sec-1', view]]), {
      sessions: [
        {
          sessionId: 'sec-1',
          baseIndex: 0,
          messages: [text('user', 'gen3', 400)],
          status: 'idle',
        },
      ],
    });
    expect(snapped?.view.messages.size).toBe(1);
    expect(snapped?.view.priorGenerations).toEqual(view.priorGenerations);
  });

  it('收到 session-rotated 事件时当前代消息原地并入旧代并追加分隔项，lastIndex 回退到 -1', () => {
    const view = emptyGuestView();
    view.messages.set(0, text('user', 'hello', 100));
    view.messages.set(1, text('assistant', 'world', 120));

    const result = applyGuestEvent(view, {
      type: 'session-rotated',
      sessionFile: '/tmp/g2.jsonl',
      at: 500,
    });
    expect(result.lastIndex).toBe(-1);
    expect(result.view.messages.size).toBe(0);
    expect(result.view.priorGenerations?.pages).toEqual([
      text('user', 'hello', 100),
      text('assistant', 'world', 120),
      { kind: 'generation', at: 500 },
    ]);
  });
});
