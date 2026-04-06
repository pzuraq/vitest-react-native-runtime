/**
 * Tree — view tree queries backed by the NativeHarness TurboModule.
 *
 * All queries are async (Promise-based) because native calls dispatch
 * to the main thread, which allows React/Fabric to commit view updates
 * between queries.
 */

import type { ResolvedElement } from './locator';
import NativeHarnessModule from './native-harness';
import type { ViewInfo } from './native-harness';

if (!NativeHarnessModule) {
  console.warn(
    '[vitest-react-native-runtime] NativeHarness module not available. ' +
      'View queries will not work. Make sure the app is built with native modules.',
  );
}

const NativeHarness: NonNullable<typeof NativeHarnessModule> = NativeHarnessModule!;

function makeNativeElement(info: ViewInfo, label: string): ResolvedElement {
  return { _type: 'native', nativeId: info.nativeId, info, label } as any;
}

export async function resolveByTestId(_containerRef: React.RefObject<any>, testId: string): Promise<ResolvedElement | null> {
  const info = await NativeHarness.queryByTestId(testId);
  if (!info) return null;
  return makeNativeElement(info, `testID="${testId}"`);
}

export async function resolveAllByTestId(_containerRef: React.RefObject<any>, testId: string): Promise<ResolvedElement[]> {
  const infos = await NativeHarness.queryAllByTestId(testId);
  return infos.map((info, i) => makeNativeElement(info, `testID="${testId}"[${i}]`));
}

export async function resolveByText(_containerRef: React.RefObject<any>, text: string): Promise<ResolvedElement | null> {
  const info = await NativeHarness.queryByText(text);
  if (!info) return null;
  return makeNativeElement(info, `text="${text}"`);
}

export async function resolveAllByText(_containerRef: React.RefObject<any>, text: string): Promise<ResolvedElement[]> {
  const infos = await NativeHarness.queryAllByText(text);
  return infos.map((info, i) => makeNativeElement(info, `text="${text}"[${i}]`));
}

export async function readText(element: ResolvedElement): Promise<string> {
  const el = element as any;
  return (await NativeHarness.getText(el.nativeId)) ?? '';
}

export function readProps(element: ResolvedElement): Record<string, any> {
  const el = element as any;
  const info: ViewInfo = el.info;
  return {
    testID: null,
    style: {},
    frame: info ? { x: info.x, y: info.y, width: info.width, height: info.height } : {},
  };
}

export function findHandler(
  _element: ResolvedElement,
  _propName: string,
): ((...args: any[]) => any) | undefined {
  return undefined;
}

export type { ViewTreeNode } from './native-harness';

export async function getViewTree(): Promise<import('./native-harness').ViewTreeNode | null> {
  return NativeHarness.dumpViewTree();
}

export async function getViewTreeString(options?: { maxDepth?: number }): Promise<string> {
  const tree = await NativeHarness.dumpViewTree();
  if (!tree) return '(empty)';
  return formatTreeNode(tree, 0, options?.maxDepth ?? 20);
}

function formatTreeNode(
  node: import('./native-harness').ViewTreeNode,
  depth: number,
  maxDepth: number,
): string {
  if (depth > maxDepth) return '';
  const indent = '  '.repeat(depth);
  let line = `${indent}${node.type}`;
  if (node.testID) line += ` (testID="${node.testID}")`;
  if (node.text) {
    const displayText = node.text.length > 60 ? node.text.slice(0, 57) + '...' : node.text;
    line += ` "${displayText}"`;
  }
  if (!node.visible) line += ' [hidden]';
  const lines = [line];
  for (const child of node.children) {
    const childStr = formatTreeNode(child, depth + 1, maxDepth);
    if (childStr) lines.push(childStr);
  }
  return lines.join('\n');
}

export { NativeHarness };
