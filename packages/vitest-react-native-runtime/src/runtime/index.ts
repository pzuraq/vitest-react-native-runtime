/**
 * vitest-react-native-runtime/runtime — Public API.
 *
 * Harness: createTestHarness
 * Tests: render, cleanup, waitFor, Locator
 */

/// <reference path="../../matchers.d.ts" />

// Harness app
export { createTestHarness } from './harness';
export { connectToVitest, onStatusChange } from './setup';
export type { HarnessStatus, ConnectOptions } from './setup';
export { TestContainerProvider, waitForContainerReady } from './context';

// Test API
export { render, cleanup, setDefaultWrapper } from './render';
export type { RenderOptions, Screen } from './render';
export { waitFor } from './retry';
export { Locator } from './locator';
export type { LocatorAPI } from './locator';

// Agent development tools
export { screenshot } from './screenshot';
export { pause } from './pause';
export type { PauseOptions } from './pause';
export { getViewTree, getViewTreeString } from './tree';
export type { ViewTreeNode } from './native-harness';
