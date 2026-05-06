import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cac from 'cac';
import {
  requirePlatform,
  resolvePlatformInteractive,
  resolvePlatformFromCache,
  resolvePlatformOrBoth,
  rejectLegacyPositional,
  expandPlatform,
  type Platform,
} from './platform';
import {
  parseNativeModules,
  readBabelPluginsFromConfig,
  readMetroCustomizerFromConfig,
  readTestPatternsFromConfig,
  resolveNativeModules,
} from './config-readers';
import { withSpinner } from './ui';

const cli = cac('vitest-mobile');

// ── Commands ─────────────────────────────────────────────────────────

cli
  .command('build', 'Build the harness binary')
  .option('--platform <platform>', 'ios or android (prompts if omitted in TTY)')
  .option('--app-dir <dir>', 'App directory', { default: '.' })
  .option('--force', 'Force rebuild (clear cache)')
  .option('--native-modules <modules>', 'Comma-separated list of react-native native modules (overrides vitest config)')
  .action(async (options: { platform?: string; appDir: string; force: boolean; nativeModules?: string }) => {
    rejectLegacyPositional(cli.args);
    const platform = (await resolvePlatformInteractive(options.platform, {
      command: 'build',
    })) as Platform;
    const { build } = await import('./build');
    const appDir = resolve(process.cwd(), options.appDir);
    const nativeModules = await resolveNativeModules(options.nativeModules, appDir, [platform]);
    await withSpinner(
      { command: 'build', platform, initialMessage: `Building ${platform} harness binary…` },
      async () => {
        await build(platform, {
          appDir: options.appDir,
          force: options.force,
          nativeModules,
        });
      },
    );
  });

cli
  .command('install', 'Install harness binary on device')
  .option('--platform <platform>', 'ios or android (inferred from cached builds if omitted)')
  .option('--app-dir <dir>', 'App directory', { default: '.' })
  .option('--native-modules <modules>', 'Comma-separated list of react-native native modules (overrides vitest config)')
  .action(async (options: { platform?: string; appDir: string; nativeModules?: string }) => {
    rejectLegacyPositional(cli.args);
    const platform = (await resolvePlatformFromCache(options.platform, {
      command: 'install',
    })) as Platform;
    const { install } = await import('./install');
    const appDir = resolve(process.cwd(), options.appDir);
    const nativeModules = await resolveNativeModules(options.nativeModules, appDir, [platform]);
    await withSpinner(
      { command: 'install', platform, initialMessage: `Installing ${platform} harness binary…` },
      async () => {
        await install(platform, {
          appDir: options.appDir,
          nativeModules,
        });
      },
    );
  });

