/**
 * Target rendering library.
 * Each target can be independently shown, hidden, recolored, scaled, and translated.
 */

/** Draw a ring (circle outline) */
export function drawRing(ctx, x, y, radius, color, strokeWidth = 3) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
}

/** Draw a cross (+) */
export function drawCross(ctx, x, y, size, color, strokeWidth = 3) {
  const half = size / 2;
  ctx.beginPath();
  ctx.moveTo(x - half, y);
  ctx.lineTo(x + half, y);
  ctx.moveTo(x, y - half);
  ctx.lineTo(x, y + half);
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** Draw fixation lock — small cross with circle */
export function drawFixationLock(ctx, x, y, size, color = '#FFFFFF', strokeWidth = 2) {
  const armLen = size / 2;
  const gap = size * 0.15;

  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';

  // Draw 4 arms with a gap in the center
  ctx.beginPath();
  // Top arm
  ctx.moveTo(x, y - gap);
  ctx.lineTo(x, y - armLen);
  // Bottom arm
  ctx.moveTo(x, y + gap);
  ctx.lineTo(x, y + armLen);
  // Left arm
  ctx.moveTo(x - gap, y);
  ctx.lineTo(x - armLen, y);
  // Right arm
  ctx.moveTo(x + gap, y);
  ctx.lineTo(x + armLen, y);
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(x, y, 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** Draw a nonius line pair (vertical lines offset horizontally) */
export function drawNoniusLines(ctx, x, y, length, color, strokeWidth = 2) {
  const half = length / 2;
  ctx.beginPath();
  ctx.moveTo(x, y - half);
  ctx.lineTo(x, y + half);
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.stroke();
}

/**
 * Target presets library.
 * Each preset defines a pair of targets for dissociated viewing.
 */
export const targetPresets = {
  'ring-cross': {
    name: 'Ring & Cross',
    description: 'Ring for one eye, cross for the other',
    drawTarget1: drawRing,    // Default: red (left eye via green lens)
    drawTarget2: drawCross,   // Default: green (right eye via red lens)
  },
  'cross-ring': {
    name: 'Cross & Ring',
    description: 'Cross for one eye, ring for the other',
    drawTarget1: drawCross,
    drawTarget2: drawRing,
  },
};

/**
 * Get target colors based on eye-color mapping configuration.
 * Red lens on right eye → right eye sees green target.
 * Green lens on left eye → left eye sees red target.
 */
/**
 * Scale a hex color by an intensity percentage (0-100).
 */
function scaleColor(hex, intensity) {
  const pct = Math.max(0, Math.min(100, intensity)) / 100;
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * pct);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * pct);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * pct);
  return `rgb(${r},${g},${b})`;
}

export function getTargetColors(config) {
  const redBase = config.redColor || '#FF0000';
  const greenBase = config.greenColor || '#00FF00';
  const redInt = config.redIntensity ?? 100;
  const greenInt = config.greenIntensity ?? 100;
  return {
    redTargetColor: scaleColor(redBase, redInt),
    greenTargetColor: scaleColor(greenBase, greenInt),
  };
}

/**
 * Draw anti-bleed background compensation.
 * Fills the entire canvas with a dim version of both target colors to raise
 * baseline luminance through each filter, masking bleed-through brightness.
 */
export function drawAntiBleedBackground(ctx, w, h, config) {
  const level = config.antiBleedLevel || 0;
  if (level <= 0) return;

  const redBase = config.redColor || '#FF0000';
  const greenBase = config.greenColor || '#00FF00';

  // Draw dim red fill across entire screen
  ctx.fillStyle = scaleColor(redBase, level);
  ctx.fillRect(0, 0, w, h);

  // Draw dim green fill on top (additive via lighter composite)
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = scaleColor(greenBase, level);
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Render all targets on canvas based on session state.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} state - session state
 * @param {number} centerX - canvas center X
 * @param {number} centerY - canvas center Y
 * @param {Object} options - { showFixation, showRed, showGreen, flashActive, scale }
 */
export function renderTargets(ctx, state, centerX, centerY, options = {}) {
  const {
    showFixation = true,
    showRed = true,
    showGreen = true,
    flashActive = false,
    scale = 1,
    displayType = 'distance', // 'distance' or 'near'
    canvasHeight = 0,
  } = options;

  const config = state.config;
  const targets = state.targets;
  const preset = targetPresets[config.targetPreset] || targetPresets['ring-cross'];
  const colors = getTargetColors(config);
  const baseSizePx = displayType === 'near'
    ? (config.nearTargetSizePx || 80)
    : (config.distanceTargetSizePx || 160);
  const targetSize = baseSizePx * scale;
  const strokeWidth = (config.strokeWidth || 4) * scale;
  const lockSize = (config.fixationLockSizePx || 30) * scale;

  // Determine which target is red and which is green
  // target1 = red (movable by default), target2 = green (fixed by default)
  const movableX = centerX + targets.movableX * scale;
  const movableY = centerY + targets.movableY * scale;
  const fixedX = centerX + targets.fixedX * scale;
  const fixedY = centerY + targets.fixedY * scale;

  // Draw fixation lock in upper 1/3 of screen (visible to both eyes - white)
  const lockY = canvasHeight > 0 ? canvasHeight / 3 : centerY;
  if (showFixation) {
    const lockMode = config.fixationLockMode;
    if (lockMode === 'always' || lockMode === 'pulse' || (lockMode === 'flash' && flashActive)) {
      const alpha = lockMode === 'pulse' ? 0.5 + 0.5 * Math.sin(Date.now() / 500) : 1;
      const lockColor = `rgba(255, 255, 255, ${alpha})`;
      drawFixationLock(ctx, centerX, lockY, lockSize, lockColor, 2 * scale);
    }
  }

  // Draw red target (movable by default)
  if (showRed) {
    if (targets.movableIsRed) {
      preset.drawTarget1(ctx, movableX, movableY, targetSize / 2, colors.redTargetColor, strokeWidth);
    } else {
      preset.drawTarget1(ctx, fixedX, fixedY, targetSize / 2, colors.redTargetColor, strokeWidth);
    }
  }

  // Draw green target (fixed by default)
  if (showGreen) {
    if (targets.movableIsRed) {
      preset.drawTarget2(ctx, fixedX, fixedY, targetSize / 2, colors.greenTargetColor, strokeWidth);
    } else {
      preset.drawTarget2(ctx, movableX, movableY, targetSize / 2, colors.greenTargetColor, strokeWidth);
    }
  }
}
