import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Plugin, UserConfig } from 'vite';

// pool is a heavy module with side effects — mock it so nativePlugin tests
// stay unit-level and don't spin up WS servers.
vi.mock('../../src/node/pool', () => ({
  createNativePoolWorker: vi.fn(() => ({ name: 'native' })),
}));

import { nativePlugin } from '../../src/node/index';
import { createNativePoolWorker } from '../../src/node/pool';

interface TestConfig extends UserConfig {
  test?: {
    pool?: { createPoolWorker: () => unknown };
    include?: string[];
    maxWorkers?: number;
    minWorkers?: number;
    isolate?: boolean;
    [key: string]: unknown;
  };
}

function applyPlugin(plugin: Plugin): TestConfig {
  const config: TestConfig = {};
  (plugin.config as (c: TestConfig) => TestConfig)(config);
  return config;
}

// ── detectMode (private, tested via nativePlugin behaviour) ───────────────────

describe('detectMode', () => {
  const origArgv = process.argv;
  const origCI = process.env.CI;

  beforeEach(() => {
    process.argv = [...origArgv];
    delete process.env.CI;
    vi.mocked(createNativePoolWorker).mockClear();
  });

  afterEach(() => {
    process.argv = origArgv;
    if (origCI !== undefined) process.env.CI = origCI;
    else delete process.env.CI;
  });

  it('defaults headless to false in dev mode (no CI, no run arg)', () => {
    const plugin = nativePlugin({});
    const config = applyPlugin(plugin);
    config.test!.pool!.createPoolWorker();
    expect(vi.mocked(createNativePoolWorker)).toHaveBeenCalledWith(
      expect.objectContaining({ headless: false, mode: 'dev' }),
    );
  });

  it('defaults headless to true when CI env var is set', () => {
    process.env.CI = '1';
    const plugin = nativePlugin({});
    const config = applyPlugin(plugin);
    config.test!.pool!.createPoolWorker();
    expect(vi.mocked(createNativePoolWorker)).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true, mode: 'run' }),
    );
  });

  it('defaults headless to true when argv contains "run"', () => {
    process.argv = [...origArgv, 'run'];
    const plugin = nativePlugin({});
    const config = applyPlugin(plugin);
    config.test!.pool!.createPoolWorker();
    expect(vi.mocked(createNativePoolWorker)).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true, mode: 'run' }),
    );
  });
});

// ── nativePlugin ──────────────────────────────────────────────────────────────

describe('nativePlugin', () => {
  beforeEach(() => {
    vi.mocked(createNativePoolWorker).mockClear();
    delete process.env.CI;
  });

  it('returns a Vite plugin named vitest-mobile', () => {
    const plugin = nativePlugin();
    expect(plugin.name).toBe('vitest-mobile');
  });

  it('sets test.pool on the config', () => {
    const plugin = nativePlugin();
    const config = applyPlugin(plugin);
    expect(config.test!.pool).toBeDefined();
    expect(typeof config.test!.pool!.createPoolWorker).toBe('function');
  });

  it('sets isolate: false and maxWorkers/minWorkers to 1 so the whole run is one task', () => {
    const plugin = nativePlugin();
    const config = applyPlugin(plugin);
    expect(config.test!.isolate).toBe(false);
    expect(config.test!.maxWorkers).toBe(1);
    expect(config.test!.minWorkers).toBe(1);
  });

  it('does not override test.isolate when the user has already set it', () => {
    const plugin = nativePlugin();
    const config: TestConfig = { test: { isolate: true } };
    (plugin.config as (c: TestConfig) => TestConfig)(config);
    expect(config.test!.isolate).toBe(true);
  });

  it('sets default test.include when none is present', () => {
    const plugin = nativePlugin();
    const config = applyPlugin(plugin);
    const include = config.test!.include as string[];
    expect(include).toContain('**/native-tests/**/*.test.tsx');
    expect(include).toContain('**/native-tests/**/*.test.ts');
  });

  it('does not override test.include when already set', () => {
    const plugin = nativePlugin();
    const config: TestConfig = { test: { include: ['my-tests/**/*.test.ts'] } };
    (plugin.config as (c: TestConfig) => TestConfig)(config);
    const include = config.test!.include as string[];
    expect(include).toEqual(['my-tests/**/*.test.ts']);
  });

  it('applies default options (auto ports, platform android)', () => {
    const plugin = nativePlugin();
    const config = applyPlugin(plugin);
    config.test!.pool!.createPoolWorker();
    expect(vi.mocked(createNativePoolWorker)).toHaveBeenCalledWith(expect.objectContaining({ platform: 'android' }));
    const callArg = vi.mocked(createNativePoolWorker).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(callArg.port).toBeUndefined();
    expect(callArg.metroPort).toBeUndefined();
  });

  it('applies custom options (port, platform, metroPort)', () => {
    const plugin = nativePlugin({ port: 9999, platform: 'ios', metroPort: 9090 });
    const config = applyPlugin(plugin);
    config.test!.pool!.createPoolWorker();
    expect(vi.mocked(createNativePoolWorker)).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9999, platform: 'ios', metroPort: 9090 }),
    );
  });

  it('defaults promptForNewDevice to true', () => {
    const plugin = nativePlugin();
    const config = applyPlugin(plugin);
    config.test!.pool!.createPoolWorker();
    expect(vi.mocked(createNativePoolWorker)).toHaveBeenCalledWith(
      expect.objectContaining({ promptForNewDevice: true }),
    );
  });

  it('defaults skipIfUnavailable to false', () => {
    const plugin = nativePlugin();
    const config = applyPlugin(plugin);
    config.test!.pool!.createPoolWorker();
    expect(vi.mocked(createNativePoolWorker)).toHaveBeenCalledWith(
      expect.objectContaining({ skipIfUnavailable: false }),
    );
  });

  it('passes testInclude from config.test.include to pool options', () => {
    const plugin = nativePlugin();
    const config: TestConfig = { test: { include: ['custom/**/*.test.ts'] } };
    (plugin.config as (c: TestConfig) => TestConfig)(config);
    config.test!.pool!.createPoolWorker();
    expect(vi.mocked(createNativePoolWorker)).toHaveBeenCalledWith(
      expect.objectContaining({ testInclude: ['custom/**/*.test.ts'] }),
    );
  });
});
