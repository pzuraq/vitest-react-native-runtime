/**
 * Locator — a lazy, re-evaluating reference to an element in the view tree.
 *
 * Mirrors the Vitest Browser Mode Locator API structure:
 * - query(), element(), elements() are sync (native queries via JSI)
 * - text, exists, props are sync convenience getters
 * - tap(), type() are async (involve timing/side effects)
 */

import { waitFor, type RetryOptions } from './retry';
import type { ViewInfo } from './native-harness';
import {
  resolveByTestId,
  resolveByText,
  resolveAllByTestId,
  resolveAllByText,
  readText,
  readProps,
  findHandler,
  Harness,
} from './tree';
import { g } from './global-types';

export class Locator {
  private _resolve: () => ResolvedElement | null;
  private _description: string;

  constructor(resolve: () => ResolvedElement | null, description: string) {
    this._resolve = resolve;
    this._description = description;
  }

  // ── Browser Mode-aligned query methods (sync) ──

  /** Returns the resolved element or null. Like browser's locator.query(). */
  query(): ResolvedElement | null {
    return this._resolve();
  }

  /** Returns the resolved element. Throws if not found. Like browser's locator.element(). */
  element(): ResolvedElement {
    const el = this._resolve();
    if (!el) {
      throw new Error(`Locator could not find element: ${this._description}`);
    }
    return el;
  }

  /** Returns all matched elements as an array. Like browser's locator.elements(). */
  elements(): ResolvedElement[] {
    const el = this._resolve();
    return el ? [el] : [];
  }

  // ── Convenience getters (mobile-specific) ──

  /** Sync text content of the element. Throws if element not found. */
  get text(): string {
    return readText(this.element());
  }

  /** Sync check if element exists. */
  get exists(): boolean {
    return this._resolve() !== null;
  }

  /** Sync props (frame info) of the element. */
  get props(): Record<string, unknown> {
    return readProps(this.element());
  }

  // ── Actions (async) ──

  async tap(): Promise<void> {
    const el = await waitFor(() => {
      const resolved = this._resolve();
      if (!resolved) throw new Error(`Locator could not find element: ${this._description}`);
      return resolved;
    });
    const { info } = el;
    if (info && Harness?.simulatePress) {
      const cx = info.x + info.width / 2;
      const cy = info.y + info.height / 2;
      await Harness.simulatePress(el.nativeId, cx, cy);
      await Harness.flushUIQueue();
      await new Promise<void>(r => g.setImmediate?.(r) ?? setTimeout(r, 0));
      await Harness.flushUIQueue();
    } else {
      const handler = findHandler(el, 'onPress');
      if (!handler) throw new Error(`No onPress handler found on element: ${this._description}`);
      handler();
    }
  }

  async longPress(): Promise<void> {
    const el = await waitFor(() => {
      const resolved = this._resolve();
      if (!resolved) throw new Error(`Locator could not find element: ${this._description}`);
      return resolved;
    });
    const handler = findHandler(el, 'onLongPress');
    if (!handler) throw new Error(`No onLongPress handler found on element: ${this._description}`);
    handler();
  }

  async type(text: string): Promise<void> {
    const el = await waitFor(() => {
      const resolved = this._resolve();
      if (!resolved) throw new Error(`Locator could not find element: ${this._description}`);
      return resolved;
    });
    if (el.nativeId && Harness?.typeIntoView) {
      await Harness.typeIntoView(el.nativeId, text);
    } else {
      const handler = findHandler(el, 'onChangeText');
      if (!handler) throw new Error(`No onChangeText handler found on element: ${this._description}`);
      handler(text);
    }
  }

  toString(): string {
    return `Locator(${this._description})`;
  }
}

export type ResolvedElement = { _type: 'native'; nativeId: string; info: ViewInfo; label: string };

export interface LocatorAPI {
  getByTestId(testId: string): Locator;
  getByText(text: string): Locator;
  getAllByTestId(testId: string): Locator[];
  getAllByText(text: string): Locator[];
  queryByTestId(testId: string): Locator | null;
  queryByText(text: string): Locator | null;
  findByTestId(testId: string, options?: RetryOptions): Promise<Locator>;
  findByText(text: string, options?: RetryOptions): Promise<Locator>;
}

export function createLocatorAPI(): LocatorAPI {
  function getByTestId(testId: string): Locator {
    return new Locator(() => resolveByTestId(testId), `testID="${testId}"`);
  }

  function getByText(text: string): Locator {
    return new Locator(() => resolveByText(text), `text="${text}"`);
  }

  function getAllByTestId(testId: string): Locator[] {
    const elements = resolveAllByTestId(testId);
    return elements.map(
      (_, i) =>
        new Locator(() => {
          const all = resolveAllByTestId(testId);
          return all[i] ?? null;
        }, `testID="${testId}"[${i}]`),
    );
  }

  function getAllByText(text: string): Locator[] {
    const elements = resolveAllByText(text);
    return elements.map(
      (_, i) =>
        new Locator(() => {
          const all = resolveAllByText(text);
          return all[i] ?? null;
        }, `text="${text}"[${i}]`),
    );
  }

  function queryByTestId(testId: string): Locator | null {
    const locator = getByTestId(testId);
    return locator.exists ? locator : null;
  }

  function queryByText(text: string): Locator | null {
    const locator = getByText(text);
    return locator.exists ? locator : null;
  }

  async function findByTestId(testId: string, options?: RetryOptions): Promise<Locator> {
    const locator = getByTestId(testId);
    await waitFor(() => {
      if (!locator.exists) {
        throw new Error(`Unable to find element with testID: ${testId}`);
      }
    }, options);
    return locator;
  }

  async function findByText(text: string, options?: RetryOptions): Promise<Locator> {
    const locator = getByText(text);
    await waitFor(() => {
      if (!locator.exists) {
        throw new Error(`Unable to find element with text: ${text}`);
      }
    }, options);
    return locator;
  }

  return {
    getByTestId,
    getByText,
    getAllByTestId,
    getAllByText,
    queryByTestId,
    queryByText,
    findByTestId,
    findByText,
  };
}
