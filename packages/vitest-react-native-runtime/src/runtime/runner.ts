/**
 * ReactNativeRunner — VitestRunner implementation for Hermes/RN.
 */

import type { VitestRunner, VitestRunnerConfig, File, Test } from '@vitest/runner';
import { importTestFile } from 'vitest-react-native-runtime/test-registry';
import { cleanup } from './render';
import { waitForContainerReady } from './context';
import { setupExpect } from './expect-setup';
import { symbolicateErrors } from './symbolicate';

interface RuntimeRpcBridge {
  onCollected(files: File[]): void;
  onTaskUpdate(packs: any[], events?: any[]): void;
  onUnhandledError(err: unknown, type: string): void;
}

type TestCallback = (test: Test) => void;

export class ReactNativeRunner implements VitestRunner {
  config: VitestRunnerConfig;
  private rpc: RuntimeRpcBridge;
  private onTestDone?: TestCallback;

  constructor(config: VitestRunnerConfig, rpc: RuntimeRpcBridge, onTestDone?: TestCallback) {
    this.config = config;
    this.rpc = rpc;
    this.onTestDone = onTestDone;
  }

  async onBeforeRunFiles(_files: File[]): Promise<void> {
    await waitForContainerReady();
    // Wait for Fabric to commit the initial view tree
    await new Promise(r => (globalThis as any).setImmediate?.(r) ?? setTimeout(r, 0));
    await new Promise(r => (globalThis as any).setImmediate?.(r) ?? setTimeout(r, 0));
    setupExpect();

    // Dump the view tree to diagnose view query issues
    try {
      const { getViewTreeString } = require('./tree');
      const treeStr = await getViewTreeString();
      console.log(`[runner] Initial view tree:\n${treeStr}`);
    } catch (e: any) {
      console.log(`[runner] Tree dump error: ${e?.message}`);
    }
  }

  async importFile(filepath: string, source: 'collect' | 'setup'): Promise<void> {
    // Resolve the registry key from the filepath
    const key = this.resolveKey(filepath);

    if (key) {
      console.log(`[runner] importFile: key=${key}, source=${source}`);
      const mod = await importTestFile(key);
      console.log(`[runner] importFile: hasRun=${typeof mod?.__run}`);
      // The babel plugin wraps test bodies in exports.__run.
      // Call it inside startTests() context where describe/it have a suite.
      if (mod && typeof mod.__run === 'function') {
        mod.__run();
        console.log('[runner] __run() called successfully');
      } else {
        console.log('[runner] No __run found, test body executed at import time');
      }
    } else {
      console.warn(`[runner] File not found in registry: ${filepath}`);
    }
  }

  /** Try to match a filepath to a test-registry key. */
  private resolveKey(filepath: string): string | null {
    // Import testFileKeys at call time (the generated module may have been HMR'd)
    const { testFileKeys } = require('vitest-react-native-runtime/test-registry');

    // Direct match
    if (testFileKeys.includes(filepath)) return filepath;

    // Extract the filename from the filepath for matching
    const filename = filepath.split('/').pop() ?? filepath;

    // Match by filename (keys are like "greeting/greeting.test.tsx")
    const match = testFileKeys.find((k: string) => {
      const keyFilename = k.split('/').pop() ?? k;
      return keyFilename === filename;
    });
    if (match) return match;

    // Try matching by suffix
    const suffixMatch = testFileKeys.find((k: string) =>
      filepath.endsWith(k) || filepath.endsWith(k.replace('./', ''))
    );
    return suffixMatch ?? null;
  }

  onCollected(files: File[]): void {
    this.rpc.onCollected(files);
  }

  async onTaskUpdate(packs: any[], events: any[]): Promise<void> {
    this.rpc.onTaskUpdate(packs, events);
  }

  async onAfterRunTask(test: Test): Promise<void> {
    console.log(`[runner] onAfterRunTask: ${test.name} = ${test.result?.state}`);
    if (test.result?.state === 'fail') {
      await symbolicateErrors(test.result);
    }
    this.onTestDone?.(test);
    await cleanup();
  }
}
