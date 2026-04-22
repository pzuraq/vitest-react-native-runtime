/**
 * Runtime setup — connects the RN app to the Vitest pool over WebSocket.
 */

import { createBirpc } from 'birpc';
import { stringify as flatStringify, parse as flatParse } from 'flatted';
import { startTests, collectTests } from '@vitest/runner';
import type { VitestRunnerConfig, File, Test } from '@vitest/runner';
import { Platform } from 'react-native';
import { ReactNativeRunner, type RuntimeRpcBridge } from './runner';
import { g, getErrorMessage } from './global-types';
import { symbolicateStack } from './symbolicate';
import { resolveRegistryKey } from './registry-utils';
import { getMetroBaseUrl, getRuntimeNetwork } from './network-config';

let ws: WebSocket | null = null;
let vitestRpc: RuntimeRpcBridge | null = null;

/** Send a raw JSON message to the pool (for rerun notifications from the explorer UI). */
export function sendToPool(msg: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
let storedConfig: VitestRunnerConfig | null = null;
let _poolMode: 'dev' | 'run' = 'dev';

/** Check if we have an active WebSocket connection to the Vitest pool. */
export function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

// ── Screenshot request/response ──────────────────────────────────

const pendingScreenshots = new Map<string, { resolve: (filePath: string) => void; reject: (err: Error) => void }>();

export function requestScreenshot(name?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to Vitest pool. Cannot take screenshot.'));
      return;
    }
    const requestId = `ss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingScreenshots.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({ __screenshot_request__: true, requestId, name }));
    setTimeout(() => {
      if (pendingScreenshots.has(requestId)) {
        pendingScreenshots.delete(requestId);
        reject(new Error('Screenshot request timed out (10s)'));
      }
    }, 10000);
  });
}

// ── Pause/resume infrastructure ──────────────────────────────────

import { configurePause, resume as resumePause, resetPause } from './pause';

let _runAbortController: AbortController | null = null;

// Serial task queue — ensures only one run/collect executes at a time
let _taskQueue: Promise<void> = Promise.resolve();
function enqueue(fn: () => Promise<void>): void {
  _taskQueue = _taskQueue.then(fn, fn);
}

// ── Module cache invalidation ────────────────────────────────────

/**
 * Walk Metro's module table and de-initialize every test module so the
 * next require() re-runs the factory with the latest code. Called at
 * the start of each pool session to clear stale state.
 */
function invalidateAllTestModules() {
  const getModules = g.__r?.getModules;
  if (!getModules) return;
  const modules = getModules();
  // Find Metro's EMPTY sentinel from an uninitialized module
  let empty: unknown = null;
  for (const [, mod] of modules) {
    if (!mod.isInitialized && mod.importedAll !== undefined) {
      empty = mod.importedAll;
      break;
    }
  }
  if (!empty) return;
  for (const [, mod] of modules) {
    const name: string | undefined = mod?.verboseName ?? mod?.path;
    if (name && /\.test\.tsx?$/.test(name)) {
      mod.isInitialized = false;
      mod.importedAll = empty;
      mod.importedDefault = empty;
    }
  }
}

// ── Status (re-exported from state.ts to avoid circular dep) ─────

import { setStatus, addLog, resetLogs, onStatusChange, emitTestEvent } from './state';
export { onStatusChange };
export type { HarnessStatus } from './state';

/**
 * Convert an absolute filepath to a project-relative display path.
 * Finds the test-packages or packages prefix and keeps from there.
 */
function toProjectRelativePath(filepath: string): string {
  const markers = ['test-packages/', 'packages/', 'src/'];
  for (const marker of markers) {
    const idx = filepath.indexOf(marker);
    if (idx >= 0) return filepath.slice(idx);
  }
  return filepath.split('/').slice(-3).join('/');
}

/**
 * Extract the describe() suite path from a vitest Test's parent chain.
 */
function getSuitePath(test: Test): string[] {
  const path: string[] = [];
  let current = test.suite;
  while (current && current.type === 'suite' && current.name) {
    path.unshift(current.name);
    current = (current as { suite?: typeof current }).suite;
  }
  return path;
}

/**
 * Try to resolve a vitest filepath to a test-registry key.
 * Uses dynamic require because the test-registry module may not exist yet
 * during early bootstrap.
 */
function tryResolveRegistryKey(filepath: string): string | null {
  try {
    const { testFileKeys } = require('vitest-mobile/test-registry');
    return resolveRegistryKey(filepath, testFileKeys);
  } catch {
    return null;
  }
}

// ── WebSocket transport ───────────────────────────────────────────

function wsSend(data: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

function sendResponse(response: Record<string, unknown>) {
  wsSend(flatStringify({ __vitest_worker_response__: true, ...response }));
}

// ── Test execution handlers ───────────────────────────────────────

interface RunContext {
  config?: VitestRunnerConfig & Record<string, unknown>;
  files?: File[];
  [key: string]: unknown;
}

let passed = 0;
let failed = 0;

function resetRunState() {
  passed = 0;
  failed = 0;
  resetLogs();
}

/**
 * Register a persistent HMR listener that triggers reruns when Metro delivers
 * updated test modules. When a source file changes, Metro's HMR propagates up
 * the dependency chain to the test file (which has module.hot.accept()), and
 * the babel plugin's dispose callback fires with the test key. We send a
 * rerun request to the pool, which tells Vitest to re-execute those tests.
 */
function registerHmrRerunListener(): void {
  const listeners = g.__TEST_HMR_LISTENERS__;
  if (!listeners) return;
  const pendingFiles = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushRerun = () => {
    flushTimer = null;
    if (!ws || ws.readyState !== WebSocket.OPEN || pendingFiles.size === 0) return;
    const files = Array.from(pendingFiles);
    pendingFiles.clear();
    console.log(`[vitest-mobile] HMR batch (${files.length}) requesting rerun`);
    ws.send(
      JSON.stringify({
        __rerun: true,
        files,
        label: `hmr:${files.length}`,
      }),
    );
  };

  listeners.add((testKey?: string) => {
    if (!testKey || !ws || ws.readyState !== WebSocket.OPEN) return;
    pendingFiles.add(testKey);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushRerun, 80);
  });
}

const DEFAULT_RUNNER_CONFIG: VitestRunnerConfig = {
  root: '.',
  setupFiles: [],
  name: undefined,
  passWithNoTests: false,
  testNamePattern: undefined,
  allowOnly: false,
  sequence: { seed: 0, hooks: 'stack', setupFiles: 'list' },
  chaiConfig: undefined,
  maxConcurrency: 1,
  testTimeout: 10000,
  hookTimeout: 10000,
  retry: 0,
  includeTaskLocation: false,
  tags: [],
  tagsFilter: undefined,
  strictTags: false,
};

interface FileHandle {
  file: File;
  filePath: string;
  fileName: string;
  registryKey: string;
  displayPath: string;
  moduleName: string;
}

function describeFile(file: File): FileHandle {
  const filePath = file.filepath ?? '';
  const fileName = filePath.split('/').pop() ?? filePath;
  const parts = filePath.split('/');
  const modulesIdx = parts.indexOf('modules');
  return {
    file,
    filePath,
    fileName,
    registryKey: tryResolveRegistryKey(filePath) ?? filePath,
    displayPath: toProjectRelativePath(filePath),
    moduleName: modulesIdx >= 0 ? parts[modulesIdx + 1] : fileName,
  };
}

async function runSingleFile(handle: FileHandle, config: VitestRunnerConfig): Promise<void> {
  setStatus({
    state: 'running',
    message: handle.moduleName,
    currentFile: handle.fileName,
  });
  emitTestEvent({ type: 'file-start', file: handle.registryKey, displayPath: handle.displayPath });

  // Yield to let React render the updated progress before tests block the thread
  await new Promise(r => setTimeout(r, 0));

  let filePassed = 0;
  let fileFailed = 0;

  const runner = new ReactNativeRunner(config, vitestRpc!, test => {
    const name = test.name ?? '?';
    const state = test.result?.state ?? 'unknown';
    const duration = test.result?.duration ?? 0;
    const errMsg = test.result?.errors?.[0]?.message;
    if (state === 'pass') {
      passed++;
      filePassed++;
      addLog(`✓ ${name} (${duration}ms)`);
    } else {
      failed++;
      fileFailed++;
      addLog(`✗ ${name} (${duration}ms)\n  ${errMsg ?? 'unknown error'}`);
    }
    setStatus({
      passed,
      failed,
      total: passed + failed,
      message: `${handle.moduleName} — ${passed + failed} tests`,
    });

    emitTestEvent({
      type: 'test-done',
      file: handle.registryKey,
      displayPath: handle.displayPath,
      testId: test.id,
      testName: name,
      suitePath: getSuitePath(test),
      state: state === 'pass' ? 'pass' : state === 'fail' ? 'fail' : 'skip',
      duration,
      error: errMsg,
    });
  });

  try {
    await startTests([handle.file], runner);
  } finally {
    emitTestEvent({
      type: 'file-done',
      file: handle.registryKey,
      passed: filePassed,
      failed: fileFailed,
    });
  }
}

async function handleRun(context: RunContext) {
  _runAbortController = new AbortController();
  const notifyPool = (msg: Record<string, unknown>) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };
  configurePause({ notifyPool, abortSignal: _runAbortController.signal, mode: _poolMode });

  const files = context.files ?? [];
  const config = storedConfig ?? context.config ?? DEFAULT_RUNNER_CONFIG;

  try {
    for (const file of files) {
      await runSingleFile(describeFile(file), config as VitestRunnerConfig);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      // Run aborted — new run starting
    } else {
      const msg = getErrorMessage(err);
      console.error('[vitest-mobile] Run error:', err);
      addLog(`ERROR: ${msg}`);
      setStatus({ state: 'error', message: msg ?? 'Unknown error' });
      try {
        const stack = err instanceof Error && err.stack ? await symbolicateStack(err.stack) : undefined;
        const errObj =
          err instanceof Error
            ? { message: err.message, stack, name: err.name }
            : { message: msg, stack: undefined, name: undefined };
        vitestRpc?.onUnhandledError(errObj, 'Unhandled Error');
      } catch {
        /* ignore */
      }
    }
  } finally {
    resetPause();
    _runAbortController = null;
  }

  await new Promise(r => setTimeout(r, 100));
  sendResponse({ type: 'testfileFinished' });
}

async function handleCollect(context: RunContext) {
  const files = context.files;
  setStatus({ state: 'running', message: `Collecting ${files?.length ?? 0} file(s)...` });

  try {
    const config = storedConfig ?? context.config ?? { ...DEFAULT_RUNNER_CONFIG, passWithNoTests: true };
    const runner = new ReactNativeRunner(config as VitestRunnerConfig, vitestRpc!);
    await collectTests(files ?? [], runner);
  } catch (err: unknown) {
    console.error('[vitest-mobile] Collect error:', err);
  }

  sendResponse({ type: 'testfileFinished' });
}

// ── Connect to Vitest ─────────────────────────────────────────────

export interface ConnectOptions {
  port?: number;
  host?: string;
}

interface PoolWsMessage {
  __error?: boolean;
  __screenshot_response__?: boolean;
  __reload?: boolean;
  __resume?: boolean;
  __open_debugger?: boolean;
  __native_run_start?: boolean;
  __native_run_end?: boolean;
  __vitest_worker_request__?: boolean;
  type?: string;
  message?: string;
  requestId?: string;
  filePath?: string;
  error?: string;
  fileCount?: number;
  testCount?: number;
  reason?: string;
  context?: RunContext;
  [key: string]: unknown;
}

export function connectToVitest(options: ConnectOptions = {}) {
  const runtimeNetwork = getRuntimeNetwork();
  const port = options.port ?? runtimeNetwork.wsPort;
  const host = options.host ?? runtimeNetwork.wsHost;
  const url = `ws://${host}:${port}`;
  const maxRetries = 30;
  let retryCount = 0;

  let pendingMessages: string[] = [];
  let birpcHandler: ((data: string) => void) | null = null;
  let _wasEverConnected = false;

  function tryConnect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    setStatus({ state: 'connecting', message: `Connecting to Vitest... (${retryCount + 1})` });
    ws = new WebSocket(url);

    ws.onopen = () => {
      // If we were previously connected (reconnection after disconnect),
      // do a full JS reload to wipe all stale module/React state.
      // Close the socket first so the pool doesn't see a duplicate connection.
      if (_wasEverConnected) {
        console.log('[vitest-mobile] Reconnected — reloading for fresh state');
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        ws = null;
        try {
          const { NativeModules } = require('react-native');
          NativeModules.DevSettings?.reload?.();
        } catch (e: unknown) {
          console.warn('[vitest-mobile] DevSettings.reload() failed:', getErrorMessage(e));
        }
        return;
      }
      _wasEverConnected = true;

      const myPlatform = Platform.OS ?? 'unknown';
      try {
        ws!.send(JSON.stringify({ __hello: true, platform: myPlatform }));
      } catch {
        /* ignore */
      }

      console.log(`[vitest-mobile] Connected to Vitest (${myPlatform})`);
      setStatus({ state: 'connected', message: 'Connected to Vitest' });
      retryCount = 0;

      registerHmrRerunListener();

      vitestRpc = createBirpc(
        {
          onCancel(reason: string) {
            console.log(`[vitest-mobile] Cancelled: ${reason}`);
          },
        } as unknown as RuntimeRpcBridge,
        {
          post: data => wsSend(data),
          on: handler => {
            birpcHandler = handler;
            for (const msg of pendingMessages) handler(msg);
            pendingMessages = [];
          },
          serialize: v => {
            // Use flatted to preserve circular references (File ↔ Suite ↔ Test)
            try {
              return flatStringify(v);
            } catch (e) {
              console.error('[vitest-mobile] serialize error:', e);
              return JSON.stringify(null);
            }
          },
          deserialize: v => {
            try {
              return flatParse(v as string);
            } catch {
              // Fallback — incoming messages from Vitest use regular JSON
              return JSON.parse(v as string);
            }
          },
          timeout: -1,
        },
      );
    };

    ws.onmessage = event => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      try {
        // Messages from the pool are flatted-encoded
        let msg: PoolWsMessage;
        try {
          msg = flatParse(raw) as PoolWsMessage;
        } catch {
          msg = JSON.parse(raw) as PoolWsMessage;
        }
        // Error from connection manager (e.g., wrong platform)
        if (msg.__error) {
          console.warn(`[vitest-mobile] ${msg.message}`);
          setStatus({ state: 'error', message: msg.message ?? 'Unknown error' });
          // Don't retry — this is a definitive rejection
          retryCount = maxRetries;
          return;
        }
        // Screenshot response from pool
        if (msg.__screenshot_response__) {
          const pending = pendingScreenshots.get(msg.requestId!);
          if (pending) {
            pendingScreenshots.delete(msg.requestId!);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg.filePath!);
            }
          }
          return;
        }
        // Reload signal — pool session restarted, modules are stale
        if (msg.__reload) {
          console.log('[vitest-mobile] Reload requested — fetching fresh bundle');
          try {
            const { NativeModules } = require('react-native');
            NativeModules.DevSettings?.reload?.();
          } catch (e: unknown) {
            console.warn('[vitest-mobile] DevSettings.reload() failed:', getErrorMessage(e));
          }
          return;
        }
        // Resume signal from pool
        if (msg.__resume) {
          resumePause();
          return;
        }
        if (msg.__open_debugger) {
          fetch(`${getMetroBaseUrl()}/open-debugger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }).catch(() => {
            try {
              const { NativeModules } = require('react-native');
              if (NativeModules.DevSettings?.openDebugger) {
                NativeModules.DevSettings.openDebugger();
              } else {
                NativeModules.DevMenu?.show?.();
              }
            } catch {
              /* ignore */
            }
          });
          return;
        }
        if (msg.__native_run_start) {
          const fileCount = msg.fileCount ?? 0;
          const testCount = msg.testCount ?? 0;
          resetRunState();
          setStatus({ state: 'running', message: `Running ${fileCount} test file(s)...` });
          emitTestEvent({ type: 'run-start', fileCount, testCount });
          return;
        }
        if (msg.__native_run_end) {
          setStatus({
            state: 'done',
            message: `Done: ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`,
            passed,
            failed,
            total: passed + failed,
          });
          emitTestEvent({ type: 'run-done', passed, failed, reason: msg.reason });
          return;
        }
        if (msg.__vitest_worker_request__) {
          switch (msg.type) {
            case 'start':
              if (msg.context?.config) {
                storedConfig = msg.context.config as VitestRunnerConfig;
              }
              if ((msg.context?.config as Record<string, unknown> | undefined)?.__poolMode) {
                _poolMode = (msg.context!.config as Record<string, unknown>).__poolMode as 'dev' | 'run';
              }
              invalidateAllTestModules();
              sendResponse({ type: 'started' });
              break;
            case 'run':
              if ((msg.context?.config as Record<string, unknown> | undefined)?.__poolMode) {
                _poolMode = (msg.context!.config as Record<string, unknown>).__poolMode as 'dev' | 'run';
              }
              // Abort any paused/running test so the new run can start
              if (_runAbortController) {
                _runAbortController.abort(new DOMException('New test run starting', 'AbortError'));
              }
              enqueue(() => handleRun(msg.context!));
              break;
            case 'collect':
              enqueue(() => handleCollect(msg.context!));
              break;
            case 'cancel':
              if (_runAbortController) {
                _runAbortController.abort(new DOMException('Cancelled', 'AbortError'));
              }
              break;
            case 'stop':
              sendResponse({ type: 'stopped' });
              break;
          }
          return;
        }
        if (birpcHandler) {
          birpcHandler(raw);
        } else {
          pendingMessages.push(raw);
        }
      } catch {
        /* ignore malformed messages */
      }
    };

    ws.onerror = () => {
      if (retryCount < maxRetries) {
        retryCount++;
        setTimeout(tryConnect, 1000);
      } else {
        setStatus({ state: 'error', message: 'Could not connect to Vitest' });
      }
    };

    ws.onclose = () => {
      const wasConnected = vitestRpc !== null;
      ws = null;
      vitestRpc = null;
      birpcHandler = null;
      if (wasConnected) {
        // Was connected and got disconnected — vitest cycle ended.
        // Reconnect with backoff so we pick up the next watch cycle.
        console.log('[vitest-mobile] Disconnected from Vitest, waiting to reconnect...');
        retryCount = 0;
        setTimeout(tryConnect, 2000);
      }
      // If we were never fully connected (just a failed attempt),
      // onerror already handles retries — don't double-reconnect.
    };
  }

  tryConnect();
}
