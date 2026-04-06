/**
 * Custom Vitest pool worker — bridges to a React Native app over WebSocket.
 *
 * Two modes:
 *   dev  (vitest --watch) — visible emulator, reuse app/Metro, leave running
 *   run  (vitest run)     — headless, clean start, shut down after
 *
 * Metro is started programmatically via metro-runner.ts. The harness binary
 * is auto-built and cached by harness-builder.ts. Test files are discovered
 * from vitest include patterns and exposed via a generated test registry.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { parse as flatParse, stringify as flatStringify } from 'flatted';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkEnvironment } from './environment';
import { ensureDevice, launchApp, stopApp, shutdownDevice } from './device';
import { captureScreenshot } from './screenshot';
import { ensureHarnessBinary, detectReactNativeVersion } from './harness-builder';
import { startMetroServer, type MetroServer as MetroRunnerServer } from './metro-runner';

import { createColors } from 'picocolors';
import { log, setVerbose, isVerbose } from './logger';
import { attachCodeFrames, isInternalLog, type BiRpcMessage } from './code-frame';
import type { NativePoolOptions, Platform } from './types';

const isColorEnabled = !process.env.CI && !!process.stdout.isTTY;
const pc = createColors(isColorEnabled);

const DEFAULT_BUNDLE_ID = 'com.vitest.native.harness';

// TypeScript's DOM lib declares setTimeout as returning `number`; Node.js returns
// a Timeout object with .unref(). Cast through unknown to access it safely.
function unrefTimer(t: ReturnType<typeof setTimeout>): void {
  (t as unknown as { unref(): void }).unref();
}

// Module-level singletons — persist across pool worker recreations (watch cycles)
let _wss: WebSocketServer | null = null;
let _connectedSocket: WebSocket | null = null;
let _metroServer: ChildProcess | null = null;
let _currentEmit: ((event: string, data: unknown) => void) | null = null;
let _resolveConnection: (() => void) | null = null;
let _hasCompletedCycle = false;
let _fileIndex = 0;
let _totalFiles = 0;
let _runBuffer: { message: any; names: string[] }[] = [];
let _flushHandle: any = null;
let _startPromise: Promise<void> | null = null;

type EventCallback = (data: unknown) => void;

export function createNativePoolWorker(options: NativePoolOptions) {
  const port = options.port ?? 7878;
  const metroPort = options.metroPort ?? 8081;
  const platform: Platform = options.platform ?? 'android';
  const deviceId = options.deviceId;
  const skipIfUnavailable = options.skipIfUnavailable ?? false;
  const mode = options.mode ?? 'run';
  const headless = options.headless ?? mode === 'run';
  const shouldShutdownEmulator = options.shutdownEmulator ?? mode === 'run';

  const appDir = options.appDir ?? process.cwd();

  // Auto-detect bundle ID from app.json if not explicitly configured
  function detectBundleId(): string {
    if (options.bundleId) return options.bundleId;
    try {
      const appJsonPath = resolve(appDir, 'app.json');
      if (existsSync(appJsonPath)) {
        const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'));
        const expo = appJson.expo ?? appJson;
        const platform_ = options.platform ?? 'ios';
        if (platform_ === 'ios' && expo.ios?.bundleIdentifier) return expo.ios.bundleIdentifier;
        if (platform_ === 'android' && expo.android?.package) return expo.android.package;
      }
    } catch { /* fall through to default */ }
    return DEFAULT_BUNDLE_ID;
  }
  let bundleId = detectBundleId();
  const testInclude = options.testInclude ?? ['packages/**/tests/**/*.test.tsx', 'packages/**/tests/**/*.test.ts'];

  if (options.verbose) setVerbose(true);

  const listeners = new Map<string, Set<EventCallback>>();
  const listenerWrappers = new Map<EventCallback, EventCallback>();

  log.verbose(`Mode: ${mode} | Headless: ${headless} | Platform: ${platform}`);

  // ── Cleanup ─────────────────────────────────────────────────────

  async function cleanup(): Promise<void> {
    cleanupPauseListeners();
    closeMetro();
    if (_connectedSocket) {
      try { _connectedSocket.terminate(); } catch { /* ignore */ }
      _connectedSocket = null;
    }
    await closeWss();
    if (mode === 'run') {
      stopApp(platform, bundleId);
      if (shouldShutdownEmulator) shutdownDevice(platform);
    }
  }

  // Handle signals so Ctrl+C actually kills everything
  function onSignal() {
    cleanup().finally(() => process.exit(1));
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // On process exit (sync), force-kill Metro so it doesn't orphan
  process.once('exit', () => {
    if (_metroServer?.pid) {
      try { process.kill(-_metroServer.pid, 'SIGKILL'); } catch { /* ignore */ }
    }
  });

  function emit(event: string, data: unknown): void {
    const cbs = listeners.get(event);
    if (cbs) cbs.forEach(cb => cb(data));
  }
  _currentEmit = emit;

  // ── Test registry generation ───────────────────────────────────
  // Uses the shared generateTestRegistry utility (same one withNativeTests uses).
  // This ensures the pool and Metro config agree on the generated file format.

  function generateTestRegistryForPool(): void {
    const { generateTestRegistry } = require('../metro/generateTestRegistry');
    const outputDir = resolve(appDir, '.vitest-native');
    const result = generateTestRegistry({
      projectRoot: appDir,
      testPatterns: testInclude,
      outputDir,
    });
    if (_totalFiles === 0) {
      _totalFiles = result.testFiles.length;
      log.info(`Found ${pc.bold(String(result.testFiles.length))} test file(s)`);
    }
  }

  // ── Metro (programmatic via Metro.runServer) ───────────────────

  let _metroRunner: MetroRunnerServer | null = null;

  async function startMetro(): Promise<void> {
    log.info('Starting Metro...');
    _metroRunner = await startMetroServer({
      projectRoot: appDir,
      port: metroPort,
      platform,
      testPatterns: testInclude,
      appModuleName: 'VitestNativeHarness',
      mode,
    });
  }

  async function isMetroRunning(): Promise<boolean> {
    try {
      // Try /status (legacy Metro) then fall back to any HTTP response on the port
      const res = await fetch(`http://localhost:${metroPort}/status`);
      const text = await res.text();
      // Metro v0.83+ may return 404 for /status but is still running
      return res.ok || text.includes('packager-status:running') || res.status === 404;
    } catch {
      return false;
    }
  }

  function killStaleOnPort(targetPort: number): void {
    try {
      const pids = execSync(`lsof -ti:${targetPort}`, { encoding: 'utf8', stdio: 'pipe' }).trim();
      if (!pids) return;
      const myPid = String(process.pid);
      const pidList = pids.split('\n').filter(p => p && p !== myPid);
      for (const pid of pidList) {
        try {
          process.kill(parseInt(pid), 'SIGTERM');
        } catch {
          /* already dead */
        }
      }
      if (pidList.length > 0) {
        log.verbose(`Killed stale process(es) on port ${targetPort}`);
      }
    } catch {
      /* no processes on port */
    }
  }

  function closeMetro(): void {
    // Close programmatic Metro runner
    if (_metroRunner) {
      _metroRunner.close().catch(() => {});
      _metroRunner = null;
      log.verbose('Metro runner closed');
    }
    // Also handle legacy child process Metro (if any)
    if (_metroServer) {
      const mp = _metroServer;
      _metroServer = null;
      try {
        mp.stdout?.destroy();
      } catch {
        /* ignore */
      }
      try {
        mp.stderr?.destroy();
      } catch {
        /* ignore */
      }
      try {
        process.kill(-mp.pid!, 'SIGTERM');
      } catch {
        /* ignore */
      }
      const t = setTimeout(() => {
        try {
          process.kill(-mp.pid!, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2000);
      unrefTimer(t);
      log.verbose('Metro closed');
    }
  }

  // ── WS server ──────────────────────────────────────────────────

  function setupWss(): void {
    if (_wss) return;
    killStaleOnPort(port);
    _wss = new WebSocketServer({ port });
    // Unref the underlying server so it doesn't prevent process exit
    (_wss as any)._server?.unref();
    _wss.on('connection', (socket: WebSocket) => {
      if (_connectedSocket && _connectedSocket !== socket && _connectedSocket.readyState <= 1) {
        socket.close();
        return;
      }
      log.info('App connected');
      _connectedSocket = socket;
      socket.on('message', (data: Buffer) => {
        const raw = data.toString();
        try {
          let msg: BiRpcMessage;
          try {
            msg = flatParse(raw) as BiRpcMessage;
          } catch {
            msg = JSON.parse(raw) as BiRpcMessage;
          }
          // Handle screenshot requests from runtime
          if ((msg as any).__screenshot_request__) {
            handleScreenshotRequest(socket, msg as any);
            return;
          }
          // Handle pause/resume signals from runtime
          if ((msg as any).__pause) {
            handlePause(msg as any);
            return;
          }
          if ((msg as any).__pause_ended) {
            handlePauseEnded();
            return;
          }
          attachCodeFrames(msg);
          _currentEmit?.('message', msg);
        } catch (e) {
          log.error('Parse error:', e);
        }
      });
      socket.on('close', () => {
        if (_connectedSocket === socket) _connectedSocket = null;
      });
      _resolveConnection?.();
    });
    _wss.on('error', (err: Error) => log.error('WS error:', err));
  }

  function closeWss(): Promise<void> {
    if (!_wss) return Promise.resolve();
    return new Promise(resolvePromise => {
      for (const client of _wss!.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
      _wss!.close(() => {
        _wss = null;
        resolvePromise();
      });
      const t = setTimeout(() => {
        _wss = null;
        resolvePromise();
      }, 1000);
      unrefTimer(t);
    });
  }

  // ── Screenshot request handler ─────────────────────────────────

  function handleScreenshotRequest(
    socket: WebSocket,
    msg: { requestId: string; name?: string },
  ): void {
    try {
      const result = captureScreenshot({ platform, name: msg.name });
      socket.send(
        JSON.stringify({
          __screenshot_response__: true,
          requestId: msg.requestId,
          filePath: result.filePath,
        }),
      );
      log.info(`Screenshot saved: ${result.filePath}`);
    } catch (err) {
      socket.send(
        JSON.stringify({
          __screenshot_response__: true,
          requestId: msg.requestId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // ── Pause/resume handling ─────────────────────────────────────

  let _isPaused = false;
  let _pauseLabel: string | null = null;
  let _stdinResumeHandler: ((data: Buffer) => void) | null = null;
  let _resumeFileWatcher: ReturnType<typeof setInterval> | null = null;

  function handlePause(msg: { label?: string; screenshot?: boolean }): void {
    _isPaused = true;
    _pauseLabel = msg.label ?? null;

    const label = msg.label ? `: ${msg.label}` : '';
    log.info('');
    log.info(pc.bold(pc.yellow(`⏸  PAUSED${label}`)));
    log.info('Component is rendered on device. Edit files — HMR will update live.');
    log.info(`Resume: Press Enter or run ${pc.cyan('npx vitest-react-native-runtime resume')}`);

    // Auto-screenshot on pause (default: true)
    if (msg.screenshot !== false) {
      try {
        const result = captureScreenshot({ platform, name: 'paused' });
        log.info(`Screenshot: ${pc.cyan(result.filePath)}`);
      } catch (err) {
        log.warn(`Auto-screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log.info('');

    // Listen for Enter key on stdin
    if (process.stdin.isTTY) {
      _stdinResumeHandler = () => {
        if (_isPaused) doResume();
      };
      process.stdin.setRawMode(false);
      process.stdin.resume();
      process.stdin.once('data', _stdinResumeHandler);
    }

    // Poll for file-based resume signal
    const signalPath = resolve(appDir, '.vitest-native', 'resume-signal');
    _resumeFileWatcher = setInterval(() => {
      if (existsSync(signalPath)) {
        try {
          const { unlinkSync } = require('node:fs');
          unlinkSync(signalPath);
        } catch { /* ignore */ }
        if (_isPaused) doResume();
      }
    }, 500);
  }

  function handlePauseEnded(): void {
    cleanupPauseListeners();
    if (_isPaused) {
      _isPaused = false;
      _pauseLabel = null;
      log.info(pc.green('Resumed'));
    }
  }

  function doResume(): void {
    cleanupPauseListeners();
    _isPaused = false;
    _pauseLabel = null;
    if (_connectedSocket) {
      _connectedSocket.send(JSON.stringify({ __resume: true }));
    }
    log.info(pc.green('Resumed'));
  }

  function cleanupPauseListeners(): void {
    if (_stdinResumeHandler) {
      process.stdin.removeListener('data', _stdinResumeHandler);
      _stdinResumeHandler = null;
      if (process.stdin.isTTY) {
        process.stdin.pause();
      }
    }
    if (_resumeFileWatcher) {
      clearInterval(_resumeFileWatcher);
      _resumeFileWatcher = null;
    }
  }

  // ── Startup logic (extracted so the pool worker can serialize concurrent calls) ──

  async function doStart(): Promise<void> {
    // ── Step 1: Check environment
    const envResult = checkEnvironment(platform);
    if (!envResult.ok) {
      log.error('\nEnvironment check failed:\n');
      for (const issue of envResult.issues) {
        log.error(`  ✗ ${issue.message}`);
        if (issue.fix) log.error(`    Fix: ${issue.fix}\n`);
      }
      if (skipIfUnavailable) {
        log.warn('Skipping native tests (skipIfUnavailable)\n');
        emit('message', { __vitest_worker_response__: true, type: 'started' });
        return;
      }
      throw new Error('Environment not ready. See above for setup instructions.');
    }

    // ── Step 2: Ensure harness binary
    if (options.harnessApp) {
      // Use pre-built binary directly
      log.info(`Using pre-built harness: ${options.harnessApp}`);
      const binaryPath = resolve(options.harnessApp);
      if (!existsSync(binaryPath)) {
        throw new Error(`Harness binary not found: ${binaryPath}`);
      }
      // Install on device
      log.info('Installing harness binary on device...');
      try {
        if (platform === 'ios') {
          execSync(`xcrun simctl install booted "${binaryPath}"`, { stdio: 'pipe' });
        } else if (platform === 'android') {
          execSync(`adb install -r "${binaryPath}"`, { stdio: 'pipe' });
        }
      } catch (e) {
        log.verbose(`Install may have failed (non-fatal if already installed): ${e}`);
      }
    } else {
      const packageRoot = resolve(__dirname, '..', '..');
      const rnVersion = detectReactNativeVersion(appDir);
      log.info(`React Native version: ${rnVersion}`);

      const harnessResult = await ensureHarnessBinary({
        platform,
        reactNativeVersion: rnVersion,
        nativeModules: options.nativeModules ?? [],
        packageRoot,
        projectRoot: appDir,
      });

      bundleId = harnessResult.bundleId;

      if (!harnessResult.cached || mode === 'run') {
        log.info('Installing harness binary on device...');
        try {
          if (platform === 'ios') {
            execSync(`xcrun simctl install booted "${harnessResult.binaryPath}"`, { stdio: 'pipe' });
          } else if (platform === 'android') {
            execSync(`adb install -r "${harnessResult.binaryPath}"`, { stdio: 'pipe' });
          }
        } catch (e) {
          log.verbose(`Install may have failed (non-fatal if already installed): ${e}`);
        }
      }
    }

    // ── Step 3: Ensure device
    await ensureDevice(platform, { wsPort: port, metroPort, deviceId, headless });

    // ── Step 4: Generate test registry (Metro runner also generates, but
    //    the pool may need it for file counting)
    generateTestRegistryForPool();

    // ── Step 5: WS server
    if (_connectedSocket) {
      log.verbose('Reusing existing app connection');
    } else {
      setupWss();
    }

    // ── Step 6: Metro
    if (_metroRunner || _metroServer) {
      log.verbose('Metro already running, reusing');
    } else {
      const metroAlready = await isMetroRunning();
      if (metroAlready) {
        log.verbose('External Metro already running on port, reusing');
      } else {
        killStaleOnPort(metroPort);
        await startMetro();
      }
    }

    // ── Step 7: App
    async function launchWithRetry(): Promise<void> {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          launchApp(platform, bundleId, { metroPort, deviceId });
          return;
        } catch (err) {
          if (attempt === 0) {
            log.warn('Launch failed, re-checking device...');
            await ensureDevice(platform, { wsPort: port, metroPort, deviceId, headless });
          } else {
            throw new Error(`Failed to launch app after retry: ${(err as Error).message}`, { cause: err });
          }
        }
      }
    }

    function waitForApp(timeoutMs = 30000): Promise<void> {
      return new Promise((resolvePromise, reject) => {
        if (_connectedSocket) {
          resolvePromise();
          return;
        }
        const original = _resolveConnection;
        const t = setTimeout(() => {
          if (!_connectedSocket) reject(new Error(`App did not connect within ${timeoutMs / 1000}s`));
        }, timeoutMs);
        unrefTimer(t);
        _resolveConnection = () => {
          clearTimeout(t);
          original?.();
          resolvePromise();
        };
      });
    }

    if (_connectedSocket && _hasCompletedCycle) {
      log.verbose('Reusing existing app connection');
    } else if (_connectedSocket) {
      log.verbose('Reusing existing app connection (first cycle)');
    } else {
      // Give a running app 5s to connect before killing + relaunching.
      log.info('Waiting for app to connect...');
      try {
        await waitForApp(5000);
        log.info('App connected (was already running)');
      } catch {
        log.info('App not connected, launching...');
        stopApp(platform, bundleId);
        await new Promise<void>(r => {
          const t = setTimeout(r, 1000);
          unrefTimer(t);
        });
        await launchWithRetry();
        await waitForApp(30000);
      }
    }
  }

  // ── Run buffer (batch run messages to get accurate per-cycle file count) ──

  function flushRunBuffer(): void {
    _flushHandle = null;
    const buffered = _runBuffer;
    _runBuffer = [];
    const fileCount = buffered.length;

    // Tell the runtime how many files to expect in this cycle
    if (_connectedSocket) {
      _connectedSocket.send(JSON.stringify({
        __native_run_start: true,
        fileCount,
      }));
    }

    for (const { message, names } of buffered) {
      _fileIndex++;
      log.info(`[${_fileIndex}/${fileCount}] ${names.join(', ')}`);
      if (_connectedSocket) {
        _connectedSocket.send(flatStringify(message));
      } else {
        emit('message', {
          __vitest_worker_response__: true,
          type: 'testfileFinished',
          error: new Error('RN app not connected'),
        });
      }
    }
  }

  // ── Pool Worker ────────────────────────────────────────────────

  const worker = {
    name: 'native' as const,
    reportMemory: false,

    on(event: string, callback: EventCallback): void {
      const wrappedCb: EventCallback = data => {
        if (event === 'message') {
          const msg = data as BiRpcMessage;
          if (msg?.m === 'onCollected') {
            log.verbose(`onCollected: ${(msg?.a?.[0] as unknown[] | undefined)?.length} file(s)`);
          }
        }
        callback(data);
      };
      listenerWrappers.set(callback, wrappedCb);
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(wrappedCb);
    },

    off(event: string, callback: EventCallback): void {
      const wrapped = listenerWrappers.get(callback);
      if (wrapped) {
        listeners.get(event)?.delete(wrapped);
        listenerWrappers.delete(callback);
      }
    },

    deserialize(data: unknown): unknown {
      return data;
    },

    async start(): Promise<void> {
      // Deduplicate concurrent start() calls from parallel test files.
      // All callers share one doStart() promise.
      if (!_startPromise) {
        _startPromise = doStart();
      }
      await _startPromise;
    },

    async stop(): Promise<void> {
      _hasCompletedCycle = true;
      emit('message', { __vitest_worker_response__: true, type: 'stopped' });
    },


    send(message: BiRpcMessage): void {
      if (message?.__vitest_worker_request__) {
        switch (message.type) {
          case 'start':
            // Reset per-cycle counters
            _fileIndex = 0;
            _runBuffer = [];
            if (_flushHandle) { clearImmediate(_flushHandle); _flushHandle = null; }
            // In dev mode, disable test timeouts to allow pause() and inject mode
            if (mode === 'dev' && (message as any).context?.config) {
              (message as any).context.config.testTimeout = 0;
              (message as any).context.config.hookTimeout = 0;
              (message as any).context.config.__poolMode = 'dev';
            } else if ((message as any).context?.config) {
              (message as any).context.config.__poolMode = 'run';
            }
            if (_connectedSocket) _connectedSocket.send(flatStringify(message));
            emit('message', { __vitest_worker_response__: true, type: 'started' });
            break;
          case 'run':
          case 'collect': {
            const files = (message as any).context?.files as { filepath?: string }[] | undefined;
            if (files?.length && message.type === 'run') {
              // Buffer run messages so we can count all files before sending
              const names = files.map(f => {
                const fp = f.filepath ?? '';
                return pc.cyan(fp.split('/').pop() ?? fp);
              });
              _runBuffer.push({ message, names });
              if (!_flushHandle) {
                _flushHandle = setImmediate(() => flushRunBuffer());
              }
            } else {
              // collect messages — send immediately
              if (_connectedSocket) {
                _connectedSocket.send(flatStringify(message));
              } else {
                emit('message', {
                  __vitest_worker_response__: true,
                  type: 'testfileFinished',
                  error: new Error('RN app not connected'),
                });
              }
            }
            break;
          }
          case 'cancel':
            if (_connectedSocket) _connectedSocket.send(flatStringify(message));
            break;
          case 'stop':
            this.stop();
            break;
        }
        return;
      }

      if (_connectedSocket) {
        try {
          _connectedSocket.send(flatStringify(message));
        } catch (e) {
          log.error('Failed to relay birpc:', e);
        }
      }
    },
  };

  return worker;
}
