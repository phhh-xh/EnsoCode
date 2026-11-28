// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { ConfirmDialog } from './ConfirmDialog';

const settle = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

afterEach(() => {
  document.body.innerHTML = '';
});

it('打开时焦点落在「取消」上，按 Esc 关闭且不触发确认', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onConfirm = vi.fn();
  let openDialog = () => {};
  function Host() {
    const [open, setOpen] = useState(false);
    openDialog = () => setOpen(true);
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete preset?"
        description="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />
    );
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Host />));

  await act(async () => openDialog());
  await settle(100);
  expect(document.activeElement?.textContent).toBe('Cancel');

  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
  });
  await settle(300);
  expect(onConfirm).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('Delete preset?');

  await act(async () => root.unmount());
});
