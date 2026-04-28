/**
 * metro-runner — starts Metro programmatically, configured for test execution.
 *
 * Replaces the previous approach of spawning `npx expo start --dev-client`.
 * The user doesn't need metro.config.js or babel.config.js — all configuration
 * is applied programmatically by the pool.
 */

import { resolve, relative, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Socket } from 'node:net';
import { log } from './logger';
import { attachMetroLogTap, type MetroLogTap } from './metro-log';
import { globSync } from 'glob';
import picomatch from 'picomatch';
import { renderNodeTemplate } from './templates';
import { detectReactNativeVersion, findHarnessBinary } from './harness-builder';
import type { RunServerOptions } from 'metro';
import type { ConfigT, Middleware } from 'metro-config';
import type { CustomResolutionContext, CustomResolver } from 'metro-resolver';
import type connect from 'connect';
import type { HandleFunction } from 'connect';
import type { WebSocketServer } from 'ws';
import type { MetroConfigCustomizer, InternalPoolOptions, ResolvedNativePluginOptions, RuntimeState } from './types';

const APP_MODULE_NAME = 'VitestMobileApp';

// ── Lazy-loaded metro + metro-config ──────────────────────────────
// Neither `metro` nor `metro-config` is a direct dependency of vitest-mobile.
// Both live in the scaffolded harness project (installed transitively by
// react-native / @react-native/metro-config), and we resolve them from there
// at runtime. This keeps the host-side metro driver in lockstep with the
// metro-config schema the harness was built against — no version skew.
interface MetroModules {
  metro: typeof import('metro');
  metroConfig: typeof import('metro-config');
}

/**
 * Return a `require` that resolves as if it were inside the scaffolded
 * harness project. We anchor on `package.json` (always present after
 * harness scaffold) rather than a fake filename — clearer intent, same
 * resolution semantics.
 */
function harnessRequire(harnessProjectDir: string): NodeRequire {
  return createRequire(resolve(harnessProjectDir, 'package.json'));
}

/**
 * Return a `require` anchored at vitest-mobile's own package root, so
 * specifiers go through our `exports` map rather than relative file-system
 * walks that depend on dist layout.
 */
function selfRequire(): NodeRequire {
  return createRequire(import.meta.url);
}

function loadMetroModules(harnessProjectDir: string): MetroModules {
  const req = harnessRequire(harnessProjectDir);
  return {
    metro: req('metro') as typeof import('metro'),
    metroConfig: req('metro-config') as typeof import('metro-config'),
  };
}

// ── Types ──────────────────────────────────────────────────────────

/**
 * Flattened options consumed by {@link prepareMetroConfig}. Callers build
 * this from the pool buckets (`options` / `internal` / `runtime`) or
 * directly (CLI `buildBundle`).
 */
export interface MetroRunnerOptions {
  appDir: string;
  metroPort: number;
  port: number;
  platform: 'ios' | 'android';
  testPatterns: string[];
  outputDir?: string;
  /**
   * Absolute path to the scaffolded harness project
   * (`<cache>/builds/<key>/project`). The generated Metro config uses this
   * as the anchor for resolving `@react-native/metro-config` and for
   * routing `react`/`react-native`/`@react-native/*` resolution, ensuring
   * the bundle always matches the RN version baked into the harness
   * binary.
   */
  harnessProjectDir?: string;
  /**
   * User-supplied callback that transforms the harness-anchored base
   * config before vitest-mobile's test-specific overrides are applied.
   */
  metro?: MetroConfigCustomizer;
  /** Extra Babel plugin specifiers to inject into Metro's transform pipeline. */
  babelPlugins?: string[];
}

export interface MetroServer {
  close(): Promise<void>;
  port: number;
}

// ── Helpers ────────────────────────────────────────────────────────

const SUPPRESSED_LOG_PATTERNS = [
  /Connection established to/,
  /Connection closed to/,
  /\[timeout\] connection terminated/,
  /JavaScript logs have moved/,
  /Launching DevTools/,
];

