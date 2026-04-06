/**
 * vitest-react-native-runtime debug — CDP-based debugging tools.
 *
 * Connects to the Hermes debugger via Chrome DevTools Protocol.
 *
 * Usage:
 *   npx vitest-react-native-runtime debug eval "<expression>"
 *   npx vitest-react-native-runtime debug status
 *   npx vitest-react-native-runtime debug logs
 */

import http from 'node:http';
import WebSocket from 'ws';

const subcommand = process.argv[2];
const portIdx = process.argv.indexOf('--port');
const metroPort = parseInt(
  (portIdx >= 0 ? process.argv[portIdx + 1] : undefined) ?? process.env.METRO_PORT ?? '8081',
  10,
);

interface CDPTarget {
  id: string;
  title: string;
  description: string;
  webSocketDebuggerUrl: string;
  appId?: string;
  deviceName?: string;
}

// ── CDP target discovery ───────────────────────────────────────────

function getTargets(): Promise<CDPTarget[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${metroPort}/json/list`, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON from /json/list: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', (err) => {
      reject(new Error(`Cannot reach Metro at localhost:${metroPort}. Is it running?\n  ${err.message}`));
    });
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error(`Timeout connecting to Metro at localhost:${metroPort}`));
    });
  });
}

// ── CDP WebSocket helpers ──────────────────────────────────────────

function connectCDP(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(new Error(`CDP WebSocket error: ${err.message}`)));
    setTimeout(() => {
      ws.close();
      reject(new Error('CDP WebSocket connection timeout'));
    }, 5000);
  });
}

function cdpSend(ws: WebSocket, method: string, params?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`CDP ${method} timed out`));
    }, 10000);
  });
}

async function evaluate(ws: WebSocket, expression: string): Promise<string> {
  const resp = await cdpSend(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  if (resp.result?.exceptionDetails) {
    const err = resp.result.exceptionDetails;
    return `Error: ${err.text ?? err.exception?.description ?? JSON.stringify(err)}`;
  }
  const val = resp.result?.result?.value;
  return val !== undefined ? String(val) : JSON.stringify(resp.result?.result);
}

// ── Subcommands ────────────────────────────────────────────────────

async function cmdStatus() {
  let targets: CDPTarget[];
  try {
    targets = await getTargets();
  } catch (err: any) {
    console.log('Metro: not reachable');
    console.log(`  ${err.message}`);
    return;
  }

  console.log(`Metro: running on port ${metroPort}`);
  console.log(`Targets: ${targets.length}`);

  for (const t of targets) {
    console.log(`\n  ${t.title}`);
    console.log(`  ${t.description}`);
    if (t.deviceName) console.log(`  Device: ${t.deviceName}`);

    // Try connecting and checking module state
    try {
      const ws = await connectCDP(t.webSocketDebuggerUrl);
      // Skip Runtime.enable — times out on Hermes bridgeless

      const dev = await evaluate(ws, 'typeof __DEV__ !== "undefined" ? __DEV__ : "unknown"');
      const moduleCount = await evaluate(ws, 'Object.keys(__r.getModules()).length');
      const hmr = await evaluate(ws, 'typeof module !== "undefined" && module.hot ? "enabled" : "disabled"');

      console.log(`  __DEV__: ${dev}`);
      console.log(`  Modules loaded: ${moduleCount}`);
      console.log(`  HMR: ${hmr}`);

      ws.close();
    } catch (err: any) {
      console.log(`  (could not inspect: ${err.message})`);
    }
  }
}

async function cmdEval(expression: string) {
  const targets = await getTargets();
  if (targets.length === 0) {
    console.error('No debuggable targets found. Is the app running?');
    process.exit(1);
  }

  // Support --file flag to evaluate a file
  if (expression === '--file' || process.argv.includes('--file')) {
    const fileIdx = process.argv.indexOf('--file');
    const filePath = process.argv[fileIdx + 1];
    if (!filePath) {
      console.error('Usage: debug eval --file <path.js>');
      process.exit(1);
    }
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expression = readFileSync(resolve(filePath), 'utf8');
  }

  const jsonOutput = process.argv.includes('--json');

  // Prefer iOS target
  const target = targets.find(t => t.deviceName?.includes('iPhone')) ?? targets[0];
  const ws = await connectCDP(target.webSocketDebuggerUrl);
  // Skip Runtime.enable — it times out on Hermes bridgeless

  const resp = await cdpSend(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });

  if (resp.result?.exceptionDetails) {
    const err = resp.result.exceptionDetails;
    console.error(`Error: ${err.text ?? err.exception?.description ?? JSON.stringify(err)}`);
    ws.close();
    process.exit(1);
  }

  const val = resp.result?.result?.value;
  if (jsonOutput) {
    console.log(JSON.stringify(val));
  } else if (typeof val === 'object' && val !== null) {
    console.log(JSON.stringify(val, null, 2));
  } else {
    console.log(val !== undefined ? String(val) : JSON.stringify(resp.result?.result));
  }
  ws.close();
}

async function cmdLogs() {
  const targets = await getTargets();
  if (targets.length === 0) {
    console.error('No debuggable targets found. Is the app running?');
    process.exit(1);
  }

  const ws = await connectCDP(targets[0].webSocketDebuggerUrl);

  // Collect console messages
  const logs: string[] = [];
  ws.on('message', (data: WebSocket.Data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = msg.params.args?.map((a: any) => a.value ?? a.description ?? '?').join(' ') ?? '';
      const type = msg.params.type ?? 'log';
      logs.push(`[${type}] ${args}`);
      console.log(`[${type}] ${args}`);
    }
  });

  await cdpSend(ws, 'Runtime.enable');
  console.log('Listening for console output... (Ctrl+C to stop)\n');

  // Keep alive until interrupted
  process.on('SIGINT', () => {
    ws.close();
    process.exit(0);
  });
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  switch (subcommand) {
    case 'status':
      await cmdStatus();
      break;
    case 'eval':
      const expr = process.argv.slice(3).join(' ');
      if (!expr) {
        console.error('Usage: debug eval "<expression>"');
        process.exit(1);
      }
      await cmdEval(expr);
      break;
    case 'logs':
      await cmdLogs();
      break;
    default:
      console.log(`Usage:
  debug status              Check Metro, targets, module state
  debug eval "<expression>" Evaluate JS in the running app
  debug logs                Stream console output from the app`);
      process.exit(subcommand ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
