/**
 * Context — React context for the test container and render bridge.
 */

import React, { createContext, useContext, useRef, useState, useCallback } from 'react';
import { View, type ViewStyle } from 'react-native';

type SetContentFn = (content: React.ReactNode) => void;
type SetKeyFn = (key: number) => void;

interface TestContainerContextValue {
  containerRef: React.RefObject<View | null>;
  setTestContent: SetContentFn;
  setContentKey: SetKeyFn;
  testContent: React.ReactNode;
  contentKey: number;
}

const TestContainerContext = createContext<TestContainerContextValue | null>(null);

let globalSetTestContent: SetContentFn | null = null;
let globalSetContentKey: SetKeyFn | null = null;
let globalContainerRef: React.RefObject<View | null> | null = null;
let _renderKey = 0;

let resolveReady: (() => void) | null = null;
const readyPromise = new Promise<void>(resolve => {
  resolveReady = resolve;
});

export function waitForContainerReady(): Promise<void> {
  if (globalSetTestContent) return Promise.resolve();
  return readyPromise;
}

export function getGlobalSetTestContent(): SetContentFn {
  if (!globalSetTestContent) {
    throw new Error('TestContainerProvider is not mounted yet.');
  }
  return globalSetTestContent;
}

export function getGlobalContainerRef(): React.RefObject<View | null> {
  if (!globalContainerRef) {
    throw new Error('TestContainerProvider is not mounted yet.');
  }
  return globalContainerRef;
}

/** Increment the render key to force React to destroy and recreate the content tree */
export function nextRenderKey(): void {
  _renderKey++;
  globalSetContentKey?.(_renderKey);
}

const containerStyle: ViewStyle = {
  flex: 1,
  width: '100%',
};

export function TestContainer() {
  const ctx = useContext(TestContainerContext);
  if (!ctx) return null;
  return (
    <View
      ref={ctx.containerRef}
      testID="test-container"
      collapsable={false}
      // @ts-expect-error collapsableChildren is a Fabric-only prop not in TS types
      collapsableChildren={false}
      style={containerStyle}
    >
      {ctx.testContent && (
        <View key={ctx.contentKey} collapsable={false}>
          {ctx.testContent}
        </View>
      )}
    </View>
  );
}

export function TestContainerProvider({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<View | null>(null);
  const [testContent, setTestContent] = useState<React.ReactNode>(null);
  const [contentKey, setContentKey] = useState(0);

  const stableSetContent = useCallback((content: React.ReactNode) => {
    setTestContent(content);
  }, []);
  const stableSetKey = useCallback((key: number) => {
    setContentKey(key);
  }, []);

  globalSetTestContent = stableSetContent;
  globalSetContentKey = stableSetKey;
  globalContainerRef = containerRef;
  resolveReady?.();

  return (
    <TestContainerContext.Provider value={{
      containerRef,
      setTestContent: stableSetContent,
      setContentKey: stableSetKey,
      testContent,
      contentKey,
    }}>
      {children}
    </TestContainerContext.Provider>
  );
}

export function useTestContainer() {
  const ctx = useContext(TestContainerContext);
  if (!ctx) throw new Error('useTestContainer must be used within TestContainerProvider');
  return ctx;
}
