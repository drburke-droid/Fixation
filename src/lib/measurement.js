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

// ============================================================
// Feature 1: Prism Sweep / Forced Vergence FD Curve
// ============================================================

/** Convert prism diopters demand to pixel offset on display */
export function prismDioptersToPx(prismDiopters, distanceMm, ppi) {
  if (!ppi || ppi <= 0 || !distanceMm || distanceMm <= 0) return 0;
  const rad = Math.atan(prismDiopters / 100);
  const mm = rad * distanceMm;
  return (mm / 25.4) * ppi;
}

/** Compute the FD curve from prism sweep results */
export function computeFDCurve(sweepResults) {
  if (!sweepResults || sweepResults.length < 2) return null;
  const pts = sweepResults.map(r => ({ demand: r.demandPrism, fd: r.measuredFD }));
  pts.sort((a, b) => a.demand - b.demand);

  // Find x-intercept (associated phoria) by linear interpolation
  let xIntercept = null;
  for (let i = 1; i < pts.length; i++) {
    if ((pts[i - 1].fd <= 0 && pts[i].fd >= 0) || (pts[i - 1].fd >= 0 && pts[i].fd <= 0)) {
      const d0 = pts[i - 1].demand, d1 = pts[i].demand;
      const f0 = pts[i - 1].fd, f1 = pts[i].fd;
      if (f1 !== f0) xIntercept = round4(d0 - f0 * (d1 - d0) / (f1 - f0));
      break;
    }
  }

  // Slope via linear regression around center points
  const xs = pts.map(p => p.demand);
  const ys = pts.map(p => p.fd);
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxy = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sx2 = xs.reduce((a, x) => a + x * x, 0);
  const slope = n * sx2 - sx * sx !== 0 ? round4((n * sxy - sx * sy) / (n * sx2 - sx * sx)) : 0;

  return { points: pts, xIntercept, slope };
}

// ============================================================
// Feature 2: Tracking Trajectory Analysis
// ============================================================

/** Analyze continuous tracking data for drift metrics */
export function analyzeTrackingTrajectory(trackPoints) {
  if (!trackPoints || trackPoints.length < 10) return null;

  const sorted = [...trackPoints].sort((a, b) => a.t - b.t);
  const dt = sorted.map((p, i) => i > 0 ? (p.t - sorted[i - 1].t) / 1000 : 0);
  const vx = sorted.map((p, i) => i > 0 && dt[i] > 0 ? (p.x - sorted[i - 1].x) / dt[i] : 0);
  const vy = sorted.map((p, i) => i > 0 && dt[i] > 0 ? (p.y - sorted[i - 1].y) / dt[i] : 0);
  const speed = vx.map((v, i) => Math.sqrt(v * v + vy[i] * vy[i]));

  const duration = (sorted[sorted.length - 1].t - sorted[0].t) / 1000;
  const meanDriftVel = round4(mean(speed.slice(1)));
  const peakDriftVel = round4(Math.max(...speed.slice(1)));

  // Correction frequency: zero-crossings of velocity
  const xVelCrossings = zeroCrossingCount(vx.slice(1));
  const correctionFreq = duration > 0 ? round4(xVelCrossings / duration) : 0;

  // Drift bias
  const driftBiasX = round4(mean(sorted.map(p => p.x)));
  const driftBiasY = round4(mean(sorted.map(p => p.y)));

  // Dominant frequency via autocorrelation
  const sampleRate = sorted.length / Math.max(duration, 0.1);
  const domFreq = round4(dominantFrequency(sorted.map(p => p.x), sampleRate));

  return {
    durationS: round4(duration),
    samples: sorted.length,
    meanDriftVelocity: meanDriftVel,
    peakDriftVelocity: peakDriftVel,
    correctionFrequency: correctionFreq,
    driftBiasX,
    driftBiasY,
    dominantFrequency: domFreq,
  };
}

function zeroCrossingCount(arr) {
  let count = 0;
  for (let i = 1; i < arr.length; i++) {
    if ((arr[i] >= 0 && arr[i - 1] < 0) || (arr[i] < 0 && arr[i - 1] >= 0)) count++;
  }
  return count;
}

function dominantFrequency(signal, sampleRate) {
  if (signal.length < 20) return 0;
  const m = mean(signal);
  const centered = signal.map(v => v - m);
  const maxLag = Math.min(Math.floor(signal.length / 2), Math.floor(sampleRate * 2));
  let bestLag = 0, bestVal = -Infinity;
  const norm = centered.reduce((a, v) => a + v * v, 0);
  if (norm === 0) return 0;

  let foundFirstPeak = false;
  let prevAc = 1;
  for (let lag = 1; lag < maxLag; lag++) {
    let ac = 0;
    for (let i = 0; i < centered.length - lag; i++) ac += centered[i] * centered[i + lag];
    ac /= norm;
    if (!foundFirstPeak && ac < 0.5) foundFirstPeak = true;
    if (foundFirstPeak && ac > bestVal && ac > prevAc) {
      bestVal = ac;
      bestLag = lag;
    }
    prevAc = ac;
  }
  return bestLag > 0 ? sampleRate / bestLag : 0;
}

// ============================================================
// Feature 3: Recovery Dynamics Analysis
// ============================================================

