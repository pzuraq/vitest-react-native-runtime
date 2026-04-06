import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from 'vitest-react-native-runtime/runtime';
import { TodoListModule } from '../TodoListModule';

afterEach(async () => {
  await cleanup();
});

describe('TodoListModule', () => {
  it('shows empty message when no items', async () => {
    const screen = render(<TodoListModule />);
    const msg = await screen.findByTestId('empty-message');
    expect(msg).toHaveText('No items yet');
  });

  it('renders initial items', async () => {
    const screen = render(<TodoListModule initialItems={['Buy milk', 'Walk dog']} />);
    const count = await screen.findByTestId('item-count');
    expect(count).toHaveText('2 items');
  });

  it('adds a new item', async () => {
    const screen = render(<TodoListModule />);
    const input = await screen.findByTestId('todo-input');
    await input.type('New task');
    const addBtn = screen.getByTestId('add-btn');
    await addBtn.tap();
    const count = screen.getByTestId('item-count');
    await waitFor(() => {
      expect(count).toHaveText('1 items');
    });
  });

  it('does not add empty items', async () => {
    const screen = render(<TodoListModule />);
    const addBtn = await screen.findByTestId('add-btn');
    await addBtn.tap();
    const msg = screen.getByTestId('empty-message');
    expect(msg).toHaveText('No items yet');
  });

  it('deletes an item', async () => {
    const screen = render(<TodoListModule initialItems={['Task A', 'Task B', 'Task C']} />);
    const deleteBtn = await screen.findByTestId('delete-btn-1');
    await deleteBtn.tap();
    const count = screen.getByTestId('item-count');
    await waitFor(() => {
      expect(count).toHaveText('2 items');
    });
  });
});
