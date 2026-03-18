/**
 * Measurement math module for fixation disparity quantification.
 * All geometric transforms are explicit and inspectable.
 */

const MM_PER_INCH = 25.4;
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_ARCMIN = 60;

/** Convert pixel displacement to millimeters */
export function pxToMm(px, ppi) {
  if (!ppi || ppi <= 0) return 0;
  return (px / ppi) * MM_PER_INCH;
}

/** Convert mm displacement to angle in radians (small angle approximation) */
export function mmToRad(mm, distanceMm) {
  if (!distanceMm || distanceMm <= 0) return 0;
  return mm / distanceMm;
}

/** Radians to degrees */
export function radToDeg(rad) {
  return rad * RAD_TO_DEG;
}

/** Degrees to arcminutes */
export function degToArcmin(deg) {
  return deg * DEG_TO_ARCMIN;
}

/** Radians to arcminutes */
export function radToArcmin(rad) {
  return degToArcmin(radToDeg(rad));
}

/**
 * Angle in radians to prism diopters.
 * 1 prism diopter = 1 cm deflection at 1 m = tan(angle) * 100
 */
export function radToPrismDiopters(rad) {
  return Math.tan(rad) * 100;
}

/** Compute all measurement units for a single capture */
export function computeTrialMetrics(xPx, yPx, ppi, distanceMm) {
  const xMm = pxToMm(xPx, ppi);
  const yMm = pxToMm(yPx, ppi);

  const xRad = mmToRad(xMm, distanceMm);
  const yRad = mmToRad(yMm, distanceMm);

  const xArcMin = radToArcmin(xRad);
  const yArcMin = radToArcmin(yRad);

  const horizontalPrism = radToPrismDiopters(xRad);
  const verticalPrism = radToPrismDiopters(yRad);

  const vectorMm = Math.sqrt(xMm * xMm + yMm * yMm);
  const vectorRad = mmToRad(vectorMm, distanceMm);
  const vectorPrism = radToPrismDiopters(vectorRad);

  return {
    xPx: round4(xPx),
    yPx: round4(yPx),
    xMm: round4(xMm),
    yMm: round4(yMm),
    xArcMin: round4(xArcMin),
    yArcMin: round4(yArcMin),
    horizontalPrism: round4(horizontalPrism),
    verticalPrism: round4(verticalPrism),
    vectorPrism: round4(vectorPrism),
  };
}

/**
 * Determine which eye controls the movable target.
 * Default: red target seen by left eye (green lens), movableIsRed = true → left eye.
 */
export function getMovableEye(config, targets) {
  if (targets.movableIsRed) {
    return config.leftEyeSees === 'red' ? 'left' : 'right';
  } else {
    return config.leftEyeSees === 'green' ? 'left' : 'right';
  }
}

/**
 * Get clinical prism direction labels from displacement.
 *
 * Sign convention (when movable eye = left, default setup):
 *  +X = patient moved target rightward = eso FD (crossed) = correcting prism Base-Out
 *  -X = patient moved target leftward  = exo FD (uncrossed) = correcting prism Base-In
 *  -Y = patient moved target upward    = L hyper = correcting prism Base-Down OL
 *  +Y = patient moved target downward  = L hypo (R hyper) = correcting prism Base-Up OL
 *
 * When movable eye = right, horizontal directions flip.
 */
export function getPrismLabels(xPx, yPx, config, targets) {
  const movableEye = getMovableEye(config, targets);
  const isLeft = movableEye === 'left';

  // Horizontal
  let hBase = '', hType = '';
  if (Math.abs(xPx) > 0.01) {
    const esoSign = isLeft ? 1 : -1; // +X = eso when left eye, -X = eso when right eye
    if (xPx * esoSign > 0) {
      hType = 'Eso (crossed)';
      hBase = 'BO';
    } else {
      hType = 'Exo (uncrossed)';
      hBase = 'BI';
    }
  }

  // Vertical
  let vBase = '', vType = '';
  if (Math.abs(yPx) > 0.01) {
    const eyeLabel = isLeft ? 'L' : 'R';
    // -Y (up on screen) = movable eye hyper
    if (yPx < 0) {
      vType = `${eyeLabel} Hyper`;
      vBase = `BD O${eyeLabel[0]}`;
    } else {
      vType = `${eyeLabel} Hypo`;
      vBase = `BU O${eyeLabel[0]}`;
    }
  }

  return { hBase, hType, vBase, vType, movableEye };
}

/** Format a prism value with direction label */
export function formatPrism(value, baseLabel) {
  if (Math.abs(value) < 0.01) return '0.00';
  return `${Math.abs(value).toFixed(2)} ${baseLabel}`;
}

