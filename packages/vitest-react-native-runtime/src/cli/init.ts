/**
 * vitest-react-native-runtime init — scaffold a test harness from a standard Expo app.
 *
 * Uses `create-expo-app` for the base, then layers on vitest config,
 * metro resolver, workspaces, and an example test package.
 *
 * Usage: npx vitest-react-native-runtime init [directory]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { execSync } from 'node:child_process';

const dest: string = process.argv[2] || 'test-app';
const destDir: string = resolve(process.cwd(), dest);
const appName: string = basename(destDir);

if (existsSync(destDir)) {
  console.error(`Error: ${dest} already exists. Remove it first or choose a different name.`);
  process.exit(1);
}

// ── Step 1: Create the Expo app ────────────────────────────────────

console.log(`\n📱 Creating Expo app "${appName}"...\n`);
try {
  execSync(`npx create-expo-app@latest ${dest} --template blank --yes`, {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
} catch {
  console.error('\nFailed to create Expo app. Is npx available?');
  process.exit(1);
}

// ── Step 2: Install additional dependencies ────────────────────────

console.log(`\n📦 Installing dependencies...\n`);

// Detect if vitest-react-native-runtime is available as a local workspace package.
// If so, skip installing it from npm — the monorepo root will link it.
function isLocalWorkspace(): boolean {
  try {
    const rootPkgPath = resolve(process.cwd(), 'package.json');
    if (!existsSync(rootPkgPath)) return false;
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
    const workspaces: string[] = rootPkg.workspaces ?? [];
    // Check if any workspace pattern could contain vitest-react-native-runtime
    return workspaces.some((w: string) => w.includes('packages'));
  } catch {
    return false;
  }
}
const isLocal = isLocalWorkspace();

try {
  // Use `npx expo install` for Expo-ecosystem packages — it resolves SDK-compatible versions.
  // Use `npm install` for non-Expo packages.
  execSync(
    'npx expo install expo-dev-client expo-build-properties',
    { cwd: destDir, stdio: 'inherit' },
  );

  if (isLocal) {
    // In a monorepo with the package as a workspace — just install the other deps.
    // The root package.json workspaces will link vitest-react-native-runtime.
    console.log('  (vitest-react-native-runtime detected as local workspace — skipping npm install for it)');
    execSync(
      'npm install @vitest/runner @vitest/expect @vitest/utils chai birpc flatted',
      { cwd: destDir, stdio: 'inherit' },
    );
  } else {
    execSync(
      'npm install vitest-react-native-runtime @vitest/runner @vitest/expect @vitest/utils chai birpc flatted',
      { cwd: destDir, stdio: 'inherit' },
    );
  }
  execSync(
    'npm install -D vitest',
    { cwd: destDir, stdio: 'inherit' },
  );
} catch {
  console.error('\nFailed to install dependencies.');
  process.exit(1);
}

// ── Step 3: Patch package.json ─────────────────────────────────────

console.log('\n⚙️  Configuring package.json...');
const pkgPath = resolve(destDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

// Patch app.json — set a consistent bundle ID and scheme
const appJsonPath = resolve(destDir, 'app.json');
const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'));
const expo = appJson.expo ?? appJson;
expo.scheme = expo.scheme ?? appName;
if (!expo.ios) expo.ios = {};
if (!expo.android) expo.android = {};
expo.ios.bundleIdentifier = 'com.vitest.nativetest';
expo.android.package = 'com.vitest.nativetest';
expo.newArchEnabled = true;
if (!expo.plugins) expo.plugins = [];
if (!expo.plugins.some((p: any) => (Array.isArray(p) ? p[0] : p) === 'expo-build-properties')) {
  expo.plugins.push(['expo-build-properties', { ios: { deploymentTarget: '16.0' } }]);
}
writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n');

// Switch entry point from expo-router to our harness
pkg.main = 'index.ts';
// Don't add workspaces here — if this app is inside a monorepo, the
// ROOT package.json should list app/packages/* as workspaces. Adding
// workspaces here makes Metro think this IS the workspace root and
// breaks monorepo auto-detection.
delete pkg.workspaces;
pkg.scripts = {
  ...pkg.scripts,
  start: 'expo start --dev-client',
  test: 'vitest run',
  'test:dev': 'vitest dev',
};
// Ensure vitest-react-native-runtime is listed as a dependency.
// In monorepo mode the root workspace links it; for standalone installs
// the npm install step above already added it.
if (!pkg.dependencies?.['vitest-react-native-runtime']) {
  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dependencies['vitest-react-native-runtime'] = '*';
}
if (!pkg.devDependencies?.vitest) {
  pkg.devDependencies = pkg.devDependencies ?? {};
  pkg.devDependencies.vitest = '^4.0.0';
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// ── Step 4: Replace app entry with test harness ───────────────────

writeFileSync(
  resolve(destDir, 'App.tsx'),
  `import { createTestHarness } from 'vitest-react-native-runtime/runtime';

export default createTestHarness();
`,
);

writeFileSync(
  resolve(destDir, 'index.ts'),
  `import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
`,
);

// ── Step 5: Patch metro.config.js ──────────────────────────────────

console.log('⚙️  Configuring Metro...');
writeFileSync(
  resolve(destDir, 'metro.config.js'),
  `const { getDefaultConfig } = require('expo/metro-config');
const { withNativeTests } = require('vitest-react-native-runtime/metro');

module.exports = withNativeTests(getDefaultConfig(__dirname), {
  testInclude: ['packages/**/tests/**/*.test.tsx'],
});
`,
);

// ── Step 6: Add vitest config ──────────────────────────────────────

console.log('⚙️  Adding vitest config...');
writeFileSync(
  resolve(destDir, 'vitest.config.ts'),
  `import { defineConfig } from 'vitest/config';
