import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SafeAreaView, ScrollView, TouchableOpacity, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Box, Text } from './atoms';
import { runTests, type TestResult } from '../standalone-runner';
import { resume, isPaused } from '../pause';
import { onStatusChange } from '../state';
import { TestContainer } from '../context';
import type { TestModule, ModuleStatus } from './types';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ── Types ─────────────────────────────────────────────────────────

interface FileRunState {
  status: ModuleStatus;
  results: TestResult[];
  duration?: number;
}

// ── Helpers ───────────────────────────────────────────────────────

function fileBasename(path: string): string {
  return path.split('/').pop()?.replace(/\.test\.tsx?$/, '') ?? path;
}

function statusIcon(status: ModuleStatus): string {
  switch (status) {
    case 'pass': return '✓';
    case 'fail': return '✗';
    case 'running': return '⋯';
    case 'pending': return '○';
    default: return ' ';
  }
}

function statusColor(status: ModuleStatus): string {
  switch (status) {
    case 'pass': return '#4ade80';
    case 'fail': return '#f87171';
    case 'running': return '#fbbf24';
    default: return '#64748b';
  }
}

// ── Components ────────────────────────────────────────────────────

function FileResultRow({ file, state }: { file: string; state: FileRunState }) {
  return (
    <Box
      paddingVertical="s"
      paddingHorizontal="l"
      borderBottomWidth={0.5}
      borderBottomColor="border"
    >
      <Box flexDirection="row" alignItems="center" gap="s">
        <Text variant="badge" style={{ color: statusColor(state.status), width: 18, textAlign: 'center' }}>
          {statusIcon(state.status)}
        </Text>
        <Text variant="body" style={{ flex: 1 }}>{fileBasename(file)}</Text>
        {state.duration != null && (
          <Text variant="caption">{state.duration}ms</Text>
        )}
      </Box>
      {/* Individual test results */}
      {state.results.length > 0 && (
        <Box marginLeft="xl" marginTop="xs">
          {state.results.map(r => (
            <Box key={r.id} flexDirection="row" alignItems="center" gap="xs" paddingVertical="xs">
              <Text style={{ fontSize: 11, color: r.state === 'pass' ? '#4ade80' : r.state === 'fail' ? '#f87171' : '#64748b', width: 14, textAlign: 'center' }}>
                {r.state === 'pass' ? '✓' : r.state === 'fail' ? '✗' : '○'}
              </Text>
              <Text variant="mono" numberOfLines={1} style={{ flex: 1 }}>{r.name}</Text>
              {r.duration != null && (
                <Text style={{ fontSize: 10, color: '#64748b' }}>{r.duration}ms</Text>
              )}
            </Box>
          ))}
          {/* Error details */}
          {state.results.filter(r => r.error).map(r => (
            <Box key={`err-${r.id}`} backgroundColor="surface" padding="s" borderRadius="s" marginTop="xs">
              <Text variant="mono" color="fail" style={{ fontSize: 11 }}>{r.error}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

// ── Screen ────────────────────────────────────────────────────────

interface Props {
  modules: TestModule[];
  onBack: () => void;
}

export function TestRunnerScreen({ modules, onBack }: Props) {
  const [resultsExpanded, setResultsExpanded] = useState(true);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pauseLabel, setPauseLabel] = useState<string | undefined>();
  const [passed, setPassed] = useState(0);
  const [failed, setFailed] = useState(0);
  const [fileStates, setFileStates] = useState<Map<string, FileRunState>>(new Map());
  const abortRef = useRef<AbortController | null>(null);

  // All files across selected modules
  const allFiles = modules.flatMap(m => m.files);
  const totalFiles = allFiles.length;

  // Listen for pause state
  useEffect(() => {
    return onStatusChange(status => {
      setPaused(status.state === 'paused');
      setPauseLabel(status.label);
    });
  }, []);

  // Run tests on mount
  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;

    // Initialize all files as pending
    const initial = new Map<string, FileRunState>();
    for (const f of allFiles) {
      initial.set(f, { status: 'pending', results: [] });
    }
    setFileStates(initial);
    setPassed(0);
    setFailed(0);
    setRunning(true);

    let currentFile = '';

    runTests({
      files: allFiles,
      signal: ac.signal,
      onTestStart(file) {
        currentFile = file;
        setFileStates(prev => {
          const next = new Map(prev);
          next.set(file, { status: 'running', results: [] });
          return next;
        });
      },
      onTestDone(result) {
        if (result.state === 'pass') setPassed(p => p + 1);
        if (result.state === 'fail') setFailed(f => f + 1);
        setFileStates(prev => {
          const next = new Map(prev);
          const existing = next.get(currentFile);
          if (existing) {
            next.set(currentFile, {
              ...existing,
              results: [...existing.results, result],
            });
          }
          return next;
        });
      },
      onFileDone(file, results) {
        const startTime = fileStates.get(file);
        const hasFail = results.some(r => r.state === 'fail');
        const totalDuration = results.reduce((sum, r) => sum + (r.duration ?? 0), 0);
        setFileStates(prev => {
          const next = new Map(prev);
          next.set(file, {
            status: hasFail ? 'fail' : 'pass',
            results,
            duration: totalDuration,
          });
          return next;
        });
      },
    }).finally(() => {
      setRunning(false);
      abortRef.current = null;
    });

    return () => {
      ac.abort();
    };
  }, []); // Run once on mount

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleBack = useCallback(() => {
    abortRef.current?.abort();
    onBack();
  }, [onBack]);

  const toggleResults = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setResultsExpanded(e => !e);
  }, []);

  const completedFiles = Array.from(fileStates.values()).filter(s => s.status === 'pass' || s.status === 'fail').length;

  return (
    <Box flex={1} backgroundColor="bg">
      {/* Header */}
      <SafeAreaView style={{ backgroundColor: '#1e293b' }}>
        <Box
          flexDirection="row"
          alignItems="center"
          justifyContent="space-between"
          paddingHorizontal="l"
          paddingVertical="m"
          backgroundColor="surface"
          borderBottomWidth={1}
          borderBottomColor="border"
        >
          <TouchableOpacity onPress={handleBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text variant="subheading" color="accent">← Back</Text>
          </TouchableOpacity>
          {running && (
            <TouchableOpacity
              onPress={handleStop}
              style={{ backgroundColor: '#f87171', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6 }}
            >
              <Text variant="button">Stop</Text>
            </TouchableOpacity>
          )}
        </Box>
      </SafeAreaView>

      {/* Test container — user components render here */}
      <ScrollView style={{ flex: 1, backgroundColor: '#ffffff' }} contentContainerStyle={{ flexGrow: 1 }}>
        <TestContainer />
      </ScrollView>

      {/* Results panel at the bottom */}
      <Box backgroundColor="surface" borderTopWidth={1} borderTopColor="border">
          {/* Panel header — always visible */}
          <TouchableOpacity onPress={toggleResults}>
            <Box
              flexDirection="row"
              alignItems="center"
              justifyContent="space-between"
              paddingHorizontal="l"
              paddingVertical="m"
            >
              <Box flexDirection="row" alignItems="center" gap="s">
                <Text variant="caption">{resultsExpanded ? '▼' : '▲'}</Text>
                <Text variant="subheading">Results</Text>
              </Box>
              <Text variant="caption">
                {completedFiles}/{totalFiles} files · {passed} passed{failed > 0 ? ` · ${failed} failed` : ''}
              </Text>
            </Box>
          </TouchableOpacity>

          {/* Expanded results list */}
          {resultsExpanded && (
            <ScrollView style={{ maxHeight: 220 }}>
              {allFiles.map(file => {
                const state = fileStates.get(file) ?? { status: 'idle' as const, results: [] };
                return <FileResultRow key={file} file={file} state={state} />;
              })}
            </ScrollView>
          )}

          {/* Pause/Continue bar */}
          {paused && (
            <Box
              flexDirection="row"
              alignItems="center"
              justifyContent="space-between"
              paddingHorizontal="l"
              paddingVertical="m"
              backgroundColor="warning"
            >
              <Text variant="body" style={{ color: '#1a1a2e' }}>
                {pauseLabel ? `Paused: ${pauseLabel}` : 'Paused'}
              </Text>
              <TouchableOpacity
                onPress={() => resume()}
                style={{ backgroundColor: '#1a1a2e', paddingHorizontal: 16, paddingVertical: 6, borderRadius: 6 }}
              >
                <Text variant="button" style={{ color: '#fbbf24' }}>Continue</Text>
              </TouchableOpacity>
            </Box>
          )}
      </Box>

      {/* Safe area so nothing hides behind home indicator */}
      <SafeAreaView style={{ backgroundColor: '#1e293b' }} />
    </Box>
  );
}
