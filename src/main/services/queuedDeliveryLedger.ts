/**
 * 已投递的排队消息 id（按会话，只留最近若干条）。leader 渲染器与 headless 宿主都从这里过：
 * 交接时上一个驱动方的投递可能还在途、写回也可能没落盘，新驱动方队列副本里还留着同一条。
 * 排队 id 全局唯一，投过一次就不该再投，所以只记不忘（有上限），下发失败才撤销。
 */
const PER_SESSION_LIMIT = 64;
const delivered = new Map<string, string[]>();

/** 首次投递返回 true 并记账；已投过返回 false */
export function claimQueuedDelivery(sessionId: string, queuedId: string): boolean {
  const ids = delivered.get(sessionId) ?? [];
  if (ids.includes(queuedId)) return false;
  ids.push(queuedId);
  if (ids.length > PER_SESSION_LIMIT) ids.shift();
  delivered.set(sessionId, ids);
  return true;
}

/** 没送到 worker：撤销记账，退回队列的同一条还能重投 */
export function releaseQueuedDelivery(sessionId: string, queuedId: string): void {
  const ids = delivered.get(sessionId);
  if (!ids) return;
  const next = ids.filter((id) => id !== queuedId);
  if (next.length > 0) delivered.set(sessionId, next);
  else delivered.delete(sessionId);
}
