import type { SecretaryBoard, SecretaryCard } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  board: null as unknown as SecretaryBoard,
  calls: [] as { name: string; args: unknown }[],
  upstreamHealth: [] as {
    provider: string;
    providerName?: string;
    state: 'degraded' | 'probing';
    since: number;
    errorKind: 'transient' | 'quota';
    lastError: string;
    waitingCount: number;
    nextProbeAt?: number;
  }[],
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params
        ? key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(params[token] ?? ''))
        : `[${key}]`,
    locale: 'zh',
    tNode: (key: string, params?: Record<string, unknown>) => {
      const parts: unknown[] = [];
      const regex = /\{\{(\w+)\}\}/g;
      let last = 0;
      let m: RegExpExecArray | null = regex.exec(key);
      while (m) {
        if (m.index > last) parts.push(key.slice(last, m.index));
        parts.push(params?.[m[1]] ?? m[0]);
        last = m.index + m[0].length;
        m = regex.exec(key);
      }
      if (last < key.length) parts.push(key.slice(last));
      return parts;
    },
  }),
}));
vi.mock('@/stores/settings', () => {
  const state = { projects: [{ id: 'p-sec', kind: 'secretary' }] };
  const useSettingsStore = (selector: (s: unknown) => unknown) => selector(state);
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});
vi.mock('@/stores/sessions', () => {
  const state = {
    activeId: 'sec',
    conversations: { sec: { projectId: 'p-sec' }, c1: { projectId: 'p1' } },
    selectConversation: (id: string) => h.calls.push({ name: 'selectConversation', args: id }),
    get upstreamHealth() {
      return h.upstreamHealth;
    },
  };
  const useSessionsStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useSessionsStore.getState = () => state;
  useSessionsStore.subscribe = () => () => undefined;
  return { useSessionsStore };
});
vi.mock('@/stores/secretary', () => ({
  focusedSecretaryId: () => undefined,
  useSecretaryStore: (selector: (state: unknown) => unknown) =>
    selector({ secretary: { board: h.board }, secretaries: [], states: {}, focusedId: null }),
}));

const { SecretaryWorkbench } = await import('./SecretaryWorkbench');
const { useSecretaryReturn } = await import('@/stores/secretaryReturn');

const NOW = new Date(2024, 4, 15, 15, 0).getTime();

const sessionCard = (
  over: Partial<Extract<SecretaryCard, { kind: 'session' }>> = {}
): SecretaryCard => ({
  kind: 'session',
  conversationId: 'c1',
  projectId: 'p1',
  projectName: 'enso-code',
  title: '写 hello.txt',
  state: 'error',
  startedAt: NOW - 60_000,
  stateSince: NOW - 60_000,
  secretaryConversationId: 'sec',
  ...over,
});

const board = (needsYou: SecretaryCard[]): SecretaryBoard => ({
  needsYou,
  running: [],
  todos: [],
  done: [],
});

let root: Root;
let container: HTMLElement;

async function render(node: ReactElement) {
  await act(async () => {
    root.render(node);
  });
}

