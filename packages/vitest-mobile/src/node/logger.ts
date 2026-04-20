/**
 * Centralized logger for vitest-mobile.
 *
 * In normal mode only warnings, errors, and explicit info() calls are printed.
 * In verbose mode every verbose() call is also printed.
 *
 * Enable verbose via the `verbose` pool option or VITEST_POOL_NATIVE_VERBOSE=1.
 *
 * When a log sink is set via `setLogSink` (as the CLI does while a spinner is
 * active), console output is suppressed and messages are written to the sink
 * instead. Warnings and errors still go to the console so failures aren't
 * swallowed.
 */

import type { Writable } from 'node:stream';

const PREFIX = '[vitest-mobile]';

let sink: Writable | null = null;

export function setLogSink(stream: Writable | null): void {
  sink = stream;
}

/**
 * Currently-active log sink, if any. Spawn helpers use this to tee child
 * process output into the same file without threading the stream through
 * every options object.
 */
export function getLogSink(): Writable | null {
  return sink;
}

function formatArgs(args: unknown[]): string {
  return args
    .map(a => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a)))
    .join(' ');
}

function writeSink(level: string, args: unknown[]): void {
  if (!sink) return;
  sink.write(`${PREFIX} [${level}] ${formatArgs(args)}\n`);
}

export function setVerbose(v: boolean): void {
  process.env.VITEST_POOL_NATIVE_VERBOSE = v ? '1' : '';
}

export function isVerbose(): boolean {
  const v = process.env.VITEST_POOL_NATIVE_VERBOSE;
  return v === '1' || v === 'true';
}

export const log = {
  /** Always printed — important status the user should see. */
  info(...args: unknown[]): void {
    if (sink) writeSink('info', args);
    else console.log(PREFIX, ...args);
  },

  /** Only printed when verbose mode is on. */
  verbose(...args: unknown[]): void {
    if (sink) writeSink('verbose', args);
    else if (isVerbose()) console.log(PREFIX, ...args);
  },

  warn(...args: unknown[]): void {
    writeSink('warn', args);
    console.warn(PREFIX, ...args);
  },

  error(...args: unknown[]): void {
    writeSink('error', args);
    console.error(PREFIX, ...args);
  },
};
