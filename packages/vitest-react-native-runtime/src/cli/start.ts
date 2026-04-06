/**
 * vitest-react-native-runtime start — launch Expo with full TTY + file watcher.
 *
 * Uses node-pty for true pseudoterminal so Expo's interactive CLI works
 * (i, j, r, etc.). Also watches test files and notifies the app via CDP.
 *
 * Usage: npx vitest-react-native-runtime start [--port <port>] [--app-dir <path>]
 */

import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import { watch, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';

const args = process.argv;

let port = '8081';
const portIdx = args.indexOf('--port');
if (portIdx >= 0 && args[portIdx + 1]) {
  port = args[portIdx + 1];
}

let appDir = process.cwd();
const appDirIdx = args.indexOf('--app-dir');
if (appDirIdx >= 0 && args[appDirIdx + 1]) {
  appDir = resolve(args[appDirIdx + 1]);
}

// Log file
const logDir = resolve(appDir, '.vitest-native');
mkdirSync(logDir, { recursive: true });
const logPath = resolve(logDir, 'app.log');
writeFileSync(logPath, `--- Expo started at ${new Date().toISOString()} ---\n`);

// ── Expo via PTY ──────────────────────────────────────────────────

// node-pty needs full binary path
const npxPath = execSync('which npx', { encoding: 'utf8' }).trim();

const proc = pty.spawn(npxPath, ['expo', 'start', '--dev-client', '--port', port], {
  name: 'xterm-256color',
  cols: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
  cwd: appDir,
  env: process.env as Record<string, string>,
});

// Tee output to terminal + log file
proc.onData((data) => {
  process.stdout.write(data);
  try { appendFileSync(logPath, data); } catch {}
});

// Forward stdin to pty
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on('data', (data) => {
  proc.write(data.toString());
});

// Handle terminal resize
process.stdout.on('resize', () => {
  proc.resize(process.stdout.columns || 80, process.stdout.rows || 24);
});

proc.onExit(({ exitCode }) => {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  try { appendFileSync(logPath, `\n--- Expo exited (code=${exitCode}) ---\n`); } catch {}
  process.exit(exitCode);
});

// ── File watcher → CDP notification ──────────────────────────────

const packagesDir = resolve(appDir, 'packages');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function getTargetWsUrl(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/json/list`, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk));
      res.on('end', () => {
        try {
          const targets = JSON.parse(data);
          const ios = targets.find((t: any) => t.deviceName?.includes('iPhone'));
          resolve((ios || targets[0])?.webSocketDebuggerUrl ?? null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

async function notifyApp(filename: string) {
  const wsUrl = await getTargetWsUrl();
  if (!wsUrl) return;

  try {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });

    ws.send(JSON.stringify({
      id: Date.now(),
      method: 'Runtime.evaluate',
      params: {
        expression: `
          (function() {
            var listeners = globalThis.__TEST_HMR_LISTENERS__;
            if (listeners) {
              listeners.forEach(function(fn) { fn(${JSON.stringify(filename)}); });
              return 'notified ' + listeners.size + ' listener(s)';
            }
            return 'no listeners';
          })()
        `,
        returnByValue: true,
      },
    }));

    await new Promise<void>((resolve) => {
      ws.on('message', () => { ws.close(); resolve(); });
      setTimeout(() => { ws.close(); resolve(); }, 2000);
    });
  } catch {
    // CDP not available — app may not be loaded yet
  }
}

try {
  watch(packagesDir, { recursive: true }, (eventType, filename) => {
    if (!filename || !filename.match(/\.test\.tsx?$/)) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      process.stdout.write(`\r\n\x1b[36m[watcher]\x1b[0m Test changed: ${filename}\r\n`);
      notifyApp(filename);
    }, 500);
  });
} catch {
  // Watcher setup failed — non-fatal
}
