import React, { useMemo } from 'react';
import { TouchableOpacity, StyleSheet, View, TextInput } from 'react-native';
import { useTheme } from '@shopify/restyle';
import { Text } from './atoms';
import type { Theme } from './theme';
import type { StatusFilter } from './types';

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'failed', label: 'Failed' },
  { key: 'passed', label: 'Passed' },
  { key: 'skipped', label: 'Skipped' },
];

interface FilterPillsProps {
  active: StatusFilter;
  onChange: (filter: StatusFilter) => void;
}

export function FilterPills({ active, onChange }: FilterPillsProps) {
  const { colors } = useTheme<Theme>();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.row}>
      {FILTERS.map(f => (
        <TouchableOpacity
          key={f.key}
          onPress={() => onChange(f.key)}
          style={[styles.pill, active === f.key && styles.pillActive]}
        >
          <Text variant="caption" style={[styles.pillText, active === f.key && styles.pillTextActive]}>
            {f.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
}

export function SearchBar({ value, onChangeText }: SearchBarProps) {
  const { colors } = useTheme<Theme>();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.searchContainer}>
      <TextInput
        style={styles.searchInput}
        placeholder="Filter tests..."
        placeholderTextColor={colors.textDim}
        value={value}
        onChangeText={onChangeText}
        autoCorrect={false}
        autoCapitalize="none"
      />
    </View>
  );
}

const createStyles = (colors: Theme['colors']) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      paddingHorizontal: 16,
      paddingVertical: 8,
      gap: 8,
    },
    pill: {
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: 12,
      backgroundColor: colors.surfaceActive,
    },
    pillActive: {
      backgroundColor: colors.accent,
    },
    pillText: {
      fontSize: 12,
      color: colors.textMuted,
    },
    pillTextActive: {
      color: colors.white,
    },
    searchContainer: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
    },
    searchInput: {
      backgroundColor: colors.bg,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      color: colors.text,
      fontSize: 13,
      borderWidth: 1,
      borderColor: colors.border,
    },
  });
