/**
 * Shared platform-arg resolution for CLI commands.
 *
 * Every command takes platform as `--platform <ios|android>`. Each command
 * decides what to do when the flag is omitted, using one of these helpers:
 *
 *   - requirePlatform:             error if missing (cache-key)
 *   - resolvePlatformInteractive:  prompt in TTY / error in non-TTY (build,
 *                                  bootstrap, boot-device, reset-device)
 *   - resolvePlatformFromCache:    infer from cached builds (install)
 *   - resolvePlatformOrBoth:       default to 'both' (trim-cache, clean-devices)
 *
 * All helpers detect the legacy positional form (`vitest-mobile build ios`)
 * and emit a clear migration error rather than silently accepting it.
 */

import { isCancel, select } from '@clack/prompts';
import { hasAnyCachedBinary } from '../node/harness-builder';

export type Platform = 'ios' | 'android';
export type PlatformOrBoth = Platform | 'both';

const VALID = ['ios', 'android'] as const;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Early guard for the legacy positional form. CLI actions pass the command's
 * leftover positional args (`cli.args`) so we can surface a clear migration
 * error instead of having the action silently ignore the value. No-op when
 * the args are empty or don't contain a platform name.
 */
export function rejectLegacyPositional(args: readonly string[]): void {
  const stray = args.find(a => a === 'ios' || a === 'android');
  if (!stray) return;
  fail(
    `'${stray}' is no longer a positional argument — pass it as --platform ${stray}.\n` +
      `Example: vitest-mobile build --platform ${stray}`,
  );
}

function parseFlag(flag: string | undefined): Platform | undefined {
  if (flag === undefined) return undefined;
  if (!VALID.includes(flag as Platform)) {
    fail(`--platform must be 'ios' or 'android' (got '${flag}')`);
  }
  return flag as Platform;
}

function isTTY(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

/** Strict: requires --platform. Used when the command's output is ambiguous without it. */
export function requirePlatform(flag: string | undefined, command: string): Platform {
  const parsed = parseFlag(flag);
  if (!parsed) {
    fail(
      `${command} requires --platform ios or --platform android.\n` +
        `The output format depends on the platform, so 'both' isn't meaningful here.`,
    );
  }
  return parsed;
}

interface InteractiveOptions {
  command: string;
  /** Include a 'both' choice in the prompt. Off by default for single-target commands. */
  allowBoth?: boolean;
}

/**
 * Prompt in TTY; error in non-TTY (e.g. CI). Use for commands where doing
 * both platforms silently would be too expensive (build, bootstrap, boot-device).
 */
export async function resolvePlatformInteractive(
  flag: string | undefined,
  opts: InteractiveOptions,
): Promise<PlatformOrBoth> {
  const parsed = parseFlag(flag);
  if (parsed) return parsed;

  if (!isTTY()) {
    fail(
      `${opts.command} requires --platform ios or --platform android when not running in a TTY.\n` +
        `(Running with stdin/stdout redirected — CI, pipes, etc. — so we can't prompt.)`,
    );
  }

  const choice = await select({
    message: `Which platform should ${opts.command} target?`,
    options: [
      { label: 'iOS', value: 'ios' },
      { label: 'Android', value: 'android' },
      ...(opts.allowBoth ? [{ label: 'Both', value: 'both' }] : []),
    ],
  });

  if (isCancel(choice)) {
    console.error('Cancelled.');
    process.exit(1);
  }

  return choice as PlatformOrBoth;
}

/**
 * Infer from the build cache. If exactly one platform has a cached binary,
 * pick it. Otherwise fall back to interactive selection (or error in non-TTY).
 */
export async function resolvePlatformFromCache(
  flag: string | undefined,
  opts: { command: string },
): Promise<PlatformOrBoth> {
  const parsed = parseFlag(flag);
  if (parsed) return parsed;

  const hasIos = hasAnyCachedBinary('ios');
  const hasAndroid = hasAnyCachedBinary('android');

  if (hasIos && !hasAndroid) return 'ios';
  if (hasAndroid && !hasIos) return 'android';

  if (!hasIos && !hasAndroid) {
    fail(
      `No cached harness binary found for either platform.\n` +
        `Run 'vitest-mobile bootstrap --platform ios' or '--platform android' first.`,
    );
  }

  // Both cached — need to disambiguate.
  return resolvePlatformInteractive(flag, { command: opts.command, allowBoth: true });
}

/**
 * Default to 'both' when --platform is omitted. Used for fast filesystem-only
 * commands where doing both is trivial and matches the natural "all of them"
 * expectation (trim-cache, clean-devices, bundle).
 */
export function resolvePlatformOrBoth(flag: string | undefined): PlatformOrBoth {
  const parsed = parseFlag(flag);
  return parsed ?? 'both';
}

/** Expand 'both' to the concrete list, preserving order (ios first). */
export function expandPlatform(p: PlatformOrBoth): Platform[] {
  return p === 'both' ? ['ios', 'android'] : [p];
}