const dismissButton = () => container.querySelector('[data-enso="secretary-dismiss-result"]');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.calls = [];
  h.upstreamHealth = [];
  useSecretaryReturn.setState({ back: null });
  h.board = board([]);
  (dom.window as unknown as Record<string, unknown>).electronAPI = {
    secretary: {
      list: async () => [],
      onListChanged: () => () => {},
      dismissResult: async (conversationId: string) => {
        h.calls.push({ name: 'dismissResult', args: conversationId });
        return { ok: true };
      },
      dismissPending: async (pendingId: string) => {
        h.calls.push({ name: 'dismissPending', args: pendingId });
        return { ok: true };
      },
      onStateChanged: () => () => {},
    },
    agent: {
      abort: async (conversationId: string, options?: unknown) => {
        h.calls.push({ name: 'abort', args: [conversationId, options] });
      },
    },
  };
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SecretaryWorkbench 结果卡', () => {
  it('失败结果的卡给「知道了」，点了交给 Main 清掉，且不展示冗长的 lastText 噪声', async () => {
    h.board = board([
      sessionCard({ result: 'failed', lastText: 'Error stack trace detail only for agent' }),
    ]);
    await render(<SecretaryWorkbench name="小安" />);
    expect(container.textContent).not.toContain('Error stack trace detail only for agent');
    const button = dismissButton();
    expect(button?.textContent).toBe('[Got it]');
    act(() => {
      (button as unknown as HTMLElement).click();
    });
    expect(h.calls).toContainEqual({ name: 'dismissResult', args: 'c1' });
  });

  it('实时审批的卡不给「知道了」，清了也不会消失', async () => {
    h.board = board([sessionCard({ state: 'waiting', result: 'needs-user' })]);
    await render(<SecretaryWorkbench name="小安" />);
    expect(container.querySelector('[data-enso="secretary-needs-you"]')).not.toBeNull();
    expect(dismissButton()).toBeNull();
    const cardEl = container.querySelector('[data-enso="secretary-card"]');
    expect(cardEl?.getAttribute('data-tone')).not.toBe('decision');
    expect(cardEl?.textContent).toContain('[Waiting for you]');
  });

  it('goal-complete 且带 needsUser 的卡：中性标签「完成 · 需要你」、summary 灰字、每条「需要你：」前缀，不显示正文噪声', async () => {
    const longNeed = '请确认是否在宿主发版后合并并上架插件 #62，并同步更新仓库发布说明';
    h.board = board([
      sessionCard({
        state: 'idle',
        result: 'goal-complete',
        lastText: '- | | PR 拆分方式 | 合并为 1 个 PR，内部按插件拆成 ...',
        summary: 'relay 已部署到 59dc0c231',
        needsUser: ['是否合并上架 #62', longNeed],
      }),
    ]);
    await render(<SecretaryWorkbench name="小安" />);
    const cardEl = container.querySelector('[data-enso="secretary-card"]');
    expect(cardEl).not.toBeNull();
    expect(cardEl?.getAttribute('data-tone')).toBe('decision');
    expect(cardEl?.className).not.toContain('border-warning');
    expect(cardEl?.textContent).toContain('[Done · needs you]');
    expect(cardEl?.textContent).not.toContain('[Goal complete]');
    expect(cardEl?.textContent).not.toContain('PR 拆分方式');
    expect(
      container.querySelector('[data-enso="secretary-card-needs-user-summary"]')?.textContent
    ).toBe('relay 已部署到 59dc0c231');
    const needItems = Array.from(
      container.querySelectorAll('[data-enso="secretary-card-needs-user-item"]')
    );
    expect(needItems.map((el) => el.textContent)).toEqual([
      'Needs you: 是否合并上架 #62',
      `Needs you: ${longNeed}`,
    ]);
    expect(needItems[1]?.getAttribute('title')).toBe(longNeed);
    const button = dismissButton();
    expect(button?.textContent).toBe('[Got it]');
    act(() => {
      (button as unknown as HTMLElement).click();
    });
    expect(h.calls).toContainEqual({ name: 'dismissResult', args: 'c1' });
  });

  it('「打开会话」跳过去后，目标会话给返回秘书', async () => {
    h.board = board([sessionCard({ result: 'failed' })]);
    await render(<SecretaryWorkbench name="小安" />);
    act(() => {
      (container.querySelector('[data-enso="secretary-card-open"]') as HTMLElement).click();
    });
    expect(h.calls).toContainEqual({ name: 'selectConversation', args: 'c1' });
    expect(useSecretaryReturn.getState().back).toEqual({ from: 'sec', to: 'c1' });
  });

  it('在跑的卡没有结果，不给「知道了」', async () => {
    h.board = board([sessionCard({ state: 'running' })]);
    await render(<SecretaryWorkbench name="小安" />);
    expect(dismissButton()).toBeNull();
  });

  it('工作台只保留需要你、进行中、待办三块，不再渲染计数卡、Triage、需求线程与动态时间线', async () => {
    h.board = {
      ...board([sessionCard({ result: 'failed' })]),
      running: [
        sessionCard({ conversationId: 'r1', title: '在跑一', state: 'running' }),
        sessionCard({ conversationId: 'r2', title: '在跑二', state: 'running' }),
      ],
      done: [
        sessionCard({
          conversationId: 'tr1',
          state: 'idle',
          result: 'goal-complete',
          triage: true,
          needsUser: ['删临时文件'],
        }),
      ],
      threads: [
        {
          id: 'dt-1',
          channel: 'telegram',
          chatId: '-100',
          messageId: '42',
          summary: '修登录',
          requesterIsOwner: true,
          sessionId: 'c1',
          sessionTitle: '写 hello.txt',
          status: 'open',
          milestones: [],
          createdAt: NOW - 1000,
          updatedAt: NOW - 1000,
        },
      ],
    };
    await render(<SecretaryWorkbench name="小安" />);
    const order = Array.from(
      container.querySelectorAll('[data-enso="secretary-workbench"] > [data-enso]')
    ).map((el) => el.getAttribute('data-enso'));
    expect(order).toEqual([
      'secretary-needs-you',
      'secretary-workbench-running',
      'secretary-todos',
    ]);
    expect(container.querySelector('[data-enso="secretary-stats"]')).toBeNull();
    expect(container.querySelector('[data-enso="secretary-triage"]')).toBeNull();
    expect(container.querySelector('[data-enso="secretary-threads"]')).toBeNull();
    expect(container.querySelector('[data-enso="secretary-feed"]')).toBeNull();
    const running = container.querySelector('[data-enso="secretary-workbench-running"]');
    expect(
      Array.from(running?.querySelectorAll('[data-enso="secretary-running-row"]') ?? []).map((el) =>
        el.getAttribute('data-conversation')
      )
    ).toEqual(['r1', 'r2']);
  });
});