cli
  .command('bootstrap', 'Build + boot + install in one step (snapshot-aware in CI)')
  .option('--platform <platform>', 'ios or android (prompts if omitted in TTY)')
  .option('--app-dir <dir>', 'App directory', { default: '.' })
  .option('--force', 'Force rebuild (clear cache)')
  .option('--headless', 'Run without GUI — enables snapshot save/restore and cache trimming (for CI)')
  .option('--api-level <level>', 'Android API level — auto-installs system image + creates AVD if needed')
  .option('--device <name>', 'Simulator/AVD name to use (skips interactive picker)')
  .option('--native-modules <modules>', 'Comma-separated list of react-native native modules (overrides vitest config)')
  .action(
    async (options: {
      platform?: string;
      appDir: string;
      force: boolean;
      headless?: boolean;
      apiLevel?: string;
      device?: string;
      nativeModules?: string;
    }) => {
      rejectLegacyPositional(cli.args);
      const platform = (await resolvePlatformInteractive(options.platform, {
        command: 'bootstrap',
      })) as Platform;
      const { bootstrap } = await import('./bootstrap');
      const { ensureDeviceMapping } = await import('./device-picker');
      const appDir = resolve(process.cwd(), options.appDir);
      const nativeModules = await resolveNativeModules(options.nativeModules, appDir, [platform]);

      // Pick the device BEFORE starting the spinner — the picker needs the
      // terminal, and @clack's spinner + select don't play well concurrently.
      // `alwaysPrompt` so every bootstrap lets the user reselect, with their
      // current choice pre-selected as the default (hit Enter to keep it).
      await ensureDeviceMapping({ platform, appDir, deviceFlag: options.device, alwaysPrompt: true });

      await withSpinner(
        { command: 'bootstrap', platform, initialMessage: `Bootstrapping ${platform} harness…` },
        async () => {
          await bootstrap(platform, {
            appDir: options.appDir,
            force: options.force ?? false,
            headless: options.headless ?? false,
            apiLevel: options.apiLevel ? Number(options.apiLevel) : undefined,
            nativeModules,
          });
        },
      );
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
  .option('--native-modules <modules>', 'Comma-separated list of react-native native modules (overrides vitest config)')
  .action(
    async (options: {
      platform?: string;
      out: string;
      wsPort: string;
      metroPort: string;
      include?: string;
      config?: string;
      dev: boolean;
      nativeModules?: string;
    }) => {
      rejectLegacyPositional(cli.args);
      const choice = resolvePlatformOrBoth(options.platform);
      const platforms = expandPlatform(choice);
      const { buildBundle } = await import('../node/metro-runner');
      const outDir = resolve(process.cwd(), options.out);
      const testPatterns = options.include
        ? options.include.split(',').map(p => p.trim())
        : await readTestPatternsFromConfig(process.cwd(), platforms, options.config);
      if (testPatterns.length === 0) {
        console.error('No test patterns found. Provide --include or ensure vitest config has test.include.');
        process.exit(1);
      }
      const nativeModules = await resolveNativeModules(options.nativeModules, process.cwd(), platforms, options.config);
      const metro = await readMetroCustomizerFromConfig(process.cwd(), platforms, options.config);
      const babelPlugins = await readBabelPluginsFromConfig(process.cwd(), platforms, options.config);
      await withSpinner(
        {
          command: 'bundle',
          platform: choice === 'both' ? undefined : choice,
          initialMessage: `Bundling JS for ${choice === 'both' ? 'ios + android' : choice}…`,
        },
        async () => {
          await buildBundle({
            projectRoot: process.cwd(),
            outDir,
            platforms,
            wsPort: Number(options.wsPort),
            metroPort: Number(options.metroPort),
            testPatterns,
            dev: options.dev,
            nativeModules,
            metro,
            babelPlugins,
          });
        },
      );
    },
  );

cli
  .command('boot-device', 'Start a simulator or emulator')
  .option('--platform <platform>', 'ios or android (prompts if omitted in TTY)')
  .option('--ws-port <port>', 'WebSocket port', { default: '7878' })
  .option('--metro-port <port>', 'Metro port', { default: '18081' })
  .option('--headless', 'Run without GUI (for CI)')
  .option('--api-level <level>', 'Android API level — auto-installs system image + creates AVD if needed')
  .option('--device <name>', 'Simulator/AVD name to use (skips interactive picker)')
  .action(
    async (options: {
      platform?: string;
      wsPort: string;
      metroPort: string;
      headless?: boolean;
      apiLevel?: string;
      device?: string;
    }) => {
      rejectLegacyPositional(cli.args);
      const platform = (await resolvePlatformInteractive(options.platform, {
        command: 'boot-device',
      })) as Platform;
      const { ensureDevice } = await import('../node/device');
      const { ensureDeviceMapping } = await import('./device-picker');
      const appDir = process.cwd();
      await ensureDeviceMapping({ platform, appDir, deviceFlag: options.device });
      await withSpinner(
        { command: 'boot-device', platform, initialMessage: `Booting ${platform} device…` },
        async () => {
          await ensureDevice(
            platform,
            {
              appDir,
              port: Number(options.wsPort),
              metroPort: Number(options.metroPort),
            },
            {
              headless: options.headless ?? false,
              apiLevel: options.apiLevel ? Number(options.apiLevel) : undefined,
            },
          );
        },
      );
    },
  );

cli
  .command('screenshot', 'Take a simulator screenshot')
  .option('--platform <platform>', 'ios or android (defaults to any running device)')
  .option('--output <path>', 'Output file path')
  .action(async (options: { platform?: string; output?: string }) => {
    rejectLegacyPositional(cli.args);
    const platform = options.platform ? (requirePlatform(options.platform, 'screenshot') as Platform) : undefined;
    const { screenshot } = await import('./screenshot');
    screenshot({ platform, output: options.output });
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
  .command('cache-key', 'Print the deterministic cache key for the harness build')
  .option('--platform <platform>', 'ios or android (required — output depends on platform)')
  .option('--app-dir <dir>', 'App directory', { default: '.' })
  .option('--native-modules <modules>', 'Comma-separated list of react-native native modules (overrides vitest config)')
  .action(async (options: { platform?: string; appDir: string; nativeModules?: string }) => {
    rejectLegacyPositional(cli.args);
    const platform = requirePlatform(options.platform, 'cache-key');
    const { fileURLToPath } = await import('node:url');
    const packageRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
    const appDir = resolve(process.cwd(), options.appDir);
    const { detectReactNativeVersion, computeCacheKey } = await import('../node/harness-builder');
    const rnVersion = detectReactNativeVersion(appDir);
    if (!rnVersion) {
      console.error(
        'Could not auto-detect React Native version (react-native not found in node_modules).\n' +
          'Install react-native first:\n  npm install react-native\n\n' +
          'Or set reactNativeVersion explicitly in your Vitest config:\n' +
          "  nativePlugin({ reactNativeVersion: '0.81.5' })",
      );
      process.exit(1);
    }
    const nativeModules = await resolveNativeModules(options.nativeModules, appDir, [platform]);
    const key = computeCacheKey({
      reactNativeVersion: rnVersion,
      nativeModules,
      packageRoot,
    });
    process.stdout.write(key);
  });

cli
  .command('trim-cache', 'Remove intermediate build artifacts (keeps only the final binary)')
  .option('--platform <platform>', 'ios or android (omit to trim both)')
  .action(async (options: { platform?: string }) => {
    rejectLegacyPositional(cli.args);
    const choice = resolvePlatformOrBoth(options.platform);
    const platforms = expandPlatform(choice);
    const { trimBuildCache } = await import('../node/harness-builder');
    for (const p of platforms) {
      const result = trimBuildCache({ platform: p });
      if (result.trimmed) {
        console.log(`[${p}] Cache trimmed: ${formatBytes(result.before)} → ${formatBytes(result.after)}`);
      } else {
        console.log(`[${p}] No build cache to trim.`);
      }
    }
  });

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

cli.command('clean', 'Remove all cached harness binaries and generated files').action(async () => {
  const { getCacheDir } = await import('../node/paths');

  const cacheDir = getCacheDir();
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
  .command('clean-devices', 'List or remove auto-created persistent devices')
  .option('--platform <platform>', 'ios or android (omit to clean both)')
  .option('--apply', 'Actually remove devices (default is dry run)')
  .action(async (options: { platform?: string; apply?: boolean }) => {
    rejectLegacyPositional(cli.args);
    const { listAutoCreatedDeviceIds, cleanupAutoCreatedDevices } = await import('../node/device');
    const choice = resolvePlatformOrBoth(options.platform);
    const platforms = expandPlatform(choice);
    let totalFound = 0;
    for (const p of platforms) {
      const existing = listAutoCreatedDeviceIds(p);
      if (existing.length === 0) {
        console.log(`[${p}] No auto-created devices found.`);
        continue;
      }
      totalFound += existing.length;
      if (!options.apply) {
        console.log(`[${p}] Auto-created devices:`);
        for (const id of existing) console.log(`  - ${id}`);
      } else {
        const removed = await cleanupAutoCreatedDevices(p);
        console.log(`[${p}] Removed ${removed.length} device(s).`);
      }
    }
    if (!options.apply && totalFound > 0) {
      console.log('\nRun with --apply to delete.');
    }
  });

cli
  .command('reset-device', "Clear this project's chosen device (deletes the device only if we created it)")
  .option('--platform <platform>', 'ios or android (prompts if omitted in TTY)')
  .option('--apply', 'Actually remove the device (default is dry run)')
  .action(async (options: { platform?: string; apply?: boolean }) => {
    rejectLegacyPositional(cli.args);
    const platform = (await resolvePlatformInteractive(options.platform, {
      command: 'reset-device',
    })) as Platform;
    const { getDeviceMapping, clearDeviceMapping } = await import('../node/device/mapping');
    const appDir = process.cwd();
    const mapping = getDeviceMapping(appDir, platform);
    if (!mapping) {
      console.log(`No vitest-mobile ${platform} device configured for ${appDir}.`);
      return;
    }

    if (!mapping.createdByUs) {
      // User picked an existing simulator/AVD of their own — we never touch it.
      // Just clear the mapping so next bootstrap re-prompts.
      if (!options.apply) {
        console.log(
          `Configured ${platform} device for ${appDir}: ${mapping.deviceName} (not created by vitest-mobile).`,
        );
        console.log('Run with --apply to clear the mapping (the device itself will not be deleted).');
        return;
      }
      clearDeviceMapping(appDir, platform);
      console.log(`Cleared ${platform} device mapping (left '${mapping.deviceName}' intact).`);
      return;
    }

    // createdByUs: delete the device + any secondaries, then clear the mapping.
    const { listProjectDeviceIds, cleanupProjectDevices } = await import('../node/device');
    const existing = listProjectDeviceIds(platform, appDir);
    if (existing.length === 0) {
      // Mapping existed but device is gone — just clear the mapping.
      if (!options.apply) {
        console.log(
          `Configured ${platform} device '${mapping.deviceName}' is already gone; run --apply to clear the mapping.`,
        );
        return;
      }
      clearDeviceMapping(appDir, platform);
      console.log(`Cleared stale ${platform} device mapping.`);
      return;
    }
    if (!options.apply) {
      console.log(`${platform} devices for ${appDir}:`);
      for (const id of existing) console.log(`  - ${id}`);
      console.log('Run with --apply to delete.');
      return;
    }
    const removed = await cleanupProjectDevices(platform, appDir);
    clearDeviceMapping(appDir, platform);
    console.log(`Removed ${removed.length} ${platform} device(s) and cleared mapping.`);
  });

cli.help();

// `command:*` fires during .parse() when a command was attempted but didn't
// match; without this handler cac silently exits 0 on unknown commands.
cli.on('command:*', () => {
  const attempted = cli.args.join(' ') || '(none)';
  console.error(`Unknown command: ${attempted}\n`);
  cli.outputHelp();
  process.exit(1);
});

cli.parse();

// If no command matched AND no positional args were given, treat as
// `--help`. cac's `command:*` doesn't fire in the empty-argv case.
if (!cli.matchedCommand && cli.args.length === 0 && process.argv.length <= 2) {
  cli.outputHelp();
}
