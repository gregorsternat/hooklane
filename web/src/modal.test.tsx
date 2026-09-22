import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Modal, SelectField } from './components';

async function nextFrame() {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

describe('modal keyboard interaction', () => {
  it('keeps focus stable during busy and callback updates and blocks busy dismissal', async () => {
    const close = vi.fn();
    const nextClose = vi.fn();
    const content = (
      <>
        <label>
          First
          <input aria-label="First" />
        </label>
        <label>
          Second
          <input aria-label="Second" />
        </label>
      </>
    );
    const { rerender } = render(
      <Modal title="Edit destination" onClose={close}>
        {content}
      </Modal>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Close dialog' }),
      ).toHaveFocus(),
    );
    screen.getByRole('textbox', { name: 'Second' }).focus();

    rerender(
      <Modal title="Edit destination" onClose={nextClose}>
        {content}
      </Modal>,
    );
    await nextFrame();
    expect(screen.getByRole('textbox', { name: 'Second' })).toHaveFocus();

    rerender(
      <Modal title="Edit destination" onClose={nextClose} busy>
        {content}
      </Modal>,
    );
    await nextFrame();
    expect(screen.getByRole('textbox', { name: 'Second' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss modal' }));
    expect(close).not.toHaveBeenCalled();
    expect(nextClose).not.toHaveBeenCalled();

    rerender(
      <Modal title="Edit destination" onClose={nextClose}>
        {content}
      </Modal>,
    );
    await nextFrame();
    expect(screen.getByRole('textbox', { name: 'Second' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nextClose).toHaveBeenCalledOnce();
  });

  it('wraps focus around usable controls and excludes closed, hidden, and disabled choices', async () => {
    render(
      <Modal title="Send event" onClose={vi.fn()}>
        <SelectField
          value="billing"
          onValueChange={vi.fn()}
          aria-label="Destination"
          options={[{ value: 'billing', label: 'Billing' }]}
        />
        <button>Send event</button>
        <div inert>
          <button>Inactive option</button>
        </div>
        <div hidden>
          <button>Hidden option</button>
        </div>
        <button disabled tabIndex={0}>
          Disabled option
        </button>
        <input type="hidden" value="hidden" readOnly />
      </Modal>,
    );
    const first = screen.getByRole('button', { name: 'Close dialog' });
    const last = screen.getByRole('button', { name: 'Send event' });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    const panel = screen.getByRole('dialog', { name: 'Send event' });
    panel.focus();
    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('restores the opener when the dialog closes', async () => {
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open editor</button>
          {open && (
            <Modal title="Editor" onClose={() => setOpen(false)}>
              <input aria-label="Name" />
            </Modal>
          )}
        </>
      );
    }
    render(<Example />);
    const opener = screen.getByRole('button', { name: 'Open editor' });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Close dialog' }),
      ).toHaveFocus(),
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(opener).toHaveFocus();
  });
});
