import { describe, expect, it } from 'vitest';
import { buildGenerationBrief, estimateBriefTokens } from './brief';
import {
  generationTokenThreshold,
  initialGenerationState,
  nextGenerationStep,
  SECRETARY_FLUSH_PROMPT,
  SECRETARY_GENERATION_STALE_MS,
  SECRETARY_GENERATION_TOKENS_MAX,
} from './generation';
import { buildRecapTurns } from './recap';
import { isPureSessionUpdate, isSecretaryFlushText } from './silence';

describe('nextGenerationStep 状态机', () => {
  it('按上下文窗口计算阈值，上限 200k', () => {
    expect(generationTokenThreshold(undefined)).toBe(SECRETARY_GENERATION_TOKENS_MAX);
    expect(generationTokenThreshold(1_000_000)).toBe(200_000);
    expect(generationTokenThreshold(200_000)).toBe(120_000);
  });

  it('开关关闭、投递中、aborted 或 turn-failed 均不触发 flush', () => {
    const idle = initialGenerationState(100);
    for (const patch of [
      { enabled: false },
      { inDelivery: true },
      { aborted: true },
      { failed: true },
      { occupancyUsed: 150_000, contextWindow: 1_000_000 },
    ]) {
      const res = nextGenerationStep(idle, {
        type: 'turnEnded',
        enabled: true,
        aborted: false,
        failed: false,
        inDelivery: false,
        occupancyUsed: 220_000,
        contextWindow: 1_000_000,
        now: 200,
        ...patch,
      });
      expect(res.state.phase).toBe('idle');
      expect(res.actions).toEqual(['none']);
    }
  });

  it('超阈值触发 pauseOutbox + sendFlush，成功后进入 rotating，rotate ok 归零 failures 并 resumeOutbox', () => {
    const step1 = nextGenerationStep(initialGenerationState(100), {
      type: 'turnEnded',
      enabled: true,
      aborted: false,
      failed: false,
      inDelivery: false,
      occupancyUsed: 210_000,
      contextWindow: 1_000_000,
      now: 200,
    });
    expect(step1.state.phase).toBe('flushing');
    expect(step1.actions).toEqual(['pauseOutbox', 'sendFlush']);

    const step2 = nextGenerationStep(step1.state, {
      type: 'flushEnded',
      ok: true,
      enabled: true,
      now: 300,
    });
    expect(step2.state.phase).toBe('rotating');
    expect(step2.actions).toEqual(['sendRotate']);

    const step3 = nextGenerationStep(step2.state, {
      type: 'rotateResult',
      status: 'ok',
      now: 400,
    });
    expect(step3.state).toEqual({ phase: 'idle', since: 400, failures: 0 });
    expect(step3.actions).toEqual(['resumeOutbox']);
  });

  it('aborted/失败的 flush 累计 failures，最多重试 1 次（failures 达 2 后本代不再触发）', () => {
    let state = initialGenerationState(100);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const start = nextGenerationStep(state, {
        type: 'turnEnded',
        enabled: true,
        aborted: false,
        failed: false,
        inDelivery: false,
        occupancyUsed: 250_000,
        contextWindow: 1_000_000,
        now: attempt * 1000,
      });
      expect(start.state.phase).toBe('flushing');
      const failed = nextGenerationStep(start.state, {
        type: 'flushEnded',
        ok: false,
        enabled: true,
        now: attempt * 1000 + 50,
      });
      expect(failed.state.phase).toBe('idle');
      expect(failed.state.failures).toBe(attempt);
      expect(failed.actions).toEqual(['resumeOutbox']);
      state = failed.state;
    }

    // 第 3 次不再触发，交给 pi 原生压缩
    const third = nextGenerationStep(state, {
      type: 'turnEnded',
      enabled: true,
      aborted: false,
      failed: false,
      inDelivery: false,
      occupancyUsed: 280_000,
      contextWindow: 1_000_000,
      now: 5000,
    });
    expect(third.state.phase).toBe('idle');
    expect(third.actions).toEqual(['none']);
  });

  it('flush 抢跑 busy 拒绝与 rotate busy 均回到 idle 且不消耗 failures，并恢复 outbox', () => {
    const flushing = { phase: 'flushing' as const, since: 100, failures: 0, flushDeliveryId: 'd1' };
    const rej = nextGenerationStep(flushing, {
      type: 'flushRejected',
      deliveryId: 'd1',
      busy: true,
      now: 120,
    });
    expect(rej.state).toEqual({ phase: 'idle', since: 120, failures: 0 });
    expect(rej.actions).toEqual(['resumeOutbox']);

    const rotating = { phase: 'rotating' as const, since: 200, failures: 0 };
    const busy = nextGenerationStep(rotating, { type: 'rotateResult', status: 'busy', now: 250 });
    expect(busy.state).toEqual({ phase: 'idle', since: 250, failures: 0 });
    expect(busy.actions).toEqual(['resumeOutbox']);
  });

  it('flush 期间或 rotating 期间关闭实验开关：安全取消换代并恢复 outbox', () => {
    const flushing = { phase: 'flushing' as const, since: 100, failures: 0 };
    const endedDisabled = nextGenerationStep(flushing, {
      type: 'flushEnded',
      ok: true,
      enabled: false,
      now: 200,
    });
    expect(endedDisabled.state.phase).toBe('idle');
    expect(endedDisabled.actions).toEqual(['resumeOutbox']);

    const rotating = { phase: 'rotating' as const, since: 100, failures: 0 };
    const disabled = nextGenerationStep(rotating, { type: 'disabled', now: 200 });
    expect(disabled.state.phase).toBe('idle');
    expect(disabled.actions).toEqual(['resumeOutbox']);
  });

  it('flushing / rotating 超过 10 分钟视为崩溃恢复，回到 idle 并 failures+1', () => {
    const stuck = { phase: 'flushing' as const, since: 1000, failures: 0 };
    const stillFresh = nextGenerationStep(stuck, {
      type: 'crashRecovered',
      now: 1000 + SECRETARY_GENERATION_STALE_MS - 1,
    });
    expect(stillFresh.state.phase).toBe('flushing');
    expect(stillFresh.actions).toEqual(['none']);

    const recovered = nextGenerationStep(stuck, {
      type: 'crashRecovered',
      now: 1000 + SECRETARY_GENERATION_STALE_MS,
    });
    expect(recovered.state).toEqual({
      phase: 'idle',
      since: 1000 + SECRETARY_GENERATION_STALE_MS,
      failures: 1,
    });
    expect(recovered.actions).toEqual(['resumeOutbox']);
  });
});

