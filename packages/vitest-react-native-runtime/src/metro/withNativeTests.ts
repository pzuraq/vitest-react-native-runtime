/**
 * Metro config helper — makes the Expo app test-aware.
 *
 * Usage in metro.config.js:
 *   const { withNativeTests } = require('vitest-react-native-runtime/metro');
 *   module.exports = withNativeTests(getDefaultConfig(__dirname));
 */

import { resolve } from 'node:path';
import { watch } from 'node:fs';
import { generateTestRegistry } from './generateTestRegistry';

export interface NativeTestsOptions {
  /** Glob patterns for test files, relative to the project root. */
  testPatterns?: string[];
}

const DEFAULT_PATTERNS = ['packages/**/tests/**/*.test.{tsx,ts}'];

/**
 * Apply native test configuration to a Metro config.
 *
 * - Discovers test files and generates a virtual registry module
 * - Watches for new/deleted test files and regenerates
 * - Enables package exports with react-native condition
 * - Sets up virtual module resolution (vitest → vitest-shim, test-registry → generated file)
 */
export function withNativeTests(config: any, options: NativeTestsOptions = {}): any {
  const testPatterns = options.testPatterns ?? DEFAULT_PATTERNS;
  const projectRoot: string = config.projectRoot ?? config.resolver?.projectRoot ?? process.cwd();
  const outputDir = resolve(projectRoot, '.vitest-native');

  // ── Generate test registry ─────────────────────────────────────
  // The pool sets VITEST_NATIVE_MODE=connected when running vitest
  const mode = process.env.VITEST_NATIVE_MODE;

  const { filePath: registryPath, testFiles } = generateTestRegistry({
    projectRoot,
    testPatterns,
    outputDir,
    mode,
  });

  console.log(`[withNativeTests] Generated test registry: ${testFiles.length} file(s)`);

  // ── File watcher for new/deleted tests ─────────────────────────
  // Only watch in development (not during production builds)
  if (process.env.NODE_ENV !== 'production') {
    let knownFiles = new Set(testFiles);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      watch(resolve(projectRoot, 'packages'), { recursive: true }, (_eventType, filename) => {
        if (!filename || !filename.match(/\.test\.tsx?$/)) return;

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const result = generateTestRegistry({ projectRoot, testPatterns, outputDir });
          const newFiles = new Set(result.testFiles);

          // Only log if the file set actually changed
          if (newFiles.size !== knownFiles.size || [...newFiles].some(f => !knownFiles.has(f))) {
            console.log(`[withNativeTests] Test files changed: ${result.testFiles.length} file(s)`);
            knownFiles = newFiles;
          }
        }, 300);
      });
    } catch {
      // Watcher setup failed — non-fatal (packages/ dir may not exist yet)
    }
  }

  // ── Package exports ────────────────────────────────────────────
  config.resolver = config.resolver ?? {};
  config.resolver.unstable_enablePackageExports = true;

  const existingConditions: string[] = config.resolver.unstable_conditionNames ?? [];
  const needed = ['react-native', 'import', 'require', 'default'];
  for (const c of needed) {
    if (!existingConditions.includes(c)) existingConditions.push(c);
  }
  config.resolver.unstable_conditionNames = existingConditions;

  // ── Module resolution ──────────────────────────────────────────
  const originalResolver = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context: any, moduleName: string, platform: string | null) => {
    // Redirect vitest-react-native-runtime/test-registry to the generated file
    if (moduleName === 'vitest-react-native-runtime/test-registry') {
      return { type: 'sourceFile', filePath: registryPath };
    }

    // Redirect `import from 'vitest'` to the vitest shim for React Native
    if (moduleName === 'vitest') {
      return context.resolveRequest(context, 'vitest-react-native-runtime/vitest-shim', platform);
    }

    if (originalResolver) {
      return originalResolver(context, moduleName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
  };

  return config;
}
