/**
 * Client-side session state management.
 * Used by the clinician (host) to manage the authoritative session state.
 * Pure functions that return new state objects for React compatibility.
 */

let idCounter = 0;

function generateId() {
  return Date.now().toString(36) + (idCounter++).toString(36);
}

const defaultConfig = {
  distanceOpticalDistanceMm: 7620,
  nearDistanceMm: 600,
  nearVerticalOffsetMm: 50,
  rightEyeSees: 'green',
  leftEyeSees: 'red',
  targetPreset: 'ring-cross',
  fixationLockMode: 'always',
  movementSensitivity: 'normal',
  repeatTrials: true,
  distanceTargetSizePx: 160,
  nearTargetSizePx: 80,
  strokeWidth: 4,
  fixationLockSizePx: 30,
  backgroundColor: '#000000',
  redColor: '#FF0000',
  greenColor: '#00FF00',
  mirrorDistance: true,
  displayPPI: 96,
  nearDisplayPPI: 132,
  displayWidthMm: null,
  displayHeightMm: null,
  nearDisplayWidthMm: null,
  nearDisplayHeightMm: null,
};

export function createSession({ patientId = '', examiner = '', config = {} } = {}) {
  return {
    sessionId: generateId(),
    createdAt: new Date().toISOString(),
    patientId,
    examiner,
    phase: 'setup',
    config: { ...defaultConfig, ...config },
    clients: {
      clinician: true,
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
    colorCalibration: {
      distanceCompleted: false,
      nearCompleted: false,
      step: 'red',  // 'red' | 'green' — which target is currently shown
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
}

export function setPhase(session, phase) {
  const next = { ...session, phase };
  if (phase === 'distance-align' || phase === 'near-align') {
    next.targets = { ...session.targets, movableX: 0, movableY: 0 };
  }
  return next;
}

export function setClientConnected(session, role, connected) {
  return {
    ...session,
    clients: { ...session.clients, [role]: connected },
  };
}

export function moveTarget(session, dx, dy) {
  return {
    ...session,
    targets: {
      ...session.targets,
      movableX: session.targets.movableX + dx,
      movableY: session.targets.movableY + dy,
    },
  };
}

export function resetTarget(session) {
  return {
    ...session,
    targets: { ...session.targets, movableX: 0, movableY: 0 },
  };
}

export function updateConfig(session, configUpdates) {
  return {
    ...session,
    config: { ...session.config, ...configUpdates },
  };
}

export function updateSuppression(session, data) {
  return {
    ...session,
    suppressionCheck: { ...session.suppressionCheck, ...data, completed: true },
  };
}

export function updateCalibration(session, display, data) {
  return {
    ...session,
    calibration: {
      ...session.calibration,
      [display]: { ...session.calibration[display], ...data },
    },
  };
}

export function captureTrial(session) {
  const phase = session.phase === 'distance-align' ? 'distance' : 'near';
  const ppi = phase === 'distance' ? session.config.displayPPI : session.config.nearDisplayPPI;
  const distanceMm = phase === 'distance'
    ? session.config.distanceOpticalDistanceMm
    : session.config.nearDistanceMm;

  const xPx = session.targets.movableX;
  const yPx = session.targets.movableY;

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

  return {
    session: { ...session, trials: [...session.trials, trial] },
    trial,
  };
}
