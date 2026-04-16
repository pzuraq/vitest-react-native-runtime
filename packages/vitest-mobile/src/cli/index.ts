import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cac from 'cac';

const VITEST_CONFIG_FILES = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs'];

async function readTestPatternsFromConfig(
  projectRoot: string,
  platforms: ('ios' | 'android')[],
  configPath?: string,
): Promise<string[]> {
  const configFile = configPath
    ? resolve(projectRoot, configPath)
    : VITEST_CONFIG_FILES.map(f => resolve(projectRoot, f)).find(f => existsSync(f));

  if (!configFile || !existsSync(configFile)) {
    console.warn('No vitest config found — use --include to specify test patterns');
    return [];
  }

  try {
    const { loadConfigFromFile } = await import('vite');
    const result = await loadConfigFromFile({ command: 'build', mode: 'production' }, configFile, projectRoot);
    if (!result) {
      console.warn('Could not load vitest config — use --include to specify test patterns');
      return [];
    }

    const config = result.config as { test?: { projects?: Array<{ test?: { name?: string; include?: string[] } }> } };
    const projects = config.test?.projects ?? [];
    const patterns = new Set<string>();
    for (const project of projects) {
      const name = project.test?.name;
      if (name && !platforms.includes(name as 'ios' | 'android')) continue;
      for (const p of project.test?.include ?? []) {
        patterns.add(p);
      }
    }

    if (patterns.size === 0) {
      console.warn('No test include patterns found in vitest config — use --include');
      return [];
    }

    console.log(`Using test patterns from ${configFile}: ${[...patterns].join(', ')}`);
    return [...patterns];
  } catch (e) {
    console.warn(`Failed to load vitest config: ${e instanceof Error ? e.message : e}`);
    console.warn('Use --include to specify test patterns manually');
    return [];
  }
}

const cli = cac('vitest-mobile');

cli
  .command('build <platform>', 'Build the harness binary')
  .option('--app-dir <dir>', 'App directory', { default: '.' })
  .option('--force', 'Force rebuild (clear cache)')
  .action(async (platform: string, options: { appDir: string; force: boolean }) => {
    const { build } = await import('./build');
    await build(platform, options);
  });

cli
  .command('install <platform>', 'Install harness binary on device')
  .option('--app-dir <dir>', 'App directory', { default: '.' })
  .action(async (platform: string, options: { appDir: string }) => {
    const { install } = await import('./install');
    await install(platform, options);
  });

cli
  .command('bootstrap <platform>', 'Build + boot + install in one step (snapshot-aware in CI)')
  .option('--app-dir <dir>', 'App directory', { default: '.' })
  .option('--force', 'Force rebuild (clear cache)')
  .option('--headless', 'Run without GUI — enables snapshot save/restore and cache trimming (for CI)')
  .option('--api-level <level>', 'Android API level — auto-installs system image + creates AVD if needed')
  .action(
    async (platform: string, options: { appDir: string; force: boolean; headless?: boolean; apiLevel?: string }) => {
      const { bootstrap } = await import('./bootstrap');
      await bootstrap(platform, {
        appDir: options.appDir,
        force: options.force ?? false,
        headless: options.headless ?? false,
        apiLevel: options.apiLevel ? Number(options.apiLevel) : undefined,
      });
    },
  );

cli
  .command('bundle', 'Pre-build the JS bundle for faster test startup')
  .option('--platform <platform>', 'ios or android (omit to build both)')
  .option('--out <dir>', 'Output directory', { default: '.vitest-mobile/bundle' })
  .option('--ws-port <port>', 'WebSocket port to bake into the bundle', { default: '17878' })
  .option('--metro-port <port>', 'Metro port to bake into the bundle', { default: '18081' })
  .option('--include <patterns>', 'Test file glob patterns (comma-separated, overrides vitest config)')
  .option('--config <path>', 'Path to vitest config file')
  .option('--no-dev', 'Build in production mode (minified)')
  .action(
    async (options: {
      platform?: string;
      out: string;
      wsPort: string;
      metroPort: string;
      include?: string;
      config?: string;
      dev: boolean;
    }) => {
      const { buildBundle } = await import('../node/metro-runner');
      const platforms: ('ios' | 'android')[] = options.platform
        ? [options.platform as 'ios' | 'android']
        : ['ios', 'android'];
      const outDir = resolve(process.cwd(), options.out);
      const testPatterns = options.include
        ? options.include.split(',').map(p => p.trim())
        : await readTestPatternsFromConfig(process.cwd(), platforms, options.config);
      if (testPatterns.length === 0) {
        console.error('No test patterns found. Provide --include or ensure vitest config has test.include.');
        process.exit(1);
      }
      await buildBundle({
        projectRoot: process.cwd(),
        outDir,
        platforms,
        wsPort: Number(options.wsPort),
        metroPort: Number(options.metroPort),
        testPatterns,
        dev: options.dev,
      });
    },
  );

