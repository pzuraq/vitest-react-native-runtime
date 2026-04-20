/**
 * Shared utilities for device management — locking, liveness, prompts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import { log } from '../logger';
import { getCacheDir } from '../paths';

export const DEFAULT_BUNDLE_ID = 'com.vitest.mobile.harness';

const LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 300;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function promptConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${message} [y/N] `);
  return new Promise(resolvePrompt => {
    process.stdin.resume();
    process.stdin.once('data', data => {
      // Pause immediately so stdin doesn't keep the event loop alive after this prompt.
      process.stdin.pause();
      const answer = String(data).trim().toLowerCase();
      resolvePrompt(answer === 'y' || answer === 'yes');
    });
  });
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Check if something is listening on a TCP port (connect-based, not bind-based). */
export function isPortListening(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = netConnect(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Serialize device selection across all vitest-mobile instances on this
 * machine so two concurrent startups can't claim the same device.
 */
export async function withDeviceLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = getCacheDir();
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, 'device.lock');
  const lockContent = `${process.pid}:${Date.now()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      writeFileSync(lockPath, lockContent, { flag: 'wx' });
      break;
    } catch {
      try {
        const held = readFileSync(lockPath, 'utf8').trim();
        const pid = Number(held.split(':')[0]);
        const ts = Number(held.split(':')[1]);
        if (!isPidAlive(pid) || Date.now() - ts > LOCK_TIMEOUT_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* ignore */
          }
          continue;
        }
      } catch {
        /* ignore */
      }
      await new Promise<void>(r => setTimeout(r, LOCK_POLL_MS));
    }
  }

  if (!existsSync(lockPath) || readFileSync(lockPath, 'utf8').trim() !== lockContent) {
    log.warn('Could not acquire device lock within timeout; proceeding anyway');
    try {
      writeFileSync(lockPath, lockContent);
    } catch {
      /* ignore */
    }
  }

  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}