describe('SecretaryWorkbench 等依赖的派发出问题', () => {
  const pendingCard = (): SecretaryCard => ({
    kind: 'pending',
    projectName: 'enso-code',
    pending: {
      id: 'pend-1',
      projectId: 'p1',
      secretaryConversationId: 'sec',
      createdAt: NOW - 60_000,
      updatedAt: NOW - 1000,
      status: 'failed',
      problem: 'dependency-failed',
      failedDependency: 'c1',
      after: ['c1'],
      draft: { projectId: 'p1', prompt: '接着改', worktree: false },
    },
  });
  const ignoreButton = () =>
    container.querySelector('[data-enso="secretary-dismiss-pending"]') as HTMLElement | null;

  it('给「忽略」，点了按派发 id 交给 Main 移除', async () => {
    h.board = board([pendingCard()]);
    await render(<SecretaryWorkbench name="小安" />);
    expect(ignoreButton()?.textContent).toBe('[Ignore]');
    act(() => ignoreButton()?.click());
    expect(h.calls).toContainEqual({ name: 'dismissPending', args: 'pend-1' });
    expect(h.calls.some((call) => call.name === 'dismissResult')).toBe(false);
  });

  it('没有会话可开：不给「打开会话」「停止」「知道了」', async () => {
    h.board = board([pendingCard()]);
    await render(<SecretaryWorkbench name="小安" />);
    expect(container.querySelector('[data-enso="secretary-card-open"]')).toBeNull();
    expect(dismissButton()).toBeNull();
    expect(container.textContent).not.toContain('[Stop]');
    expect(container.textContent).not.toContain('[Open session]');
  });

  it('和会话结果卡并排时，结果卡的「知道了」照旧', async () => {
    h.board = board([pendingCard(), sessionCard({ result: 'failed' })]);
    await render(<SecretaryWorkbench name="小安" />);
    act(() => (dismissButton() as unknown as HTMLElement).click());
    expect(h.calls).toContainEqual({ name: 'dismissResult', args: 'c1' });
    expect(ignoreButton()).not.toBeNull();
  });
});

describe('SecretaryWorkbench 单一待办列表与去重', () => {
  it('已在「进行中」展示的派发待办不在待办里重复列出，未派发与出问题的待办合并在待办列表内', async () => {
    h.board = {
      needsYou: [],
      running: [
        sessionCard({
          conversationId: 'a61340f1',
          title: '监听事件按对象认领',
          state: 'running',
        }),
      ],
      todos: [
        {
          id: 't1',
          text: '监听事件按组认领',
          createdAt: 1,
          updatedAt: 2,
          conversationId: 'a61340f1',
          sessionTitle: '监听事件按对象认领',
          sessionState: 'running',
          phase: 'active',
        },
        {
          id: 't2',
          text: '未写入恢复清单的待办',
          createdAt: 1,
          updatedAt: 2,
          conversationId: 'c2',
          sessionTitle: '崩溃会话',
          sessionState: 'idle',
          problem: 'stopped',
          phase: 'problem',
        },
        {
          id: 't3',
          text: '记一条普通待办',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      done: [],
    };
    await render(<SecretaryWorkbench name="小安" />);
    const todoRows = Array.from(container.querySelectorAll('[data-enso="secretary-todo"]'));
    expect(todoRows).toHaveLength(2);
    expect(todoRows[0]?.getAttribute('data-phase')).toBe('problem');
    expect(todoRows[0]?.querySelector('[data-enso="secretary-todo-problem"]')?.textContent).toBe(
      '[The session was stopped]'
    );
    expect(todoRows[1]?.textContent).toContain('记一条普通待办');
  });
});

describe('SecretaryWorkbench 上游健康横幅', () => {
  it('有可读 providerName 时显示名字而不是运行时哈希 id，倒计时照显', async () => {
    h.upstreamHealth = [
      {
        provider: 'enso-d8cd1cfb1018-28077c58',
        providerName: 'xAI (Grok)',
        state: 'degraded',
        since: NOW - 60_000,
        errorKind: 'transient',
        lastError: '503 No available accounts',
        waitingCount: 2,
        nextProbeAt: NOW + 161_000,
      },
    ];
    h.board = { needsYou: [], running: [sessionCard()], todos: [], done: [] };
    await render(<SecretaryWorkbench name="小安" />);
    const banner = container.querySelector('[data-enso="secretary-upstream-health"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('xAI (Grok)');
    expect(banner?.textContent).not.toContain('enso-d8cd1cfb1018-28077c58');
  });

  it('条目找不到名字（供应商已删/换 key）时退回原 id', async () => {
    h.upstreamHealth = [
      {
        provider: 'enso-d8cd1cfb1018-28077c58',
        state: 'degraded',
        since: NOW - 60_000,
        errorKind: 'transient',
        lastError: '503',
        waitingCount: 1,
      },
    ];
    h.board = { needsYou: [], running: [sessionCard()], todos: [], done: [] };
    await render(<SecretaryWorkbench name="小安" />);
    const banner = container.querySelector('[data-enso="secretary-upstream-health"]');
    expect(banner?.textContent).toContain('enso-d8cd1cfb1018-28077c58');
  });
});