cli
  .command('boot-device <platform>', 'Start a simulator or emulator')
  .option('--ws-port <port>', 'WebSocket port', { default: '7878' })
  .option('--metro-port <port>', 'Metro port', { default: '18081' })
  .option('--headless', 'Run without GUI (for CI)')
  .option('--api-level <level>', 'Android API level — auto-installs system image + creates AVD if needed')
  .action(
    async (platform: string, options: { wsPort: string; metroPort: string; headless?: boolean; apiLevel?: string }) => {
      const { ensureDevice } = await import('../node/device');
      await ensureDevice(platform as 'ios' | 'android', {
        headless: options.headless ?? false,
        wsPort: Number(options.wsPort),
        metroPort: Number(options.metroPort),
        apiLevel: options.apiLevel ? Number(options.apiLevel) : undefined,
      });
      console.log(`${platform} device ready.`);
    },
  );

cli
  .command('screenshot', 'Take a simulator screenshot')
  .option('--platform <platform>', 'ios or android')
  .option('--output <path>', 'Output file path')
  .action(async (options: { platform?: string; output?: string }) => {
    const { screenshot } = await import('./screenshot');
    await screenshot(options);
  });

cli
  .command('debug open', 'Open the JS debugger on the device')
  .option('--metro-port <port>', 'Metro port', { default: '18081' })
  .action(async (options: { metroPort: string }) => {
    const { debugOpen } = await import('./debug');
    await debugOpen(Number(options.metroPort));
  });

cli
  .command('debug eval <expression>', 'Evaluate JS in the running app via CDP')
  .option('--metro-port <port>', 'Metro port', { default: '18081' })
  .action(async (expression: string, options: { metroPort: string }) => {
    const { debugEval } = await import('./debug');
    await debugEval(expression, Number(options.metroPort));
  });

cli
  .command('cache-key <platform>', 'Print the deterministic cache key for the harness build')
  .option('--app-dir <dir>', 'App directory', { default: '.' })
  .action(async (platform: string, options: { appDir: string }) => {
    const { fileURLToPath } = await import('node:url');
    const packageRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
    const appDir = resolve(process.cwd(), options.appDir);
    const { detectReactNativeVersion, computeCacheKey } = await import('../node/harness-builder');
    const rnVersion = detectReactNativeVersion(appDir);
    const key = computeCacheKey({
      platform: platform as 'ios' | 'android',
      reactNativeVersion: rnVersion,
      nativeModules: [],
      packageRoot,
    });
    process.stdout.write(key);
  });

cli
  .command('trim-cache <platform>', 'Remove intermediate build artifacts from cache (keeps only the final binary)')
  .action(async (platform: string) => {
    const { trimBuildCache } = await import('../node/harness-builder');
    const result = trimBuildCache({ platform: platform as 'ios' | 'android' });
    if (result.trimmed) {
      console.log(`Cache trimmed: ${formatBytes(result.before)} → ${formatBytes(result.after)}`);
    } else {
      console.log('No build cache to trim.');
    }
  });

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

cli.command('clean', 'Remove all cached harness binaries and generated files').action(async () => {
  const { getDefaultCacheDir } = await import('../node/harness-builder');

  const cacheDir = getDefaultCacheDir();
  if (existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true });
    console.log(`Removed cache directory: ${cacheDir}`);
  } else {
    console.log('No cache directory found.');
  }

  const vmDir = resolve(process.cwd(), '.vitest-mobile');
  if (existsSync(vmDir)) {
    rmSync(vmDir, { recursive: true, force: true });
    console.log(`Removed .vitest-mobile/`);
  }

  console.log('Clean complete.');
});

cli
  .command('clean-devices <platform>', 'List or remove auto-created persistent devices')
  .option('--apply', 'Actually remove devices (default is dry run)')
  .action(async (platform: string, options: { apply?: boolean }) => {
    const { listAutoCreatedDeviceIds, cleanupAutoCreatedDevices } = await import('../node/device');
    const p = platform as 'ios' | 'android';
    const existing = listAutoCreatedDeviceIds(p);
    if (existing.length === 0) {
      console.log('No auto-created devices found.');
      return;
    }
    if (!options.apply) {
      console.log('Auto-created devices:');
      for (const id of existing) console.log(`  - ${id}`);
      console.log('Run with --apply to delete.');
      return;
    }
    const removed = cleanupAutoCreatedDevices(p);
    console.log(`Removed ${removed.length} device(s).`);
  });

cli.help();
cli.parse();
