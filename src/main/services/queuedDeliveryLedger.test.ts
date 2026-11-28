import { describe, expect, it } from 'vitest';
import { claimQueuedDelivery, releaseQueuedDelivery } from './queuedDeliveryLedger';

describe('queuedDeliveryLedger', () => {
  it('同一会话同一排队 id 只认领一次；撤销后可再认领；会话之间互不影响', () => {
    expect(claimQueuedDelivery('ledger-a', 'q1')).toBe(true);
    expect(claimQueuedDelivery('ledger-a', 'q1')).toBe(false);
    expect(claimQueuedDelivery('ledger-b', 'q1')).toBe(true);
    releaseQueuedDelivery('ledger-a', 'q1');
    expect(claimQueuedDelivery('ledger-a', 'q1')).toBe(true);
  });

  it('每会话只留最近 64 条，最早的被挤出后不再拦', () => {
    expect(claimQueuedDelivery('ledger-cap', 'oldest')).toBe(true);
    for (let i = 0; i < 63; i++) claimQueuedDelivery('ledger-cap', `q${i}`);
    expect(claimQueuedDelivery('ledger-cap', 'oldest')).toBe(false);
    claimQueuedDelivery('ledger-cap', 'one-more');
    expect(claimQueuedDelivery('ledger-cap', 'oldest')).toBe(true);
  });
});
