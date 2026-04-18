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
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { log } from './logger';
import { generateTestRegistry } from '../metro/generateTestRegistry';
import { detectReactNativeVersion, findHarnessBinary } from './harness-builder';
import type { RunServerOptions, RunServerResult, Reporter } from 'metro';
import type { ConfigT, Middleware } from 'metro-config';
import type { CustomResolutionContext, CustomResolver } from 'metro-resolver';
import type connect from 'connect';
import type { HandleFunction } from 'connect';
import type { WebSocketServer } from 'ws';

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

function loadMetroModules(harnessProjectDir: string): MetroModules {
  const anchor = resolve(harnessProjectDir, '_vitest-mobile-anchor.js');
  const req = createRequire(anchor);
  return {
    metro: req('metro') as typeof import('metro'),
    metroConfig: req('metro-config') as typeof import('metro-config'),
  };
}

// ── Types ──────────────────────────────────────────────────────────

export interface MetroRunnerOptions {
  projectRoot: string;
  port: number;
  wsPort: number;
  platform: 'ios' | 'android';
  testPatterns: string[];
  appModuleName: string;
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
  registryPath: string;
  testFiles: string[];
}

export async function prepareMetroConfig(options: MetroRunnerOptions): Promise<PreparedMetroConfig> {
  const { projectRoot, port, wsPort, testPatterns, appModuleName } = options;

  const outputDir = options.outputDir ?? resolve(projectRoot, '.vitest-mobile');
  mkdirSync(outputDir, { recursive: true });
  if (!existsSync(resolve(outputDir, '.gitignore'))) {
    writeFileSync(resolve(outputDir, '.gitignore'), '*\n');
  }

  for (const plat of ['ios', 'android'] as const) {
    generateEntryPoint({
      entryPath: resolve(outputDir, `index.${plat}.js`),
      appModuleName,
      wsPort,
      metroPort: port,
    });
  }
  const { filePath: registryPath, testFiles } = generateTestRegistry({
    projectRoot,
    testPatterns,
    outputDir,
  });
  log.info(`Discovered ${testFiles.length} test file(s)`);

  if (!options.harnessProjectDir) {
    throw new Error(
      'vitest-mobile: prepareMetroConfig requires harnessProjectDir — harness binary must be built first (run `npx vitest-mobile bootstrap <platform>`).',
    );
  }
  const baseConfig = await loadMetroConfig(projectRoot, outputDir, options.harnessProjectDir);
  const config = applyTestTransforms(baseConfig, {
    projectRoot,
    port,
    registryPath,
    outputDir,
    harnessProjectDir: options.harnessProjectDir,
  });
  const entryPath = resolve(outputDir, `index.${options.platform}.js`);

  return { config, entryPath, outputDir, registryPath, testFiles };
}

// ── Public API ─────────────────────────────────────────────────────

export async function startMetroServer(options: MetroRunnerOptions): Promise<MetroServer> {
  if (!options.harnessProjectDir) {
    throw new Error(
      'vitest-mobile: startMetroServer requires harnessProjectDir — harness binary must be built first (run `npx vitest-mobile bootstrap <platform>`).',
    );
  }
  const { metro } = loadMetroModules(options.harnessProjectDir);
  const { config, outputDir } = await prepareMetroConfig(options);
  const { projectRoot, port } = options;

  const { middleware: devMiddleware, websocketEndpoints } = loadDevMiddleware(projectRoot, port);

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
  const { httpServer } = await metro.runServer(config, runServerOpts);

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
      projectRoot,
      port: metroPort,
      wsPort,
      platform,
      testPatterns,
      appModuleName: 'VitestMobileApp',
      harnessProjectDir: harnessResult.projectDir,
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
  const { projectRoot, harnessProjectDir } = opts;
  return `// Auto-generated by vitest-mobile — do not edit.
const path = require('node:path');
const { createRequire } = require('node:module');

const HARNESS_DIR = ${JSON.stringify(harnessProjectDir)};
const PROJECT_ROOT = ${JSON.stringify(projectRoot)};

// A stable dummy path inside the harness project. Its containing directory
// is used as the anchor for both Node's createRequire walk-up (below) and
// Metro's resolveRequest hierarchical lookup (further down). Keep it
// constant so Metro's per-directory resolution cache stays warm.
const HARNESS_ANCHOR = path.join(HARNESS_DIR, '_vitest-mobile-anchor.js');

const harnessReq = createRequire(HARNESS_ANCHOR);
// Hardcoded: @react-native/metro-config is a guaranteed RN-template devDep
// installed during harness scaffolding. A missing module here means the
// scaffold is corrupt; the clean MODULE_NOT_FOUND is the right signal.
const { getDefaultConfig } = harnessReq('@react-native/metro-config');

const config = getDefaultConfig(PROJECT_ROOT);

// Include the harness project in Metro's watched tree. Metro's resolver
// uses an in-memory file map built from projectRoot + watchFolders, and
// \`fileSystemLookup\` only considers files inside that map to "exist" —
// even though we pin harness-anchored resolutions via \`resolveRequest\`
// below, the default resolver still needs the harness node_modules to
// be part of the file map for the physical files to be visible.
config.watchFolders = [...(config.watchFolders || []), HARNESS_DIR];

const HARNESS_PINNED = new Set(['react', 'react-native', 'react-native-safe-area-context']);
function isHarnessPinned(name) {
  if (HARNESS_PINNED.has(name)) return true;
  for (const pkg of HARNESS_PINNED) {
    if (name === pkg || name.startsWith(pkg + '/')) return true;
  }
  return name.startsWith('@react-native/');
}

const prevResolveRequest = config.resolver && config.resolver.resolveRequest;
const HARNESS_DIR_PREFIX = HARNESS_DIR + path.sep;

config.resolver = Object.assign({}, config.resolver, {
  resolveRequest(ctx, moduleName, platform) {
    if (isHarnessPinned(moduleName)) {
      // Only rewrite originModulePath when the request comes from OUTSIDE
      // the harness tree. This pins user-code imports of harness-pinned
      // modules, but preserves Node's nested node_modules resolution for
      // imports that already originate within the harness tree (e.g.
      // react-native's own Libraries/Lists/FlatList.js importing
      // @react-native/virtualized-lists, which may be installed at
      // react-native/node_modules/@react-native/virtualized-lists due to
      // version conflicts).
      const originInHarness =
        typeof ctx.originModulePath === 'string' && ctx.originModulePath.startsWith(HARNESS_DIR_PREFIX);

      if (originInHarness) {
        // Request is already inside the harness tree; let the default
        // resolver do its normal nested-node_modules walk from that origin.
        return ctx.resolveRequest(ctx, moduleName, platform);
      }
      // Request is from outside the harness (user code); rewrite the
      // origin so Metro's default resolver starts from inside the harness.
      return ctx.resolveRequest(
        Object.assign({}, ctx, { originModulePath: HARNESS_ANCHOR }),
        moduleName,
        platform,
      );
    }
    if (prevResolveRequest) {
      return prevResolveRequest(ctx, moduleName, platform);
    }
    return ctx.resolveRequest(ctx, moduleName, platform);
  },
});

module.exports = config;
`;
}

