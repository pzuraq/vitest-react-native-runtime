import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetLoadedConfigCacheForTests,
  parseNativeModules,
  readBabelPluginsFromConfig,
  readMetroCustomizerFromConfig,
  readNativeModulesFromConfig,
  readTestPatternsFromConfig,
  readVitestMobilePluginOptions,
  resolveNativeModules,
  resolveVitestConfigFile,
} from '../../src/cli/config-readers';

// Anchor the per-test scratch directories inside the package's own
// `tests/unit/fixtures/config-readers/` tree so vite's `loadConfigFromFile`
// can resolve a bare `import 'vitest-mobile'` against the workspace's
// node_modules walk-up. (Tmpdir-based fixtures fail because the
// `.timestamp.mjs` file vite writes alongside the config can't see
// vitest-mobile's `node_modules` siblings from `/private/var/folders/...`.)
const FIXTURES_ROOT = resolve(__dirname, 'fixtures', 'config-readers');

let tmp: string;

function writeConfig(name: string, contents: string): string {
  const file = resolve(tmp, name);
  writeFileSync(file, contents, 'utf8');
  return file;
}

beforeEach(() => {
  mkdirSync(FIXTURES_ROOT, { recursive: true });
  tmp = mkdtempSync(resolve(FIXTURES_ROOT, 'case-'));
  _resetLoadedConfigCacheForTests();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  _resetLoadedConfigCacheForTests();
});

describe('parseNativeModules', () => {
  it('returns [] for empty / undefined input', () => {
    expect(parseNativeModules(undefined)).toEqual([]);
    expect(parseNativeModules('')).toEqual([]);
  });

  it('splits, trims, and drops empties', () => {
    expect(parseNativeModules(' react-native-reanimated , react-native-worklets ,, ')).toEqual([
      'react-native-reanimated',
      'react-native-worklets',
    ]);
  });
});

describe('resolveVitestConfigFile', () => {
  it('returns undefined when no config exists', () => {
    expect(resolveVitestConfigFile(tmp)).toBeUndefined();
  });

  it('finds vitest.config.ts in the project root', () => {
    const file = writeConfig('vitest.config.ts', 'export default {};');
    expect(resolveVitestConfigFile(tmp)).toBe(file);
  });

  it('honors an explicit config path argument', () => {
    mkdirSync(resolve(tmp, 'subdir'));
    const file = writeConfig('subdir/custom.config.mjs', 'export default {};');
    expect(resolveVitestConfigFile(tmp, 'subdir/custom.config.mjs')).toBe(file);
  });
});

describe('readMetroCustomizerFromConfig', () => {
  // Regression: see the changeset at .changeset/* — `readMetroCustomizerFromConfig`
  // previously inspected `stored.metro` as if it were the customizer function
  // itself (matching an obsolete shape of the plugin options), but
  // `nativePlugin({ metro })` stashes a `MetroOptions` object on the plugin
  // instance, so the customizer was never picked up and the bundle CLI built
  // user code with only the harness-anchored base resolver.
  it('reads the customizer from `metro.customize` on the plugin options', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

const customize = (cfg) => ({ ...cfg, __marker: 'ios-customize' });

export default {
  test: {
    projects: [
      {
        plugins: [
          nativePlugin({
            platform: 'ios',
            metro: { customize },
          }),
        ],
        test: { name: 'ios' },
      },
    ],
  },
};
      `.trim(),
    );

    const customizer = await readMetroCustomizerFromConfig(tmp, ['ios']);
    expect(customizer).toBeTypeOf('function');
    const out = (await customizer!({ existing: 1 } as never, {
      harnessProjectDir: '',
      projectRoot: '',
      platform: 'ios',
    })) as unknown as { existing: number; __marker: string };
    expect(out.existing).toBe(1);
    expect(out.__marker).toBe('ios-customize');
  });

  it('returns undefined when no plugin declares a customizer', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

export default {
  test: {
    projects: [
      {
        plugins: [nativePlugin({ platform: 'android' })],
        test: { name: 'android' },
      },
    ],
  },
};
      `.trim(),
    );

    expect(await readMetroCustomizerFromConfig(tmp, ['android'])).toBeUndefined();
  });

  it('returns undefined when no config exists', async () => {
    expect(await readMetroCustomizerFromConfig(tmp, ['ios'])).toBeUndefined();
  });

  it('composes customizers from multiple matching plugins left-to-right', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

const first = (cfg) => ({ ...cfg, order: [...(cfg.order ?? []), 'first'] });
const second = (cfg) => ({ ...cfg, order: [...(cfg.order ?? []), 'second'] });

export default {
  test: {
    projects: [
      {
        plugins: [
          nativePlugin({ platform: 'ios', metro: { customize: first } }),
          nativePlugin({ platform: 'ios', metro: { customize: second } }),
        ],
        test: { name: 'ios' },
      },
    ],
  },
};
      `.trim(),
    );

    const customizer = await readMetroCustomizerFromConfig(tmp, ['ios']);
    expect(customizer).toBeTypeOf('function');
    const out = (await customizer!({} as never, {
      harnessProjectDir: '',
      projectRoot: '',
      platform: 'ios',
    })) as unknown as { order: string[] };
    expect(out.order).toEqual(['first', 'second']);
  });

  it('skips projects whose name is not in the platforms filter', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

const iosCustomize = (cfg) => ({ ...cfg, __marker: 'ios' });
const androidCustomize = (cfg) => ({ ...cfg, __marker: 'android' });

export default {
  test: {
    projects: [
      {
        plugins: [nativePlugin({ platform: 'ios', metro: { customize: iosCustomize } })],
        test: { name: 'ios' },
      },
      {
        plugins: [nativePlugin({ platform: 'android', metro: { customize: androidCustomize } })],
        test: { name: 'android' },
      },
    ],
  },
};
      `.trim(),
    );

    const customizer = await readMetroCustomizerFromConfig(tmp, ['android']);
    const out = (await customizer!({} as never, {
      harnessProjectDir: '',
      projectRoot: '',
      platform: 'android',
    })) as unknown as { __marker: string };
    expect(out.__marker).toBe('android');
  });
});

