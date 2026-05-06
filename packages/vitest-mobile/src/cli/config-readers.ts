import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MetroConfigCustomizer, NativePluginOptions } from '../node/types';
import type { Platform } from './platform';

const VITEST_CONFIG_FILES = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs'];

/**
 * Resolve the vitest config file path that each CLI reader helper loads.
 * Returns `undefined` when no config can be found (callers decide whether
 * that's fatal or just means "skip the config-backed default").
 */
export function resolveVitestConfigFile(projectRoot: string, configPath?: string): string | undefined {
  const candidate = configPath
    ? resolve(projectRoot, configPath)
    : VITEST_CONFIG_FILES.map(f => resolve(projectRoot, f)).find(f => existsSync(f));
  return candidate && existsSync(candidate) ? candidate : undefined;
}

/**
 * Load the vitest config via vite's static loader. Returns `null` on any
 * failure so callers can fall back silently. Memoized per configFile path
 * because multiple helpers (test patterns, native modules, metro customizer,
 * babel plugins) read the same config during a single CLI invocation.
 */
const _loadedConfigCache = new Map<string, unknown>();
export async function loadVitestConfig(configFile: string, projectRoot: string): Promise<unknown | null> {
  if (_loadedConfigCache.has(configFile)) {
    return _loadedConfigCache.get(configFile) ?? null;
  }
  try {
    const { loadConfigFromFile } = await import('vite');
    const result = await loadConfigFromFile({ command: 'build', mode: 'production' }, configFile, projectRoot);
    const config = result?.config ?? null;
    _loadedConfigCache.set(configFile, config);
    return config;
  } catch (e) {
    _loadedConfigCache.set(configFile, null);
    console.warn(`Failed to load vitest config: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Test-only: clear the memoized config cache so adjacent fixtures don't bleed. */
export function _resetLoadedConfigCacheForTests(): void {
  _loadedConfigCache.clear();
}

// ── Unified plugin-options extraction ─────────────────────────────────────────

/**
 * Walk a loaded vitest config and return every `NativePluginOptions` instance
 * declared on `nativePlugin(...)` plugins inside projects matching `platforms`.
 *
 * `nativePlugin` stashes its original user-supplied options on the returned
 * Plugin object under `VITEST_MOBILE_PLUGIN_OPTIONS_KEY`, so we can recover
 * them here without evaluating the plugin's `config()` hook or booting a
 * full vitest instance.
 *
 * This is the **only** place where the on-disk plugin shape is decoded —
 * every per-field reader (`readNativeModulesFromConfig`,
 * `readMetroCustomizerFromConfig`, `readBabelPluginsFromConfig`) builds on
 * top of this function, so a future change to `NativePluginOptions` shape
 * fails the type-checker in one place instead of silently dropping options
 * in three.
 */
export async function readVitestMobilePluginOptions(
  projectRoot: string,
  platforms: Platform[],
  configPath?: string,
): Promise<NativePluginOptions[]> {
  const configFile = resolveVitestConfigFile(projectRoot, configPath);
  if (!configFile) return [];

  const config = (await loadVitestConfig(configFile, projectRoot)) as {
    test?: {
      projects?: Array<{
        test?: { name?: string };
        plugins?: unknown[];
      }>;
    };
  } | null;
  if (!config) return [];

  const { VITEST_MOBILE_PLUGIN_OPTIONS_KEY: OPTIONS_KEY } = await import('../node/index');
  const out: NativePluginOptions[] = [];
  for (const project of config.test?.projects ?? []) {
    const name = project.test?.name;
    if (name && !platforms.includes(name as Platform)) continue;
    for (const plugin of project.plugins ?? []) {
      if (!plugin || typeof plugin !== 'object') continue;
      const stored = (plugin as Record<string, unknown>)[OPTIONS_KEY] as NativePluginOptions | undefined;
      if (stored) out.push(normalizeLegacyOptions(stored));
    }
  }
  return out;
}

/**
 * Backward-compat shim: prior to the `harness` group being introduced,
 * `nativePlugin({ nativeModules })` accepted `nativeModules` at the top level.
 * Re-home it to `harness.nativeModules` so per-field readers can stay
 * strictly typed against the current `NativePluginOptions` shape.
 *
 * `harness.nativeModules` always wins when both forms are present.
 */
function normalizeLegacyOptions(stored: NativePluginOptions): NativePluginOptions {
  const legacy = (stored as { nativeModules?: string[] }).nativeModules;
  if (!legacy || stored.harness?.nativeModules) return stored;
  return { ...stored, harness: { ...stored.harness, nativeModules: legacy } };
}

// ── Per-field plucks (every one of these is a tiny `.map`/`.flatMap` over the
// unified extractor — keep them this way) ─────────────────────────────────────

/**
 * Deduped union of `harness.nativeModules` across every matching plugin.
 *
 * Used by every CLI command that ultimately calls `ensureHarnessBinary`
 * (`build`, `install`, `bootstrap`, `bundle`, `cache-key`) so the cache key
 * matches what the pool computes at run time.
 */
export async function readNativeModulesFromConfig(
  projectRoot: string,
  platforms: Platform[],
  configPath?: string,
): Promise<string[]> {
  const all = await readVitestMobilePluginOptions(projectRoot, platforms, configPath);
  const modules = new Set<string>();
  for (const opts of all) {
    for (const mod of opts.harness?.nativeModules ?? []) {
      modules.add(mod);
    }
  }
  return [...modules];
}

/**
 * Composed `metro.customize` callback across every matching plugin. Multiple
 * customizers are chained left-to-right (first listed plugin's customizer
 * runs first; each receives the output of the previous). Returns undefined
 * if no matching plugin declares one.
 *
 * Read by `vitest-mobile bundle` so pre-built bundles get the same Metro
 * resolver hooks as the in-process pool path.
 */
export async function readMetroCustomizerFromConfig(
  projectRoot: string,
  platforms: Platform[],
  configPath?: string,
): Promise<MetroConfigCustomizer | undefined> {
  const all = await readVitestMobilePluginOptions(projectRoot, platforms, configPath);
  const customizers: MetroConfigCustomizer[] = [];
  for (const opts of all) {
    const customize = opts.metro?.customize;
    if (typeof customize === 'function') customizers.push(customize);
  }
  if (customizers.length === 0) return undefined;
  if (customizers.length === 1) return customizers[0];
  return async (cfg, ctx) => {
    let current = cfg;
    for (const fn of customizers) {
      current = await fn(current, ctx);
    }
    return current;
  };
}

/**
 * Deduped union of `metro.babelPlugins` across every matching plugin. Read by
 * `vitest-mobile bundle` so pre-built bundles use the same Babel transform
 * pipeline as the in-process pool path.
 */
export async function readBabelPluginsFromConfig(
  projectRoot: string,
  platforms: Platform[],
  configPath?: string,
): Promise<string[]> {
  const all = await readVitestMobilePluginOptions(projectRoot, platforms, configPath);
  const plugins = new Set<string>();
  for (const opts of all) {
    for (const bp of opts.metro?.babelPlugins ?? []) {
      plugins.add(bp);
    }
  }
  return [...plugins];
}

// ── Test-pattern reader (different shape — reads `project.test.include`,
// not plugin options) ─────────────────────────────────────────────────────────

export async function readTestPatternsFromConfig(
  projectRoot: string,
  platforms: Platform[],
  configPath?: string,
): Promise<string[]> {
  const configFile = resolveVitestConfigFile(projectRoot, configPath);
  if (!configFile) {
    console.warn('No vitest config found — use --include to specify test patterns');
    return [];
  }

  const config = (await loadVitestConfig(configFile, projectRoot)) as {
    test?: { projects?: Array<{ test?: { name?: string; include?: string[] } }> };
  } | null;
  if (!config) {
    console.warn('Could not load vitest config — use --include to specify test patterns');
    return [];
  }

  const projects = config.test?.projects ?? [];
  const patterns = new Set<string>();
  for (const project of projects) {
    const name = project.test?.name;
    if (name && !platforms.includes(name as Platform)) continue;
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
}

// ── --native-modules CLI flag plumbing ───────────────────────────────────────

/**
 * Parse a comma-separated list of native module package names into an array.
 * Used by the CLI commands that feed into `ensureHarnessBinary`.
 */
export function parseNativeModules(input?: string): string[] {
  return input
    ? input
        .split(',')
        .map(m => m.trim())
        .filter(Boolean)
    : [];
}

/**
 * Compute the final native-modules list for a CLI command. An explicit
 * `--native-modules` flag wins; otherwise the value falls back to whatever
 * is declared on the `nativePlugin({ harness: { nativeModules } })` in the
 * vitest config.
 */
export async function resolveNativeModules(
  cliFlag: string | undefined,
  projectRoot: string,
  platforms: Platform[],
  configPath?: string,
): Promise<string[]> {
  const explicit = parseNativeModules(cliFlag);
  if (explicit.length > 0) return explicit;
  return readNativeModulesFromConfig(projectRoot, platforms, configPath);
}
