/**
 * Spinner + log-to-file wrapper for long-running CLI commands.
 *
 * `withSpinner(opts, fn)` creates a spinner (in a TTY) or plain step-by-step
 * output (non-TTY), opens a log file under `~/.cache/vitest-mobile/logs/`, and
 * passes a `logStream` to `fn`. Actions pass that stream down into spawn
 * helpers (harness-builder, device drivers) so child-process output goes to
 * the log rather than smashing the spinner.
 *
 * While the spinner is active we also route logger.ts output to the log sink
 * (see `setLogSink`), so internal `log.info` / `log.verbose` calls stay quiet
 * and the spinner stays legible.
 *
 * On failure, the log path is printed so the user can inspect what went wrong
 * — nothing is silently swallowed.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { spinner } from '@clack/prompts';
import pc from 'picocolors';
import { getCacheDir } from '../node/paths';
import { setLogSink } from '../node/logger';

export function getLogDir(): string {
  const dir = resolve(getCacheDir(), 'logs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

let activeUpdate: ((msg: string) => void) | null = null;

/**
 * Update the currently-active spinner's headline (if one is running). In
 * non-spinner contexts (no active withSpinner, or non-TTY) the message
 * prints to stdout. Safe to call from deep in the action stack without
 * plumbing an update callback through every options object.
 */
export function updateStatus(msg: string): void {
  if (activeUpdate) activeUpdate(msg);
  else console.log(msg);
}

function makeLogPath(opts: { command: string; platform?: string }): string {
  const iso = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const suffix = opts.platform ? `-${opts.platform}` : '';
  return resolve(getLogDir(), `${iso}-${opts.command}${suffix}.log`);
}

export interface SpinnerContext {
  /** Update the spinner headline. In non-TTY mode this prints a line. */
  update(msg: string): void;
  /** Pass this into spawn helpers so child stdout/stderr is tee'd to the log. */
  logStream: Writable;
  /** Path to the log file — surfaced in error messages. */
  logPath: string;
}

export interface SpinnerOptions {
  /** Used in the log filename and final success/fail message. */
  command: string;
  /** Included in the log filename when present. */
  platform?: string;
  /** First line shown in the spinner. */
  initialMessage: string;
  /** Message shown on successful completion. Defaults to "${command} complete." */
  successMessage?: string;
}

export async function withSpinner<T>(opts: SpinnerOptions, fn: (ctx: SpinnerContext) => Promise<T>): Promise<T> {
  const logPath = makeLogPath(opts);
  const logStream = createWriteStream(logPath, { flags: 'a' });
  logStream.write(`# ${opts.command}${opts.platform ? ` (${opts.platform})` : ''} — ${new Date().toISOString()}\n\n`);
  setLogSink(logStream);

  const isTTY = Boolean(process.stdout.isTTY);

  const success = opts.successMessage ?? `${opts.command} complete.`;

  if (!isTTY) {
    console.log(`${opts.initialMessage}`);
    const update = (msg: string) => console.log(msg);
    activeUpdate = update;
    try {
      const result = await fn({ update, logStream, logPath });
      console.log(pc.green(`✓ ${success}`));
      return result;
    } catch (err) {
      console.error(pc.red(`✖ ${opts.command} failed.`));
      console.error(`  Full log: ${logPath}`);
      throw err;
    } finally {
      activeUpdate = null;
      setLogSink(null);
      await endStream(logStream);
    }
  }

  const s = spinner();
  s.start(opts.initialMessage);
  const update = (msg: string) => s.message(msg);
  activeUpdate = update;

  try {
    const result = await fn({ update, logStream, logPath });
    s.stop(pc.green(`✓ ${success}`));
    return result;
  } catch (err) {
    s.stop(pc.red(`✖ ${opts.command} failed.`));
    console.error(`  Full log: ${logPath}`);
    throw err;
  } finally {
    activeUpdate = null;
    setLogSink(null);
    await endStream(logStream);
  }
}

function endStream(stream: Writable): Promise<void> {
  return new Promise(res => {
    stream.end(() => res());
  });
}
