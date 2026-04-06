import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ThemeProvider } from '@shopify/restyle';
import { testFileKeys } from 'vitest-react-native-runtime/test-registry';
import theme from './theme';
import { ModuleListScreen } from './ModuleListScreen';
import { TestRunnerScreen } from './TestRunnerScreen';
import type { Screen, TestModule } from './types';

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

/** Find which module a test key belongs to */
function findModuleForFile(testKey: string, modules: TestModule[]): TestModule | null {
  const moduleName = testKey.split('/')[0];
  return modules.find(m => m.name === moduleName) ?? null;
}

export function TestExplorer() {
  const [screen, setScreen] = useState<Screen>({ type: 'modules' });
  const [runKey, setRunKey] = useState(0);
  const [modifiedModules, setModifiedModules] = useState<Set<string>>(new Set());
  // Use ref so the HMR handler always has the latest screen
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const allModules = React.useMemo(() => {
    return groupByModule(testFileKeys);
  }, []);

  const navigateToRunner = useCallback((modules: TestModule[]) => {
    setRunKey(k => k + 1);
    setModifiedModules(new Set());
    setScreen({ type: 'runner', modules });
  }, []);

  const navigateBack = useCallback(() => {
    setScreen({ type: 'modules' });
  }, []);

  // Listen for HMR updates on test files
  useEffect(() => {
    const listeners: Set<(changedFile?: string) => void> | undefined =
      (globalThis as any).__TEST_HMR_LISTENERS__;
    if (!listeners) return;

    const handler = (changedFile?: string) => {
      console.log(`[TestExplorer] HMR: ${changedFile ?? 'unknown'}, screen=${screenRef.current.type}`);

      if (screenRef.current.type === 'runner') {
        // On runner screen: if changed file is part of the current run, re-run
        // If it's a different module, navigate to that module's runner
        if (changedFile) {
          const changedModule = findModuleForFile(changedFile, allModules);
          if (changedModule) {
            const currentModuleNames = screenRef.current.modules.map(m => m.name);
            if (currentModuleNames.includes(changedModule.name)) {
              // Changed file is in the current run — just re-run
              console.log(`[TestExplorer] Re-running current modules (${changedFile} changed)`);
              setRunKey(k => k + 1);
              // Re-set screen to force remount
              setScreen({ type: 'runner', modules: screenRef.current.modules });
            } else {
              // Changed file is a different module — navigate to it
              console.log(`[TestExplorer] Navigating to changed module: ${changedModule.name}`);
              setRunKey(k => k + 1);
              setScreen({ type: 'runner', modules: [changedModule] });
            }
          }
        } else {
          // Unknown file — re-run current
          setRunKey(k => k + 1);
          setScreen({ type: 'runner', modules: screenRef.current.modules });
        }
      } else {
        // On module list: show modified badge
        if (changedFile) {
          const moduleName = changedFile.split('/')[0];
          console.log(`[TestExplorer] Module modified: ${moduleName}`);
          setModifiedModules(prev => new Set(prev).add(moduleName));
        }
      }
    };

    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, [allModules]);

  return (
    <ThemeProvider theme={theme}>
      {screen.type === 'modules' ? (
        <ModuleListScreen
          onRunModules={navigateToRunner}
          modifiedModules={modifiedModules}
        />
      ) : (
        <TestRunnerScreen key={runKey} modules={screen.modules} onBack={navigateBack} />
      )}
    </ThemeProvider>
  );
}
