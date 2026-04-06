/**
 * Standalone test runner — executes tests without a Vitest pool/WebSocket.
 *
 * Uses @vitest/runner directly with a local RPC bridge that
 * collects results in-process instead of sending them over the wire.
 */

import { startTests, type File, type Test } from '@vitest/runner';
import { getTests } from '@vitest/runner/utils';
import { ReactNativeRunner } from './runner';
import { waitForContainerReady } from './context';
import { setupExpect } from './expect-setup';
import { cleanup } from './render';
import { configurePause, resetPause } from './pause';

export interface TestResult {
  id: string;
  name: string;
  state: 'pass' | 'fail' | 'skip' | 'pending';
  duration?: number;
  error?: string;
}

export interface RunResult {
  passed: number;
  failed: number;
  skipped: number;
  tests: TestResult[];
  files: File[];
}

export interface StandaloneRunOptions {
  /** Registry keys (file paths) to run. */
  files: string[];
  /** Called after each test completes. */
  onTestStart?: (file: string) => void;
  onTestDone?: (result: TestResult) => void;
  onFileDone?: (file: string, results: TestResult[]) => void;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Collect test structure (describe/it blocks) without executing them.
 */
export async function collectTests(files: string[]): Promise<File[]> {
  await waitForContainerReady();
  setupExpect();

  const collectedFiles: File[] = [];

  const localRpc = {
    onCollected(f: File[]) { collectedFiles.push(...f); },
    onTaskUpdate() {},
    onUnhandledError() {},
  };

  const config = {
    root: '/',
    sequence: { hooks: 'stack' as const },
    hookTimeout: 10000,
    testTimeout: 10000,
    retry: 0,
    passWithNoTests: true,
    allowOnly: true,
  };

  const runner = new ReactNativeRunner(config as any, localRpc);

  const fileEntries = files.map(f => ({
    id: f,
    name: f,
    filepath: f,
    type: 'suite' as const,
    mode: 'run' as const,
    tasks: [],
    meta: {},
    projectName: '',
    file: null as any,
    result: undefined,
  }));
  // Fix self-reference
  for (const entry of fileEntries) {
    entry.file = entry as any;
  }

  await startTests(fileEntries as any[], runner as any);
  await cleanup();

  return collectedFiles.length > 0 ? collectedFiles : fileEntries as any[];
}

/**
 * Run tests standalone (no Vitest pool needed).
 */
export async function runTests(options: StandaloneRunOptions): Promise<RunResult> {
  const { files, onTestStart, onTestDone, onFileDone, signal } = options;

  await waitForContainerReady();
  setupExpect();

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const allTests: TestResult[] = [];
  const collectedFiles: File[] = [];

  const localRpc = {
    onCollected(f: File[]) { collectedFiles.push(...f); },
    onTaskUpdate() {},
    onUnhandledError(err: unknown) {
      console.error('[standalone-runner] Unhandled error:', err);
    },
  };

  const config = {
    root: '/',
    sequence: { hooks: 'stack' as const },
    hookTimeout: 10000,
    testTimeout: 30000,
    retry: 0,
    passWithNoTests: true,
    allowOnly: true,
  };

  // Set up pause for standalone mode — no pool notifier, but abort signal works
  const ac = signal ? undefined : new AbortController();
  const effectiveSignal = signal ?? ac?.signal;

  for (const filePath of files) {
    if (effectiveSignal?.aborted) break;

    onTestStart?.(filePath);
    const fileTests: TestResult[] = [];

    // Configure pause so pause() works in standalone mode
    configurePause({
      notifyPool: () => {}, // no-op in standalone
      abortSignal: effectiveSignal!,
      mode: 'dev',
    });

    console.log(`[standalone-runner] Running file: ${filePath}`);

    const runner = new ReactNativeRunner(config as any, localRpc, (test: Test) => {
      console.log(`[standalone-runner] Test done: ${test.name} = ${test.result?.state}`);
      const result: TestResult = {
        id: test.id,
        name: test.name,
        state: test.result?.state === 'fail' ? 'fail' :
               test.result?.state === 'pass' ? 'pass' :
               test.mode === 'skip' ? 'skip' : 'pending',
        duration: test.result?.duration,
        error: test.result?.errors?.[0]?.message,
      };

      if (result.state === 'pass') passed++;
      else if (result.state === 'fail') failed++;
      else skipped++;

      allTests.push(result);
      fileTests.push(result);
      onTestDone?.(result);
    });

    const fileEntry = {
      id: filePath,
      name: filePath,
      filepath: filePath,
      type: 'suite' as const,
      mode: 'run' as const,
      tasks: [],
      meta: {},
      projectName: '',
      file: null as any,
      result: undefined,
    };
    fileEntry.file = fileEntry as any;

    try {
      console.log(`[standalone-runner] Calling startTests for ${filePath}`);
      await startTests([fileEntry as any], runner as any);
      console.log(`[standalone-runner] startTests completed. fileTests: ${fileTests.length}`);

      // Catch tests that failed during collection (e.g. checkAllowOnly) —
      // these bypass onAfterRunTask so the UI never hears about them.
      const reportedIds = new Set(fileTests.map(t => t.id));
      for (const test of getTests(fileEntry as any)) {
        if (!reportedIds.has(test.id) && test.result?.state === 'fail') {
          const result: TestResult = {
            id: test.id,
            name: test.name,
            state: 'fail',
            error: test.result.errors?.[0]?.message,
          };
          failed++;
          allTests.push(result);
          fileTests.push(result);
          onTestDone?.(result);
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') break;
      console.error(`[standalone-runner] Error running ${filePath}:`, err.message);
      allTests.push({
        id: filePath,
        name: filePath,
        state: 'fail',
        error: err.message,
      });
      failed++;
    }

    await cleanup();
    resetPause();
    onFileDone?.(filePath, fileTests);
  }

  return { passed, failed, skipped, tests: allTests, files: collectedFiles };
}
