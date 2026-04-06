import { defineConfig } from 'vitest/config';
import { nativePlugin } from 'vitest-react-native-runtime';

export default defineConfig({
  plugins: [
    nativePlugin({
      platform: 'ios',
    }),
  ],
  test: {
    include: ['test-packages/**/tests/**/*.test.tsx'],
  },
});
