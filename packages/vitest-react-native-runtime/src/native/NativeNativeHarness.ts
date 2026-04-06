import { TurboModuleRegistry, type TurboModule } from 'react-native';

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
  visible: boolean;
  frame: { x: number; y: number; width: number; height: number };
  children: ViewTreeNode[];
}

interface Spec extends TurboModule {
  // All methods are async (Promise-based) to avoid blocking the JS event loop.
  // Native side dispatches to main thread and resolves the promise.
  queryByTestId(testId: string): Promise<ViewInfo | null>;
  queryAllByTestId(testId: string): Promise<ViewInfo[]>;
  queryByText(text: string): Promise<ViewInfo | null>;
  queryAllByText(text: string): Promise<ViewInfo[]>;
  getText(nativeId: string): Promise<string | null>;
  isVisible(nativeId: string): Promise<boolean>;
  dumpViewTree(): Promise<Object | null>;

  simulatePress(nativeId: string, x: number, y: number): Promise<void>;
  typeChar(character: string): Promise<void>;
  typeIntoView(nativeId: string, text: string): Promise<void>;

  // Round-trip marker: dispatches to the UI thread and resolves when it
  // returns. Used after interactions to flush the native event pipeline.
  flushUIQueue(): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeHarness');