describe('readBabelPluginsFromConfig', () => {
  it('returns the deduped union of `metro.babelPlugins` across matching projects', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

export default {
  test: {
    projects: [
      {
        plugins: [
          nativePlugin({
            platform: 'ios',
            metro: { babelPlugins: ['react-native-reanimated/plugin', 'foo'] },
          }),
        ],
        test: { name: 'ios' },
      },
      {
        plugins: [
          nativePlugin({
            platform: 'android',
            metro: { babelPlugins: ['react-native-reanimated/plugin', 'bar'] },
          }),
        ],
        test: { name: 'android' },
      },
    ],
  },
};
      `.trim(),
    );

    expect(await readBabelPluginsFromConfig(tmp, ['ios', 'android'])).toEqual([
      'react-native-reanimated/plugin',
      'foo',
      'bar',
    ]);
  });

  it('returns [] when no config exists', async () => {
    expect(await readBabelPluginsFromConfig(tmp, ['ios'])).toEqual([]);
  });
});

describe('readVitestMobilePluginOptions', () => {
  it('returns every nativePlugin options object across matching projects', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

export default {
  test: {
    projects: [
      {
        plugins: [
          nativePlugin({ platform: 'ios', harness: { nativeModules: ['ios-mod'] } }),
          nativePlugin({ platform: 'ios', metro: { babelPlugins: ['ios-bp'] } }),
        ],
        test: { name: 'ios' },
      },
      {
        plugins: [nativePlugin({ platform: 'android', harness: { nativeModules: ['android-mod'] } })],
        test: { name: 'android' },
      },
    ],
  },
};
      `.trim(),
    );

    const ios = await readVitestMobilePluginOptions(tmp, ['ios']);
    expect(ios).toHaveLength(2);
    expect(ios[0].harness?.nativeModules).toEqual(['ios-mod']);
    expect(ios[1].metro?.babelPlugins).toEqual(['ios-bp']);

    const both = await readVitestMobilePluginOptions(tmp, ['ios', 'android']);
    expect(both).toHaveLength(3);
  });

  it('returns [] when no config file exists', async () => {
    expect(await readVitestMobilePluginOptions(tmp, ['ios'])).toEqual([]);
  });

  it('skips projects whose name is not in the platforms filter', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

export default {
  test: {
    projects: [
      {
        plugins: [nativePlugin({ platform: 'ios', harness: { nativeModules: ['ios-mod'] } })],
        test: { name: 'ios' },
      },
      {
        plugins: [nativePlugin({ platform: 'android', harness: { nativeModules: ['android-mod'] } })],
        test: { name: 'android' },
      },
    ],
  },
};
      `.trim(),
    );

    const opts = await readVitestMobilePluginOptions(tmp, ['android']);
    expect(opts).toHaveLength(1);
    expect(opts[0].harness?.nativeModules).toEqual(['android-mod']);
  });

  it('ignores plugins that are not nativePlugin instances', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

export default {
  test: {
    projects: [
      {
        plugins: [
          { name: 'some-other-plugin' },
          nativePlugin({ platform: 'ios', harness: { nativeModules: ['only-this-one'] } }),
          null,
          'definitely-not-a-plugin',
        ],
        test: { name: 'ios' },
      },
    ],
  },
};
      `.trim(),
    );

    const opts = await readVitestMobilePluginOptions(tmp, ['ios']);
    expect(opts).toHaveLength(1);
    expect(opts[0].harness?.nativeModules).toEqual(['only-this-one']);
  });

  it('normalizes legacy top-level `nativeModules` into `harness.nativeModules`', async () => {
    // Older vitest-mobile callers passed `{ nativeModules }` at the top
    // level instead of nesting under `harness`. The unified extractor
    // re-homes the legacy field so consumers can stay strictly typed
    // against the current `NativePluginOptions` shape.
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

const plugin = nativePlugin({ platform: 'ios' });
plugin.__vitestMobileOptions.nativeModules = ['legacy-only'];

export default {
  test: {
    projects: [
      { plugins: [plugin], test: { name: 'ios' } },
    ],
  },
};
      `.trim(),
    );

    const opts = await readVitestMobilePluginOptions(tmp, ['ios']);
    expect(opts).toHaveLength(1);
    expect(opts[0].harness?.nativeModules).toEqual(['legacy-only']);
  });
});

describe('readNativeModulesFromConfig + resolveNativeModules', () => {
  it('reads `harness.nativeModules` from matching plugin instances', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

export default {
  test: {
    projects: [
      {
        plugins: [
          nativePlugin({
            platform: 'ios',
            harness: { nativeModules: ['react-native-reanimated', 'react-native-worklets'] },
          }),
        ],
        test: { name: 'ios' },
      },
    ],
  },
};
      `.trim(),
    );

    expect(await readNativeModulesFromConfig(tmp, ['ios'])).toEqual([
      'react-native-reanimated',
      'react-native-worklets',
    ]);
  });

  it('lets an explicit --native-modules flag override the config', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

export default {
  test: {
    projects: [
      {
        plugins: [
          nativePlugin({ platform: 'ios', harness: { nativeModules: ['from-config'] } }),
        ],
        test: { name: 'ios' },
      },
    ],
  },
};
      `.trim(),
    );

    expect(await resolveNativeModules('flag-only', tmp, ['ios'])).toEqual(['flag-only']);
  });

  it('still picks up the legacy top-level `nativeModules` field for backward compat', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

const plugin = nativePlugin({ platform: 'ios' });
plugin.__vitestMobileOptions.nativeModules = ['legacy-only'];

export default {
  test: { projects: [{ plugins: [plugin], test: { name: 'ios' } }] },
};
      `.trim(),
    );

    expect(await readNativeModulesFromConfig(tmp, ['ios'])).toEqual(['legacy-only']);
  });

  it('falls back to config when --native-modules is empty / undefined', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
import { nativePlugin } from 'vitest-mobile';

export default {
  test: {
    projects: [
      {
        plugins: [
          nativePlugin({ platform: 'ios', harness: { nativeModules: ['from-config'] } }),
        ],
        test: { name: 'ios' },
      },
    ],
  },
};
      `.trim(),
    );

    expect(await resolveNativeModules(undefined, tmp, ['ios'])).toEqual(['from-config']);
  });
});

describe('readTestPatternsFromConfig', () => {
  it('reads include patterns from the matching project', async () => {
    writeConfig(
      'vitest.config.mjs',
      `
export default {
  test: {
    projects: [
      { test: { name: 'ios', include: ['ui-modules/**/*.test.tsx'] } },
      { test: { name: 'android', include: ['other/**/*.test.ts'] } },
    ],
  },
};
      `.trim(),
    );

    expect(await readTestPatternsFromConfig(tmp, ['ios'])).toEqual(['ui-modules/**/*.test.tsx']);
  });

  it('returns [] when there are no matching include patterns', async () => {
    writeConfig('vitest.config.mjs', `export default { test: { projects: [] } };`);
    expect(await readTestPatternsFromConfig(tmp, ['ios'])).toEqual([]);
  });
});
