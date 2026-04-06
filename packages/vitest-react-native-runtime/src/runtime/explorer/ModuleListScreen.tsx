import React, { useCallback, useMemo, useState } from 'react';
import { SafeAreaView, ScrollView, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { testFileKeys } from 'vitest-react-native-runtime/test-registry';
import { Box, Text } from './atoms';
import type { TestModule } from './types';

function groupByModule(keys: string[]): TestModule[] {
  const map = new Map<string, string[]>();
  for (const key of keys) {
    const match = key.match(/^([^/]+)\//);
    const name = match?.[1] ?? key;
    if (!map.has(name)) map.set(name, []);
    map.get(name)!.push(key);
  }
  return Array.from(map.entries())
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Components ────────────────────────────────────────────────────

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <Box
      width={22}
      height={22}
      borderRadius="s"
      borderWidth={2}
      borderColor={checked ? 'checkboxOn' : 'checkboxOff'}
      backgroundColor={checked ? 'checkboxOn' : 'transparent'}
      alignItems="center"
      justifyContent="center"
    >
      {checked && <Text variant="badge" color="white" style={{ fontSize: 13 }}>✓</Text>}
    </Box>
  );
}

function ModuleRow({
  module,
  selected,
  modified,
  onToggle,
  onPress,
}: {
  module: TestModule;
  selected: boolean;
  modified: boolean;
  onToggle: () => void;
  onPress: () => void;
}) {
  const fileCount = module.files.length;
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      paddingVertical="m"
      paddingHorizontal="l"
      borderBottomWidth={StyleSheet.hairlineWidth}
      borderBottomColor="border"
    >
      <TouchableOpacity onPress={onToggle} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Checkbox checked={selected} />
      </TouchableOpacity>
      <TouchableOpacity onPress={onPress} style={{ flex: 1, marginLeft: 12 }}>
        <Box flexDirection="row" alignItems="center" gap="s">
          <Text variant="body" style={{ fontWeight: '500' }}>{module.name}</Text>
          <Text variant="caption">
            {fileCount} {fileCount === 1 ? 'file' : 'files'}
          </Text>
          {modified && (
            <Text variant="caption" color="warning" style={{ fontWeight: '600' }}>modified</Text>
          )}
        </Box>
      </TouchableOpacity>
    </Box>
  );
}

// ── Screen ────────────────────────────────────────────────────────

interface Props {
  onRunModules: (modules: TestModule[]) => void;
  modifiedModules?: Set<string>;
}

export function ModuleListScreen({ onRunModules, modifiedModules }: Props) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const modules = useMemo(() => {
    return groupByModule(testFileKeys);
  }, []);

  const filteredModules = useMemo(() => {
    if (!filter) return modules;
    const lower = filter.toLowerCase();
    return modules.filter(m => m.name.toLowerCase().includes(lower));
  }, [modules, filter]);

  const toggleModule = useCallback((name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(filteredModules.map(m => m.name)));
  }, [filteredModules]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
  }, []);

  const runSelected = useCallback(() => {
    const toRun = modules.filter(m => selected.has(m.name));
    if (toRun.length > 0) onRunModules(toRun);
  }, [modules, selected, onRunModules]);

  const runSingle = useCallback((mod: TestModule) => {
    onRunModules([mod]);
  }, [onRunModules]);

  const selectedCount = selected.size;

  return (
    <Box flex={1} backgroundColor="bg">
      <SafeAreaView style={{ backgroundColor: '#1e293b' }}>
        {/* Header */}
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
          <Text variant="heading">Test Explorer</Text>
          <TouchableOpacity
            onPress={runSelected}
            disabled={selectedCount === 0}
            style={{
              backgroundColor: selectedCount > 0 ? '#60a5fa' : '#334155',
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderRadius: 8,
            }}
          >
            <Text variant="button" style={{ opacity: selectedCount > 0 ? 1 : 0.5 }}>
              Run{selectedCount > 0 ? ` (${selectedCount})` : ''}
            </Text>
          </TouchableOpacity>
        </Box>
      </SafeAreaView>

      {/* Filter */}
      <Box paddingHorizontal="l" paddingVertical="s" backgroundColor="surface">
        <TextInput
          style={{
            backgroundColor: '#0f172a',
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 8,
            color: '#e2e8f0',
            fontSize: 14,
            borderWidth: 1,
            borderColor: '#334155',
          }}
          placeholder="Filter modules..."
          placeholderTextColor="#64748b"
          value={filter}
          onChangeText={setFilter}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </Box>

      {/* Module list */}
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
        {filteredModules.map(mod => (
          <ModuleRow
            key={mod.name}
            module={mod}
            selected={selected.has(mod.name)}
            modified={modifiedModules?.has(mod.name) ?? false}
            onToggle={() => toggleModule(mod.name)}
            onPress={() => runSingle(mod)}
          />
        ))}
        {filteredModules.length === 0 && (
          <Box padding="xl" alignItems="center">
            <Text variant="caption">
              {modules.length === 0 ? 'No test files found' : 'No matches'}
            </Text>
          </Box>
        )}
      </ScrollView>

      {/* Bottom toolbar */}
      <Box
        flexDirection="row"
        justifyContent="center"
        gap="l"
        paddingVertical="m"
        backgroundColor="surface"
        borderTopWidth={1}
        borderTopColor="border"
      >
        <TouchableOpacity onPress={selectAll}>
          <Text variant="caption" color="accent">Select All</Text>
        </TouchableOpacity>
        <Text variant="caption" color="border">·</Text>
        <TouchableOpacity onPress={clearSelection}>
          <Text variant="caption" color="accent">Clear</Text>
        </TouchableOpacity>
      </Box>
    </Box>
  );
}
