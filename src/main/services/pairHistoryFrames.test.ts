import { applyGuestHistory, emptyGuestView } from '@shared/pair/guestProjection';
import { describe, expect, it } from 'vitest';
import { currentPageAnswer, type PriorPageReader, priorCursorAnswer } from './pairHistoryFrames';

const failing: PriorPageReader = async () => ({ ok: false, code: 'unavailable', error: 'x' });
const throwing: PriorPageReader = async () => {
  throw new Error('boom');
};
const tail: PriorPageReader = async () => ({
  ok: true,
  entries: [{ kind: 'message', index: 3 }],
  cursor: { genIndex: 0, beforeIndex: 3 },
});

describe('手机分页应答', () => {
  it('跨代游标读失败或抛错时回空 history 帧，手机的加载态能收掉', async () => {
    for (const read of [failing, throwing]) {
      expect(await priorCursorAnswer('s', { genIndex: 0 }, read)).toEqual({
        type: 'history',
        sessionId: 's',
        baseIndex: 0,
        messages: [],
      });
    }
    expect(await priorCursorAnswer('s', { genIndex: 0 }, tail)).toMatchObject({
      type: 'prior-history',
      cursor: { genIndex: 0, beforeIndex: 3 },
    });
  });

  it('当前代空页也立刻回 history 帧（旧手机不认 prior-history），有旧代时再补上一代尾页', async () => {
    const empty = { baseIndex: 0, messages: [] };
    const none = currentPageAnswer('s', empty, null, tail);
    expect(none.history).toEqual({ type: 'history', sessionId: 's', baseIndex: 0, messages: [] });
    expect(none.prior).toBeNull();

    const withPrior = currentPageAnswer('s', empty, { genIndex: 1 }, tail);
    expect(withPrior.history.type).toBe('history');
    expect(await withPrior.prior).toMatchObject({ type: 'prior-history', sessionId: 's' });

    const priorFails = currentPageAnswer('s', empty, { genIndex: 1 }, failing);
    expect(priorFails.history.type).toBe('history');
    expect(await priorFails.prior).toBeNull();

    // 空 history 帧并入后视图不变
    const view = emptyGuestView();
    expect(applyGuestHistory(view, none.history as never)).toBe(view);
  });

  it('当前代有内容时只回 history 帧，不读旧代', async () => {
    let reads = 0;
    const counting: PriorPageReader = async (cursor) => {
      reads += 1;
      return tail(cursor);
    };
    const answer = currentPageAnswer(
      's',
      { baseIndex: 2, messages: [{}] },
      { genIndex: 0 },
      counting
    );
    expect(answer.history).toMatchObject({ baseIndex: 2, messages: [{}] });
    expect(answer.prior).toBeNull();
    expect(reads).toBe(0);
  });
});