/** Compute statistics across multiple trials */
export function computeTrialStats(trials) {
  if (!trials || trials.length === 0) return null;

  const xPxArr = trials.map(t => t.xPx);
  const yPxArr = trials.map(t => t.yPx);
  const xMmArr = trials.map(t => t.xMm);
  const yMmArr = trials.map(t => t.yMm);
  const xArcMinArr = trials.map(t => t.xArcMin);
  const yArcMinArr = trials.map(t => t.yArcMin);
  const hPrismArr = trials.map(t => t.horizontalPrism);
  const vPrismArr = trials.map(t => t.verticalPrism);

  const radialDistances = trials.map(t => Math.sqrt(t.xMm * t.xMm + t.yMm * t.yMm));

  return {
    count: trials.length,
    meanX_px: round4(mean(xPxArr)),
    meanY_px: round4(mean(yPxArr)),
    medianX_px: round4(median(xPxArr)),
    medianY_px: round4(median(yPxArr)),
    stdX_px: round4(std(xPxArr)),
    stdY_px: round4(std(yPxArr)),
    meanX_mm: round4(mean(xMmArr)),
    meanY_mm: round4(mean(yMmArr)),
    meanX_arcmin: round4(mean(xArcMinArr)),
    meanY_arcmin: round4(mean(yArcMinArr)),
    meanH_prism: round4(mean(hPrismArr)),
    meanV_prism: round4(mean(vPrismArr)),
    radialRepeatability: round4(std(radialDistances)),
    rangeX_px: round4(range(xPxArr)),
    rangeY_px: round4(range(yPxArr)),
    variabilityNote: std(radialDistances) > 2 ? 'High variability' :
                     std(radialDistances) > 1 ? 'Moderate variability' : 'Good repeatability',
  };
}

/** Generate EMR summary text */
export function generateEMRSummary(session, distanceStats, nearStats) {
  const cfg = session.config;
  const distDist = cfg.distanceOpticalDistanceMm;
  const nearDist = cfg.nearDistanceMm;

  const suppression = session.suppressionCheck;
  const suppResult = suppression.completed
    ? `red ${suppression.redSeen ? 'seen' : 'not seen'}, green ${suppression.greenSeen ? 'seen' : 'not seen'}, both ${suppression.bothSeen ? 'seen' : 'not seen'} — ${suppression.result || 'not recorded'}`
    : 'not performed';

  const distTrials = session.trials.filter(t => t.phase === 'distance');
  const nearTrials = session.trials.filter(t => t.phase === 'near');

  let distText = 'not measured';
  if (distanceStats && distTrials.length > 0) {
    distText = `X = ${distanceStats.meanX_px} px / ${distanceStats.meanX_mm} mm / ${distanceStats.meanX_arcmin} arcmin, ` +
               `Y = ${distanceStats.meanY_px} px / ${distanceStats.meanY_mm} mm / ${distanceStats.meanY_arcmin} arcmin, ` +
               `estimated prism: horiz ${distanceStats.meanH_prism} pd, vert ${distanceStats.meanV_prism} pd`;
  }

  let nearText = 'not measured';
  if (nearStats && nearTrials.length > 0) {
    nearText = `X = ${nearStats.meanX_px} px / ${nearStats.meanX_mm} mm / ${nearStats.meanX_arcmin} arcmin, ` +
               `Y = ${nearStats.meanY_px} px / ${nearStats.meanY_mm} mm / ${nearStats.meanY_arcmin} arcmin, ` +
               `estimated prism: horiz ${nearStats.meanH_prism} pd, vert ${nearStats.meanV_prism} pd`;
  }

  const repeatability = distanceStats?.variabilityNote || nearStats?.variabilityNote || 'N/A';

  return `Fixation disparity quantifier performed in-phoropter with red/green dissociation at optical distance ${Math.round(distDist / 304.8)} ft and near at ${Math.round(nearDist / 10)} cm. ` +
    `Patient completed free 2D alignment of dissociated ${cfg.targetPreset} targets using blind phone controller. ` +
    `Distance alignment offset: ${distText}. ` +
    `Near alignment offset: ${nearText}. ` +
    `Suppression check: ${suppResult}. ` +
    `Trial repeatability: ${repeatability}. ` +
    `Clinical interpretation: [enter interpretation].`;
}

// --- Utility functions ---

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1));
}

function range(arr) {
  if (arr.length === 0) return 0;
  return Math.max(...arr) - Math.min(...arr);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