function createDevMiddlewareLogger() {
  function shouldSuppress(args: unknown[]): boolean {
    const msg = args.map(String).join(' ');
    return SUPPRESSED_LOG_PATTERNS.some(p => p.test(msg));
  }
  const filtered =
    (level: 'verbose' | 'warn' | 'error') =>
    (...args: unknown[]) => {
      if (!shouldSuppress(args)) log[level](...args);
    };

  return {
    info: filtered('verbose'),
    warn: filtered('warn'),
    error: filtered('error'),
    log: filtered('verbose'),
  };
}

// ── Shared Config Preparation ──────────────────────────────────────

export interface PreparedMetroConfig {
  config: ConfigT;
  entryPath: string;
  outputDir: string;
  testFiles: string[];
}

function discoverTestFiles(appDir: string, testPatterns: string[]): string[] {
  const testFiles: string[] = [];
  for (const pattern of testPatterns) {
    try {
      testFiles.push(...globSync(pattern, { cwd: appDir }));
    } catch {
      /* ignore glob errors */
    }
  }
  return [...new Set(testFiles)].sort();
}

/**
 * Combine Vitest include patterns into a single regex source the device-side
 * `require.context()` filter can use. Each glob is converted to a regex by
 * picomatch — the same engine Vitest itself uses (via tinyglobby) — so the
 * device's matched set stays in lockstep with the host's `cfg.include` matches.
 *
 * The combined regex also excludes any path containing a `node_modules/`
 * segment (test fixtures shipped inside deps would otherwise be inlined into
 * the bundle and fail unresolvable-import resolution in `'sync'` mode), and
 * tolerates an optional leading `./` since Metro tests context-module keys
 * with that prefix.
 */
function buildContextRegexSource(testPatterns: string[]): string {
  if (testPatterns.length === 0) return '(?!)';
  const sources = testPatterns.map(p => {
    // Vitest passes `dot: true` to tinyglobby (see VitestProject.globFiles);
    // mirror it here so the device's match set matches host-side glob results.
    const re = picomatch.makeRe(p, { dot: true });
    let s = re.source;
    if (s.startsWith('^')) s = s.slice(1);
    if (s.endsWith('$')) s = s.slice(0, -1);
    return s;
  });
  return `^(?!.*\\/node_modules\\/)(?:\\.\\/)?(?:${sources.join('|')})$`;
}

