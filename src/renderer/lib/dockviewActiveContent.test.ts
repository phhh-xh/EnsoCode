// @vitest-environment jsdom
import { createDockview, type DockviewApi, type IContentRenderer } from 'dockview-react';
import { afterEach, describe, expect, it } from 'vitest';

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
