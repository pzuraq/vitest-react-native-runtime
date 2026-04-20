/**
 * Shared shell execution helpers used by device.ts and environment.ts.
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLogSink } from './logger';

export function run(cmd: string, opts: ExecSyncOptions = {}): string | null {
  try {
    return (
      execSync(cmd, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 60000,
        ...opts,
      }) as string
    ).trim();
  } catch (e: unknown) {
    // run() deliberately returns null on failure so probe-style callers
    // (getBootedSimulator, device claims, etc.) can treat "not there" and
    // "errored" the same. But when something that *should* work fails —
    // simctl create, adb shell, etc. — the cause otherwise disappears. Tee
    // the command + stderr to the active log sink (set by the CLI spinner)
    // so failures land in the per-run log file, inspectable post-mortem.
    const sink = getLogSink();
    if (sink) {
      const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
      const stderr = err.stderr?.toString().trim() ?? '';
      const stdout = err.stdout?.toString().trim() ?? '';
      sink.write(`$ ${cmd}\n`);
      if (stdout) sink.write(`${stdout}\n`);
      if (stderr) sink.write(`${stderr}\n`);
      if (!stdout && !stderr && err.message) sink.write(`${err.message}\n`);
    }
    return null;
  }
}

export function getAndroidHome(): string {
  return (
    process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || resolve(process.env.HOME || '', 'Library/Android/sdk')
  );
}

/** Resolve the full path to the adb binary. Falls back to bare 'adb' if not found in the SDK. */
export function getAdbPath(): string {
  const candidate = resolve(getAndroidHome(), 'platform-tools', 'adb');
  if (existsSync(candidate)) return candidate;
  return 'adb';
}
