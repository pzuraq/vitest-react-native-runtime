/**
 * Test harness — root component for the test app.
 *
 * The harness always attempts to connect to the Vitest pool's WebSocket.
 * The UI behavior depends on the pool mode:
 *
 *   run (vitest run)  — headless, pool drives everything
 *   dev (vitest dev)  — explorer UI + pool connected, bidirectional results
 *   standalone        — explorer UI only, no pool (when launched manually)
 */

import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { TestContainerProvider, TestContainer } from './context';
import { connectToVitest, onStatusChange } from './setup';
import { TestExplorer } from './explorer/TestExplorer';
import { loadAllTestFiles } from 'vitest-react-native-runtime/test-registry';
import type { HarnessStatus } from './setup';

type PoolMode = 'run' | 'dev' | 'standalone';

interface TestHarnessConfig {
  mode?: PoolMode;
  port?: number;
}

// ── Connected mode status UI ─────────────────────────────────────

function StatusBar({ status }: { status: HarnessStatus }) {
  const bg =
    status.state === 'paused'
      ? '#fbbf24'
      : status.state === 'done' && status.failed === 0
        ? '#4ade80'
        : status.state === 'done' || status.state === 'error'
          ? '#f87171'
          : status.state === 'running'
            ? '#60a5fa'
            : '#94a3b8';

  const showProgress = status.state === 'running' && status.fileCount && status.fileCount > 0;

  return (
    <View style={[styles.statusBar, { backgroundColor: bg }]}>
      <Text style={styles.statusText}>{status.message}</Text>
      {showProgress && (
        <View style={styles.progressBar}>
          <View
            style={[
              styles.progressFill,
              { width: `${((status.fileIndex ?? 0) / status.fileCount!) * 100}%` },
            ]}
          />
        </View>
      )}
      {(status.passed !== undefined || status.failed !== undefined) && status.state !== 'connecting' && (
        <Text style={styles.counters}>
          {status.passed ?? 0} passed{status.failed ? ` · ${status.failed} failed` : ''}
        </Text>
      )}
    </View>
  );
}

function LogList({ logs }: { logs: string[] }) {
  if (!logs.length) return null;
  return (
    <ScrollView style={styles.logList}>
      {logs.map((line, i) => (
        <Text
          key={i}
          style={[styles.logLine, line.startsWith('✗') && styles.logFail]}
        >
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

function HeadlessHarness({ port }: { port: number }) {
  const [status, setStatus] = useState<HarnessStatus>({
    state: 'connecting',
    message: 'Connecting to Vitest...',
  });

  useEffect(() => {
    connectToVitest({ port });
    return onStatusChange(setStatus);
  }, [port]);

  return (
    <View style={styles.container}>
      <StatusBar status={status} />
      <TestContainer />
      <LogList logs={status.logs ?? []} />
    </View>
  );
}

// ── Main entry point ──────────────────────────────────────────────

function resolveMode(config: TestHarnessConfig): PoolMode {
  if (config.mode) return config.mode;
  // Check global injected by test registry (set by pool via Metro)
  const globalMode = (globalThis as any).__VITEST_NATIVE_MODE__;
  if (globalMode === 'run') return 'run';
  if (globalMode === 'dev' || globalMode === 'connected') return 'dev';
  return 'standalone';
}

/**
 * Create the root test harness component.
 */
export function createTestHarness(config: TestHarnessConfig = {}) {
  const mode = resolveMode(config);
  const port = config.port ?? 7878;

  // Preload test file bundles so they're cached by the time the user runs tests
  loadAllTestFiles().catch(() => {});

  // In dev and standalone modes, always try to connect to the pool.
  // This enables the bidirectional flow: even when showing the explorer UI,
  // the pool can send test commands and receive results.
  if (mode === 'dev' || mode === 'standalone') {
    // Attempt connection with a short timeout — if no pool is running,
    // the explorer works standalone without blocking.
    connectToVitest({ port });
  }

  return function TestHarness() {
    if (mode === 'run') {
      // CI/headless: pool drives everything, minimal UI
      return (
        <TestContainerProvider>
          <HeadlessHarness port={port} />
        </TestContainerProvider>
      );
    }

    // Dev + standalone: show explorer UI
    // If pool connects, results flow bidirectionally
    return (
      <TestContainerProvider>
        <TestExplorer />
      </TestContainerProvider>
    );
  };
}

// ── Styles ────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  statusBar: {
    paddingTop: 52,
    paddingBottom: 12,
    paddingHorizontal: 16,
    gap: 6,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  counters: {
    fontSize: 12,
    color: '#1a1a2e',
    opacity: 0.8,
  },
  progressBar: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(0,0,0,0.15)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderRadius: 2,
  },
  logList: {
    flex: 1,
    padding: 12,
  },
  logLine: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#94a3b8',
    marginBottom: 4,
  },
  logFail: {
    color: '#f87171',
  },
});