// ── Dev Middleware ─────────────────────────────────────────────────

function loadDevMiddleware(
  projectRoot: string,
  port: number,
): {
  middleware: HandleFunction | null;
  websocketEndpoints: RunServerOptions['websocketEndpoints'] | undefined;
} {
  try {
    const cjsRequire = createRequire(resolve(projectRoot, '_resolver.js'));
    const { createDevMiddleware } = cjsRequire('@react-native/dev-middleware');
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
  const content = `// Auto-generated by vitest-mobile — do not edit
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
globalThis.__VITEST_METRO_PORT__ = ${opts.metroPort};

import { AppRegistry } from 'react-native';
import { createTestHarness } from 'vitest-mobile/runtime';

const HarnessApp = createTestHarness({ port: ${opts.wsPort}, metroPort: ${opts.metroPort} });
AppRegistry.registerComponent('${opts.appModuleName}', () => HarnessApp);
`;

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
function generateTransformerShim(opts: {
  outputDir: string;
  harnessProjectDir: string;
  testWrapperPluginPath: string;
}): string {
  const { outputDir, harnessProjectDir, testWrapperPluginPath } = opts;
  const transformerPath = resolve(outputDir, 'transformer.cjs');
  const content = `// Auto-generated by vitest-mobile — do not edit.
const path = require('node:path');
const { createRequire } = require('node:module');

const HARNESS_DIR = ${JSON.stringify(harnessProjectDir)};
const TEST_WRAPPER_PLUGIN_PATH = ${JSON.stringify(testWrapperPluginPath)};

// Resolve @react-native/metro-babel-transformer from inside the harness tree.
// Hardcoded: the harness scaffold always installs this as a transitive dep
// of @react-native/metro-config. A missing module here means a broken scaffold.
const harnessReq = createRequire(path.join(HARNESS_DIR, '_vitest-mobile-anchor.js'));
const upstream = harnessReq('@react-native/metro-babel-transformer');

// Test-wrapper plugin is bundled into vitest-mobile's dist; require by
// absolute path (it has no external deps that need harness resolution).
const testWrapperMod = require(TEST_WRAPPER_PLUGIN_PATH);
const testWrapperPlugin = testWrapperMod && testWrapperMod.default ? testWrapperMod.default : testWrapperMod;

exports.getCacheKey = upstream.getCacheKey;
exports.transform = function (props) {
  return upstream.transform(
    Object.assign({}, props, {
      plugins: [...(props.plugins || []), testWrapperPlugin],
    }),
  );
};
`;
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
    registryPath: string;
    outputDir: string;
    harnessProjectDir: string;
  },
): ConfigT {
  const { projectRoot, registryPath, outputDir, harnessProjectDir } = options;

  // Module resolution: redirect vitest → shim, test-registry → generated file
  const originalResolver = config.resolver.resolveRequest;
  const resolveRequest: CustomResolver = (
    context: CustomResolutionContext,
    moduleName: string,
    platform: string | null,
  ) => {
    if (moduleName === 'vitest-mobile/test-registry') {
      return { type: 'sourceFile', filePath: registryPath };
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

  // Suppress Metro's ASCII logo on startup
  const origReporter = config.reporter;
  const reporter: Reporter = {
    update(event: Parameters<Reporter['update']>[0]) {
      if (event?.type === 'initialize_started') return;
      origReporter?.update?.(event);
    },
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
  const testWrapperPluginPath = createRequire(import.meta.url).resolve('../../dist/babel/test-wrapper-plugin.cjs');
  const transformerPath = generateTransformerShim({ outputDir, harnessProjectDir, testWrapperPluginPath });

  return {
    ...config,
    projectRoot,
    watchFolders,
    reporter,
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
    },
    server: {
      ...config.server,
      port: options.port,
      rewriteRequestUrl,
      enhanceMiddleware,
    },
  };
}
