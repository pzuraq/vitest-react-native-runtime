import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { parse as flatParse } from 'flatted';

vi.mock('../../src/node/environment', () => ({
  checkEnvironment: vi.fn(() => ({ ok: true, checks: [], issues: [] })),
}));

vi.mock('../../src/node/device', () => ({
  ensureDevice: vi.fn(async () => {}),
  launchApp: vi.fn(),
  stopApp: vi.fn(),
}));

vi.mock('../../src/node/harness-builder', () => ({
  detectReactNativeVersion: vi.fn(() => '0.76.0'),
  findHarnessBinary: vi.fn(() => ({
    binaryPath: '',
    bundleId: 'com.vitest.mobile.harness',
    cached: true,
    cacheKey: 'test-key',
  })),
}));

vi.mock('../../src/node/metro-runner', () => ({
  startMetroServer: vi.fn(async () => ({
    close: vi.fn(async () => {}),
  })),
}));

vi.mock('../../src/metro/generateTestRegistry', () => ({
  generateTestRegistry: vi.fn(() => ({ testFiles: [] })),
}));

vi.mock('../../src/node/instance-manager', () => ({
  resolveInstanceResources: vi.fn(async (opts: { wsPort: number; metroPort: number; appDir: string }) => ({
    instanceId: `test-${Date.now().toString(36)}`,
    wsPort: opts.wsPort,
    metroPort: opts.metroPort,
    outputDir: opts.appDir,
  })),
  registerInstanceRecord: vi.fn(),
  releaseInstanceRecord: vi.fn(),
  updateInstanceRecord: vi.fn(),
}));

import { createNativePoolWorker } from '../../src/node/pool';
import { closeServer } from '../../src/node/connections';
import { checkEnvironment } from '../../src/node/environment';
import { ensureDevice } from '../../src/node/device';
import type { NativePoolOptions } from '../../src/node/types';

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(err => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

function poolOptions(port: number, metroPort: number, appDir: string): NativePoolOptions {
  return {
    port,
    metroPort,
    platform: 'android',
    bundleId: 'com.vitest.mobile.harness',
    appDir,
    skipIfUnavailable: false,
    headless: true,
    verbose: false,
    mode: 'run',
    testInclude: ['**/*.test.ts'],
  };
}

function connectWs(port: number, platform = 'android'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 25_000;
    const attempt = (): void => {
      if (Date.now() > deadline) {
        reject(new Error('WebSocket connect timeout'));
        return;
      }
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once('open', () => {
        ws.send(JSON.stringify({ __hello: true, platform }));
        resolve(ws);
      });
      ws.once('error', () => setTimeout(attempt, 30));
    };
    attempt();
  });
}

