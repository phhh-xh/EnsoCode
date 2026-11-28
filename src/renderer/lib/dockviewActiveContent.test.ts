// @vitest-environment jsdom
import { createDockview, type DockviewApi, type IContentRenderer } from 'dockview-react';
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeSidePanelLayout } from '../stores/sidePanel/layoutSanitize';

// 秘书面板偶发白屏：未激活的 renderer:'always' 面板（插件页）把激活面板的内容挤出分组内容区。
// 用真 dockview 跑，断言用户看得到的 DOM：激活面板的内容要挂在内容区里。

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const hosts: HTMLElement[] = [];

function mount(): { api: DockviewApi; shown: () => string[] } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const api = createDockview(host, {
    createComponent: ({ id }): IContentRenderer => {
      const element = document.createElement('div');
      element.dataset.panel = id;
      return { element, init() {} };
    },
  });
  api.layout(800, 600);
  const shown = () =>
    [...host.querySelectorAll<HTMLElement>('.dv-content-container [data-panel]')].map(
      (element) => element.dataset.panel ?? ''
    );
  return { api, shown };
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

describe('dockview 激活面板内容不被未激活的 always 面板挤掉', () => {
  it('恢复布局时秘书面板激活、后面跟着插件页：秘书内容仍在，插件页关掉后也在', () => {
    const saved = mount();
    saved.api.addPanel({ id: 'secretary', component: 'secretary' });
    saved.api.addPanel({ id: 'plugin:enso.x:x', component: 'plugin', renderer: 'always' });
    saved.api.getPanel('secretary')?.api.setActive();

    const { api, shown } = mount();
    api.fromJSON(saved.api.toJSON());
    expect(api.activePanel?.id).toBe('secretary');
    expect(shown()).toEqual(['secretary']);

    api.getPanel('plugin:enso.x:x')?.api.close();
    expect(api.panels.map((panel) => panel.id)).toEqual(['secretary']);
    expect(shown()).toEqual(['secretary']);
  });

  it('不抢焦点地补进 always 插件页：当前面板内容仍在', () => {
    const { api, shown } = mount();
    api.addPanel({ id: 'secretary', component: 'secretary' });
    api.addPanel({
      id: 'plugin:enso.x:x',
      component: 'plugin',
      renderer: 'always',
      inactive: true,
      position: { referenceGroup: api.groups[0] },
    });
    expect(api.activePanel?.id).toBe('secretary');
    expect(shown()).toEqual(['secretary']);
  });

  it('对未激活面板 setRenderer(always)：当前面板内容仍在', () => {
    const { api, shown } = mount();
    api.addPanel({ id: 'plugin:enso.x:x', component: 'plugin' });
    api.addPanel({ id: 'secretary', component: 'secretary' });
    api.getPanel('plugin:enso.x:x')?.api.setRenderer('always');
    expect(api.activePanel?.id).toBe('secretary');
    expect(shown()).toEqual(['secretary']);
  });
});

// 用户磁盘上的侧栏布局都是 dockview 8.2.0 写的（仓库从引入 dockview 起一直是 8.2.0）。
// 这份是 8.2.0 真实 toJSON 的输出：上下两个分组、多 tab、带 params 和 renderer:'always' 的插件页
const LAYOUT_FROM_8_2_0 = {
  grid: {
    root: {
      type: 'branch',
      data: [
        {
          type: 'branch',
          data: [
            {
              type: 'leaf',
              data: {
                views: ['secretary', 'changes', 'plugin:enso.x:x'],
                activeView: 'secretary',
                id: '1',
              },
              size: 300,
            },
            {
              type: 'leaf',
              data: {
                views: ['files', 'terminal:t1'],
                activeView: 'terminal:t1',
                id: '2',
              },
              size: 300,
            },
          ],
          size: 800,
        },
      ],
      size: 600,
    },
    width: 800,
    height: 600,
    orientation: 'HORIZONTAL',
  },
  panels: {
    secretary: {
      id: 'secretary',
      contentComponent: 'secretary',
      params: {
        conversationId: 'c1',
        projectId: 'p1',
      },
      title: '爱酱',
    },
    changes: {
      id: 'changes',
      contentComponent: 'changes',
      params: {
        conversationId: 'c1',
      },
      title: 'Changes',
    },
    'plugin:enso.x:x': {
      id: 'plugin:enso.x:x',
      contentComponent: 'plugin',
      params: {
        conversationId: 'c1',
        projectId: 'p1',
        pluginId: 'enso.x',
        viewId: 'x',
      },
      title: 'X',
      renderer: 'always',
    },
    files: {
      id: 'files',
      contentComponent: 'files',
      title: 'Files',
    },
    'terminal:t1': {
      id: 'terminal:t1',
      contentComponent: 'terminal',
      title: 'Terminal',
    },
  },
  activeGroup: '1',
};

describe('dockview 8.2.0 写的旧布局', () => {
  it('经 sanitize 后能原样恢复：分组、tab 顺序、激活项、params、renderer 不变，再存回去一致', () => {
    const { api, shown } = mount();
    const layout = sanitizeSidePanelLayout(
      structuredClone(LAYOUT_FROM_8_2_0),
      new Set(['secretary', 'changes', 'plugin', 'files', 'terminal'])
    );
    expect(layout).toBeDefined();
    if (!layout) return;
    api.fromJSON(layout);

    expect(api.groups.map((group) => group.panels.map((panel) => panel.id))).toEqual([
      ['secretary', 'changes', 'plugin:enso.x:x'],
      ['files', 'terminal:t1'],
    ]);
    expect(api.groups.map((group) => group.activePanel?.id)).toEqual(['secretary', 'terminal:t1']);
    expect(api.activePanel?.id).toBe('secretary');
    expect(api.getPanel('secretary')?.title).toBe('爱酱');
    expect(api.getPanel('plugin:enso.x:x')?.api.renderer).toBe('always');
    expect(api.getPanel('plugin:enso.x:x')?.params).toEqual({
      conversationId: 'c1',
      projectId: 'p1',
      pluginId: 'enso.x',
      viewId: 'x',
    });
    // 每个分组的激活面板内容都挂在内容区里（always 插件页不在内容区）
    expect(shown()).toEqual(['secretary', 'terminal:t1']);
    expect(api.toJSON()).toEqual(LAYOUT_FROM_8_2_0);
  });
});
