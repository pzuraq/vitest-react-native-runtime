/**
 * Pause API — freeze test execution indefinitely for interactive development.
 *
 * When pause() is called in a test:
 *   - dev mode: blocks until resumed (via Enter key, CLI command, or file edit)
 *   - run mode: throws an error (forces cleanup before CI)
 *
 * Component HMR updates render live while paused.
 * Test file edits trigger a rerun (abort → fresh start → pause again).
 */

import { setStatus } from './state';

export interface PauseOptions {
  /** Descriptive label shown in terminal (e.g., "after login flow") */
  label?: string;
  /** Auto-screenshot on pause. Default: true */
  screenshot?: boolean;
}

// ── Module-level state ──────────────────────────────────────────

let _abortSignal: AbortSignal | null = null;
let _notifyPool: ((msg: any) => void) | null = null;
let _resumeResolver: (() => void) | null = null;
let _isPaused = false;
let _mode: 'dev' | 'run' = 'dev';

/**
 * Called by setup.ts at the start of each handleRun().
 * Provides the abort signal and pool notification channel for this run.
 */
export function configurePause(opts: {
  notifyPool: (msg: any) => void;
  abortSignal: AbortSignal;
  mode: 'dev' | 'run';
}): void {
  _notifyPool = opts.notifyPool;
  _abortSignal = opts.abortSignal;
  _mode = opts.mode;
  _isPaused = false;
  _resumeResolver = null;
}

/**
 * Called by setup.ts at the end of handleRun() or on abort.
 */
export function resetPause(): void {
  _isPaused = false;
  _resumeResolver = null;
  _abortSignal = null;
  _notifyPool = null;
}

/**
 * Called when the pool sends a __resume message.
 */
export function resume(): void {
  if (_resumeResolver) {
    _resumeResolver();
    _resumeResolver = null;
  }
}

/**
 * Pause test execution indefinitely.
 *
 * In dev mode: blocks until resumed or aborted.
 * In run mode: throws immediately.
 *
 * @example
 * ```tsx
 * it('develops a component', async () => {
 *   const screen = render(<MyComponent />);
 *   await screen.findByTestId('loaded');
 *   await pause(); // Stops here — edit component, take screenshots
 *   expect(screen.getByTestId('result')).toHaveText('Done');
 * });
 * ```
 */
export async function pause(options?: PauseOptions): Promise<void> {
  if (_mode === 'run') {
    throw new Error(
      'pause() is not allowed in run mode. Remove it before running in CI.',
    );
  }

  // In standalone/explorer mode, there's no abort signal from the pool.
  // We still pause — the explorer UI shows a "Continue" button that calls resume().
  const isStandalone = !_abortSignal;

  const signal = _abortSignal;
  if (signal?.aborted) {
    throw signal.reason;
  }

  _isPaused = true;

  const label = options?.label;
  setStatus({
    state: 'paused',
    message: label ? `Paused: ${label}` : 'Paused',
    label,
  });

  // Notify pool — triggers terminal status, auto-screenshot, stdin listener
  if (!isStandalone) {
    _notifyPool?.({
      __pause: true,
      label,
      screenshot: options?.screenshot,
    });
  }

  try {
    await new Promise<void>((resolve, reject) => {
      _resumeResolver = resolve;

      if (signal) {
        const onAbort = () => {
          _resumeResolver = null;
          reject(signal.reason ?? new DOMException('Test run aborted while paused', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  } finally {
    _isPaused = false;
    _resumeResolver = null;
    if (!isStandalone) {
      _notifyPool?.({ __pause_ended: true });
    }
    setStatus({ state: 'running', message: 'Resumed' });
  }
}

/** Check if currently paused. */
export function isPaused(): boolean {
  return _isPaused;
}