/** Analyze recovery trajectory after saccade disruption */
export function analyzeRecoveryDynamics(recoveryPoints) {
  if (!recoveryPoints || recoveryPoints.length < 5) return null;

  const sorted = [...recoveryPoints].sort((a, b) => a.t - b.t);
  const t0 = sorted[0].t;
  const pts = sorted.map(p => ({ t: (p.t - t0) / 1000, x: p.x, y: p.y }));

  const peakX = Math.max(...pts.map(p => Math.abs(p.x)));
  const peakY = Math.max(...pts.map(p => Math.abs(p.y)));

  // Time to stabilize: first time displacement stays < threshold for 0.5s
  const threshold = 3; // px
  const stableWindow = 0.5; // seconds
  let timeToStabilize = pts[pts.length - 1].t;
  for (let i = 0; i < pts.length; i++) {
    const mag = Math.sqrt(pts[i].x * pts[i].x + pts[i].y * pts[i].y);
    if (mag < threshold) {
      let stable = true;
      for (let j = i; j < pts.length && pts[j].t - pts[i].t < stableWindow; j++) {
        if (Math.sqrt(pts[j].x * pts[j].x + pts[j].y * pts[j].y) >= threshold) {
          stable = false;
          break;
        }
      }
      if (stable) { timeToStabilize = round4(pts[i].t); break; }
    }
  }

  // Damping classification based on zero crossings of smoothed horizontal signal
  const smoothed = movingAverage(pts.map(p => p.x), 5);
  const crossings = zeroCrossingCount(smoothed);
  let damping = 'overdamped';
  if (crossings >= 3) damping = 'underdamped';
  else if (crossings >= 1) damping = 'critically damped';

  return {
    timeToStabilize,
    peakDisplacementX: round4(peakX),
    peakDisplacementY: round4(peakY),
    damping,
    oscillationCount: crossings,
    points: pts,
  };
}

function movingAverage(arr, window) {
  const result = [];
  const half = Math.floor(window / 2);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) {
      sum += arr[j]; count++;
    }
    result.push(sum / count);
  }
  return result;
}

// ============================================================
// Feature 5: H-V Scatter / Correlation
// ============================================================

/** Compute Pearson correlation between horizontal and vertical FD */
export function pearsonCorrelation(xs, ys) {
  if (xs.length < 2 || xs.length !== ys.length) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? round4(num / denom) : 0;
}

// ============================================================
// Post-hoc Analysis: Extract metrics from continuous signal
// ============================================================

/**
 * Analyze a continuous position signal within a time window.
 * Extracts: initial offset, settled position, time to settle, variability.
 */
export function analyzeWindow(points, windowStartMs, windowEndMs) {
  const pts = points.filter(p => p.t >= windowStartMs && p.t <= windowEndMs);
  if (pts.length < 5) return null;

  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const duration = (pts[pts.length - 1].t - pts[0].t) / 1000;

  // Initial position (mean of first 5 samples)
  const initX = mean(xs.slice(0, Math.min(5, xs.length)));
  const initY = mean(ys.slice(0, Math.min(5, ys.length)));

  // Settled position (mean of last 20% of samples)
  const tail = Math.max(3, Math.floor(xs.length * 0.2));
  const settledX = mean(xs.slice(-tail));
  const settledY = mean(ys.slice(-tail));

  // Variability of settled region
  const settledVarX = std(xs.slice(-tail));
  const settledVarY = std(ys.slice(-tail));

  // Time to settle: first time the signal stays within 3px of settled for 1s
  let timeToSettle = duration;
  const threshold = 3;
  for (let i = 0; i < pts.length; i++) {
    const dist = Math.sqrt((pts[i].x - settledX) ** 2 + (pts[i].y - settledY) ** 2);
    if (dist < threshold) {
      let stable = true;
      for (let j = i; j < pts.length && (pts[j].t - pts[i].t) < 1000; j++) {
        if (Math.sqrt((pts[j].x - settledX) ** 2 + (pts[j].y - settledY) ** 2) >= threshold) {
          stable = false; break;
        }
      }
      if (stable) { timeToSettle = round4((pts[i].t - pts[0].t) / 1000); break; }
    }
  }

  return {
    samples: pts.length,
    durationS: round4(duration),
    initialX: round4(initX),
    initialY: round4(initY),
    settledX: round4(settledX),
    settledY: round4(settledY),
    settledVarX: round4(settledVarX),
    settledVarY: round4(settledVarY),
    timeToSettleS: timeToSettle,
  };
}

/**
 * Extract per-phase metrics from an auto protocol recording.
 * Returns array of { label, analysis } for each phase marker.
 */
export function extractPhaseMetrics(positionLog, phaseMarkers) {
  if (!positionLog?.length || !phaseMarkers?.length) return [];

  const results = [];
  for (let i = 0; i < phaseMarkers.length; i++) {
    const start = phaseMarkers[i].t;
    const end = i + 1 < phaseMarkers.length ? phaseMarkers[i + 1].t : positionLog[positionLog.length - 1]?.t || start;
    const analysis = analyzeWindow(positionLog, start, end);
    if (analysis) {
      results.push({ label: phaseMarkers[i].label, start, end, ...analysis });
    }
  }
  return results;
}

/**
 * Apply simple smoothing (moving average) to position data.
 */
export function smoothPositionData(points, windowSize = 5) {
  if (points.length < windowSize) return points;
  const half = Math.floor(windowSize / 2);
  return points.map((p, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(points.length, i + half + 1);
    const slice = points.slice(start, end);
    return { ...p, x: mean(slice.map(s => s.x)), y: mean(slice.map(s => s.y)) };
  });
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
