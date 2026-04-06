/**
 * Sets up @vitest/expect with chai in the Hermes runtime.
 *
 * Idempotent — safe to call at module load time or from the runner.
 */

import { Locator } from './locator';

// Chai 6.x uses EventTarget for plugin events. Hermes doesn't provide it,
// so we polyfill the minimum needed before chai loads.
function ensureEventTargetPolyfill() {
  if (typeof EventTarget !== 'undefined') return;
  (globalThis as any).Event = class Event {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  };
  (globalThis as any).EventTarget = class EventTarget {
    private _listeners: Record<string, Function[]> = {};
    addEventListener(type: string, listener: Function) {
      (this._listeners[type] ??= []).push(listener);
    }
    removeEventListener(type: string, listener: Function) {
      const list = this._listeners[type];
      if (list) this._listeners[type] = list.filter(l => l !== listener);
    }
    dispatchEvent(event: any) {
      for (const listener of this._listeners[event.type] ?? []) listener(event);
      return true;
    }
  };
}

let initialized = false;
let _expect: any = null;

export function getExpect() {
  return _expect ?? (globalThis as any).expect;
}

export function setupExpect() {
  if (initialized) return;
  initialized = true;

  try {
    ensureEventTargetPolyfill();
    const chai = require('chai');
    const {
      JestChaiExpect,
      JestAsymmetricMatchers,
      JestExtend,
      GLOBAL_EXPECT,
      JEST_MATCHERS_OBJECT,
      ASYMMETRIC_MATCHERS_OBJECT,
      getState,
      setState,
    } = require('@vitest/expect');

    // Initialize global state @vitest/expect needs
    if (!(globalThis as any)[JEST_MATCHERS_OBJECT]) {
      (globalThis as any)[JEST_MATCHERS_OBJECT] = { matchers: {}, state: new WeakMap() };
    }
    if (!(globalThis as any)[ASYMMETRIC_MATCHERS_OBJECT]) {
      (globalThis as any)[ASYMMETRIC_MATCHERS_OBJECT] = {};
    }

    // Disable chai's Proxy — can cause this-binding issues in Hermes
    chai.config.useProxy = false;

    try {
      chai.use(JestChaiExpect);
    } catch (e: any) {
      console.error('[expect-setup] JestChaiExpect FAILED:', e.message);
      throw e;
    }

    try {
      chai.use(JestAsymmetricMatchers);
    } catch (e: any) {
      console.error('[expect-setup] JestAsymmetricMatchers FAILED:', e.message);
      throw e;
    }

    try {
      chai.use(JestExtend);
    } catch (e: any) {
      console.error('[expect-setup] JestExtend FAILED:', e.message);
      throw e;
    }

    // Must be a separate function, NOT chai.expect itself, to avoid recursion
    // when JestExtendPlugin defines properties on the expect object.
    const expect: any = (value: any, message?: string) => {
      const { assertionCalls } = getState(expect);
      setState({ assertionCalls: assertionCalls + 1 }, expect);
      return chai.expect(value, message);
    };
    Object.assign(expect, chai.expect);
    Object.assign(expect, (globalThis as any)[ASYMMETRIC_MATCHERS_OBJECT]);
    expect.getState = () => getState(expect);
    expect.setState = (state: any) => setState(state, expect);
    setState(
      {
        assertionCalls: 0,
        isExpectingAssertions: false,
        isExpectingAssertionsError: null,
        expectedAssertionsNumber: null,
        expectedAssertionsNumberErrorGen: null,
      },
      expect,
    );
    (globalThis as any)[GLOBAL_EXPECT] = expect;

    // Wire extend() — call as method on chai.expect to preserve `this` binding
    expect.extend = (matchers: Record<string, any>) => {
      chai.expect.extend(expect, matchers);
    };

    try {
      expect(1).toBe(1);
    } catch (e: any) {
      console.error('[expect-setup] Self-test failed:', e.message);
    }

    expect.extend({
      async toBeVisible(received: unknown) {
        if (received instanceof Locator) {
          const doesExist = await received.exists();
          if (!doesExist) {
            return { pass: false, message: () => 'Expected element to be visible but it does not exist' };
          }
          return {
            pass: true,
            message: () => 'Expected element NOT to be visible',
          };
        }
        return { pass: !!received, message: () => `Expected value to be visible` };
      },

      async toHaveText(received: unknown, expected: string) {
        if (received instanceof Locator) {
          const actual = await received.getText();
          return {
            pass: actual === expected,
            message: () => `Expected element to have text "${expected}" but got "${actual}"`,
          };
        }
        return {
          pass: String(received) === expected,
          message: () => `Expected "${received}" to have text "${expected}"`,
        };
      },

      async toContainText(received: unknown, expected: string) {
        if (received instanceof Locator) {
          const actual = await received.getText();
          return {
            pass: actual.includes(expected),
            message: () => `Expected element to contain text "${expected}" but got "${actual}"`,
          };
        }
        return { pass: String(received).includes(expected), message: () => `Expected to contain "${expected}"` };
      },
    });

    // Make expect available via import and globally
    _expect = expect;
    (globalThis as any).expect = expect;
  } catch (err: any) {
    console.error('[expect-setup] Failed to initialize @vitest/expect:', err?.message);
    console.error('[expect-setup] Falling back to minimal expect');
  }
}
