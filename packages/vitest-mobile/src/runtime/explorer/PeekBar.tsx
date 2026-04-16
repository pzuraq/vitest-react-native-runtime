import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '@shopify/restyle';
import { Text } from './atoms';
import { statusIcon, statusColor } from './status-utils';
import type { Theme } from './theme';
import type { ModuleStatus } from './types';

interface PeekBarProps {
  running: boolean;
  passed: number;
  failed: number;
  skipped: number;
  completedFiles: number;
  totalFiles: number;
  currentTestPath: string[];
  currentTestName: string | null;
  currentStatus: ModuleStatus;
  onDebug: () => void;
  onRerunAll: () => void;
  onStop: () => void;
}

export function PeekBar({
  running,
  passed,
  failed,
  skipped,
  completedFiles,
  totalFiles,
  currentTestPath,
  currentTestName,
  currentStatus,
  onDebug,
  onRerunAll,
  onStop,
}: PeekBarProps) {
  const { colors } = useTheme<Theme>();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const allDone = !running && completedFiles > 0;
  const filePath = currentTestPath[0] ?? '';
  const moduleCurrent =
    totalFiles > 0 ? (running ? Math.min(completedFiles + 1, totalFiles) : Math.min(completedFiles, totalFiles)) : 0;
  const moduleFraction = `${moduleCurrent}/${totalFiles}`;

  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <Text variant="caption" numberOfLines={1} style={styles.filePath}>
          {filePath}
        </Text>
        <Text style={styles.moduleCounter}>{moduleFraction}</Text>
      </View>

      {currentTestName && running ? (
        <Text variant="body" numberOfLines={1} style={[styles.testName, { color: statusColor(currentStatus, colors) }]}>
          {statusIcon(currentStatus)} {currentTestName}
        </Text>
      ) : allDone ? (
        <Text
          variant="body"
          numberOfLines={1}
          style={[styles.testName, { color: failed > 0 ? colors.fail : colors.pass }]}
        >
          {failed > 0 ? 'Done — tests failed' : 'All tests passed'}
        </Text>
      ) : (
        <Text variant="body" numberOfLines={1} style={[styles.testName, { color: colors.warning }]}>
          ⋯ Waiting...
        </Text>
      )}

      <View style={styles.statsRow}>
        <View style={styles.statValues}>
          <Text style={[styles.statLabel, passed > 0 ? styles.statPassed : styles.statZero]}>{passed} passed</Text>
          <Text style={[styles.statLabel, failed > 0 ? styles.statFailed : styles.statZero]}>{failed} failed</Text>
          <Text style={[styles.statLabel, skipped > 0 ? styles.statSkipped : styles.statZero]}>{skipped} skipped</Text>
        </View>
        <View style={styles.actions}>
          <Text onPress={onDebug} style={styles.debugButton}>
            Debug
          </Text>
          {running ? (
            <Text onPress={onStop} style={styles.stopButton}>
              Stop
            </Text>
          ) : completedFiles > 0 ? (
            <Text onPress={onRerunAll} style={styles.rerunButton}>
              ▶ Rerun
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const createStyles = (colors: Theme['colors']) =>
  StyleSheet.create({
    container: {
      paddingHorizontal: 16,
      paddingBottom: 8,
      paddingTop: 4,
    },
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 2,
    },
    filePath: {
      color: colors.textDim,
      fontSize: 12,
      flex: 1,
      marginRight: 8,
    },
    actions: {
      flexDirection: 'row',
      gap: 12,
      marginLeft: 8,
    },
    debugButton: {
      color: colors.textMuted,
      fontSize: 13,
      fontWeight: '500',
    },
    stopButton: {
      color: colors.fail,
      fontSize: 13,
      fontWeight: '600',
    },
    rerunButton: {
      color: colors.accent,
      fontSize: 13,
      fontWeight: '600',
    },
    testName: {
      fontSize: 14,
      marginBottom: 4,
    },
    statsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    statValues: {
      flexDirection: 'row',
      gap: 10,
    },
    statLabel: {
      fontSize: 11,
      fontWeight: '500',
    },
    statPassed: {
      color: colors.pass,
    },
    statFailed: {
      color: colors.fail,
    },
    statSkipped: {
      color: colors.warning,
    },
    statZero: {
      color: colors.checkboxOff,
    },
    moduleCounter: {
      fontSize: 11,
      color: colors.textMuted,
      fontWeight: '600',
      marginLeft: 8,
    },
  });
