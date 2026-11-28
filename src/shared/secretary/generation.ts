/**
 * 秘书上下文分代控制器：纯状态机。
 * 同一代内只追加，回合结束超过阈值且热缓存时触发静默 flush，成功后立即就地换代。
 */

export const SECRETARY_GENERATION_TOKENS_MAX = 200_000;
export const SECRETARY_GENERATION_RATIO = 0.6;
export const SECRETARY_GENERATION_MAX_FAILURES = 2;
export const SECRETARY_GENERATION_STALE_MS = 10 * 60_000;

export const SECRETARY_FLUSH_OPEN = '<secretary-flush>';
export const SECRETARY_FLUSH_CLOSE = '</secretary-flush>';
export const SECRETARY_BRIEF_CUSTOM_TYPE = 'secretary-brief';

export const SECRETARY_FLUSH_PROMPT = `${SECRETARY_FLUSH_OPEN}
把本代中尚未落盘的口头指示、偏好和纠正写进记忆（用 preference/learning），更新待办，然后 silence_turn。
${SECRETARY_FLUSH_CLOSE}`;

export type SecretaryGenerationPhase = 'idle' | 'flushing' | 'rotating';

export interface SecretaryGenerationState {
  phase: SecretaryGenerationPhase;
  since: number;
  /** 同一代内连续 flush/rotate 失败次数；换代成功后归零 */
  failures: number;
  /** 正在跑的 flush 回合投递 id，用于精确核对 turn-completed / delivery-rejected 归属 */
  flushDeliveryId?: string;
  /** 本次 flush 是否已被 worker 确认启动（delivery-settled）；未启动前的 turn-completed 属于别的轮次 */
  flushStarted?: boolean;
}

export type SecretaryGenerationAction =
  | 'none'
  | 'pauseOutbox'
  | 'resumeOutbox'
  | 'sendFlush'
  | 'sendRotate';

export type SecretaryGenerationEvent =
  | {
      type: 'turnEnded';
      enabled: boolean;
      aborted: boolean;
      failed: boolean;
      inDelivery: boolean;
      occupancyUsed: number;
      contextWindow?: number;
      now: number;
    }
  | { type: 'flushStarted'; deliveryId: string }
  | { type: 'flushRejected'; deliveryId: string; busy?: boolean; now: number }
  | { type: 'flushEnded'; ok: boolean; enabled: boolean; now: number }
  | { type: 'rotateResult'; status: 'ok' | 'busy' | 'error'; now: number }
  | { type: 'disabled'; now: number }
  | { type: 'crashRecovered'; now: number };

export function initialGenerationState(now = 0): SecretaryGenerationState {
  return { phase: 'idle', since: now, failures: 0 };
}

export function generationTokenThreshold(contextWindow?: number): number {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return SECRETARY_GENERATION_TOKENS_MAX;
  }
  return Math.min(
    SECRETARY_GENERATION_TOKENS_MAX,
    Math.floor(contextWindow * SECRETARY_GENERATION_RATIO)
  );
}

export function parseGenerationState(raw: unknown): SecretaryGenerationState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return initialGenerationState();
  const obj = raw as Record<string, unknown>;
  const phase: SecretaryGenerationPhase =
    obj.phase === 'flushing' || obj.phase === 'rotating' ? obj.phase : 'idle';
  const since = typeof obj.since === 'number' && Number.isFinite(obj.since) ? obj.since : 0;
  const failures =
    typeof obj.failures === 'number' && Number.isInteger(obj.failures) && obj.failures >= 0
      ? obj.failures
      : 0;
  const flushDeliveryId =
    typeof obj.flushDeliveryId === 'string' && obj.flushDeliveryId.length > 0
      ? obj.flushDeliveryId
      : undefined;
  const flushStarted = obj.flushStarted === true ? true : undefined;
  return {
    phase,
    since,
    failures,
    ...(phase === 'flushing' && flushDeliveryId ? { flushDeliveryId } : {}),
    ...(phase === 'flushing' && flushStarted ? { flushStarted } : {}),
  };
}

