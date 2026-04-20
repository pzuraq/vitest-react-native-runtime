/**
 * Drop-in replacement for `execSync(cmd, { stdio: 'inherit' })` that tees
 * output to the active log sink when a spinner is running. Use in CLI
 * actions so long-running tool output (simctl install, adb install) doesn't
 * smash the spinner but still gets captured for post-mortem.
 *
 * When no log sink is active, falls through to the original `stdio: 'inherit'`
 * behavior so programmatic callers and non-spinner paths keep the live
 * terminal output they rely on.
 */

import { execSync, spawnSync } from 'node:child_process';
import { getLogSink } from '../node/logger';

export function teeExec(cmd: string, opts: { timeout?: number } = {}): void {
  const sink = getLogSink();
  if (!sink) {
    execSync(cmd, { stdio: 'inherit', timeout: opts.timeout });
    return;
  }

  sink.write(`$ ${cmd}\n`);
  const result = spawnSync('sh', ['-c', cmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    timeout: opts.timeout,
  });
  if (result.stdout) sink.write(result.stdout);
  if (result.stderr) sink.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status ?? 'null'}: ${cmd}`);
  }
}
