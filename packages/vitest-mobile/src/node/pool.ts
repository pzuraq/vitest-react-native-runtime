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
 *
 * Multiple pool workers (one per platform) share a single WebSocket server
 * via the connection manager (connections.ts). Each app identifies itself
 * with a platform hello, and the server routes it to the right worker.
 */

import { type WebSocket } from 'ws';
import { parse as flatParse, stringify as flatStringify } from 'flatted';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkEnvironment } from './environment';
import { ensureDevice, launchApp, stopApp, getInstalledCacheKey } from './device';
import { getAdbPath } from './exec-utils';
import { captureScreenshot } from './screenshot';
import { findHarnessBinary, detectReactNativeVersion } from './harness-builder';
import { startMetroServer, type MetroServer as MetroRunnerServer, type BundleManifest } from './metro-runner';
import { registerPlatform, unregisterPlatform, closeServer } from './connections';
import {
  registerInstanceRecord,
  releaseInstanceRecord,
  resolveInstanceResources,
  updateInstanceRecord,
} from './instance-manager';

import { createColors } from 'picocolors';
import { log, setVerbose } from './logger';
import { generateTestRegistry } from '../metro/generateTestRegistry';
import { attachCodeFrames, type BiRpcMessage } from './code-frame';
import type { NativePoolOptions, Platform } from './types';
import {
  isScreenshotRequest,
  isPauseMessage,
  isPauseEndedMessage,
  isRerunMessage,
  isCancelMessage,
  type VitestWorkerContext,
} from './pool-messages';

const isColorEnabled = !process.env.CI && !!process.stdout.isTTY;
const pc = createColors(isColorEnabled);

const DEFAULT_BUNDLE_ID = 'com.vitest.mobile.harness';

// TypeScript's DOM lib declares setTimeout as returning `number`; Node.js returns
// a Timeout object with .unref(). Cast through unknown to access it safely.
function unrefTimer(t: ReturnType<typeof setTimeout>): void {
  (t as unknown as { unref(): void }).unref();
}

type EventCallback = (data: unknown) => void;

// ── Pre-built bundle detection + static server ──────────────────

function detectPrebuiltBundle(appDir: string, platform: string): (BundleManifest & { bundleDir: string }) | null {
  const bundleDir = resolve(appDir, '.vitest-mobile', 'bundle');
  const manifestPath = resolve(bundleDir, 'bundle-manifest.json');
  if (!existsSync(manifestPath)) return null;

  try {
    const manifest: BundleManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry = manifest.bundles[platform];
    if (!entry) return null;
    const bundlePath = resolve(bundleDir, entry.bundleFile);
    if (!existsSync(bundlePath)) return null;
    return { ...manifest, bundleDir };
  } catch {
    return null;
  }
}