describe('buildGenerationBrief 与 flush 识别', () => {
  it('空状态仍输出带快照时间的简报结构', () => {
    const brief = buildGenerationBrief({
      snapshotAt: Date.parse('2026-11-28T12:00:00.000Z'),
      todos: [],
      dispatches: [],
      schedules: [],
      daily: [],
      recentMessages: [],
      rules: [],
    });
    expect(brief).toContain('<secretary-brief>');
    expect(brief).toContain('2026-11-28T12:00:00.000Z');
    expect(brief).toContain('</secretary-brief>');
  });

  it('保留外部消息的 untrusted 包裹、跳过 flush 回合和简报，并在超预算时按顺序从后往前截断', () => {
    expect(isSecretaryFlushText(SECRETARY_FLUSH_PROMPT)).toBe(true);
    expect(isPureSessionUpdate(SECRETARY_FLUSH_PROMPT)).toBe(true);

    const brief = buildGenerationBrief({
      snapshotAt: Date.parse('2026-11-28T12:00:00.000Z'),
      todos: [{ id: 't1', text: '高优待办', status: 'todo' }],
      dispatches: [{ conversationId: 'c1', title: '修 bug', state: 'running', goal: '完成 PR5' }],
      schedules: [{ id: 'sch1', name: '早报', spec: '0 9 * * *' }],
      daily: [{ at: Date.parse('2026-11-28T09:00:00.000Z'), kind: 'goal-complete', title: 'PR4' }],
      recentMessages: [
        { role: 'custom', customType: 'secretary-brief', text: 'old brief' },
        { role: 'user', text: SECRETARY_FLUSH_PROMPT },
        { role: 'assistant', text: 'flush done' },
        {
          role: 'user',
          text: '来自 Telegram：<untrusted-content source="telegram">回复不要用表格</untrusted-content>',
        },
        { role: 'assistant', text: '好的，记住了。' },
      ],
      rules: [
        {
          id: 'm1',
          spaceId: 'project:sec',
          unitType: 'preference',
          content: '回复不要用表格',
          importance: 0.9,
          updatedAt: 1000,
        },
      ],
    });

    expect(brief).toContain('高优待办');
    expect(brief).toContain('session:c1');
    expect(brief).toContain(
      '<untrusted-content source="telegram">回复不要用表格</untrusted-content>'
    );
    expect(brief).not.toContain('flush done');
    expect(brief).not.toContain('old brief');

    // recap 同样跳过 flush 回合和简报
    const recap = buildRecapTurns(
      [
        { role: 'user', text: '<secretary-brief>snap</secretary-brief>' },
        { role: 'assistant', text: 'ack' },
        { role: 'user', text: SECRETARY_FLUSH_PROMPT },
        { role: 'assistant', text: 'flushed' },
        { role: 'user', text: '正常问题' },
        { role: 'assistant', text: '正常回答' },
      ],
      3
    );
    expect(recap).toEqual([{ user: '正常问题', assistant: '正常回答' }]);

    // 小预算：先保留高优待办，从后往前截掉常驻规则与尾部
    const tight = buildGenerationBrief({
      snapshotAt: Date.parse('2026-11-28T12:00:00.000Z'),
      todos: [{ id: 't1', text: '必须保留的待办', status: 'todo' }],
      dispatches: [],
      schedules: [],
      daily: [],
      recentMessages: [
        { role: 'user', text: '长对话'.repeat(200) },
        { role: 'assistant', text: '长回复'.repeat(200) },
      ],
      rules: [
        {
          id: 'm1',
          spaceId: 'global',
          unitType: 'preference',
          content: '常驻规则尾部内容',
          importance: 0.9,
          updatedAt: 1000,
        },
      ],
      maxTokens: 160,
    });
    expect(tight).toContain('必须保留的待办');
    expect(tight).not.toContain('常驻规则尾部内容');
    expect(estimateBriefTokens(tight)).toBeLessThanOrEqual(180);
  });
});
