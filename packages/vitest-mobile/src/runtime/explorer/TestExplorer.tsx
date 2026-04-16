import React, { useMemo } from 'react';
import { ThemeProvider } from '@shopify/restyle';
import { testFileKeys } from 'vitest-mobile/test-registry';
import { getTheme, type ThemeMode } from './theme';
import { RunnerView } from './RunnerView';
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

interface TestExplorerProps {
  themeMode?: ThemeMode;
}

export function TestExplorer({ themeMode = 'dark' }: TestExplorerProps) {
  const allModules = useMemo(() => groupByModule(testFileKeys), []);
  const theme = useMemo(() => getTheme(themeMode), [themeMode]);

  return (
    <ThemeProvider theme={theme}>
      <RunnerView modules={allModules} />
    </ThemeProvider>
  );
}
