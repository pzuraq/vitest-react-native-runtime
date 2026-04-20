import { captureScreenshot, detectPlatform } from '../node/screenshot';
import type { Platform } from '../node/types';

export function screenshot(options: { platform?: Platform; output?: string }): void {
  const platform = options.platform ?? detectPlatform();
  const result = captureScreenshot({ platform, output: options.output });
  console.log(result.filePath);
}
