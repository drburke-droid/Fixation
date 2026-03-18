import { randomUUID } from 'crypto';

/** In-memory session store */
const sessions = new Map();

/** Default session configuration */
const defaultConfig = {
  distanceOpticalDistanceMm: 7620, // 25 ft
  nearDistanceMm: 600,             // 60 cm
  nearVerticalOffsetMm: 50,
  rightEyeSees: 'green',
  leftEyeSees: 'red',
  targetPreset: 'ring-cross',
  fixationLockMode: 'always',
  movementSensitivity: 'normal',
  repeatTrials: true,
  targetSizePx: 80,
  strokeWidth: 3,
  fixationLockSizePx: 20,
  backgroundColor: '#000000',
  displayPPI: 96,
  nearDisplayPPI: 132,
  displayWidthMm: null,
  displayHeightMm: null,
  nearDisplayWidthMm: null,
  nearDisplayHeightMm: null,
};

/** Create a new session */
export function createSession(configOverrides = {}) {
  const sessionId = randomUUID().slice(0, 8);
  const session = {
    sessionId,
    createdAt: new Date().toISOString(),
    patientId: '',
    examiner: '',
    phase: 'setup',
    config: { ...defaultConfig, ...configOverrides },
    clients: {
      clinician: false,
      distance: false,
      near: false,
      controller: false,
    },
    suppressionCheck: {
      completed: false,
      redSeen: null,
      greenSeen: null,
      bothSeen: null,
      result: null,
      notes: '',
    },
    calibration: {
      distance: { completed: false, centerX: 0, centerY: 0, offsetX: 0, offsetY: 0 },
      near: { completed: false, centerX: 0, centerY: 0, offsetX: 0, offsetY: 0 },
      handoff: { completed: false },
    },
    targets: {
      fixedX: 0,
      fixedY: 0,
      movableX: 0,
      movableY: 0,
      movableIsRed: true,
    },
    trials: [],
    summaryText: '',
  };
  sessions.set(sessionId, session);
  return session;
}

/** Get session by ID */
export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/** Update session fields (shallow merge) */
export function updateSession(sessionId, updates) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  Object.assign(session, updates);
  return session;
}

/** Update session config */
export function updateConfig(sessionId, configUpdates) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  Object.assign(session.config, configUpdates);
  return session;
}

/** Set client connection status */
export function setClientConnected(sessionId, role, connected) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (role in session.clients) {
    session.clients[role] = connected;
  }
  return session;
}

/** Move the movable target by delta */
export function moveTarget(sessionId, dx, dy) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.targets.movableX += dx;
  session.targets.movableY += dy;
  return session;
}

/** Reset movable target to center */
export function resetTarget(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.targets.movableX = 0;
  session.targets.movableY = 0;
  return session;
}

/** Capture current alignment as a trial */
export function captureTrial(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const phase = session.phase === 'distance-align' ? 'distance' : 'near';
  const ppi = phase === 'distance' ? session.config.displayPPI : session.config.nearDisplayPPI;
  const distanceMm = phase === 'distance'
    ? session.config.distanceOpticalDistanceMm
    : session.config.nearDistanceMm;

  const xPx = session.targets.movableX;
  const yPx = session.targets.movableY;

  // Compute measurements inline (avoid importing client-side module)
  const MM_PER_INCH = 25.4;
  const xMm = ppi > 0 ? (xPx / ppi) * MM_PER_INCH : 0;
  const yMm = ppi > 0 ? (yPx / ppi) * MM_PER_INCH : 0;
  const xRad = distanceMm > 0 ? xMm / distanceMm : 0;
  const yRad = distanceMm > 0 ? yMm / distanceMm : 0;
  const xArcMin = xRad * (180 / Math.PI) * 60;
  const yArcMin = yRad * (180 / Math.PI) * 60;
  const horizontalPrism = Math.tan(xRad) * 100;
  const verticalPrism = Math.tan(yRad) * 100;
  const vectorMm = Math.sqrt(xMm * xMm + yMm * yMm);
  const vectorRad = distanceMm > 0 ? vectorMm / distanceMm : 0;
  const vectorPrism = Math.tan(vectorRad) * 100;

  const round4 = n => Math.round(n * 10000) / 10000;

  const trial = {
    phase,
    trialNumber: session.trials.filter(t => t.phase === phase).length + 1,
    xPx: round4(xPx),
    yPx: round4(yPx),
    xMm: round4(xMm),
    yMm: round4(yMm),
    xArcMin: round4(xArcMin),
    yArcMin: round4(yArcMin),
    horizontalPrism: round4(horizontalPrism),
    verticalPrism: round4(verticalPrism),
    vectorPrism: round4(vectorPrism),
    capturedAt: new Date().toISOString(),
  };

  session.trials.push(trial);
  return { session, trial };
}

/** Update suppression check results */
export function updateSuppression(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  Object.assign(session.suppressionCheck, data);
  return session;
}

/** Update calibration data */
export function updateCalibration(sessionId, display, data) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.calibration[display]) {
    Object.assign(session.calibration[display], data);
  }
  return session;
}

/** Delete a session */
export function deleteSession(sessionId) {
  return sessions.delete(sessionId);
}

/** List all sessions */
export function listSessions() {
  return Array.from(sessions.values());
}
