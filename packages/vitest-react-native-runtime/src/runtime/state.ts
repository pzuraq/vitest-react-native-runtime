/**
 * Shared harness state — status events and log accumulator.
 *
 * Extracted from setup.ts to break the setup <-> pause circular dependency.
 * Both setup.ts and pause.ts import from here without creating a cycle.
 */

// ── Status event system for UI ────────────────────────────────────

type StatusListener = (status: HarnessStatus) => void;
const statusListeners: Set<StatusListener> = new Set();

export interface HarnessStatus {
  state: 'connecting' | 'connected' | 'running' | 'paused' | 'done' | 'error';
  message: string;
  label?: string;
  currentFile?: string;
  fileIndex?: number;
  fileCount?: number;
  passed?: number;
  failed?: number;
  total?: number;
  logs?: string[];
}

let currentStatus: HarnessStatus = { state: 'connecting', message: 'Connecting to Vitest...' };
const logs: string[] = [];

export function setStatus(status: Partial<HarnessStatus>) {
  currentStatus = { ...currentStatus, ...status };
  statusListeners.forEach(fn => fn(currentStatus));
}

export function addLog(line: string) {
  logs.push(line);
  setStatus({ logs: [...logs] });
}

export function resetLogs() {
  logs.length = 0;
}

export function onStatusChange(listener: StatusListener): () => void {
  statusListeners.add(listener);
  listener(currentStatus);
  return () => statusListeners.delete(listener);
}