function startStaticBundleServer(
  bundleDir: string,
  manifest: BundleManifest,
  platform: string,
): Promise<MetroRunnerServer> {
  const entry = manifest.bundles[platform]!;
  const bundlePath = resolve(bundleDir, entry.bundleFile);
  const sourcemapPath = resolve(bundleDir, entry.sourcemapFile);
  const bundleContent = readFileSync(bundlePath);
  const sourcemapContent = existsSync(sourcemapPath) ? readFileSync(sourcemapPath) : null;

  return new Promise((resolveServer, reject) => {
    const server = createHttpServer((req, res) => {
      const url = req.url ?? '';

      if (url === '/status') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('packager-status:running');
        return;
      }

      if (url.includes('.bundle') || url.includes('.js')) {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(bundleContent);
        return;
      }

      if (url.endsWith('.map') && sourcemapContent) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(sourcemapContent);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.on('error', reject);
    server.listen(manifest.metroPort, '127.0.0.1', () => {
      (server as HttpServer & { unref?: () => void }).unref?.();
      log.info(`Static bundle server on port ${manifest.metroPort} (pre-built)`);
      resolveServer({
        port: manifest.metroPort,
        async close() {
          await new Promise<void>(r => {
            server.close(() => r());
            setTimeout(r, 1000);
          });
        },
      });
    });
  });
}

export function createNativePoolWorker(options: NativePoolOptions) {
  let port = options.port ?? 17878;
  let metroPort = options.metroPort ?? 18081;
  const platform: Platform = options.platform ?? 'android';
  let deviceId = options.deviceId;
  const skipIfUnavailable = options.skipIfUnavailable ?? false;
  const mode = options.mode ?? 'run';
  const headless = options.headless ?? mode === 'run';
  const promptForNewDevice = options.promptForNewDevice ?? true;
  const appConnectTimeout = options.appConnectTimeout ?? 180_000;

  const appDir = options.appDir ?? process.cwd();
  let outputDir = resolve(appDir, '.vitest-mobile');
  let instanceId = 'unresolved';

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
    } catch {
      /* fall through to default */
    }
    return DEFAULT_BUNDLE_ID;
  }
  let bundleId = detectBundleId();
  const testInclude = options.testInclude ?? ['packages/**/tests/**/*.test.tsx', 'packages/**/tests/**/*.test.ts'];

  if (options.verbose) setVerbose(true);

  const listeners = new Map<string, Set<EventCallback>>();
  const listenerWrappers = new Map<EventCallback, EventCallback>();

  log.verbose(`Mode: ${mode} | Headless: ${headless} | Platform: ${platform}`);

  // ── Per-worker state (closure-scoped, not module-level) ────────
  // Each pool worker (one per platform) gets its own set of state.
  // The shared WS server in connections.ts routes sockets here.

  let _connectedSocket: WebSocket | null = null;
  let _resolveConnection: (() => void) | null = null;
  let _hasCompletedCycle = false;
  let _startPromise: Promise<void> | null = null;
  let _startComplete = false;
  let _metroRunner: MetroRunnerServer | null = null;
  let _harnessProjectDir: string | undefined;
  let _rerunCallback: ((files: string[], pattern?: string) => void) | null = null;
  const _lastRunMessages = new Map<string, BiRpcMessage>();
  const _registryToAbsPath = new Map<string, string>();
  let _sessionCount = 0;
  let _instanceRegistered = false;
  let _startConfigSent = false;

  function waitForApp(timeoutMs = appConnectTimeout): Promise<void> {
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

  // ── Cleanup ─────────────────────────────────────────────────────

  async function cleanup(): Promise<void> {
    cleanupPauseListeners();
    await closeMetro();
    if (_connectedSocket) {
      try {
        _connectedSocket.terminate();
      } catch {
        /* ignore */
      }
      _connectedSocket = null;
    }
    unregisterPlatform(platform);
    if (_instanceRegistered) {
      releaseInstanceRecord(appDir, instanceId);
      _instanceRegistered = false;
    }
    // App and emulator stay running — Metro is in-process and dies
    // with Vitest naturally. Next run reconnects to the live app.
  }

  // Handle signals so Ctrl+C actually kills everything
  function onSignal() {
    cleanup().finally(() => process.exit(1));
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  function emit(event: string, data: unknown): void {
    const cbs = listeners.get(event);
    if (cbs) cbs.forEach(cb => cb(data));
  }

  // ── Test registry generation ───────────────────────────────────

  function generateTestRegistryForPool(): void {
    const result = generateTestRegistry({
      projectRoot: appDir,
      testPatterns: testInclude,
      outputDir,
    });
    log.info(`Found ${pc.bold(String(result.testFiles.length))} test file(s)`);
  }

  // ── Metro (programmatic via Metro.runServer) ───────────────────

  async function startMetro(): Promise<void> {
    log.info('Starting Metro...');
    _metroRunner = await startMetroServer({
      projectRoot: appDir,
      port: metroPort,
      platform,
      testPatterns: testInclude,
      appModuleName: 'VitestMobileApp',
      outputDir,
      wsPort: port,
      harnessProjectDir: _harnessProjectDir,
    });
  }

  async function closeMetro(): Promise<void> {
    if (_metroRunner) {
      const runner = _metroRunner;
      _metroRunner = null;
      try {
        await runner.close();
      } catch {
        /* ignore */
      }
      log.verbose('Metro runner closed');
    }
  }

  // ── Connection handler (called by shared connection manager) ───

  function handleAppConnection(socket: WebSocket): void {
    // If we already have a live connection, reject the new one
    if (_connectedSocket && _connectedSocket.readyState <= 1) {
      try {
        socket.send(
          JSON.stringify({
            __error: true,
            message: `A ${platform} app is already connected. Only one connection per platform is allowed.`,
          }),
        );
      } catch {
        /* ignore */
      }
      socket.close();
      return;
    }

    const isReconnect = _hasCompletedCycle;
    log.info(`${platform} app ${isReconnect ? 'reconnected' : 'connected'}`);
    _connectedSocket = socket;

    // If the app reconnected after a completed test cycle (e.g. harness code
    // changed → Metro HMR → DevSettings.reload()), rerun all tests.
    if (isReconnect && _rerunCallback) {
      const testFiles = Array.from(_lastRunMessages.keys()).filter(k => k.startsWith('/'));
      if (testFiles.length > 0) {
        log.info('Triggering rerun after app reload...');
        setTimeout(() => _rerunCallback?.(testFiles), 500);
      }
    }

    socket.on('message', async (data: Buffer) => {
      const raw = data.toString();
      try {
        let msg: BiRpcMessage;
        try {
          msg = flatParse(raw) as BiRpcMessage;
        } catch {
          msg = JSON.parse(raw) as BiRpcMessage;
        }
        if (isScreenshotRequest(msg)) {
          handleScreenshotRequest(socket, msg);
          return;
        }
        if (isPauseMessage(msg)) {
          handlePause(msg);
          return;
        }
        if (isPauseEndedMessage(msg)) {
          handlePauseEnded();
          return;
        }
        if (isRerunMessage(msg)) {
          const label = (msg.label as string | undefined) ?? 'unknown';
          const files = msg.files as string[] | undefined;
          const pattern = msg.testNamePattern as string | undefined;

          if (_rerunCallback && files?.length) {
            const resolved = files.map(f => _registryToAbsPath.get(f) ?? f);
            _rerunCallback(resolved, pattern);
          } else if (files?.length && _connectedSocket) {
            log.info(
              pc.cyan(`↻ Rerun from device: ${label}`) +
                (files?.length ? ` (${files.length} file${files.length > 1 ? 's' : ''})` : '') +
                (pattern ? ` [pattern: ${pattern}]` : ''),
            );
            const toReplay = new Set<BiRpcMessage>();
            for (const f of files) {
              const stored = _lastRunMessages.get(f);
              if (stored) toReplay.add(stored);
            }
            if (toReplay.size > 0) {
              worker.sendToDevice({
                __native_run_start: true,
                fileCount: toReplay.size,
              });
              for (const message of toReplay) {
                _connectedSocket.send(flatStringify(message));
              }
            } else {
              log.warn('  No stored run messages to replay');
            }
          }
          return;
        }
        if (isCancelMessage(msg)) {
          log.info(pc.yellow('■ Cancel from device'));
          if (_connectedSocket) {
            _connectedSocket.send(
              flatStringify({
                __vitest_worker_request__: true,
                type: 'cancel',
              }),
            );
          }
          return;
        }
        attachCodeFrames(msg);
        emit('message', msg);
      } catch (e) {
        log.error('Parse error:', e);
      }
    });

    socket.on('close', () => {
      if (_connectedSocket === socket) {
        _connectedSocket = null;
        log.verbose(`${platform} app disconnected`);
      }
    });

    _resolveConnection?.();
  }

  // ── Screenshot request handler ─────────────────────────────────

  function handleScreenshotRequest(socket: WebSocket, msg: { requestId: string; name?: string }): void {
    try {
      const result = captureScreenshot({ platform, name: msg.name, deviceId });
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
    log.info(`Resume: Press ${pc.cyan('Enter')} or use the resume button in the UI`);

    if (msg.screenshot !== false) {
      try {
        const result = captureScreenshot({ platform, name: 'paused', deviceId });
        log.info(`Screenshot: ${pc.cyan(result.filePath)}`);
      } catch (err) {
        log.warn(`Auto-screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log.info('');

    if (process.stdin.isTTY) {
      _stdinResumeHandler = () => {
        if (_isPaused) doResume();
      };
      process.stdin.setRawMode(false);
      process.stdin.resume();
      process.stdin.once('data', _stdinResumeHandler);
    }

    const signalPath = resolve(outputDir, 'resume-signal');
    _resumeFileWatcher = setInterval(() => {
      if (existsSync(signalPath)) {
        try {
          unlinkSync(signalPath);
        } catch {
          /* ignore */
        }
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

  // ── Startup logic ─────────────────────────────────────────────

  async function doStart(): Promise<void> {
    // Resolve isolated instance resources before touching shared services.
    const resolved = await resolveInstanceResources({
      appDir,
      platform,
      wsPort: options.port,
      metroPort: options.metroPort,
    });
    instanceId = resolved.instanceId;
    port = resolved.wsPort;
    metroPort = resolved.metroPort;
    outputDir = resolved.outputDir;
    registerInstanceRecord(appDir, {
      instanceId,
      pid: process.pid,
      platform,
      wsPort: port,
      metroPort,
      outputDir,
    });
    _instanceRegistered = true;
    log.info(`[instance:${instanceId}] ws=${port} metro=${metroPort} output=${outputDir}`);

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

    // ── Step 2: Ensure harness binary (resolve only — install after device selection)
    let binaryPath: string | null = null;
    let harnessCacheKey: string | null = null;
    if (options.harnessApp) {
      log.info(`Using pre-built harness: ${options.harnessApp}`);
      binaryPath = resolve(options.harnessApp);
      if (!existsSync(binaryPath)) {
        throw new Error(`Harness binary not found: ${binaryPath}`);
      }
    } else {
      const packageRoot = resolve(__dirname, '..', '..');
      const rnVersion = options.reactNativeVersion ?? detectReactNativeVersion(appDir);
      if (!rnVersion) {
        throw new Error(
          'Could not auto-detect React Native version (react-native not found in node_modules).\n' +
            'Either install react-native or set reactNativeVersion explicitly in your Vitest config:\n\n' +
            "  nativePlugin({ reactNativeVersion: '0.81.5' })",
        );
      }
      log.info(`React Native version: ${rnVersion}`);

      const harnessResult = findHarnessBinary({
        platform,
        reactNativeVersion: rnVersion,
        nativeModules: options.nativeModules ?? [],
        packageRoot,
      });

      if (!harnessResult) {
        throw new Error(
          `No harness binary found for ${platform}. Build it first:\n\n` +
            `  npx vitest-mobile bootstrap ${platform}\n`,
        );
      }

      bundleId = harnessResult.bundleId;
      binaryPath = harnessResult.binaryPath;
      harnessCacheKey = harnessResult.cacheKey;
      _harnessProjectDir = harnessResult.projectDir;
      log.info(`Using cached harness binary: ${harnessResult.binaryPath.split('/').pop()?.slice(0, 12)}...`);
    }

    // ── Step 3: Ensure device + install binary
    // ensureDevice uses port-based liveness checks (reading RCT_jsLocation /
    // checking app processes) to determine which devices are already in use.
    // A global lock in ~/.cache/vitest-mobile/ serializes concurrent selections.
    const selectedDevice = await ensureDevice(platform, {
      wsPort: port,
      metroPort,
      deviceId,
      bundleId,
      headless,
      instanceId,
      promptForNewDevice,
    });
    if (selectedDevice) {
      deviceId = selectedDevice;
      updateInstanceRecord(appDir, { instanceId, deviceId: selectedDevice });
    }

    // Install the binary — skip if the device already has a matching build
    if (binaryPath) {
      let skipInstall = false;
      if (harnessCacheKey) {
        const installedKey = getInstalledCacheKey(platform, bundleId, deviceId);
        if (installedKey === harnessCacheKey) {
          skipInstall = true;
          log.info('Harness binary already installed — skipping install');
        }
      }
      if (!skipInstall) {
        try {
          if (platform === 'ios') {
            const target = deviceId ?? 'booted';
            execSync(`xcrun simctl install ${target} "${binaryPath}"`, { stdio: 'pipe' });
          } else if (platform === 'android') {
            const target = deviceId ? `-s ${deviceId} ` : '';
            execSync(`${getAdbPath()} ${target}install -r "${binaryPath}"`, { stdio: 'pipe' });
          }
        } catch (e) {
          log.verbose(`Install may have failed (non-fatal if already installed): ${e}`);
        }
      }
    }

    // ── Step 4: Generate test registry
    generateTestRegistryForPool();

    // ── Step 5: Register with shared WS server
    registerPlatform(platform, port, { onConnection: handleAppConnection });

    // ── Step 6: Metro (or static bundle server)
    const useBundle = options.bundle;
    const prebuilt = useBundle
      ? detectPrebuiltBundle(typeof useBundle === 'string' ? resolve(useBundle) : appDir, platform)
      : null;
    if (prebuilt) {
      log.info(`Using pre-built bundle for ${platform}`);
      metroPort = prebuilt.metroPort;
      _metroRunner = await startStaticBundleServer(prebuilt.bundleDir, prebuilt, platform);
    } else if (useBundle) {
      log.warn(`Pre-built bundle requested but not found for ${platform} — falling back to Metro`);
      await startMetro();
    } else if (_metroRunner) {
      log.verbose('Metro already running, reusing');
    } else {
      await startMetro();
    }

    // ── Step 7: App
    async function launchWithRetry(): Promise<void> {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await launchApp(platform, bundleId, { metroPort, deviceId });
          return;
        } catch (err) {
          if (attempt === 0) {
            log.warn('Launch failed, re-checking device...');
            const selected = await ensureDevice(platform, {
              wsPort: port,
              metroPort,
              deviceId,
              bundleId,
              headless,
              instanceId,
              promptForNewDevice,
            });
            if (selected) {
              deviceId = selected;
              updateInstanceRecord(appDir, { instanceId, deviceId: selected });
            }
          } else {
            throw new Error(`Failed to launch app after retry: ${(err as Error).message}`, { cause: err });
          }
        }
      }
    }

    if (_connectedSocket) {
      log.verbose('Reusing existing app connection');
    } else {
      log.info('Waiting for app to connect...');
      try {
        await waitForApp(3000);
        log.info('App connected');
      } catch {
        log.info('App not connected, launching...');
        try {
          await launchApp(platform, bundleId, { metroPort, deviceId });
        } catch {
          stopApp(platform, bundleId, deviceId);
          await new Promise<void>(r => {
            const t = setTimeout(r, 500);
            unrefTimer(t);
          });
          await launchWithRetry();
        }
        await waitForApp(appConnectTimeout);
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
      if (!_startPromise) {
        _startPromise = doStart().then(() => {
          _startComplete = true;
        });
        _startPromise.catch(e => log.error('Startup failed:', e));
      }
      // Block until device startup completes. This keeps Node.js alive
      // (all our servers/timers are unref'd) and fits within vitest's
      // WORKER_START_TIMEOUT (90s). The separate 'start' message handler
      // responds with 'started' immediately so START_TIMEOUT (60s) is
      // never hit — it only begins after this method returns.
      await _startPromise;
    },

    async stop(): Promise<void> {
      _hasCompletedCycle = true;
      _sessionCount++;
      if (_instanceRegistered) {
        releaseInstanceRecord(appDir, instanceId);
        _instanceRegistered = false;
      }
      emit('message', { __vitest_worker_response__: true, type: 'stopped' });
    },

    setRerunCallback(cb: (files: string[], pattern?: string) => void): void {
      _rerunCallback = cb;
    },

    sendToDevice(msg: Record<string, unknown>): void {
      if (_connectedSocket) {
        _connectedSocket.send(JSON.stringify(msg));
      }
    },

    async teardown(): Promise<void> {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      await cleanup();
      await closeServer();
    },

    send(message: BiRpcMessage): void {
      if (message?.__vitest_worker_request__) {
        const ctx = (message as BiRpcMessage & { context?: VitestWorkerContext }).context;
        switch (message.type) {
          case 'start': {
            if (mode === 'dev' && ctx?.config) {
              ctx.config.testTimeout = 0;
              ctx.config.hookTimeout = 0;
              ctx.config.__poolMode = 'dev';
            } else if (ctx?.config) {
              ctx.config.__poolMode = 'run';
            }

            // Respond to vitest immediately — the 'start' message is a
            // worker lifecycle handshake with a 60s timeout (START_TIMEOUT
            // in vitest). Device startup (simulator boot, app launch) can
            // take longer than that, but we don't need the device for the
            // handshake. run/collect already defer until _startComplete.
            emit('message', { __vitest_worker_response__: true, type: 'started' });

            // Forward config to the device once per session so it has the
            // correct root for file-hash ID generation. Only the first
            // start carries the config; subsequent per-file starts are
            // skipped to avoid repeated invalidateAllTestModules() calls.
            if (!_startConfigSent) {
              _startConfigSent = true;
              if (_connectedSocket) {
                _connectedSocket.send(flatStringify(message));
              } else if (_startPromise) {
                _startPromise.then(() => {
                  if (_connectedSocket) _connectedSocket.send(flatStringify(message));
                });
              }
            }
            break;
          }
          case 'run':
          case 'collect': {
            if (!_startComplete && _startPromise) {
              _startPromise.then(() => worker.send(message));
              break;
            }
            if (ctx?.config) {
              ctx.config.__poolMode = mode;
            }
            const files = ctx?.files;
            if (files?.length && message.type === 'run') {
              for (const f of files) {
                if (f.filepath) {
                  _lastRunMessages.set(f.filepath, message);
                  const fname = f.filepath.split('/').pop() ?? f.filepath;
                  _lastRunMessages.set(fname, message);
                  _registryToAbsPath.set(fname, f.filepath);
                  const parts = f.filepath.split('/');
                  const testsIdx = parts.indexOf('tests');
                  if (testsIdx >= 1) {
                    const registryKey = `${parts[testsIdx - 1]}/${parts[parts.length - 1]}`;
                    _lastRunMessages.set(registryKey, message);
                    _registryToAbsPath.set(registryKey, f.filepath);
                  }
                }
              }
              log.info(files.map(f => pc.cyan(f.filepath?.split('/').pop() ?? '')).join(', '));
            }
            if (_connectedSocket) {
              _connectedSocket.send(flatStringify(message));
            } else if (message.type === 'run') {
              emit('message', {
                __vitest_worker_response__: true,
                type: 'testfileFinished',
                error: new Error('RN app not connected'),
              });
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
