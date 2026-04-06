// HMR test trigger: 2
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from 'vitest-react-native-runtime/runtime';
import { CounterModule } from '../CounterModule';

afterEach(async () => {
  await cleanup();
});

describe('CounterModule', () => {
  it('renders initial count of zero', async () => {
    const screen = render(<CounterModule userId="123" />);
    const count = await screen.findByTestId('count-display');
    expect(count).toHaveText('0');
  });

  it('increments on press', async () => {
    const screen = render(<CounterModule userId="123" />);
    const btn = await screen.findByTestId('increment-btn');
    await btn.tap();
    const count = screen.getByTestId('count-display');
    await waitFor(() => {
      expect(count).toHaveText('1');
    });
  });

  it('renders compact variant', async () => {
    const screen = render(<CounterModule userId="123" variant="compact" />);
    const layout = await screen.findByTestId('compact-layout');
    expect(layout).toBeVisible();
  });

  it('calls onCountChange callback', async () => {
    const spy = { calls: [] as number[] };
    const screen = render(<CounterModule userId="123" onCountChange={(n: number) => spy.calls.push(n)} />);
    const btn = await screen.findByTestId('increment-btn');
    await btn.tap();
    await btn.tap();
    await waitFor(() => {
      expect(spy.calls).toEqual([1, 2]);
    });
  });
});
