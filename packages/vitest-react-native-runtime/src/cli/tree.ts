/**
 * vitest-react-native-runtime tree — dump the view hierarchy via CDP.
 *
 * Connects to the running app via Chrome DevTools Protocol and calls
 * the runtime's view tree dump function.
 *
 * Usage: npx vitest-react-native-runtime tree [--json]
 */

import http from 'node:http';
import WebSocket from 'ws';

const jsonMode = process.argv.includes('--json');
const metroPort = parseInt(process.env.METRO_PORT ?? '8081', 10);

interface CDPTarget {
  id: string;
  title: string;
  webSocketDebuggerUrl: string;
}

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
    req.on('error', (err) => reject(new Error(`Cannot reach Metro: ${err.message}`)));
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function connectCDP(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(new Error(`CDP error: ${err.message}`)));
    setTimeout(() => { ws.close(); reject(new Error('CDP timeout')); }, 5000);
  });
}

function cdpEval(ws: WebSocket, expression: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        if (msg.result?.exceptionDetails) {
          reject(new Error(msg.result.exceptionDetails.text ?? 'Eval error'));
        } else {
          resolve(msg.result?.result?.value);
        }
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    setTimeout(() => { ws.removeListener('message', handler); reject(new Error('Eval timeout')); }, 10000);
  });
}

async function main() {
  const targets = await getTargets();
  if (targets.length === 0) {
    console.error('No debuggable targets. Is the app running and connected to Metro?');
    process.exit(1);
  }

  const ws = await connectCDP(targets[0].webSocketDebuggerUrl);
  await cdpEval(ws, '1'); // enable Runtime

  // Try to get the view tree from the runtime
  const expression = jsonMode
    ? `(function() {
        try {
          const { getViewTree } = require('vitest-react-native-runtime/runtime');
          return JSON.stringify(getViewTree(), null, 2);
        } catch(e) { return JSON.stringify({ error: e.message }); }
      })()`
    : `(function() {
        try {
          const { getViewTreeString } = require('vitest-react-native-runtime/runtime');
          return getViewTreeString();
        } catch(e) { return 'Error: ' + e.message; }
      })()`;

  const result = await cdpEval(ws, expression);
  console.log(result ?? '(no output)');
  ws.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
