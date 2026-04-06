declare module 'vitest-react-native-runtime/test-registry' {
  /** Sync list of test file display keys (e.g. 'greeting/greeting.test.tsx'). */
  export const testFileKeys: string[];

  /** Async import of a test file by its display key. Returns the module with __run. */
  export function importTestFile(key: string): Promise<any>;

  /** Preload all test file bundles. Call at startup. */
  export function loadAllTestFiles(): Promise<PromiseSettledResult<any>[]>;
}
