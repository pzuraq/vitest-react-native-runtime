export interface TestModule {
  name: string;
  files: string[];
}

export type ModuleStatus = 'idle' | 'pending' | 'running' | 'pass' | 'fail';

export type Screen =
  | { type: 'modules' }
  | { type: 'runner'; modules: TestModule[] };
