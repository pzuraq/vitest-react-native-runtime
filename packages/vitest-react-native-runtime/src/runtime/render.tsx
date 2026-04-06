/**
 * Render API — mount a React component into the harness app's test container.
 */

import React from 'react';
import { getGlobalSetTestContent, getGlobalContainerRef, nextRenderKey } from './context';
import { createLocatorAPI, type LocatorAPI } from './locator';
import { getViewTree, getViewTreeString } from './tree';
import type { ViewTreeNode } from './native-harness';

export interface RenderOptions {
  wrapper?: React.ComponentType<{ children: React.ReactNode }>;
}

export interface Screen extends LocatorAPI {
  unmount(): void;
  dumpTree(): Promise<string>;
  getTree(): Promise<ViewTreeNode | null>;
}

let defaultWrapper: React.ComponentType<{ children: React.ReactNode }> | null = null;

export function setDefaultWrapper(wrapper: React.ComponentType<{ children: React.ReactNode }> | null) {
  defaultWrapper = wrapper;
}

function yield_(): Promise<void> {
  return new Promise(r => (globalThis as any).setImmediate?.(r) ?? setTimeout(r, 0));
}

export function render(element: React.ReactElement, options: RenderOptions = {}): Screen {
  const setTestContent = getGlobalSetTestContent();
  const containerRef = getGlobalContainerRef();

  const wrapper = options.wrapper ?? defaultWrapper;
  const content = wrapper ? React.createElement(wrapper, null, element) : element;

  // Increment key to force React to destroy previous tree and create fresh state
  nextRenderKey();
  setTestContent(content);

  const locators = createLocatorAPI(containerRef);

  return {
    ...locators,
    unmount() {
      setTestContent(null);
    },
    async dumpTree() {
      return getViewTreeString();
    },
    async getTree() {
      return getViewTree();
    },
  };
}

export async function cleanup(): Promise<void> {
  try {
    const setTestContent = getGlobalSetTestContent();
    setTestContent(null);
    // Yield multiple times to ensure React commits the unmount
    // and Fabric removes the native views
    await yield_();
    await yield_();
    await yield_();
  } catch {
    // If provider not mounted yet, nothing to clean up
  }
}
