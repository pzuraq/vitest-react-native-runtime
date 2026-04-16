/**
 * Test harness — root component for the test app.
 *
 * Always shows the explorer UI with a bottom sheet overlay on top of
 * the test container. Connects to the Vitest pool over WebSocket.
 * If the pool is not running, the explorer shows "Vitest not connected".
 */

import React from 'react';
import { LogBox } from 'react-native';
import './polyfills';

LogBox.ignoreLogs(['[vitest-mobile]', '[runner]', 'Require cycle']);
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TestContainerProvider } from './context';
import { connectToVitest } from './setup';
import { TestExplorer } from './explorer/TestExplorer';
import { loadAllTestFiles } from 'vitest-mobile/test-registry';
import { configureRuntimeNetwork } from './network-config';

interface TestHarnessConfig {
  port?: number;
  host?: string;
  metroPort?: number;
  metroHost?: string;
  /** UI color scheme. Defaults to 'dark'. */
  theme?: 'light' | 'dark';
}

export function createTestHarness(config: TestHarnessConfig = {}) {
  const host = config.host ?? '127.0.0.1';
  const port = config.port ?? 7878;
  const metroHost = config.metroHost ?? '127.0.0.1';
  const metroPort = config.metroPort ?? 8081;
  const themeMode = config.theme ?? 'dark';

  configureRuntimeNetwork({
    wsHost: host,
    wsPort: port,
    metroHost,
    metroPort,
  });

  loadAllTestFiles().catch(() => {});
  connectToVitest({ port, host });

  return function TestHarness() {
    return (
      <SafeAreaProvider>
        <TestContainerProvider>
          <TestExplorer themeMode={themeMode} />
        </TestContainerProvider>
      </SafeAreaProvider>
    );
  };
}
