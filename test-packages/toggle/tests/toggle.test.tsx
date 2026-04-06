import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from 'vitest-react-native-runtime/runtime';
import { ToggleModule } from '../ToggleModule';

afterEach(async () => {
  await cleanup();
});

describe('ToggleModule', () => {
  it('renders in off state by default', async () => {
    const screen = render(<ToggleModule label="Dark Mode" />);
    const label = await screen.findByTestId('toggle-label');
    expect(label).toHaveText('OFF');
  });

  it('toggles to on state when tapped', async () => {
    const screen = render(<ToggleModule label="Dark Mode" />);
    const btn = await screen.findByTestId('toggle-btn');
    await btn.tap();
    const label = screen.getByTestId('toggle-label');
    await waitFor(() => {
      expect(label).toHaveText('ON');
    });
  });

  it('shows details panel when on', async () => {
    const screen = render(<ToggleModule label="Dark Mode" />);
    const btn = await screen.findByTestId('toggle-btn');
    await btn.tap();
    const details = await screen.findByTestId('details-text');
    expect(details).toHaveText('Details visible');
  });

  it('hides details panel when toggled back off', async () => {
    const screen = render(<ToggleModule label="Dark Mode" />);
    const btn = await screen.findByTestId('toggle-btn');
    await btn.tap();
    await btn.tap();
    const label = screen.getByTestId('toggle-label');
    await waitFor(() => {
      expect(label).toHaveText('OFF');
    });
  });

  it('calls onToggle callback with new value', async () => {
    const values: boolean[] = [];
    const screen = render(<ToggleModule label="Notifications" onToggle={v => values.push(v)} />);
    const btn = await screen.findByTestId('toggle-btn');
    await btn.tap();
    await btn.tap();
    await waitFor(() => {
      expect(values).toEqual([true, false]);
    });
  });
});
