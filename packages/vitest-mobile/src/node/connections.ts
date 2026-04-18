/**
 * Shared WebSocket connection manager — routes app connections to the
 * correct platform's pool worker based on a hello handshake.
 *
 * One WS server on a single port serves both iOS and Android. When an
 * app connects it sends { __hello: true, platform: "ios" }. The server
 * looks up the registered handler for that platform and hands off the
 * socket. If no handler is registered, the app gets a clear error.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { log } from './logger';

// ── Types ────────────────────────────────────────────────────────

export interface PlatformHandler {
  /** Called when a socket for this platform is accepted. */
  onConnection(socket: WebSocket): void;
}

// ── Module-level shared state ────────────────────────────────────

let _wss: WebSocketServer | null = null;
let _wssPort: number | null = null;
const _platformHandlers = new Map<string, PlatformHandler>();

// How long to wait for the hello message before closing the socket.
const HELLO_TIMEOUT_MS = 5000;

// ── Public API ───────────────────────────────────────────────────

/**
 * Register a platform's pool worker to receive connections.
 * Creates the shared WS server on first call.
 */
export function registerPlatform(platform: string, port: number, handler: PlatformHandler): void {
  _platformHandlers.set(platform, handler);
  ensureServer(port);
}

/**
 * Unregister a platform — it will no longer accept connections.
 * If no platforms remain, the server stays alive (for reconnects).
 */
export function unregisterPlatform(platform: string): void {
  _platformHandlers.delete(platform);
}

/** Close the shared server and clear all handlers. */
export function closeServer(): Promise<void> {
  _platformHandlers.clear();
  if (!_wss) return Promise.resolve();
  const wss = _wss;
  _wss = null;
  _wssPort = null;
  return new Promise(resolve => {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        /* ignore */
      }
    }
    wss.close(() => resolve());
    // Safety timeout — don't block shutdown forever. Unref so it can't
    // hold the event loop open on its own if wss.close() has already
    // resolved the promise.
    const t = setTimeout(resolve, 1000);
    (t as unknown as { unref(): void }).unref();
  });
}

// ── Internals ────────────────────────────────────────────────────

function ensureServer(port: number): void {
  if (_wss && _wssPort === port) return;
  if (_wss) {
    // Port changed — shouldn't happen in practice, but handle it
    log.warn(`WS server port changed from ${_wssPort} to ${port}, recreating`);
    _wss.close();
    _wss = null;
  }

  _wss = new WebSocketServer({ port });
  _wssPort = port;
  // Unref so the server doesn't prevent process exit
  (_wss as WebSocketServer & { _server?: { unref(): void } })._server?.unref();

  _wss.on('connection', (socket: WebSocket) => {
    // Wait for the hello message to identify the platform.
    const helloTimeout = setTimeout(() => {
      sendError(socket, 'No hello message received — closing connection.');
      socket.close();
    }, HELLO_TIMEOUT_MS);

    // Buffer messages received before hello is processed
    const buffered: Buffer[] = [];
    let identified = false;

    const onMessage = (data: Buffer) => {
      if (identified) return; // Shouldn't happen — listener is removed

      const raw = data.toString();
      try {
        const msg = JSON.parse(raw);
        if (msg?.__hello && msg.platform) {
          clearTimeout(helloTimeout);
          identified = true;
          socket.removeListener('message', onMessage);

          const handler = _platformHandlers.get(msg.platform);
          if (!handler) {
            const active = [..._platformHandlers.keys()];
            const activeStr =
              active.length > 0
                ? `Only ${active.join(', ')} ${active.length === 1 ? 'is' : 'are'} active.`
                : 'No platforms are active.';
            sendError(socket, `Vitest project for ${msg.platform} is not running. ${activeStr}`);
            socket.close();
            return;
          }

          // Hand off to the platform's pool worker
          handler.onConnection(socket);

          // Replay any messages that arrived between hello and handoff
          // (unlikely but possible with fast senders)
          for (const buf of buffered) {
            socket.emit('message', buf);
          }
          return;
        }
      } catch {
        // Not JSON or not a hello — buffer it
      }
      buffered.push(data);
    };

    socket.on('message', onMessage);
    socket.on('close', () => clearTimeout(helloTimeout));
  });

  _wss.on('error', (err: Error) => {
    log.error('WS server error:', err);
  });

  log.verbose(`WS server listening on port ${port}`);
}

function sendError(socket: WebSocket, message: string): void {
  try {
    socket.send(JSON.stringify({ __error: true, message }));
  } catch {
    /* ignore */
  }
}