export function nextGenerationStep(
  state: SecretaryGenerationState,
  event: SecretaryGenerationEvent
): { state: SecretaryGenerationState; actions: SecretaryGenerationAction[] } {
  switch (event.type) {
    case 'crashRecovered': {
      if (state.phase === 'idle') return { state, actions: ['none'] };
      if (event.now - state.since < SECRETARY_GENERATION_STALE_MS) {
        return { state, actions: ['none'] };
      }
      return {
        state: {
          phase: 'idle',
          since: event.now,
          failures: state.failures + 1,
        },
        actions: ['resumeOutbox'],
      };
    }

    case 'disabled': {
      if (state.phase === 'idle') return { state, actions: ['none'] };
      // 关闭开关时不强行中止正在跑的 flush 回合，但取消待执行的换代并确保恢复 outbox
      if (state.phase === 'rotating') {
        return {
          state: { phase: 'idle', since: event.now, failures: state.failures },
          actions: ['resumeOutbox'],
        };
      }
      return { state, actions: ['none'] };
    }

    case 'turnEnded': {
      if (state.phase !== 'idle') return { state, actions: ['none'] };
      if (!event.enabled || event.aborted || event.failed || event.inDelivery) {
        return { state, actions: ['none'] };
      }
      if (state.failures >= SECRETARY_GENERATION_MAX_FAILURES) {
        return { state, actions: ['none'] };
      }
      const threshold = generationTokenThreshold(event.contextWindow);
      if (!Number.isFinite(event.occupancyUsed) || event.occupancyUsed <= threshold) {
        return { state, actions: ['none'] };
      }
      return {
        state: {
          phase: 'flushing',
          since: event.now,
          failures: state.failures,
        },
        actions: ['pauseOutbox', 'sendFlush'],
      };
    }

    case 'flushStarted': {
      if (state.phase !== 'flushing') return { state, actions: ['none'] };
      if (state.flushDeliveryId && state.flushDeliveryId !== event.deliveryId) {
        return { state, actions: ['none'] };
      }
      return {
        state: { ...state, flushDeliveryId: event.deliveryId, flushStarted: true },
        actions: ['none'],
      };
    }

    case 'flushRejected': {
      if (state.phase !== 'flushing') return { state, actions: ['none'] };
      if (state.flushDeliveryId && state.flushDeliveryId !== event.deliveryId) {
        return { state, actions: ['none'] };
      }
      // 忙即拒（用户抢跑）不算失败，不消耗重试次数；其他拒绝算失败一次
      return {
        state: {
          phase: 'idle',
          since: event.now,
          failures: event.busy ? state.failures : state.failures + 1,
        },
        actions: ['resumeOutbox'],
      };
    }

    case 'flushEnded': {
      if (state.phase !== 'flushing') return { state, actions: ['none'] };
      if (!event.ok) {
        return {
          state: {
            phase: 'idle',
            since: event.now,
            failures: state.failures + 1,
          },
          actions: ['resumeOutbox'],
        };
      }
      if (!event.enabled) {
        // flush 期间用户关闭了分代开关：不再换代，直接恢复投递
        return {
          state: {
            phase: 'idle',
            since: event.now,
            failures: state.failures,
          },
          actions: ['resumeOutbox'],
        };
      }
      return {
        state: {
          phase: 'rotating',
          since: event.now,
          failures: state.failures,
        },
        actions: ['sendRotate'],
      };
    }

    case 'rotateResult': {
      if (state.phase !== 'rotating') return { state, actions: ['none'] };
      if (event.status === 'ok') {
        return {
          state: { phase: 'idle', since: event.now, failures: 0 },
          actions: ['resumeOutbox'],
        };
      }
      if (event.status === 'busy') {
        return {
          state: { phase: 'idle', since: event.now, failures: state.failures },
          actions: ['resumeOutbox'],
        };
      }
      return {
        state: { phase: 'idle', since: event.now, failures: state.failures + 1 },
        actions: ['resumeOutbox'],
      };
    }
  }
}
