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
export function getTargetColors(config) {
  return {
    redTargetColor: config.redColor || '#FF0000',
    greenTargetColor: config.greenColor || '#00FF00',
  };
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

  // Draw fixation lock (visible to both eyes - white)
  if (showFixation) {
    const lockMode = config.fixationLockMode;
    if (lockMode === 'always' || lockMode === 'pulse' || (lockMode === 'flash' && flashActive)) {
      const alpha = lockMode === 'pulse' ? 0.5 + 0.5 * Math.sin(Date.now() / 500) : 1;
      const lockColor = `rgba(255, 255, 255, ${alpha})`;
      drawFixationLock(ctx, centerX, centerY, lockSize, lockColor, 2 * scale);
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