import { nativePlugin } from 'vitest-react-native-runtime';

export default defineConfig({
  plugins: [
    nativePlugin({
      platform: 'ios', // change to 'android' for Android
      // bundleId is auto-detected from app.json
    }),
  ],
  test: {
    include: ['packages/**/tests/**/*.test.tsx'],
  },
});
`,
);

// ── Step 7: Create example package ─────────────────────────────────

console.log('⚙️  Creating example package...');
const exDir = resolve(destDir, 'packages', 'example');
mkdirSync(resolve(exDir, 'tests'), { recursive: true });

writeFileSync(
  resolve(exDir, 'package.json'),
  JSON.stringify(
    { name: 'example', version: '0.0.0', private: true },
    null,
    2,
  ) + '\n',
);

writeFileSync(
  resolve(exDir, 'Greeting.tsx'),
  `import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface GreetingProps {
  name: string;
}

export function Greeting({ name }: GreetingProps) {
  return (
    <View testID="greeting" style={styles.container}>
      <Text testID="greeting-text" style={styles.text}>
        Hello, {name}!
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 24,
    alignItems: 'center',
  },
  text: {
    fontSize: 24,
    fontWeight: '600',
    color: '#1e293b',
  },
});
`,
);

writeFileSync(
  resolve(exDir, 'tests', 'greeting.test.tsx'),
  `/// <reference types="vitest-react-native-runtime" />
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screenshot } from 'vitest-react-native-runtime/runtime';
import { Greeting } from '../Greeting';

afterEach(async () => {
  await cleanup();
});

describe('Greeting', () => {
  it('renders a greeting', async () => {
    const screen = render(<Greeting name="World" />);
    await screen.findByTestId('greeting');

    expect(screen.getByTestId('greeting-text')).toHaveText('Hello, World!');

    const shot = await screenshot('greeting');
    console.log('Screenshot:', shot);
  });
});
`,
);

// ── Step 8: Add .gitignore entries ─────────────────────────────────

const gitignorePath = resolve(destDir, '.gitignore');
if (existsSync(gitignorePath)) {
  const existing = readFileSync(gitignorePath, 'utf8');
  if (!existing.includes('.vitest-native')) {
    writeFileSync(gitignorePath, existing + '\n# vitest-react-native-runtime\n.vitest-native/\n');
  }
} else {
  writeFileSync(gitignorePath, `node_modules/
ios/
android/
.expo/
.vitest-native/
`);
}

// ── Done ───────────────────────────────────────────────────────────

console.log(`
✅ Done! Your test harness is ready.

  cd ${dest}

  # Boot a simulator and build the app
  npx vitest-react-native-runtime bootstrap ios
  # or: npx vitest-react-native-runtime bootstrap android

  # Run tests
  npm test

  # Dev mode (watch + pause/resume)
  npm run test:dev

Create new test packages in packages/:

  packages/
    my-component/
      package.json        { "name": "my-component", "private": true }
      MyComponent.tsx
      tests/
        my-component.test.tsx
`);