export async function prepareMetroConfig(options: MetroRunnerOptions): Promise<PreparedMetroConfig> {
  const { appDir, metroPort, port, testPatterns } = options;

  // Inlined into the bundle by the inline-app-root babel plugin (needed
  // before Metro's static analysis of `require.context(...)` in the device
  // runtime's test-context.ts). jest-worker children inherit env at spawn,
  // so setting it here on the parent reaches the transform workers spawned
  // by metro.runServer / metro.runBuild below.
  process.env.VITEST_MOBILE_APP_ROOT = appDir.split('\\').join('/');
  // The require.context filter regex is also inlined by the babel plugin —
  // it MUST mirror Vitest's `cfg.include` patterns or the device bundle
  // would either pull in unrelated test files (Node integration tests in
  // monorepo siblings) or miss user device tests entirely.
  process.env.VITEST_MOBILE_TEST_PATTERN_SOURCE = buildContextRegexSource(testPatterns);

  const outputDir = options.outputDir ?? resolve(appDir, '.vitest-mobile');
  mkdirSync(outputDir, { recursive: true });
  if (!existsSync(resolve(outputDir, '.gitignore'))) {
    writeFileSync(resolve(outputDir, '.gitignore'), '*\n');
  }

  for (const plat of ['ios', 'android'] as const) {
    generateEntryPoint({
      entryPath: resolve(outputDir, `index.${plat}.js`),
      appModuleName: APP_MODULE_NAME,
      wsPort: port,
      metroPort,
    });
  }
  const testFiles = discoverTestFiles(appDir, testPatterns);
  log.info(`Discovered ${testFiles.length} test file(s)`);

  if (!options.harnessProjectDir) {
    throw new Error(
      'vitest-mobile: prepareMetroConfig requires harnessProjectDir — harness binary must be built first (run `npx vitest-mobile bootstrap <platform>`).',
    );
  }
  const baseConfig = await loadMetroConfig(appDir, outputDir, options.harnessProjectDir);
  // Apply user customizer (if any) BEFORE our internal test transforms so
  // that things like vitest shim resolution and the test-context module
  // alias remain authoritative — the customizer can't accidentally unwrap
  // them. User hooks like extra assetExts or a wrapping resolveRequest still
  // end up in the final config because applyTestTransforms preserves the
  // incoming resolver chain via `config.resolver.resolveRequest` capture.
  const customizedBase = options.metro
    ? await options.metro(baseConfig, {
        harnessProjectDir: options.harnessProjectDir,
        projectRoot: appDir,
        platform: options.platform,
      })
    : baseConfig;
  const config = applyTestTransforms(customizedBase, {
    projectRoot: appDir,
    port: metroPort,
    outputDir,
    harnessProjectDir: options.harnessProjectDir,
    babelPlugins: options.babelPlugins ?? [],
  });
  const entryPath = resolve(outputDir, `index.${options.platform}.js`);

  return { config, entryPath, outputDir, testFiles };
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Start a Metro server for the pool. Accepts the pool's three atomic
 * buckets directly — no field plucking at call sites.
 */
export async function startMetroServer(
  options: Pick<ResolvedNativePluginOptions, 'platform' | 'metro'>,
  internal: Pick<InternalPoolOptions, 'appDir' | 'testPatterns' | 'outputDir'>,
  runtime: Pick<RuntimeState, 'port' | 'metroPort' | 'harnessProjectDir' | 'instanceDir'>,
): Promise<MetroServer> {
  if (!runtime.harnessProjectDir) {
    throw new Error(
      'vitest-mobile: startMetroServer requires harness.projectDir — harness binary must be built first (run `npx vitest-mobile bootstrap <platform>`).',
    );
  }
  if (runtime.port === undefined || runtime.metroPort === undefined) {
    throw new Error('vitest-mobile: startMetroServer called before ports were resolved');
  }
  const { metro } = loadMetroModules(runtime.harnessProjectDir);
  const { config } = await prepareMetroConfig({
    appDir: internal.appDir,
    metroPort: runtime.metroPort,
    port: runtime.port,
    platform: options.platform,
    testPatterns: internal.testPatterns,
    outputDir: internal.outputDir,
    harnessProjectDir: runtime.harnessProjectDir,
    metro: options.metro.customize,
    babelPlugins: options.metro.babelPlugins,
  });
  const { appDir: projectRoot } = internal;
  const port = runtime.metroPort;

  // Redirect Metro's own output to `<instanceDir|outputDir>/metro.log` by
  // installing a file-backed Reporter. Metro's reporter is the sole path
  // by which it writes to stdout (bundle progress, the welcome banner,
  // device-forwarded `client_log` events, jest-worker stderr chunks,
  // bundler errors), so swapping it keeps the terminal clean — only the
  // pool's own `[vitest-mobile]` status lines stay visible — while
  // retaining every Metro signal in the log file for debugging.
  const metroLogDir = runtime.instanceDir ?? internal.outputDir;
  const metroLogPath = resolve(metroLogDir, 'metro.log');
  const tap: MetroLogTap = attachMetroLogTap(metroLogPath);
  const configWithFileReporter: ConfigT = { ...config, reporter: tap.reporter };
  log.info(`Metro log: ${metroLogPath}`);

  const { middleware: devMiddleware, websocketEndpoints } = loadDevMiddleware(
    projectRoot,
    runtime.harnessProjectDir,
    port,
  );

  log.info(`Starting Metro on port ${port}...`);

  // Metro's `onClose` fires AFTER its internal `endMiddleware()` resolves,
  // which in turn awaits `metroServer.end()` — the only place that shuts
  // down the transform worker pool and the metro-file-map watcher.
  // Without waiting for this, the Node process lingers because jest-worker
  // child processes and fs watchers keep the event loop alive.
  let resolveMetroClosed: () => void = () => {};
  const metroClosed = new Promise<void>(r => {
    resolveMetroClosed = r;
  });

  // `onClose` is accepted by metro.runServer at runtime (it's fired after
  // Metro's internal `endMiddleware()` resolves, which awaits
  // `metroServer.end()`), but older `metro` typings we resolve against
  // don't declare it. Cast through to pass it through.
  const runServerOpts = {
    host: '127.0.0.1',
    onClose: () => resolveMetroClosed(),
    ...(devMiddleware ? { unstable_extraMiddleware: [devMiddleware] } : {}),
    ...(websocketEndpoints ? { websocketEndpoints } : {}),
  } as RunServerOptions;
  const { httpServer } = await metro.runServer(configWithFileReporter, runServerOpts);

  // Track keep-alive TCP connections so we can forcibly destroy them on
  // close. `httpServer.close()` only waits for idle sockets; without this,
  // lingering HMR/devtools keep-alive connections block shutdown until the
  // socket timeout elapses (which is effectively forever since Metro sets
  // `httpServer.timeout = 0`).
  const activeSockets = new Set<Socket>();
  httpServer.on('connection', (socket: Socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  log.info(`Metro ready on port ${port}`);

  return {
    port,
    async close() {
      log.verbose('Metro close requested');

      // 1. Close every WebSocketServer we attached to the httpServer. ws's
      //    WebSocketServer.close() does NOT terminate existing clients by
      //    default — it only stops accepting new ones — so terminate each
      //    client explicitly. This covers the dev-middleware inspector
      //    proxy endpoints that the RN app connects to during testing.
      const wsEndpointServers: WebSocketServer[] = Object.values(
        (websocketEndpoints ?? {}) as Record<string, WebSocketServer>,
      );
      for (const wss of wsEndpointServers) {
        try {
          for (const client of wss.clients) {
            try {
              client.terminate();
            } catch {
              /* ignore */
            }
          }
          wss.close();
        } catch {
          /* ignore */
        }
      }

      // 2. Destroy lingering TCP connections so httpServer.close() can
      //    actually resolve. `closeAllConnections` (Node 18.2+) handles
      //    active requests; `closeIdleConnections` handles keep-alive
      //    connections that aren't currently servicing a request — this
      //    is what catches the still-"idle"-from-http's-perspective
      //    sockets that have been upgraded to long-lived WebSockets for
      //    /hot HMR and the dev-middleware inspector proxy. Without this,
      //    httpServer.close() waits indefinitely for them to drain.
      const httpServerWithClose = httpServer as typeof httpServer & {
        closeAllConnections?: () => void;
        closeIdleConnections?: () => void;
      };
      httpServerWithClose.closeAllConnections?.();
      httpServerWithClose.closeIdleConnections?.();
      for (const socket of activeSockets) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
      activeSockets.clear();

      // 3. Stop accepting new connections. The callback fires once all
      //    sockets are drained (effectively immediate after step 2) and
      //    also triggers Metro's internal 'close' handler which calls
      //    `endMiddleware()` → `metroServer.end()`.
      await new Promise<void>(r => {
        httpServer.close(() => r());
        const t = setTimeout(r, 3000);
        (t as unknown as { unref(): void }).unref();
      });

      // 4. Wait for `onClose` to fire — this is our only signal that the
      //    transform worker pool (jest-worker child processes) and the
      //    dep-graph file watchers have actually shut down. Without this
      //    wait, those handles keep the Node event loop alive and Vitest
      //    prints "Tests closed successfully but something prevents the
      //    main process from exiting".
      await Promise.race([
        metroClosed,
        new Promise<void>(r => {
          const t = setTimeout(r, 3000);
          (t as unknown as { unref(): void }).unref();
        }),
      ]);

      // Close the Metro log tap LAST so any final Metro output emitted
      // while httpServer / workers are tearing down still lands in the
      // file. This also restores process.stdout/stderr.write to their
      // originals so the rest of the Vitest run isn't tee'd.
      try {
        await tap.close();
      } catch {
        /* ignore — tap errors must not block shutdown */
      }

      log.verbose('Metro server closed');
    },
  };
}

// ── Offline Bundle Build ──────────────────────────────────────────

export interface BundleManifest {
  wsPort: number;
  metroPort: number;
  dev: boolean;
  bundles: Record<string, { bundleFile: string; sourcemapFile: string }>;
}

export interface BuildBundleOptions {
  projectRoot: string;
  outDir: string;
  platforms: ('ios' | 'android')[];
  wsPort: number;
  metroPort: number;
  testPatterns: string[];
  dev?: boolean;
  /**
   * Native modules declared in the vitest-mobile plugin config. Must match
   * what was passed at bootstrap time so the harness cache key resolves to
   * the same scaffolded project. Defaults to [] (matching the pool default).
   */
  nativeModules?: string[];
  /**
   * React Native version. Auto-detected from `projectRoot/node_modules` if
   * not provided (same logic the pool uses).
   */
  reactNativeVersion?: string;
  /**
   * User-supplied callback that transforms the harness-anchored base
   * config before vitest-mobile's test-specific overrides are applied.
   * Mirrors `nativePlugin({ metro })`; the bundle CLI reads this back from
   * the vitest config automatically, so you rarely need to set it directly.
   */
  metro?: MetroConfigCustomizer;
  /** Extra Babel plugin specifiers to inject into Metro's transform pipeline. */
  babelPlugins?: string[];
}

export async function buildBundle(options: BuildBundleOptions): Promise<BundleManifest> {
  const { projectRoot, outDir, platforms, wsPort, metroPort, testPatterns, dev = true, nativeModules = [] } = options;

  mkdirSync(outDir, { recursive: true });

  const rnVersion = options.reactNativeVersion ?? detectReactNativeVersion(projectRoot);
  if (!rnVersion) {
    throw new Error(
      'vitest-mobile: could not auto-detect React Native version (react-native not found in node_modules). ' +
        'Install react-native or pass reactNativeVersion explicitly.',
    );
  }

  // metro-runner is bundled into dist/cli/ and dist/node/. Walk up to the
  // installed vitest-mobile package root to match what the pool passes.
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

  const manifest: BundleManifest = { wsPort, metroPort, dev, bundles: {} };

  for (const platform of platforms) {
    log.info(`Bundling for ${platform}...`);

    const harnessResult = findHarnessBinary({ platform, reactNativeVersion: rnVersion, nativeModules, packageRoot });
    if (!harnessResult) {
      throw new Error(
        `No harness binary found for ${platform}. Build it first:\n\n` + `  npx vitest-mobile bootstrap ${platform}\n`,
      );
    }

    const { metro } = loadMetroModules(harnessResult.projectDir);

    const prepared = await prepareMetroConfig({
      appDir: projectRoot,
      metroPort,
      port: wsPort,
      platform,
      testPatterns,
      harnessProjectDir: harnessResult.projectDir,
      metro: options.metro,
      babelPlugins: options.babelPlugins ?? [],
    });

    const baseName = `index.${platform}.jsbundle`;
    const bundlePath = resolve(outDir, baseName);

    // Metro's runBuild types are incomplete — platform/sourceMap/sourceMapOut
    // exist at runtime but not in the .d.ts. Cast to pass them through.
    await metro.runBuild(prepared.config, {
      entry: prepared.entryPath,
      dev,
      minify: !dev,
      out: bundlePath,
      platform,
      sourceMap: true,
      sourceMapOut: resolve(outDir, `${baseName}.map`),
    } as Parameters<typeof metro.runBuild>[1]);

    // Metro may append .js to the output path — detect the actual filename
    const bundleFile = existsSync(bundlePath) ? baseName : existsSync(`${bundlePath}.js`) ? `${baseName}.js` : baseName;
    const sourcemapFile = existsSync(resolve(outDir, `${baseName}.map`)) ? `${baseName}.map` : `${baseName}.js.map`;
    manifest.bundles[platform] = { bundleFile, sourcemapFile };
    log.info(`${platform} bundle written to ${bundleFile}`);
  }

  const manifestPath = resolve(outDir, 'bundle-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log.info(`Manifest written to ${manifestPath}`);

  return manifest;
}

// ── Config Loading ────────────────────────────────────────────────

async function loadMetroConfig(
  projectRoot: string,
  outputDir: string,
  harnessProjectDir: string | undefined,
): Promise<ConfigT> {
  // We require a harness project for BOTH branches: `metroConfig.loadConfig`
  // itself is resolved from the harness tree, so we need to know where that
  // tree lives before we can load any config — user-provided or generated.
  if (!harnessProjectDir) {
    throw new Error(
      'vitest-mobile: no harness project directory available — the harness binary must be built first (run `npx vitest-mobile bootstrap <platform>`).',
    );
  }

  const { metroConfig } = loadMetroModules(harnessProjectDir);

  const userConfigPath = ['metro.config.js', 'metro.config.cjs']
    .map(name => resolve(projectRoot, name))
    .find(p => existsSync(p));

  if (userConfigPath) {
    log.verbose(`Loading user ${userConfigPath}`);
    return metroConfig.loadConfig({ config: userConfigPath }, { projectRoot });
  }

  const generatedPath = resolve(outputDir, 'metro.config.cjs');
  writeFileSync(generatedPath, buildGeneratedMetroConfig({ projectRoot, harnessProjectDir }));
  log.verbose('Loading generated metro config with RN defaults (harness-anchored)');
  return metroConfig.loadConfig({ config: generatedPath }, { projectRoot });
}

/**
 * Generate the auto-generated `metro.config.cjs` content.
 *
 * The generated config:
 *  1. Loads `@react-native/metro-config` from the harness project (so all
 *     of `getDefaultConfig()`'s internal `require.resolve` calls for
 *     `@react-native/*`, `react-native/Libraries/Core/InitializeCore`, and
 *     polyfills anchor there — pinning them to the RN version the harness
 *     binary was built against).
 *  2. Installs a `resolver.resolveRequest` override that force-routes a
 *     fixed allow-list of packages (`react`, `react-native`,
 *     `react-native-safe-area-context`, `@react-native/*`) through the
 *     harness tree. Per Metro's resolution algorithm, `resolveRequest`
 *     runs before hierarchical node_modules lookup — making this a true
 *     override, not a fallback. This avoids any version skew between
 *     user-tree copies and the harness binary.
 *
 * User code imports that aren't in the allow-list go through Metro's
 * default resolver against `projectRoot` unchanged.
 */
function buildGeneratedMetroConfig(opts: { projectRoot: string; harnessProjectDir: string }): string {
  return renderNodeTemplate('metro.config.cjs', {
    HARNESS_DIR: opts.harnessProjectDir,
    PROJECT_ROOT: opts.projectRoot,
  });
}

// ── Dev Middleware ─────────────────────────────────────────────────

function loadDevMiddleware(
  projectRoot: string,
  harnessProjectDir: string,
  port: number,
): {
  middleware: HandleFunction | null;
  websocketEndpoints: RunServerOptions['websocketEndpoints'] | undefined;
} {
  try {
    // Anchor at the harness project so dev-middleware comes from the same
    // RN version the harness binary was built against. Resolving from the
    // user's projectRoot could pick up a mismatched version in monorepos
    // where the user tree has different RN hoisting than the harness.
    const req = harnessRequire(harnessProjectDir);
    const { createDevMiddleware } = req('@react-native/dev-middleware') as {
      createDevMiddleware: (opts: unknown) => {
        middleware: HandleFunction;
        websocketEndpoints: RunServerOptions['websocketEndpoints'];
      };
    };
    const result = createDevMiddleware({
      projectRoot,
      serverBaseUrl: `http://127.0.0.1:${port}`,
      logger: createDevMiddlewareLogger(),
    });
    log.verbose('Dev middleware (inspector proxy) enabled');
    return {
      middleware: result.middleware as HandleFunction,
      websocketEndpoints: result.websocketEndpoints as RunServerOptions['websocketEndpoints'],
    };
  } catch (e: unknown) {
    log.verbose(`Dev middleware not available: ${e instanceof Error ? e.message : String(e)}`);
    return { middleware: null, websocketEndpoints: undefined };
  }
}

// ── Entry Point ───────────────────────────────────────────────────

function generateEntryPoint(opts: {
  entryPath: string;
  appModuleName: string;
  wsPort: number;
  metroPort: number;
}): void {
  const content = renderNodeTemplate('index.entry.js', {
    APP_MODULE_NAME: opts.appModuleName,
    WS_PORT: String(opts.wsPort),
    METRO_PORT: String(opts.metroPort),
  });

  let existing = '';
  try {
    existing = readFileSync(opts.entryPath, 'utf8');
  } catch {
    // File does not exist yet.
  }
  if (existing !== content) writeFileSync(opts.entryPath, content);
}

// ── Metro Config Transforms ───────────────────────────────────────

/**
 * Generate a CJS "transformer shim" in the output dir that wraps the
 * harness's `@react-native/metro-babel-transformer` with our test-wrapper
 * babel plugin.
 *
 * Why generate this at runtime rather than ship a static `dist/metro/transformer.cjs`
 * and require `@react-native/metro-babel-transformer` from there:
 *
 * Metro loads `babelTransformerPath` in worker processes via Node's normal
 * `require`. A static file shipped inside `vitest-mobile/dist/` would walk
 * up from the vitest-mobile package when resolving
 * `@react-native/metro-babel-transformer` — and in monorepos where that
 * package is only in the harness tree, resolution fails with MODULE_NOT_FOUND.
 * The generated shim uses `createRequire` anchored inside the harness, so
 * the upstream transformer is always found at the correct harness-pinned
 * version regardless of consumer hoisting.
 */
/**
 * Resolve user-supplied Babel plugin specifiers from the harness tree's
 * `node_modules`. Returns absolute paths that the transformer shim can
 * `require()` directly. Specifiers that fail to resolve are logged and
 * skipped — e.g. if the user declares a plugin whose package isn't in
 * `harness.nativeModules`.
 */
function resolveBabelPlugins(harnessProjectDir: string, pluginSpecifiers: string[]): string[] {
  if (pluginSpecifiers.length === 0) return [];
  const anchor = resolve(harnessProjectDir, 'package.json');
  const req = createRequire(anchor);
  const paths: string[] = [];
  for (const spec of pluginSpecifiers) {
    try {
      paths.push(req.resolve(spec));
    } catch {
      log.warn(
        `Could not resolve babel plugin '${spec}' from harness tree — skipping. Make sure the providing package is listed in harness.nativeModules.`,
      );
    }
  }
  return paths;
}

function generateTransformerShim(opts: {
  outputDir: string;
  harnessProjectDir: string;
  testWrapperPluginPath: string;
  vitestCompatPluginPath: string;
  inlineAppRootPluginPath: string;
  extraBabelPluginPaths?: string[];
}): string {
  const transformerPath = resolve(opts.outputDir, 'transformer.cjs');
  const content = renderNodeTemplate('transformer.cjs', {
    HARNESS_DIR: opts.harnessProjectDir,
    TEST_WRAPPER_PLUGIN_PATH: opts.testWrapperPluginPath,
    VITEST_COMPAT_PLUGIN_PATH: opts.vitestCompatPluginPath,
    INLINE_APP_ROOT_PLUGIN_PATH: opts.inlineAppRootPluginPath,
    EXTRA_BABEL_PLUGINS_JSON: JSON.stringify(opts.extraBabelPluginPaths ?? []),
  });
  writeFileSync(transformerPath, content);
  return transformerPath;
}

/**
 * Build a new ConfigT with test-specific overrides.
 * ConfigT is Readonly, so we produce a new object via spreading.
 */
function applyTestTransforms(
  config: ConfigT,
  options: {
    projectRoot: string;
    port: number;
    outputDir: string;
    harnessProjectDir: string;
    babelPlugins: string[];
  },
): ConfigT {
  const { projectRoot, outputDir, harnessProjectDir } = options;
  const pkgRequire = selfRequire();
  const testContextPath: string = pkgRequire.resolve('vitest-mobile/test-context');

  // Module resolution: redirect vitest → shim, test-context → dist runtime
  const originalResolver = config.resolver.resolveRequest;
  const resolveRequest: CustomResolver = (
    context: CustomResolutionContext,
    moduleName: string,
    platform: string | null,
  ) => {
    if (moduleName === 'vitest-mobile/test-context') {
      return { type: 'sourceFile', filePath: testContextPath };
    }
    if (moduleName === 'vitest') {
      return context.resolveRequest(context, 'vitest-mobile/vitest-shim', platform);
    }
    return originalResolver
      ? originalResolver(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
  };

  // Rewrite /index.bundle → /.vitest-mobile/index.bundle so the entry point
  // lives in .vitest-mobile/ instead of polluting the project root.
  // This runs on the incoming URL before Metro parses it, so the entry file
  // resolves as .vitest-mobile/index relative to projectRoot.
  // We intentionally do NOT use unstable_serverRoot because it also changes
  // the base for lazy bundle URL generation, breaking paths to modules
  // outside the server root directory.
  const origRewrite = config.server.rewriteRequestUrl;
  const outputPathFromRoot = relative(projectRoot, outputDir).split('\\').join('/');
  const rewriteRequestUrl = (url: string) => {
    // Match /index. in both path-only and full URL forms
    const rewritten = url.replace(/\/index\./, `/${outputPathFromRoot}/index.`);
    return origRewrite ? origRewrite(rewritten) : rewritten;
  };

  // Serve /status for RCTBundleURLProvider's packager-running check
  type EnhanceMiddleware = ConfigT['server']['enhanceMiddleware'];
  const origEnhance = config.server.enhanceMiddleware;
  const enhanceMiddleware: EnhanceMiddleware = (middleware, metroServer) => {
    const enhanced = origEnhance ? origEnhance(middleware, metroServer) : middleware;
    return ((req: connect.IncomingMessage, res: import('http').ServerResponse, next: connect.NextFunction) => {
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('packager-status:running');
        return;
      }
      (enhanced as connect.NextHandleFunction)(req, res, next);
    }) as Middleware;
  };

  // Ensure react-native conditions are present
  const conditions = [...config.resolver.unstable_conditionNames];
  for (const c of ['react-native', 'require', 'default']) {
    if (!conditions.includes(c)) conditions.push(c);
  }

  const watchFolders = [...config.watchFolders];
  if (!watchFolders.includes(options.outputDir)) watchFolders.push(options.outputDir);

  // Emit a harness-anchored transformer shim into the output dir and point
  // Metro's babelTransformerPath at it. See generateTransformerShim for the
  // rationale (summary: we can't ship a static transformer.cjs that requires
  // `@react-native/metro-babel-transformer` from vitest-mobile's location
  // because monorepo hoisting makes that resolution unreliable).
  //
  // Go through our own package's exports map so we don't hard-code a
  // dist-layout-dependent relative path; changing the tsup output shape
  // then only requires updating package.json's `exports`.
  const testWrapperPluginPath = pkgRequire.resolve('vitest-mobile/babel-plugin');
  const vitestCompatPluginPath = pkgRequire.resolve('vitest-mobile/vitest-compat-plugin');
  const inlineAppRootPluginPath = pkgRequire.resolve('vitest-mobile/inline-app-root-plugin');
  const extraBabelPluginPaths = resolveBabelPlugins(harnessProjectDir, options.babelPlugins);
  const transformerPath = generateTransformerShim({
    outputDir,
    harnessProjectDir,
    testWrapperPluginPath,
    vitestCompatPluginPath,
    inlineAppRootPluginPath,
    extraBabelPluginPaths,
  });

  return {
    ...config,
    projectRoot,
    watchFolders,
    resolver: {
      ...config.resolver,
      unstable_enablePackageExports: true,
      unstable_conditionNames: conditions,
      resolveRequest,
    },
    // Intentionally do NOT override config.serializer.getModulesRunBeforeMainModule
    // or config.transformer.assetRegistryPath. The harness-anchored @react-native/metro-config
    // already resolves these to harness-tree paths via its own require.resolve calls
    // at getDefaultConfig() time. Overriding them to paths resolved from `projectRoot`
    // (the user tree) causes a split-brain bundle: InitializeCore runs from the user
    // tree's react-native copy while bare `import 'react-native'` goes to the harness
    // tree, so module identity mismatches and setImmediate etc. don't get wired up.
    transformer: {
      ...config.transformer,
      babelTransformerPath: transformerPath,
      // enable require.context() in the app bundle (test-context registry)
      unstable_allowRequireContext: true,
    },
    server: {
      ...config.server,
      port: options.port,
      rewriteRequestUrl,
      enhanceMiddleware,
    },
  };
}
