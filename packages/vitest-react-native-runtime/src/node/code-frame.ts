/**
 * Code frame generation for test failure output.
 *
 * Reads source files, applies syntax highlighting via tinyhighlight,
 * and builds formatted code snippets with line numbers and error carets.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createColors } from 'picocolors';
import { highlight } from 'tinyhighlight';

const isColorEnabled = !process.env.CI && !!process.stdout.isTTY;
const pc = createColors(isColorEnabled);

export const V8_STACK_RE = /at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/;

export const HIGHLIGHT_COLORS: Record<string, (text: string) => string> = {
  Keyword: pc.magenta,
  IdentifierCapitalized: pc.yellow,
  Punctuator: pc.cyan,
  StringLiteral: pc.green,
  NoSubstitutionTemplate: pc.green,
  RegularExpressionLiteral: pc.red,
  NumericLiteral: pc.yellow,
  TemplateHead: pc.green,
  TemplateMiddle: pc.green,
  TemplateTail: pc.green,
  Invalid: (t: string) => pc.white(pc.bgRed(pc.bold(t))),
  IdentifierCallable: pc.blue,
};

export const INTERNAL_LOG_PREFIXES = [
  '[start]',
  '[run]',
  '[runner]',
  '[expect-setup]',
  '[vitest-react-native-runtime]',
  '[tree]',
  '[pool]',
];

export function isInternalLog(line: string): boolean {
  return INTERNAL_LOG_PREFIXES.some(p => line.includes(p));
}

export function highlightCode(file: string, source: string): string {
  const jsx = file.endsWith('x');
  try {
    return highlight(source, { jsx, colors: HIGHLIGHT_COLORS });
  } catch {
    return source;
  }
}

export function generateCodeFrame(file: string, line: number, column: number, range = 2): string | null {
  try {
    const absPath = resolve(process.cwd(), file);
    if (!existsSync(absPath)) return null;
    const source = readFileSync(absPath, 'utf-8');
    const lines = source.split('\n');
    const start = Math.max(0, line - 1 - range);
    const end = Math.min(lines.length, line + range);
    const pad = String(end).length;

    const snippet = lines.slice(start, end).join('\n');
    const highlighted = highlightCode(file, snippet).split('\n');

    const frame: string[] = [];
    for (let i = 0; i < highlighted.length; i++) {
      const lineIdx = start + i;
      const lineNum = String(lineIdx + 1).padStart(pad);
      if (lineIdx === line - 1) {
        frame.push(pc.red(` > ${lineNum}`) + ` | ${highlighted[i]}`);
        if (column > 0) {
          frame.push(pc.red(`   ${' '.repeat(pad)} | ${' '.repeat(column - 1)}^`));
        }
      } else {
        frame.push(pc.gray(`   ${lineNum}`) + ` | ${highlighted[i]}`);
      }
    }
    return frame.join('\n');
  } catch {
    return null;
  }
}

export interface BiRpcMessage {
  m?: string;
  a?: unknown[];
  __vitest_worker_response__?: boolean;
  __vitest_worker_request__?: boolean;
  type?: string;
  [key: string]: unknown;
}

export interface TaskError {
  message?: string;
  stack?: string;
  stackStr?: string;
  codeFrame?: string;
  [key: string]: unknown;
}

export interface TaskResult {
  errors?: TaskError[];
  [key: string]: unknown;
}

export function attachCodeFrames(msg: BiRpcMessage): void {
  if (msg?.m !== 'onTaskUpdate') return;
  const packs = msg?.a?.[0] as [string, TaskResult | undefined, unknown][] | undefined;
  if (!Array.isArray(packs)) return;

  for (const pack of packs) {
    const result = pack?.[1];
    if (!result?.errors?.length) continue;
    for (const err of result.errors) {
      if (err.codeFrame) continue;
      const stack = err.stack || err.stackStr || '';
      for (const stackLine of stack.split('\n')) {
        const match = stackLine.match(V8_STACK_RE);
        if (!match) continue;
        const [, , file, ln, col] = match;
        if (!file || file.includes('node_modules')) continue;
        const frame = generateCodeFrame(file, parseInt(ln, 10), parseInt(col, 10));
        if (frame) {
          err.codeFrame = `${pc.cyan(file)}:${pc.yellow(ln)}:${pc.yellow(col)}\n${frame}`;
          break;
        }
      }
    }
  }
}
