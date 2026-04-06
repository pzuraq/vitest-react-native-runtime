/**
 * Locator — a lazy, re-evaluating reference to an element in the view tree.
 *
 * All queries are async because native view queries dispatch to the main
 * thread, allowing React/Fabric to commit view updates between queries.
 */

import { waitFor, type RetryOptions } from './retry';
import {
  resolveByTestId,
  resolveByText,
  resolveAllByTestId,
  resolveAllByText,
  readText,
  readProps,
  NativeHarness,
} from './tree';

export class Locator {
  private _resolve: () => Promise<ResolvedElement | null>;
  private _description: string;

  constructor(resolve: () => Promise<ResolvedElement | null>, description: string) {
    this._resolve = resolve;
    this._description = description;
  }

  private async _get(): Promise<ResolvedElement> {
    const el = await this._resolve();
    if (!el) {
      throw new Error(`Locator could not find element: ${this._description}`);
    }
    return el;
  }

  async getText(): Promise<string> {
    const el = await this._get();
    return readText(el);
  }

  get props(): Record<string, any> {
    // readProps is synchronous (reads cached info)
    return {};
  }

  async exists(): Promise<boolean> {
    return (await this._resolve()) !== null;
  }

  async tap(): Promise<void> {
    const el = await this._get();
    const info = (el as any).info;
    const cx = info.x + info.width / 2;
    const cy = info.y + info.height / 2;
    await NativeHarness.simulatePress((el as any).nativeId, cx, cy);
    // Flush the native event pipeline: each round-trip through the UI thread
    // ensures pending work (event delivery, React callbacks, Fabric commit)
    // has been processed before the next interaction.
    // On iOS: dispatch_async(main_queue) — matches Hammer's marker approach
    // On Android: Choreographer frame callback — matches EventBeat's vsync
    await NativeHarness.flushUIQueue();
    await NativeHarness.flushUIQueue();
  }

  async longPress(): Promise<void> {
    await this.tap();
  }

  async type(text: string): Promise<void> {
    const el = await this._get();
    await NativeHarness.typeIntoView((el as any).nativeId, text);
  }

  toString(): string {
    return `Locator(${this._description})`;
  }
}

export type ResolvedElement = { _type: 'native'; nativeId: string; info: any; label: string };

export interface LocatorAPI {
  getByTestId(testId: string): Locator;
  getByText(text: string): Locator;
  getAllByTestId(testId: string): Promise<Locator[]>;
  getAllByText(text: string): Promise<Locator[]>;
  queryByTestId(testId: string): Promise<Locator | null>;
  queryByText(text: string): Promise<Locator | null>;
  findByTestId(testId: string, options?: RetryOptions): Promise<Locator>;
  findByText(text: string, options?: RetryOptions): Promise<Locator>;
}

export function createLocatorAPI(ref: React.RefObject<any>): LocatorAPI {
  function getByTestId(testId: string): Locator {
    const containerRef = ref;
    return new Locator(
      () => resolveByTestId(containerRef, testId),
      `testID="${testId}"`,
    );
  }

  function getByText(text: string): Locator {
    const containerRef = ref;
    return new Locator(
      () => resolveByText(containerRef, text),
      `text="${text}"`,
    );
  }

  async function getAllByTestId(testId: string): Promise<Locator[]> {
    const containerRef = ref;
    const elements = await resolveAllByTestId(containerRef, testId);
    return elements.map((_, i) =>
      new Locator(
        async () => {
          const all = await resolveAllByTestId(containerRef, testId);
          return all[i] ?? null;
        }, `testID="${testId}"[${i}]`),
    );
  }

  async function getAllByText(text: string): Promise<Locator[]> {
    const containerRef = ref;
    const elements = await resolveAllByText(containerRef, text);
    return elements.map((_, i) =>
      new Locator(
        async () => {
          const all = await resolveAllByText(containerRef, text);
          return all[i] ?? null;
        }, `text="${text}"[${i}]`),
    );
  }

  async function queryByTestId(testId: string): Promise<Locator | null> {
    const locator = getByTestId(testId);
    return (await locator.exists()) ? locator : null;
  }

  async function queryByText(text: string): Promise<Locator | null> {
    const locator = getByText(text);
    return (await locator.exists()) ? locator : null;
  }

  async function findByTestId(testId: string, options?: RetryOptions): Promise<Locator> {
    const locator = getByTestId(testId);
    await waitFor(async () => {
      if (!(await locator.exists())) {
        throw new Error(`Unable to find element with testID: ${testId}`);
      }
    }, options);
    return locator;
  }

  async function findByText(text: string, options?: RetryOptions): Promise<Locator> {
    const locator = getByText(text);
    await waitFor(async () => {
      if (!(await locator.exists())) {
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
