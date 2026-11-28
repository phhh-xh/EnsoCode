import { describe, expect, it } from 'vitest';
import { TOAST_CLOSE_CLASS, TOAST_CONTENT_CLASS } from './toast';

type DataState = Record<string, boolean>;

/** 按元素的 data-* 状态算出生效的工具类；其他变体只有列在 variants 里才算生效 */
function activeUtilities(className: string, state: DataState, variants: string[] = []): string[] {
  return className.split(/\s+/).flatMap((token) => {
    const parts = token.split(':');
    const utility = parts.pop() ?? '';
    const active = parts.every((variant) => {
      if (variant.startsWith('not-data-')) return !state[variant.slice('not-data-'.length)];
      if (variant.startsWith('data-')) return !!state[variant.slice('data-'.length)];
      return variants.includes(variant);
    });
    return active ? [utility] : [];
  });
}

const pointerEvents = (state: DataState) =>
  activeUtilities(TOAST_CONTENT_CLASS, state).filter((u) => u.startsWith('pointer-events-'));

describe('toast 堆叠层的可点性', () => {
  it('收起时后面那条点不到，最前面那条可点', () => {
    expect(pointerEvents({ behind: true })).toContain('pointer-events-none');
    expect(pointerEvents({})).toEqual(['pointer-events-auto']);
  });

  it('展开后后面那条也能点到 × 和操作按钮', () => {
    expect(pointerEvents({ behind: true, expanded: true })).toEqual(['pointer-events-auto']);
    expect(pointerEvents({ expanded: true })).toEqual(['pointer-events-auto']);
  });

  it('展开后后面那条可见', () => {
    const active = activeUtilities(TOAST_CONTENT_CLASS, { behind: true, expanded: true });
    expect(active).toContain('opacity-100');
  });

  it('触屏下关闭按钮的命中区比图标大', () => {
    const hitArea = (variants: string[]) => activeUtilities(TOAST_CLOSE_CLASS, {}, variants);
    expect(hitArea(['pointer-coarse', 'after'])).toEqual(
      expect.arrayContaining(['absolute', '-inset-2.5'])
    );
    expect(hitArea(['after'])).not.toContain('-inset-2.5');
  });
});
