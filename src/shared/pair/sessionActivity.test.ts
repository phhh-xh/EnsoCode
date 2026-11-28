import { describe, expect, it } from 'vitest';
import {
  activityKeepsLive,
  pairSessionActivity,
  treeWorkRunning,
  withChildBackground,
} from './sessionActivity';

describe('pairSessionActivity', () => {
  it('自身回合在跑是 running；回合已结束但后台任务 / 子代理在跑是 background，不算完成', () => {
    expect(pairSessionActivity({ status: 'running' })).toBe('running');
    expect(pairSessionActivity({ status: 'running', backgroundRunning: true })).toBe('running');
    expect(pairSessionActivity({ status: 'idle', backgroundRunning: true })).toBe('background');
    expect(pairSessionActivity({ status: 'idle', unread: true, backgroundRunning: true })).toBe(
      'background'
    );
    // 旧桌面不发 backgroundRunning：目录里 coworker 子会话在跑也算
    expect(pairSessionActivity({ status: 'idle' }, true)).toBe('background');
  });

  it('待审批与待回答都是 waiting，优先于运行与后台', () => {
    expect(pairSessionActivity({ status: 'running', pendingApprovalCount: 1 })).toBe('waiting');
    expect(
      pairSessionActivity({ status: 'idle', pendingAskCount: 1, backgroundRunning: true })
    ).toBe('waiting');
  });

  it('等提醒、排队、等上游恢复、失败与桌面侧栏同序', () => {
    expect(pairSessionActivity({ status: 'idle', parked: 'reminder' })).toBe('reminder');
    expect(pairSessionActivity({ status: 'idle', parked: 'reminder', unread: true })).toBe(
      'reminder'
    );
    expect(pairSessionActivity({ status: 'idle', parked: 'upstream' })).toBe('queued');
    expect(pairSessionActivity({ status: 'queued' })).toBe('queued');
    expect(pairSessionActivity({ status: 'queued', queueFailed: 'boom' })).toBe('failed');
    expect(pairSessionActivity({ status: 'failed', backgroundRunning: true })).toBe('failed');
    // 后台在跑压过提醒：先等任务，提醒稍后
    expect(
      pairSessionActivity({ status: 'idle', parked: 'reminder', backgroundRunning: true })
    ).toBe('background');
  });

  it('真正收尾：空闲 / 未读', () => {
    expect(pairSessionActivity({ status: 'idle' })).toBe('idle');
    expect(pairSessionActivity({ status: 'idle', unread: true })).toBe('unread');
    expect(pairSessionActivity({ status: 'idle', backgroundRunning: false })).toBe('idle');
  });
});

describe('activityKeepsLive', () => {
  it('运行、等后台、等你都让灵动岛留着；其余收起', () => {
    expect(activityKeepsLive('running')).toBe(true);
    expect(activityKeepsLive('background')).toBe(true);
    expect(activityKeepsLive('waiting')).toBe(true);
    for (const a of ['reminder', 'queued', 'failed', 'unread', 'idle'] as const)
      expect(activityKeepsLive(a)).toBe(false);
  });
});

describe('treeWorkRunning', () => {
  it('回合结束时子代理 / coworker 在跑或等你、后台命令在跑都算还有活', () => {
    expect(treeWorkRunning('running', [])).toBe(true);
    expect(treeWorkRunning('waiting', [])).toBe(true);
    expect(treeWorkRunning('idle', [{ status: 'running' }])).toBe(true);
    expect(treeWorkRunning('idle', [{ status: 'done' }, { status: 'failed' }])).toBe(false);
    expect(treeWorkRunning('error', [])).toBe(false);
    expect(treeWorkRunning('idle', [])).toBe(false);
  });
});

describe('withChildBackground', () => {
  it('旧桌面：coworker 子会话在跑，父会话补 backgroundRunning；其余不动', () => {
    const catalog: {
      id: string;
      parentId?: string;
      status: string;
      backgroundRunning?: boolean;
    }[] = [
      { id: 'p', status: 'idle' },
      { id: 'p::c', parentId: 'p', status: 'running' },
      { id: 'q', status: 'idle' },
      { id: 'q::c', parentId: 'q', status: 'idle' },
    ];
    const out = withChildBackground(catalog);
    expect(out.map((c) => [c.id, c.backgroundRunning])).toEqual([
      ['p', true],
      ['p::c', undefined],
      ['q', undefined],
      ['q::c', undefined],
    ]);
    expect(out[2]).toBe(catalog[2]);
  });

  it('新桌面算好的 true 原样保留', () => {
    const row = { id: 'p', status: 'idle', backgroundRunning: true };
    expect(withChildBackground([row])[0]).toBe(row);
  });
});