describe('createNativePoolWorker lifecycle (mocked device / Metro / binary)', () => {
  let appDir: string;
  let metroPort: number;
  const clients: WebSocket[] = [];
  let worker: ReturnType<typeof createNativePoolWorker> | null = null;

  beforeEach(() => {
    appDir = mkdtempSync(join(tmpdir(), 'vitest-mobile-'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          text: async () => 'packager-status:running',
        } as Response),
      ),
    );
    vi.mocked(checkEnvironment).mockClear();
    vi.mocked(ensureDevice).mockClear();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      try {
        c.removeAllListeners();
        c.close();
      } catch {
        /* ignore */
      }
    }
    if (worker) {
      try {
        await worker.stop();
      } catch {
        /* ignore */
      }
      worker = null;
    }
    await closeServer();
    vi.unstubAllGlobals();
  });

  it('returns a worker with name, on, off, send, start, stop', async () => {
    const port = await reservePort();
    metroPort = await reservePort();
    worker = createNativePoolWorker(poolOptions(port, metroPort, appDir));

    expect(worker.name).toBe('native');
    expect(typeof worker.on).toBe('function');
    expect(typeof worker.off).toBe('function');
    expect(typeof worker.send).toBe('function');
    expect(typeof worker.start).toBe('function');
    expect(typeof worker.stop).toBe('function');
  });

  it('start() runs environment check and device setup when Metro is already “up” (fetch mock)', async () => {
    const port = await reservePort();
    metroPort = await reservePort();
    worker = createNativePoolWorker(poolOptions(port, metroPort, appDir));

    worker.start();
    const ws = await connectWs(port);
    clients.push(ws);
    await new Promise(r => setTimeout(r, 200));

    expect(vi.mocked(checkEnvironment)).toHaveBeenCalled();
    expect(vi.mocked(ensureDevice)).toHaveBeenCalled();
  });

  it('send() forwards non-birpc payloads to the connected WebSocket client', async () => {
    const port = await reservePort();
    metroPort = await reservePort();
    worker = createNativePoolWorker(poolOptions(port, metroPort, appDir));

    worker.start();
    const ws = await connectWs(port);
    clients.push(ws);
    await new Promise(r => setTimeout(r, 200));

    const received = new Promise<unknown>(resolve => {
      ws.once('message', data => {
        resolve(flatParse(data.toString()));
      });
    });

    worker.send({ type: 'test' } as Parameters<typeof worker.send>[0]);
    const msg = await received;
    expect(msg).toMatchObject({ type: 'test' });
  });

  it('forwards a batched run request with all files in a single WebSocket frame', async () => {
    const port = await reservePort();
    metroPort = await reservePort();
    worker = createNativePoolWorker(poolOptions(port, metroPort, appDir));

    worker.start();
    const ws = await connectWs(port);
    clients.push(ws);
    await new Promise(r => setTimeout(r, 200));

    // Frames are a mix of plain-JSON device-facing messages (__native_run_start)
    // and flatted BiRpc messages (the run request). Try each parser in turn and
    // ignore malformed frames.
    const parseAny = (raw: string): unknown => {
      try {
        return flatParse(raw);
      } catch {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
    };

    const seenFrames: string[] = [];
    const runReceived = new Promise<{ type: string; context: { files: { filepath: string }[] } }>(resolve => {
      ws.on('message', data => {
        const raw = data.toString();
        seenFrames.push(raw);
        const parsed = parseAny(raw) as { type?: string; context?: { files?: { filepath: string }[] } } | null;
        if (parsed?.type === 'run') {
          resolve(parsed as { type: string; context: { files: { filepath: string }[] } });
        }
      });
    });

    worker.send({
      __vitest_worker_request__: true,
      type: 'start',
      context: { config: {} },
    } as unknown as Parameters<typeof worker.send>[0]);

    worker.send({
      __vitest_worker_request__: true,
      type: 'run',
      context: {
        files: [{ filepath: '/abs/a.test.ts' }, { filepath: '/abs/b.test.ts' }, { filepath: '/abs/c.test.ts' }],
      },
    } as unknown as Parameters<typeof worker.send>[0]);

    const runMsg = await runReceived;
    expect(runMsg.type).toBe('run');
    expect(runMsg.context.files.map(f => f.filepath)).toEqual(['/abs/a.test.ts', '/abs/b.test.ts', '/abs/c.test.ts']);

    // Only one run frame was sent — the pool must not split the batch per-file.
    const runFrameCount = seenFrames.filter(f => {
      const parsed = parseAny(f) as { type?: string } | null;
      return parsed?.type === 'run';
    }).length;
    expect(runFrameCount).toBe(1);
  });

  it('on/off correctly adds and removes listeners', async () => {
    const port = await reservePort();
    metroPort = await reservePort();
    worker = createNativePoolWorker(poolOptions(port, metroPort, appDir));

    worker.start();
    const ws = await connectWs(port);
    clients.push(ws);
    await new Promise(r => setTimeout(r, 200));

    const received: unknown[] = [];
    const listener = (data: unknown) => received.push(data);
    worker.on('message', listener);

    ws.send(JSON.stringify({ ping: 1 }));
    await new Promise(r => setTimeout(r, 100));
    const countAfterOn = received.length;
    expect(countAfterOn).toBeGreaterThan(0);

    worker.off('message', listener);
    ws.send(JSON.stringify({ ping: 2 }));
    await new Promise(r => setTimeout(r, 100));
    expect(received.length).toBe(countAfterOn);
  });

  it('handshake: a {type:stop} request synchronously emits a stopped response', async () => {
    const port = await reservePort();
    metroPort = await reservePort();
    worker = createNativePoolWorker(poolOptions(port, metroPort, appDir));

    worker.start();
    const ws = await connectWs(port);
    clients.push(ws);
    await new Promise(r => setTimeout(r, 200));

    const stopped = new Promise<unknown>(resolve => {
      worker!.on('message', data => {
        const m = data as { type?: string; __vitest_worker_response__?: boolean };
        if (m?.__vitest_worker_response__ && m.type === 'stopped') resolve(data);
      });
    });

    worker.send({
      __vitest_worker_request__: true,
      type: 'stop',
    } as unknown as Parameters<typeof worker.send>[0]);

    const msg = await stopped;
    expect(msg).toEqual(expect.objectContaining({ __vitest_worker_response__: true, type: 'stopped' }));
  });

  it('teardown: worker.stop() in run mode notifies the device with __native_run_end', async () => {
    const port = await reservePort();
    metroPort = await reservePort();
    worker = createNativePoolWorker(poolOptions(port, metroPort, appDir));

    worker.start();
    const ws = await connectWs(port);
    clients.push(ws);
    await new Promise(r => setTimeout(r, 200));

    const endSeen = new Promise<Record<string, unknown>>(resolve => {
      ws.on('message', data => {
        const raw = data.toString();
        // __native_run_end is plain JSON, not flatted birpc.
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed?.__native_run_end === true) resolve(parsed);
        } catch {
          /* not JSON (could be flatted) — ignore */
        }
      });
    });

    await worker.stop();
    const msg = await endSeen;
    expect(msg).toMatchObject({ __native_run_end: true });
    worker = null;
  });
});
