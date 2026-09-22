import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/motion/select';
import { Switch } from './components/motion/switch';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: true,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  );
});

afterEach(() => vi.unstubAllGlobals());

function DestinationSelect({
  onValueChange,
  defaultValue,
  disabled,
}: {
  onValueChange: (value: string) => void;
  defaultValue?: string;
  disabled?: boolean;
}) {
  return (
    <>
      <label htmlFor="destination">Destination</label>
      <p id="destination-hint">Choose an active endpoint.</p>
      <Select
        id="destination"
        defaultValue={defaultValue}
        disabled={disabled}
        onValueChange={onValueChange}
      >
        <SelectTrigger aria-required aria-describedby="destination-hint">
          <SelectValue placeholder="Choose a destination" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="billing">Billing</SelectItem>
          <SelectItem value="archived" disabled>
            Archived
          </SelectItem>
          <SelectItem value="notifications">Notifications</SelectItem>
          <SelectItem value="analytics">Analytics</SelectItem>
        </SelectContent>
      </Select>
    </>
  );
}

describe('beUI select accessibility', () => {
  it('navigates enabled options with arrows, Home and End and selects with Enter', () => {
    const change = vi.fn();
    render(<DestinationSelect onValueChange={change} />);
    const trigger = screen.getByRole('combobox', { name: 'Destination' });
    expect(trigger).toHaveAccessibleDescription('Choose an active endpoint.');
    expect(trigger).toHaveAttribute('aria-required', 'true');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const billing = screen.getByRole('option', { name: 'Billing' });
    const notifications = screen.getByRole('option', { name: 'Notifications' });
    const analytics = screen.getByRole('option', { name: 'Analytics' });
    expect(billing).toHaveFocus();
    fireEvent.keyDown(billing, { key: 'ArrowDown' });
    expect(notifications).toHaveFocus();
    fireEvent.keyDown(notifications, { key: 'End' });
    expect(analytics).toHaveFocus();
    fireEvent.keyDown(analytics, { key: 'Home' });
    expect(billing).toHaveFocus();
    fireEvent.keyDown(billing, { key: 'ArrowUp' });
    expect(billing).toHaveFocus();
    fireEvent.keyDown(billing, { key: 'ArrowDown' });
    fireEvent.keyDown(notifications, { key: 'Enter' });
    expect(change).toHaveBeenCalledExactlyOnceWith('notifications');
    expect(trigger).toHaveTextContent('Notifications');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('opens at the last option with ArrowUp and accepts Space', () => {
    const change = vi.fn();
    render(<DestinationSelect onValueChange={change} />);
    const trigger = screen.getByRole('combobox', { name: 'Destination' });
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    const analytics = screen.getByRole('option', { name: 'Analytics' });
    expect(analytics).toHaveFocus();
    fireEvent.keyDown(analytics, { key: ' ' });
    expect(change).toHaveBeenCalledExactlyOnceWith('analytics');
    expect(trigger).toHaveFocus();
  });

  it('restores focus on Escape without dismissing the enclosing dialog', () => {
    const change = vi.fn();
    const outerKeyDown = vi.fn();
    render(
      <div onKeyDown={outerKeyDown}>
        <DestinationSelect
          defaultValue="notifications"
          onValueChange={change}
        />
      </div>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Destination' });
    fireEvent.click(trigger);
    const selected = screen.getByRole('option', { name: 'Notifications' });
    expect(selected).toHaveFocus();
    fireEvent.keyDown(selected, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
    expect(outerKeyDown).not.toHaveBeenCalled();
  });

  it('supports pointer selection and prevents interaction when disabled', () => {
    const change = vi.fn();
    const { rerender } = render(<DestinationSelect onValueChange={change} />);
    const trigger = screen.getByRole('combobox', { name: 'Destination' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Archived' }));
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'Billing' }));
    expect(change).toHaveBeenCalledExactlyOnceWith('billing');
    expect(trigger).toHaveFocus();
    rerender(<DestinationSelect onValueChange={change} disabled />);
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('beUI switch accessibility', () => {
  it('uses an external label and description and respects disabled state', () => {
    function DeliverySwitch({ disabled = false }: { disabled?: boolean }) {
      const [checked, setChecked] = useState(false);
      return (
        <>
          <label htmlFor="enabled">Enable delivery</label>
          <p id="enabled-hint">Paused destinations keep queued events.</p>
          <Switch
            id="enabled"
            checked={checked}
            onCheckedChange={setChecked}
            disabled={disabled}
            ariaDescribedBy="enabled-hint"
          />
        </>
      );
    }
    const { rerender } = render(<DeliverySwitch />);
    const control = screen.getByRole('switch', { name: 'Enable delivery' });
    expect(control).toHaveAccessibleDescription(
      'Paused destinations keep queued events.',
    );
    expect(control).not.toBeChecked();
    fireEvent.click(screen.getByText('Enable delivery'));
    expect(control).toBeChecked();
    rerender(<DeliverySwitch disabled />);
    fireEvent.click(control);
    expect(control).toBeDisabled();
    expect(control).toBeChecked();
  });
});
