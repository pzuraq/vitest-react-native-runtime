/**
 * NativeHarness — JS bridge to the native view query + touch synthesis TurboModule.
 *
 * All query methods are async (Promise-based) to avoid blocking the JS event loop,
 * which is critical for allowing React/Fabric to commit view updates.
 */

import { TurboModuleRegistry } from 'react-native';

export interface ViewInfo {
  nativeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewTreeNode {
  type: string;
  testID?: string;
  text?: string;
  children: ViewTreeNode[];
  visible: boolean;
  frame: { x: number; y: number; width: number; height: number };
}

export interface NativeHarnessModule {
  queryByTestId(testId: string): Promise<ViewInfo | null>;
  queryAllByTestId(testId: string): Promise<ViewInfo[]>;
  queryByText(text: string): Promise<ViewInfo | null>;
  queryAllByText(text: string): Promise<ViewInfo[]>;
  getText(nativeId: string): Promise<string | null>;
  isVisible(nativeId: string): Promise<boolean>;
  dumpViewTree(): Promise<ViewTreeNode | null>;
  simulatePress(nativeId: string, x: number, y: number): Promise<void>;
  typeChar(character: string): Promise<void>;
  typeIntoView(nativeId: string, text: string): Promise<void>;
  flushUIQueue(): Promise<void>;
}

let module: NativeHarnessModule | null = null;
try {
  module = TurboModuleRegistry.getEnforcing<NativeHarnessModule>('NativeHarness');
} catch {
  try {
    const { NativeModules } = require('react-native');
    module = NativeModules.NativeHarness ?? null;
  } catch {
    module = null;
  }
}

export default module;
