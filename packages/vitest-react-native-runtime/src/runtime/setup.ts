/**
 * Runtime setup — connects the RN app to the Vitest pool over WebSocket.
 */

import { createBirpc } from 'birpc';
import { stringify as flatStringify, parse as flatParse } from 'flatted';
import { startTests, collectTests } from '@vitest/runner';
import { ReactNativeRunner } from './runner';
import { symbolicateStack } from './symbolicate';

let ws: WebSocket | null = null;
let vitestRpc: any = null;
let storedConfig: any = null;
let _poolMode: 'dev' | 'run' = 'dev';

/** Check if we have an active WebSocket connection to the Vitest pool. */
export function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

// ── Screenshot request/response ──────────────────────────────────

const pendingScreenshots = new Map<
  string,
  { resolve: (filePath: string) => void; reject: (err: Error) => void }
>();

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

// ── Status (re-exported from state.ts to avoid circular dep) ─────

import { setStatus, addLog, resetLogs, onStatusChange } from './state';
export { setStatus, onStatusChange };
export type { HarnessStatus } from './state';

// ── WebSocket transport ───────────────────────────────────────────

function wsSend(data: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

function sendResponse(response: any) {
  wsSend(flatStringify({ __vitest_worker_response__: true, ...response }));
}

// ── Test execution handlers ───────────────────────────────────────

let passed = 0;
let failed = 0;
let fileIndex = 0;
let fileCount = 0;

function resetRunState() {
  passed = 0;
  failed = 0;
  fileIndex = 0;
  fileCount = 0;
  resetLogs();
}

async function handleRun(context: any) {
  // Set up abort controller for this run (used by pause() to detect cancellation)
  _runAbortController = new AbortController();
  const notifyPool = (msg: any) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };
  configurePause({ notifyPool, abortSignal: _runAbortController.signal, mode: _poolMode });

  const files = context.files;
  fileIndex++;

  // Extract a short filename for the UI
  const filePath: string = files?.[0]?.filepath ?? '';
  const fileName = filePath.split('/').pop() ?? filePath;
  // Derive the module/suite name from the path (e.g. modules/counter/tests/counter.test.tsx → counter)
  const parts = filePath.split('/');
  const modulesIdx = parts.indexOf('modules');
  const moduleName = modulesIdx >= 0 ? parts[modulesIdx + 1] : fileName;

  setStatus({
    state: 'running',
    message: `[${fileIndex}/${fileCount}] ${moduleName}`,
    currentFile: fileName,
    fileIndex,
    fileCount,
  });

  // Yield to let React render the updated progress before tests block the thread
  await new Promise(r => setTimeout(r, 0));

  try {
    const config = storedConfig ??
      context.config ?? {
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

    const runner = new ReactNativeRunner(config, vitestRpc, test => {
      const name = test.name ?? '?';
      const state = test.result?.state ?? 'unknown';
      const duration = test.result?.duration ?? 0;
      if (state === 'pass') {
        passed++;
        addLog(`✓ ${name} (${duration}ms)`);
      } else {
        failed++;
        const errMsg = test.result?.errors?.[0]?.message ?? 'unknown error';
        addLog(`✗ ${name} (${duration}ms)\n  ${errMsg}`);
      }
      setStatus({
        passed,
        failed,
        total: passed + failed,
        message: `[${fileIndex}/${fileCount}] ${moduleName} — ${passed + failed} tests`,
      });
    });

    await startTests(files ?? [], runner);
  } catch (err: any) {
    // AbortError means a new run is starting — don't report as failure
    if (err?.name === 'AbortError') {
      console.log('[vitest-react-native-runtime] Run aborted (new run starting)');
    } else {
      console.error('[vitest-react-native-runtime] Run error:', err);
      addLog(`ERROR: ${err?.message}`);
      setStatus({ state: 'error', message: err?.message ?? 'Unknown error' });
      try {
        const stack = err?.stack ? await symbolicateStack(err.stack) : err?.stack;
        vitestRpc?.onUnhandledError({ message: err?.message, stack, name: err?.name }, 'Unhandled Error');
      } catch {
        /* ignore symbolication errors */
      }
    }
  } finally {
    resetPause();
    _runAbortController = null;
  }

  // Show done state only after the last file
  if (fileIndex >= fileCount) {
    setStatus({
      state: 'done',
      message: `Done: ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`,
      passed,
      failed,
      total: passed + failed,
    });
  }

  await new Promise(r => setTimeout(r, 100));
  sendResponse({ type: 'testfileFinished' });
}

async function handleCollect(context: any) {
  const files = context.files;
  setStatus({ state: 'running', message: `Collecting ${files?.length ?? 0} file(s)...` });

  try {
    const config = context.config ?? {};
    const runner = new ReactNativeRunner(config, vitestRpc);
    await collectTests(files ?? [], runner);
  } catch (err: any) {
    console.error('[vitest-react-native-runtime] Collect error:', err);
  }

  sendResponse({ type: 'testfileFinished' });
}

// ── Connect to Vitest ─────────────────────────────────────────────

export interface ConnectOptions {
  port?: number;
  host?: string;
}

export function connectToVitest(options: ConnectOptions = {}) {
  const port = options.port ?? 7878;
  const host = options.host ?? '127.0.0.1';
  const url = `ws://${host}:${port}`;
  const maxRetries = 30;
  let retryCount = 0;

  let pendingMessages: string[] = [];
  let birpcHandler: ((data: string) => void) | null = null;

  function tryConnect() {
    // Don't open a new connection if we already have a live one
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    setStatus({ state: 'connecting', message: `Connecting to Vitest... (${retryCount + 1})` });
    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('[vitest-react-native-runtime] Connected to Vitest');
      setStatus({ state: 'connected', message: 'Connected to Vitest' });
      retryCount = 0;

      vitestRpc = createBirpc(
        {
          onCancel(reason: string) {
            console.log(`[vitest-react-native-runtime] Cancelled: ${reason}`);
          },
        } as any,
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
              console.error('[vitest-react-native-runtime] serialize error:', e);
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
        let msg: any;
        try {
          msg = flatParse(raw);
        } catch {
          msg = JSON.parse(raw);
        }
        // Screenshot response from pool
        if (msg.__screenshot_response__) {
          const pending = pendingScreenshots.get(msg.requestId);
          if (pending) {
            pendingScreenshots.delete(msg.requestId);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg.filePath);
            }
          }
          return;
        }
        // Resume signal from pool
        if (msg.__resume) {
          resumePause();
          return;
        }
        if (msg.__native_run_start) {
          resetRunState();
          fileCount = msg.fileCount ?? 0;
          setStatus({ state: 'running', message: `Running ${fileCount} test file(s)...` });
          return;
        }
        if (msg.__vitest_worker_request__) {
          switch (msg.type) {
            case 'start':
              if (msg.context?.config) {
                storedConfig = msg.context.config;
              }
              if (msg.context?.config?.__poolMode) {
                _poolMode = msg.context.config.__poolMode;
              }
              sendResponse({ type: 'started' });
              break;
            case 'run':
              // Abort any paused/running test so the new run can start
              if (_runAbortController) {
                _runAbortController.abort(new DOMException('New test run starting', 'AbortError'));
              }
              enqueue(() => handleRun(msg.context));
              break;
            case 'collect':
              enqueue(() => handleCollect(msg.context));
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
        console.log('[vitest-react-native-runtime] Disconnected from Vitest, waiting to reconnect...');
        retryCount = 0;
        setTimeout(tryConnect, 2000);
      }
      // If we were never fully connected (just a failed attempt),
      // onerror already handles retries — don't double-reconnect.
    };
  }

  tryConnect();
}
