import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { highlight } from 'tinyhighlight';
import {
  isInternalLog,
  highlightCode,
  generateCodeFrame,
  attachCodeFrames,
  V8_STACK_RE,
  INTERNAL_LOG_PREFIXES,
  type BiRpcMessage,
  type TaskError,
  type TaskResult,
} from '../../src/node/code-frame';

vi.mock('tinyhighlight', () => ({
  highlight: vi.fn((source: string, opts: { jsx?: boolean; colors?: unknown }) => {
    if (source === '__THROW__') throw new Error('mock tinyhighlight failure');
    return `[hl:${opts.jsx ? 'jsx' : 'js'}]${source}`;
  }),
}));

describe('INTERNAL_LOG_PREFIXES', () => {
  it('lists known internal bracket prefixes', () => {
    expect(INTERNAL_LOG_PREFIXES).toEqual([
      '[start]',
      '[run]',
      '[runner]',
      '[expect-setup]',
      '[vitest-react-native-runtime]',
      '[tree]',
      '[pool]',
    ]);
  });
});

describe('V8_STACK_RE', () => {
  it('matches common V8 stack line shapes', () => {
    expect('at foo (/src/a.ts:10:5)').toMatch(V8_STACK_RE);
    expect('at /abs/path/file.tsx:1:22').toMatch(V8_STACK_RE);
    const m = 'at myFn (/project/foo.ts:42:3)'.match(V8_STACK_RE);
    expect(m?.[2]).toBe('/project/foo.ts');
    expect(m?.[3]).toBe('42');
    expect(m?.[4]).toBe('3');
  });
});

describe('isInternalLog', () => {
  it.each([
    'prefix [start] rest',
    '[run] something',
    'x [runner] y',
    'line [expect-setup]',
    'msg [vitest-react-native-runtime] tail',
    '[tree] log',
    '[pool] init',
  ])('returns true when line contains internal marker: %s', line => {
    expect(isInternalLog(line)).toBe(true);
  });

  it('returns false for plain user log lines', () => {
    expect(isInternalLog('LOG  Hello from my test')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isInternalLog('')).toBe(false);
  });
});

describe('highlightCode', () => {
  it('returns a non-empty string for valid JS/TS source', () => {
    const out = highlightCode('file.ts', 'const x = 1;');
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('const x = 1;');
  });

  it('enables jsx highlighting for paths ending in x (.tsx, .jsx)', () => {
    vi.mocked(highlight).mockClear();
    highlightCode('Component.tsx', '<div />');
    expect(highlight).toHaveBeenCalledWith('<div />', {
      jsx: true,
      colors: expect.any(Object) as Record<string, (t: string) => string>,
    });
    highlightCode('Component.jsx', '<span />');
    expect(highlight).toHaveBeenLastCalledWith('<span />', {
      jsx: true,
      colors: expect.any(Object) as Record<string, (t: string) => string>,
    });
  });

  it('disables jsx for .ts and .js', () => {
    vi.mocked(highlight).mockClear();
    highlightCode('file.ts', 'const a = 1');
    expect(highlight).toHaveBeenCalledWith('const a = 1', {
      jsx: false,
      colors: expect.any(Object) as Record<string, (t: string) => string>,
    });
  });

  it('returns the original source when highlight throws', () => {
    const source = '__THROW__';
    expect(highlightCode('bad.ts', source)).toBe(source);
  });
});

describe('generateCodeFrame', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `codeframe-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('includes the error line marker and caret for line and column', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
    const absPath = join(tempDir, 'sample.ts');
    writeFileSync(absPath, lines.join('\n'), 'utf-8');
    const frame = generateCodeFrame(absPath, 5, 10);
    expect(frame).not.toBeNull();
    // Strip ANSI color codes before asserting on structure
    const plain = frame!.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toMatch(/>\s*5\s+\|/);
    // After `|`, one space from the template plus (column - 1) caret padding.
    expect(plain).toMatch(/\|\s{10}\^/);
  });

  it('narrows context when range is smaller', () => {
    const body = Array.from({ length: 10 }, (_, i) => `MARK_${i + 1}`);
    const absPath = join(tempDir, 'range.ts');
    writeFileSync(absPath, body.join('\n'), 'utf-8');

    const narrow = generateCodeFrame(absPath, 5, 1, 0);
    expect(narrow).toContain('MARK_5');
    expect(narrow).not.toContain('MARK_4');
    expect(narrow).not.toContain('MARK_6');

    const wide = generateCodeFrame(absPath, 5, 1, 2);
    expect(wide).toContain('MARK_3');
    expect(wide).toContain('MARK_7');
  });

  it('returns null for a non-existent file', () => {
    expect(generateCodeFrame(join(tempDir, 'missing.ts'), 1, 1)).toBeNull();
  });
});

describe('attachCodeFrames', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `attach-codeframe-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function onTaskUpdateMessage(result: TaskResult): BiRpcMessage {
    return {
      m: 'onTaskUpdate',
      a: [[['task-id', result, undefined]]],
    };
  }

  it('sets err.codeFrame from the first user-file stack frame for onTaskUpdate', () => {
    const absPath = join(tempDir, 'user.ts');
    writeFileSync(absPath, ['a', 'b', 'c', 'd', 'broken here'].join('\n'), 'utf-8');
    const stack = `Error: boom\n    at test (${absPath}:5:8)`;
    const err: TaskError = { message: 'boom', stack };
    const result: TaskResult = { errors: [err] };

    attachCodeFrames(onTaskUpdateMessage(result));

    expect(err.codeFrame).toBeDefined();
    expect(String(err.codeFrame)).toContain(absPath);
    expect(String(err.codeFrame)).toContain('5');
    expect(String(err.codeFrame)).toContain('8');
  });

  it('skips errors that already have codeFrame', () => {
    const absPath = join(tempDir, 'skip.ts');
    writeFileSync(absPath, 'x\n', 'utf-8');
    const existing = 'already attached frame';
    const err: TaskError = {
      codeFrame: existing,
      stack: `at x (${absPath}:1:1)`,
    };
    attachCodeFrames(onTaskUpdateMessage({ errors: [err] }));
    expect(err.codeFrame).toBe(existing);
  });

  it('skips stack frames that point into node_modules', () => {
    const err: TaskError = {
      stack: 'at dep (/project/node_modules/pkg/index.js:1:1)',
    };
    attachCodeFrames(onTaskUpdateMessage({ errors: [err] }));
    expect(err.codeFrame).toBeUndefined();
  });

  it('does nothing when message type is not onTaskUpdate', () => {
    const absPath = join(tempDir, 'ignored.ts');
    writeFileSync(absPath, 'y\n', 'utf-8');
    const err: TaskError = { stack: `at x (${absPath}:1:1)` };
    const msg: BiRpcMessage = { m: 'other', a: [[['id', { errors: [err] }, undefined]]] };
    attachCodeFrames(msg);
    expect(err.codeFrame).toBeUndefined();
  });

  it('does nothing when there are no errors', () => {
    const msg: BiRpcMessage = onTaskUpdateMessage({});
    expect(() => attachCodeFrames(msg)).not.toThrow();
    const msgEmpty: BiRpcMessage = onTaskUpdateMessage({ errors: [] });
    attachCodeFrames(msgEmpty);
  });
});
