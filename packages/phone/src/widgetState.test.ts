import type { CatalogEntry } from '@enso/pair';
import { withChildBackground } from '@shared/pair/sessionActivity';
import { describe, expect, it } from 'vitest';
import { buildWidgetSnapshotFromCatalog, DeskWidgetTracker } from './widgetState';

const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
  id: 's1',
  title: '会话',
  projectName: 'proj',
  projectId: 'p',
  status: 'idle',
  updatedAt: 10,
  ...over,
});

const snapshot = (catalog: CatalogEntry[]) =>
  buildWidgetSnapshotFromCatalog({
    deviceLabel: 'Mac',
    connectionState: 'online',
    transport: 'relay',
    rttMs: null,
    catalog,
    activeId: null,
    now: 1000,
  });

describe('buildWidgetSnapshotFromCatalog 活跃态与桌面一致', () => {
  it('回合结束但后台任务在跑：不是已完成，灵动岛继续显示等待后台任务', () => {
    const snap = snapshot([entry({ backgroundRunning: true })]);
    expect(snap).toMatchObject({
      runningCount: 1,
      activeSessionId: 's1',
      activeStatus: 'background',
      activeDetail: '等待后台任务',
    });
    expect(snap.sessions[0]?.status).toBe('background');
  });

  it('旧桌面没有 backgroundRunning：目录里 coworker 子会话在跑，父会话算等后台', () => {
    const snap = snapshot(
      withChildBackground([
        entry({ id: 'p1' }),
        entry({ id: 'p1::c', parentId: 'p1', status: 'running' }),
      ])
    );
    expect(snap.activeStatus).toBe('background');
    expect(snap.sessions.map((s) => [s.id, s.status])).toEqual([['p1', 'background']]);
  });

  it('自身在跑优先于等后台', () => {
    const snap = snapshot([
      entry({ id: 'bg', backgroundRunning: true, updatedAt: 20 }),
      entry({ id: 'run', status: 'running', updatedAt: 5 }),
    ]);
    expect(snap).toMatchObject({
      runningCount: 2,
      activeStatus: 'running',
      activeSessionId: 'run',
    });
  });

  it('只等提醒：灵动岛收起，但状态是等待提醒而不是已完成', () => {
    const snap = snapshot([entry({ parked: 'reminder' })]);
    expect(snap).toMatchObject({
      runningCount: 0,
      pendingCount: 0,
      activeStatus: 'reminder',
      activeDetail: '等待提醒',
    });
    expect(snap.sessions[0]?.status).toBe('reminder');
  });

  it('真正收尾才是空闲', () => {
    const snap = snapshot([entry({ backgroundRunning: false })]);
    expect(snap).toMatchObject({ runningCount: 0, activeStatus: 'idle' });
    expect(snap.sessions[0]?.status).toBe('idle');
  });
});

describe('DeskWidgetTracker 后台任务', () => {
  const event = (e: object) => JSON.stringify([e]);
  const identity = { sessionId: 's1' };
  const build = (tracker: DeskWidgetTracker) =>
    tracker.buildSnapshot({
      deviceLabel: 'Mac',
      connectionState: 'online',
      transport: '',
      rttMs: null,
      now: 1,
    });

  it('回合结束时后台任务仍在跑 → 等后台；任务结束后才空闲', () => {
    const tracker = new DeskWidgetTracker();
    tracker.applyAgentEventPayload(event({ type: 'status', identity, status: 'running' }));
    tracker.applyAgentEventPayload(
      event({ type: 'task-started', identity, task: { taskId: 't1', status: 'running' } })
    );
    tracker.applyAgentEventPayload(event({ type: 'status', identity, status: 'idle' }));
    tracker.applyAgentEventPayload(event({ type: 'turn-completed', identity }));
    expect(build(tracker)).toMatchObject({ activeStatus: 'background', runningCount: 1 });

    expect(
      tracker.applyAgentEventPayload(
        event({ type: 'task-ended', identity, taskId: 't1', status: 'done' })
      )
    ).toBe(true);
    expect(build(tracker)).toMatchObject({ activeStatus: 'idle', runningCount: 0 });
  });

  it('快照带回运行中的后台任务与子代理', () => {
    const tracker = new DeskWidgetTracker();
    tracker.applyAgentEventPayload(
      event({
        type: 'snapshot',
        sessions: [
          {
            identity,
            status: 'idle',
            backgroundTasks: [{ taskId: 't1', status: 'done' }],
            subagents: [{ id: 'a1', status: 'running' }],
          },
        ],
      })
    );
    expect(build(tracker).activeStatus).toBe('background');
    tracker.applyAgentEventPayload(
      event({ type: 'subagent-update', identity, agent: { id: 'a1', status: 'completed' } })
    );
    expect(build(tracker).activeStatus).toBe('idle');
  });
});
