import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindFrameChrome,
  edgeColor,
  type FrameChromeBinding,
  isOpaqueColor,
  parseDeskChrome,
  serializeDeskChrome,
} from './chrome';

describe('desk chrome cache', () => {
  it('round-trips the edge colors used for the next launch', () => {
    const raw = serializeDeskChrome({ top: 'rgb(255, 255, 255)', bottom: 'rgb(9, 9, 16)' });
    expect(parseDeskChrome(raw)).toEqual({ top: 'rgb(255, 255, 255)', bottom: 'rgb(9, 9, 16)' });
  });

  it('ignores anything that is not a plain rgb color', () => {
    for (const raw of [
      null,
      '',
      '{',
      '{"top":"red","bottom":"rgb(1, 2, 3)"}',
      '{"top":"rgb(1, 2, 3); x: url(y)","bottom":"rgb(1, 2, 3)"}',
    ]) {
      expect(parseDeskChrome(raw)).toBeNull();
    }
  });
});

describe('frame chrome binding', () => {
  const root = { nodeName: 'HTML' } as unknown as Node;
  const body = { nodeName: 'BODY' } as unknown as HTMLElement;
  let observe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    observe = vi.fn();
    vi.stubGlobal(
      'MutationObserver',
      class {
        observe = observe;
        disconnect() {}
      }
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('skips a document that has no documentElement yet instead of observing a non-Node', () => {
    expect(bindFrameChrome({ documentElement: null, body: null }, undefined, () => {})).toBeNull();
    expect(observe).not.toHaveBeenCalled();
  });

  it('binds body once it appears, without rebinding the root', () => {
    const first = bindFrameChrome({ documentElement: root, body: null }, undefined, () => {});
    expect(first?.body).toBe(false);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(root, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    const bound = first as FrameChromeBinding;
    expect(bindFrameChrome({ documentElement: root, body }, bound, () => {})).toBe(bound);
    expect(bound.body).toBe(true);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenLastCalledWith(body, { childList: true });

    bindFrameChrome({ documentElement: root, body }, bound, () => {});
    expect(observe).toHaveBeenCalledTimes(2);
  });
});

describe('isOpaqueColor', () => {
  it('rejects transparent and semi-transparent colors including CSS Color 4 backdrops', () => {
    for (const color of [
      '',
      'transparent',
      'rgba(0, 0, 0, 0)',
      'rgba(0, 0, 0, 0.4)',
      'hsla(0, 0%, 0%, 0.32)',
      'rgb(0 0 0 / 0.4)',
      'rgb(0 0 0 / 40%)',
      'oklab(0 0 0 / 0.4)',
      'oklab(0 0 0 / 0)',
      'oklch(0.985 0 0 / 0.15)',
      'color(srgb 0 0 0 / 0.4)',
      '#0006',
      '#00000066',
    ]) {
      expect(isOpaqueColor(color), color).toBe(false);
    }
  });

  it('accepts fully opaque colors', () => {
    for (const color of [
      'rgb(255, 255, 255)',
      'rgba(255, 255, 255, 1)',
      'rgb(255 255 255 / 1)',
      'rgb(255 255 255 / 100%)',
      'oklab(1 0 0)',
      'oklch(0.985 0 0)',
      'color(srgb 1 1 1)',
      '#fff',
      '#ffffff',
      '#ffffffff',
    ]) {
      expect(isOpaqueColor(color), color).toBe(true);
    }
  });
});

describe('edgeColor', () => {
  function fakeEl(
    style: { backgroundColor: string; opacity?: string },
    parentElement: Element | null = null
  ): { el: Element; style: { backgroundColor: string; opacity: string } } {
    return {
      el: { parentElement } as unknown as Element,
      style: { backgroundColor: style.backgroundColor, opacity: style.opacity ?? '1' },
    };
  }

  it('skips translucent drawer backdrop and samples the opaque surface behind it', () => {
    const root = fakeEl({ backgroundColor: 'rgba(0, 0, 0, 0)' });
    const header = fakeEl({ backgroundColor: 'rgb(255, 255, 255)' }, root.el);
    const backdrop = fakeEl({ backgroundColor: 'oklab(0 0 0 / 0.4)' }, root.el);
    const styles = new Map([
      [root.el, root.style],
      [header.el, header.style],
      [backdrop.el, backdrop.style],
    ]);
    const doc = {
      defaultView: {
        innerWidth: 440,
        getComputedStyle: (el: Element) => styles.get(el),
      },
      elementsFromPoint: () => [backdrop.el, header.el, root.el],
      elementFromPoint: () => backdrop.el,
    } as unknown as Document;

    expect(edgeColor(doc, 1)).toBe('rgb(255, 255, 255)');
  });

  it('skips fading overlays with opacity < 1 even if their backgroundColor is opaque', () => {
    const page = fakeEl({ backgroundColor: 'rgb(255, 255, 255)' });
    const fading = fakeEl({ backgroundColor: 'rgb(0, 0, 0)', opacity: '0.35' });
    const styles = new Map([
      [page.el, page.style],
      [fading.el, fading.style],
    ]);
    const doc = {
      defaultView: {
        innerWidth: 440,
        getComputedStyle: (el: Element) => styles.get(el),
      },
      elementsFromPoint: () => [fading.el, page.el],
      elementFromPoint: () => fading.el,
    } as unknown as Document;

    expect(edgeColor(doc, 1)).toBe('rgb(255, 255, 255)');
  });
});
