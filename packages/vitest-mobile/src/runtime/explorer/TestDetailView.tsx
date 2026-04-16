import React, { useMemo } from 'react';
import { ScrollView, TouchableOpacity, StyleSheet, View } from 'react-native';
import { useTheme } from '@shopify/restyle';
import { Text } from './atoms';
import { MiniTree } from './TestTree';
import { countByStatus, collectConsoleLogs } from './tree-utils';
import { statusIcon, statusColor } from './status-utils';
import type { Theme } from './theme';
import type { TestTreeNode, ConsoleLogEntry } from './types';

function logColor(level: ConsoleLogEntry['level'], colors: Theme['colors']): string {
  switch (level) {
    case 'error':
      return colors.fail;
    case 'warn':
      return colors.warning;
    default:
      return colors.textMuted;
  }
}

interface TestDetailViewProps {
  node: TestTreeNode;
  breadcrumb: string[];
  running: boolean;
  onBack: () => void;
  onRerun: () => void;
  onStop: () => void;
  onDrillDown: (child: TestTreeNode) => void;
}

export function TestDetailView({
  node,
  breadcrumb,
  running,
  onBack,
  onRerun,
  onStop,
  onDrillDown,
}: TestDetailViewProps) {
  const { colors } = useTheme<Theme>();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const isGroup = node.type !== 'test';
  const counts = isGroup ? countByStatus(node) : null;
  const isRunning = running || node.status === 'running';

  const allConsoleLogs = isGroup
    ? collectConsoleLogs(node)
    : node.consoleLogs?.length
      ? [{ testName: node.label, logs: node.consoleLogs }]
      : [];

  const failedChildren = isGroup
    ? node.children.filter(c => c.status === 'fail' || (c.type !== 'test' && hasFailedDescendant(c)))
    : [];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.backButton}>← Tests</Text>
        </TouchableOpacity>
        {isRunning ? (
          <TouchableOpacity onPress={onStop} style={styles.stopButton}>
            <Text style={styles.stopText}>■ Stop</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={onRerun} style={styles.rerunButton}>
            <Text style={styles.rerunText}>↻ {isGroup ? 'Rerun All' : 'Rerun'}</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView style={styles.scrollContent} contentContainerStyle={styles.scrollContentInner}>
        <View style={styles.identity}>
          <View style={styles.identityRow}>
            <Text style={[styles.identityIcon, { color: statusColor(node.status, colors) }]}>
              {statusIcon(node.status)}
            </Text>
            <Text style={styles.identityName} numberOfLines={2}>
              {node.label}
            </Text>
          </View>
          {breadcrumb.length > 0 && <Text style={styles.breadcrumb}>{breadcrumb.join(' > ')}</Text>}
          <View style={styles.identityMeta}>
            {isRunning ? (
              <Text style={styles.metaRunning}>Running...</Text>
            ) : node.duration != null && node.duration > 0 ? (
              <Text style={styles.metaDuration}>{Math.round(node.duration)}ms</Text>
            ) : null}
          </View>
          {counts && (
            <Text style={styles.countsText}>
              {counts.passed} passed · {counts.failed} failed
              {counts.pending > 0 ? ` · ${counts.pending} pending` : ''}
            </Text>
          )}
        </View>

        {isGroup && node.children.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Tests</Text>
            <MiniTree nodes={node.children} onSelectNode={onDrillDown} />
          </View>
        )}

        {!isGroup && node.error && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Error</Text>
            <View style={styles.errorBlock}>
              <Text style={styles.errorText}>{node.error}</Text>
            </View>
          </View>
        )}

        {isGroup && failedChildren.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Errors ({failedChildren.length})</Text>
            {failedChildren.map(child => (
              <TouchableOpacity key={child.id} onPress={() => onDrillDown(child)} style={styles.errorBlock}>
                <Text style={styles.errorChildName}>✗ {child.label}</Text>
                {child.error && <Text style={styles.errorText}>{child.error}</Text>}
                {child.type !== 'test' && <Text style={styles.errorDrillHint}>Tap to see details →</Text>}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {allConsoleLogs.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              Console{isRunning ? ' (live)' : ` (${allConsoleLogs.reduce((n, g) => n + g.logs.length, 0)} entries)`}
            </Text>
            <View style={styles.consoleBlock}>
              {allConsoleLogs.map((group, gi) => (
                <View key={gi}>
                  {isGroup && <Text style={styles.consoleGroupName}>{group.testName}:</Text>}
                  {group.logs.map((entry, li) => (
                    <Text
                      key={li}
                      style={[
                        styles.consoleEntry,
                        { color: logColor(entry.level, colors) },
                        isGroup && styles.consoleEntryIndented,
                      ]}
                    >
                      [{entry.level}] {entry.message}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function hasFailedDescendant(node: TestTreeNode): boolean {
  if (node.status === 'fail') return true;
  return node.children.some(c => hasFailedDescendant(c));
}

const createStyles = (colors: Theme['colors']) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    backButton: {
      color: colors.accent,
      fontSize: 15,
      fontWeight: '600',
    },
    rerunButton: {
      backgroundColor: colors.surfaceActive,
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: 6,
    },
    rerunText: {
      color: colors.accent,
      fontSize: 13,
      fontWeight: '600',
    },
    stopButton: {
      backgroundColor: colors.fail,
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: 6,
    },
    stopText: {
      color: colors.white,
      fontSize: 13,
      fontWeight: '600',
    },
    scrollContent: {
      flex: 1,
    },
    scrollContentInner: {
      paddingBottom: 16,
    },
    identity: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    identityRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
    },
    identityIcon: {
      fontSize: 18,
      fontWeight: '700',
      marginTop: 1,
    },
    identityName: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
      flex: 1,
    },
    breadcrumb: {
      fontSize: 12,
      color: colors.textDim,
      marginTop: 4,
    },
    identityMeta: {
      marginTop: 4,
    },
    metaRunning: {
      fontSize: 12,
      color: colors.warning,
    },
    metaDuration: {
      fontSize: 12,
      color: colors.textDim,
    },
    countsText: {
      fontSize: 12,
      color: colors.textMuted,
      marginTop: 4,
    },
    section: {
      paddingHorizontal: 16,
      paddingTop: 16,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textMuted,
      marginBottom: 8,
    },
    errorBlock: {
      backgroundColor: 'rgba(248,113,113,0.1)',
      borderRadius: 8,
      padding: 12,
      marginBottom: 8,
    },
    errorChildName: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.fail,
      marginBottom: 4,
    },
    errorText: {
      fontSize: 12,
      fontFamily: 'monospace',
      color: colors.fail,
    },
    errorDrillHint: {
      fontSize: 11,
      color: colors.textDim,
      marginTop: 4,
    },
    consoleBlock: {
      backgroundColor: colors.bg,
      borderRadius: 8,
      padding: 12,
    },
    consoleGroupName: {
      fontSize: 11,
      color: colors.textDim,
      fontWeight: '600',
      marginTop: 4,
      marginBottom: 2,
    },
    consoleEntry: {
      fontSize: 11,
      fontFamily: 'monospace',
      marginBottom: 2,
    },
    consoleEntryIndented: {
      paddingLeft: 8,
    },
  });
