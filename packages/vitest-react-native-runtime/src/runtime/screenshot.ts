/**
 * Screenshot API — request a screenshot of the running emulator/simulator.
 *
 * In connected mode: sends request to pool worker over WebSocket, host captures via adb/simctl.
 * In explorer mode: no-op (user can see the screen directly).
 */

import { requestScreenshot, isConnected } from './setup';

/**
 * Take a screenshot of the running emulator/simulator.
 * Returns the absolute file path on the host machine.
 *
 * In standalone/explorer mode, returns a placeholder since the user
 * can see the device screen directly.
 */
export async function screenshot(name?: string): Promise<string> {
  if (!isConnected()) {
    // Standalone mode — no pool to relay screenshot request to
    console.log(`[screenshot] ${name ?? 'screenshot'} (skipped — standalone mode)`);
    return `(standalone) ${name ?? 'screenshot'}`;
  }
  return requestScreenshot(name);
}
