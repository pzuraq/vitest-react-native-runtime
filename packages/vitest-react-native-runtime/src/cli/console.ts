/**
 * vitest-react-native-runtime console — interactive CDP REPL.
 *
 * Connects to the running React Native app's Hermes debugger and provides
 * a persistent JS console. Variables persist across evaluations.
 *
 * Usage: npx vitest-react-native-runtime console [--port <metro-port>]
 */

import http from 'node:http';
import readline from 'node:readline';
import WebSocket from 'ws';

const args = process.argv;
const metroPort = parseInt(
  (args.indexOf('--port') >= 0 ? args[args.indexOf('--port') + 1] : undefined) ?? '8081',
  10,
);

interface CDPTarget {
  id: string;
  title: string;
  description: string;
  webSocketDebuggerUrl: string;
  deviceName?: string;
}

// ── CDP helpers ───────────────────────────────────────────────────

function getTargets(): Promise<CDPTarget[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${metroPort}/json/list`, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from Metro')); }
      });
    });
    req.on('error', (err) => reject(new Error(`Cannot reach Metro on port ${metroPort}: ${err.message}`)));
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout connecting to Metro')); });
  });
}

function connectWS(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(new Error(`WebSocket error: ${err.message}`)));
    setTimeout(() => { ws.close(); reject(new Error('WebSocket timeout')); }, 5000);
  });
}

// ── REPL ──────────────────────────────────────────────────────────

async function main() {
  let targets: CDPTarget[];
  try {
    targets = await getTargets();
  } catch (err: any) {
    console.error(`Could not connect to Metro: ${err.message}`);
    process.exit(1);
  }

  if (targets.length === 0) {
    console.error('No debuggable targets found. Is the app running?');
    process.exit(1);
  }

  // Prefer iOS target, fall back to first
  let targetIdx = targets.findIndex(t => t.deviceName?.includes('iPhone'));
  if (targetIdx < 0) targetIdx = 0;
  let target = targets[targetIdx];

  console.log(`\x1b[36mConnected to: ${target.title}\x1b[0m`);
  console.log(`\x1b[2mDevice: ${target.deviceName ?? 'unknown'}\x1b[0m`);
  console.log(`\x1b[2mType JS expressions to evaluate. Special commands: .targets .switch .reload .clear .exit\x1b[0m\n`);

  let ws = await connectWS(target.webSocketDebuggerUrl);
  let msgId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  // Handle incoming messages
  ws.on('message', (data: WebSocket.Data) => {
    const msg = JSON.parse(data.toString());

    // Response to our request
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)!;
      pending.delete(msg.id);
      resolve(msg);
      return;
    }

    // Console API events (from Runtime.enable, may or may not work)
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = msg.params?.args?.map((a: any) =>
        a.value !== undefined ? a.value : a.description ?? '?'
      ) ?? [];
      const type = msg.params?.type ?? 'log';
      const prefix = type === 'error' ? '\x1b[31m[app error]\x1b[0m' :
                     type === 'warn' ? '\x1b[33m[app warn]\x1b[0m' :
                     '\x1b[2m[app]\x1b[0m';
      // Clear current line, print log, restore prompt
      process.stdout.write(`\r\x1b[K${prefix} ${args.join(' ')}\n`);
      rl.prompt(true);
    }
  });

  ws.on('close', () => {
    console.log('\n\x1b[31mDisconnected from app\x1b[0m');
    process.exit(0);
  });

  // Try to enable console log streaming (fire and forget — don't await)
  ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.enable' }));

  function cdpSend(method: string, params?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, 10000);
    });
  }

  async function evaluate(expression: string): Promise<string> {
    try {
      const resp = await cdpSend('Runtime.evaluate', {
        expression,
        returnByValue: true,
        generatePreview: true,
      });

      if (resp.result?.exceptionDetails) {
        const err = resp.result.exceptionDetails;
        const text = err.exception?.description ?? err.text ?? JSON.stringify(err);
        return `\x1b[31m${text}\x1b[0m`;
      }

      const result = resp.result?.result;
      if (!result) return '\x1b[2mundefined\x1b[0m';

      if (result.type === 'undefined') return '\x1b[2mundefined\x1b[0m';
      if (result.value !== undefined) {
        if (typeof result.value === 'object') {
          return JSON.stringify(result.value, null, 2);
        }
        return String(result.value);
      }
      if (result.description) return result.description;
      return JSON.stringify(result);
    } catch (err: any) {
      return `\x1b[31mError: ${err.message}\x1b[0m`;
    }
  }

  // ── REPL loop ───────────────────────────────────────────────────

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[36m>\x1b[0m ',
    terminal: true,
  });

  let multilineBuffer = '';

  rl.prompt();

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();

    // Special commands
    if (trimmed === '.exit' || trimmed === '.quit') {
      ws.close();
      process.exit(0);
    }

    if (trimmed === '.clear') {
      process.stdout.write('\x1b[2J\x1b[H');
      rl.prompt();
      return;
    }

    if (trimmed === '.targets') {
      try {
        const t = await getTargets();
        t.forEach((tgt, i) => {
          const marker = tgt.id === target.id ? ' \x1b[32m(active)\x1b[0m' : '';
          console.log(`  ${i}: ${tgt.title} — ${tgt.deviceName ?? '?'}${marker}`);
        });
      } catch (err: any) {
        console.log(`\x1b[31m${err.message}\x1b[0m`);
      }
      rl.prompt();
      return;
    }

    if (trimmed.startsWith('.switch')) {
      const idx = parseInt(trimmed.split(/\s+/)[1], 10);
      try {
        const t = await getTargets();
        if (idx >= 0 && idx < t.length) {
          ws.close();
          target = t[idx];
          ws = await connectWS(target.webSocketDebuggerUrl);
          ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.enable' }));
          console.log(`\x1b[36mSwitched to: ${target.title}\x1b[0m`);
        } else {
          console.log(`Invalid index. Use .targets to see available.`);
        }
      } catch (err: any) {
        console.log(`\x1b[31m${err.message}\x1b[0m`);
      }
      rl.prompt();
      return;
    }

    if (trimmed === '.reload') {
      try {
        await cdpSend('Runtime.evaluate', { expression: 'location.reload()' });
        console.log('Reloading...');
      } catch {
        console.log('Sent reload (may not be supported on Hermes)');
      }
      rl.prompt();
      return;
    }

    // Multi-line detection
    multilineBuffer += (multilineBuffer ? '\n' : '') + line;
    const opens = (multilineBuffer.match(/[{([\[]/g) || []).length;
    const closes = (multilineBuffer.match(/[})\]]/g) || []).length;
    if (opens > closes) {
      rl.setPrompt('\x1b[2m...\x1b[0m ');
      rl.prompt();
      return;
    }

    const expr = multilineBuffer;
    multilineBuffer = '';
    rl.setPrompt('\x1b[36m>\x1b[0m ');

    if (!expr.trim()) {
      rl.prompt();
      return;
    }

    const result = await evaluate(expr);
    console.log(result);
    rl.prompt();
  });

  rl.on('close', () => {
    ws.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
