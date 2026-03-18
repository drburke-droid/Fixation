import { io } from 'socket.io-client';

let socket = null;

export function getSocket() {
  if (!socket) {
    socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
    });
  }
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

// Event name constants
export const Events = {
  // Client → Server
  CREATE_SESSION: 'create-session',
  JOIN_SESSION: 'join-session',
  MOVE_TARGET: 'move-target',
  CAPTURE_TRIAL: 'capture-trial',
  ADVANCE_PHASE: 'advance-phase',
  UPDATE_CONFIG: 'update-config',
  SUPPRESSION_RESPONSE: 'suppression-response',
  FLASH_LOCK: 'flash-lock',
  TOGGLE_LOCK: 'toggle-lock',
  RESET_TARGET: 'reset-target',
  UPDATE_SENSITIVITY: 'update-sensitivity',
  CALIBRATION_UPDATE: 'calibration-update',
  UPDATE_SUMMARY: 'update-summary',

  // Server → Client
  SESSION_CREATED: 'session-created',
  SESSION_JOINED: 'session-joined',
  STATE_UPDATED: 'state-updated',
  TARGET_MOVED: 'target-moved',
  TRIAL_CAPTURED: 'trial-captured',
  PHASE_CHANGED: 'phase-changed',
  LOCK_FLASH: 'lock-flash',
  CLIENT_CONNECTED: 'client-connected',
  CLIENT_DISCONNECTED: 'client-disconnected',
  ERROR: 'error-msg',
};
