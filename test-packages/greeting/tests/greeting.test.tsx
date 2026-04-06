import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from 'vitest-react-native-runtime/runtime';
import { GreetingModule } from '../GreetingModule';

afterEach(async () => {
  await cleanup();
});

describe('GreetingModule', () => {
  it('shows placeholder when no name is entered', async () => {
    const screen = render(<GreetingModule />);
    const greeting = await screen.findByTestId('greeting-text');
    expect(greeting).toHaveText('Enter your name');
  });

  it('renders with default name', async () => {
    const screen = render(<GreetingModule defaultName="Alice" />);
    const greeting = await screen.findByTestId('greeting-text');
    expect(greeting).toHaveText('Hello, Alice!');
  });

  it('updates greeting when name is typed', async () => {
    const screen = render(<GreetingModule />);
    const input = await screen.findByTestId('name-input');
    await input.type('Bob');
    const greeting = screen.getByTestId('greeting-text');
    await waitFor(() => {
      expect(greeting).toHaveText('Hello, Bob!');
    });
  });

  it('shows character count', async () => {
    const screen = render(<GreetingModule defaultName="Eve" />);
    const count = await screen.findByTestId('char-count');
    expect(count).toHaveText('3 characters');
  });

  it('clears name when clear button is tapped', async () => {
    const screen = render(<GreetingModule defaultName="Alice" />);
    const clearBtn = await screen.findByTestId('clear-btn');
    await clearBtn.tap();
    const greeting = screen.getByTestId('greeting-text');
    await waitFor(() => {
      expect(greeting).toHaveText('Enter your name');
    });
  });
});
