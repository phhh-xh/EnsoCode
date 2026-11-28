import type { HostToPhone, PairPriorGenerationCursor } from '@enso/pair';

type HistoryFrame = Extract<HostToPhone, { type: 'history' | 'prior-history' }>;

export type PriorPageReader = (
  cursor: PairPriorGenerationCursor
) => Promise<
  | { ok: true; entries: unknown[]; cursor: PairPriorGenerationCursor | null }
  | { ok: false; code: string; error: string }
>;

async function readPrior(
  read: PriorPageReader,
  cursor: PairPriorGenerationCursor
): Promise<{ entries: unknown[]; cursor: PairPriorGenerationCursor | null } | null> {
  try {
    const result = await read(cursor);
    return result.ok ? result : null;
  } catch {
    return null;
  }
}

/**
 * 手机带游标的跨代翻页请求。手机发出 history 后一直挂着「加载中」，只有 history / prior-history
 * 应答能收掉：读不到旧代也必须回一个空 history 帧，不能静默。
 */
export async function priorCursorAnswer(
  sessionId: string,
  cursor: PairPriorGenerationCursor,
  read: PriorPageReader
): Promise<HistoryFrame> {
  const page = await readPrior(read, cursor);
  return page
    ? { type: 'prior-history', sessionId, entries: page.entries, cursor: page.cursor }
    : { type: 'history', sessionId, baseIndex: 0, messages: [] };
}

/**
 * 当前代分页应答：history 帧永远立刻发（空页也发），旧手机不认 prior-history，只有它能收掉加载态。
 * 当前代翻到头且有旧代时，prior 再补一帧上一代尾页给新手机。
 */
export function currentPageAnswer(
  sessionId: string,
  page: { baseIndex: number; messages: unknown[] },
  initialCursor: PairPriorGenerationCursor | null,
  read: PriorPageReader | undefined
): { history: HistoryFrame; prior: Promise<HistoryFrame | null> | null } {
  const history: HistoryFrame = {
    type: 'history',
    sessionId,
    baseIndex: page.baseIndex,
    messages: page.messages,
  };
  if (page.messages.length > 0 || !initialCursor || !read) return { history, prior: null };
  return {
    history,
    prior: readPrior(read, initialCursor).then((tail) =>
      tail ? { type: 'prior-history', sessionId, entries: tail.entries, cursor: tail.cursor } : null
    ),
  };
}
