/**
 * metro-runner — starts Metro programmatically, configured for test execution.
 *
 * Replaces the previous approach of spawning `npx expo start --dev-client`.
 * The user doesn't need metro.config.js or babel.config.js — all configuration
 * is applied programmatically by the pool.
 */

import { resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { log } from './logger';
import { generateTestRegistry } from '../metro/generateTestRegistry';
import { runServer, runBuild, type RunServerOptions, type RunServerResult, type Reporter } from 'metro';
import { loadConfig, type ConfigT, type Middleware } from 'metro-config';
import type { CustomResolutionContext, CustomResolver } from 'metro-resolver';
import type connect from 'connect';
import type { HandleFunction } from 'connect';

// ── Types ──────────────────────────────────────────────────────────

export interface MetroRunnerOptions {
  projectRoot: string;
  port: number;
  wsPort: number;
  platform: 'ios' | 'android';
  testPatterns: string[];
  appModuleName: string;
  outputDir?: string;
}

export interface MetroServer {
  close(): Promise<void>;
  port: number;
}

// ── Helpers ────────────────────────────────────────────────────────

function tryResolve(projectRoot: string, modulePath: string): string | null {
  try {
    return createRequire(resolve(projectRoot, '_resolver.js')).resolve(modulePath);
  } catch {
    return null;
  }
}

const BABEL_CONFIG_FILES = [
  'babel.config.js',
  'babel.config.cjs',
  'babel.config.json',
  '.babelrc',
  '.babelrc.js',
  '.babelrc.json',
];

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
  ensureBabelConfig(projectRoot);

  const { filePath: registryPath, testFiles } = generateTestRegistry({
    projectRoot,
    testPatterns,
    outputDir,
  });
  log.info(`Discovered ${testFiles.length} test file(s)`);

  const baseConfig = await loadMetroConfig(projectRoot, outputDir);
  const config = applyTestTransforms(baseConfig, { projectRoot, port, registryPath, outputDir });
  const entryPath = resolve(outputDir, `index.${options.platform}.js`);

  return { config, entryPath, outputDir, registryPath, testFiles };
}

// ── Public API ─────────────────────────────────────────────────────

export async function startMetroServer(options: MetroRunnerOptions): Promise<MetroServer> {
  const { config, outputDir } = await prepareMetroConfig(options);
  const { projectRoot, port } = options;

  const { middleware: devMiddleware, websocketEndpoints } = loadDevMiddleware(projectRoot, port);

  log.info(`Starting Metro on port ${port}...`);

  const runServerOpts: RunServerOptions = {
    host: '127.0.0.1',
    ...(devMiddleware ? { unstable_extraMiddleware: [devMiddleware] } : {}),
    ...(websocketEndpoints ? { websocketEndpoints } : {}),
  };
  const { httpServer } = await runServer(config, runServerOpts);
  log.info(`Metro ready on port ${port}`);

  return {
    port,
    async close() {
      log.verbose('Metro close requested');
      await new Promise<void>(r => {
        httpServer.close(() => r());
        setTimeout(r, 3000);
      });
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
}

export async function buildBundle(options: BuildBundleOptions): Promise<BundleManifest> {
  const { projectRoot, outDir, platforms, wsPort, metroPort, testPatterns, dev = true } = options;

  mkdirSync(outDir, { recursive: true });

  const manifest: BundleManifest = { wsPort, metroPort, dev, bundles: {} };

  for (const platform of platforms) {
    log.info(`Bundling for ${platform}...`);

    const prepared = await prepareMetroConfig({
      projectRoot,
      port: metroPort,
      wsPort,
      platform,
      testPatterns,
      appModuleName: 'VitestMobileApp',
    });

    const baseName = `index.${platform}.jsbundle`;
    const bundlePath = resolve(outDir, baseName);

    // Metro's runBuild types are incomplete — platform/sourceMap/sourceMapOut
    // exist at runtime but not in the .d.ts. Cast to pass them through.
    await runBuild(prepared.config, {
      entry: prepared.entryPath,
      dev,
      minify: !dev,
      out: bundlePath,
      platform,
      sourceMap: true,
      sourceMapOut: resolve(outDir, `${baseName}.map`),
    } as Parameters<typeof runBuild>[1]);

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

async function loadMetroConfig(projectRoot: string, outputDir: string): Promise<ConfigT> {
  const userConfigPath = ['metro.config.js', 'metro.config.cjs']
    .map(name => resolve(projectRoot, name))
    .find(p => existsSync(p));

  if (userConfigPath) {
    log.verbose(`Loading user ${userConfigPath}`);
    return loadConfig({ config: userConfigPath }, { projectRoot });
  }

  const generatedPath = resolve(outputDir, 'metro.config.cjs');
  writeFileSync(
    generatedPath,
    [
      '// Auto-generated by vitest-mobile',
      `const { getDefaultConfig } = require('@react-native/metro-config');`,
      `module.exports = getDefaultConfig(${JSON.stringify(projectRoot)});`,
      '',
    ].join('\n'),
  );
  log.verbose('Loading generated metro config with RN defaults');
  return loadConfig({ config: generatedPath }, { projectRoot });
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

// ── Babel Config ──────────────────────────────────────────────────

function ensureBabelConfig(projectRoot: string): void {
  if (BABEL_CONFIG_FILES.some(name => existsSync(resolve(projectRoot, name)))) {
    return;
  }
  writeFileSync(
    resolve(projectRoot, 'babel.config.cjs'),
    `// Auto-generated by vitest-mobile — do not edit\nmodule.exports = {\n  plugins: ['vitest-mobile/babel-plugin'],\n};\n`,
  );
  log.info('Generated babel.config.cjs');
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
 * Build a new ConfigT with test-specific overrides.
 * ConfigT is Readonly, so we produce a new object via spreading.
 */
function applyTestTransforms(
  config: ConfigT,
  options: { projectRoot: string; port: number; registryPath: string; outputDir: string },
): ConfigT {
  const { projectRoot, registryPath, outputDir } = options;

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

  // Ensure InitializeCore runs before the main module
  const initCorePath = tryResolve(projectRoot, 'react-native/Libraries/Core/InitializeCore.js');

  // Fix Metro's default 'missing-asset-registry-path' placeholder
  const { assetRegistryPath: existingARP } = config.transformer;
  const assetRegistryPath =
    !existingARP || existingARP === 'missing-asset-registry-path'
      ? (tryResolve(projectRoot, 'react-native/Libraries/Image/AssetRegistry.js') ?? existingARP)
      : existingARP;

  const watchFolders = [...config.watchFolders];
  if (!watchFolders.includes(options.outputDir)) watchFolders.push(options.outputDir);

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
    serializer: {
      ...config.serializer,
      getModulesRunBeforeMainModule: initCorePath
        ? () => [initCorePath]
        : config.serializer.getModulesRunBeforeMainModule,
    },
    transformer: { ...config.transformer, assetRegistryPath },
    server: {
      ...config.server,
      port: options.port,
      rewriteRequestUrl,
      enhanceMiddleware,
    },
  };
}
