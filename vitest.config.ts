import { defineConfig } from 'vitest/config';
import { nativePlugin } from 'vitest-mobile';

const isRunMode = process.argv.includes('run') || !!process.env.CI;

const useBundle = isRunMode;

export default defineConfig({
  test: {
    teardownTimeout: 500,
    projects: [
      {
        plugins: [nativePlugin({ platform: 'ios', bundle: useBundle })],
        test: {
          name: 'ios',
          include: ['test-packages/**/tests/**/*.test.tsx'],
        },
      },
      {
        plugins: [nativePlugin({ platform: 'android', bundle: useBundle })],
        test: {
          name: 'android',
          include: ['test-packages/**/tests/**/*.test.tsx'],
        },
      },
    ],
  },
});
