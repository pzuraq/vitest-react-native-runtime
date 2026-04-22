/**
 * Discriminated union types for WebSocket messages between the pool worker
 * and the React Native app.
 */

import type { BiRpcMessage } from './code-frame';

export interface ScreenshotRequest {
  __screenshot_request__: true;
  requestId: string;
  name?: string;
}

export interface PauseMessage {
  __pause: true;
  label?: string;
  screenshot?: boolean;
}

export interface PauseEndedMessage {
  __pause_ended: true;
}

export interface RerunMessage {
  __rerun: true;
  label?: string;
  files?: string[];
  testNamePattern?: string;
}

export interface CancelMessage {
  __cancel: true;
}

export interface VitestWorkerContext {
  config?: Record<string, unknown> & {
    __poolMode?: string;
    testTimeout?: number;
    hookTimeout?: number;
  };
  files?: { filepath?: string }[];
}

export function isScreenshotRequest(msg: BiRpcMessage): msg is ScreenshotRequest & BiRpcMessage {
  return '__screenshot_request__' in msg && msg.__screenshot_request__ === true;
}

export function isPauseMessage(msg: BiRpcMessage): msg is PauseMessage & BiRpcMessage {
  return '__pause' in msg && msg.__pause === true;
}

export function isPauseEndedMessage(msg: BiRpcMessage): msg is PauseEndedMessage & BiRpcMessage {
  return '__pause_ended' in msg && msg.__pause_ended === true;
}

export function isRerunMessage(msg: BiRpcMessage): msg is RerunMessage & BiRpcMessage {
  return '__rerun' in msg && msg.__rerun === true;
}

export function isCancelMessage(msg: BiRpcMessage): msg is CancelMessage & BiRpcMessage {
  return '__cancel' in msg && msg.__cancel === true;
}
