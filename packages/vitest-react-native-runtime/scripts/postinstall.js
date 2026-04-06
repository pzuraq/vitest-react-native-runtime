#!/usr/bin/env node
/**
 * Fix node-pty spawn-helper permissions on macOS.
 * npm doesn't preserve execute bits from tarballs, so spawn-helper
 * gets installed as 644 instead of 755.
 */
const { chmodSync } = require('fs');
const { join } = require('path');
const { platform, arch } = require('os');

if (platform() !== 'darwin') process.exit(0);

const ptyDir = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
const targets = [`darwin-${arch()}`, 'darwin-x64', 'darwin-arm64'];

for (const target of targets) {
  try {
    chmodSync(join(ptyDir, target, 'spawn-helper'), 0o755);
  } catch {
    // May not exist for this arch — that's fine
  }
}
