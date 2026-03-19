/**
 * Target rendering library.
 * Each target can be independently shown, hidden, recolored, scaled, and translated.
 */

// --- Basic shape drawing functions ---

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

/** Draw a triangle (roof) — apex at top, base at center line */
export function drawTriangleRoof(ctx, x, y, size, color, strokeWidth = 3) {
  const half = size;
  ctx.beginPath();
  ctx.moveTo(x, y - half);           // apex
  ctx.lineTo(x + half * 0.8, y);     // base right
  ctx.lineTo(x - half * 0.8, y);     // base left
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/** Draw a square (base) — top edge at center, extends downward */
export function drawSquareBase(ctx, x, y, size, color, strokeWidth = 3) {
  const side = size * 1.4;
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = 'round';
  ctx.strokeRect(x - side / 2, y, side, side);
}

/** Draw a vertical line */
export function drawVerticalLine(ctx, x, y, size, color, strokeWidth = 3) {
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x, y + size);
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** Draw a horizontal line */
export function drawHorizontalLine(ctx, x, y, size, color, strokeWidth = 3) {
  ctx.beginPath();
  ctx.moveTo(x - size, y);
  ctx.lineTo(x + size, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** Draw downward-pointing arrow (long tail, prominent head) */
export function drawArrowDown(ctx, x, y, size, color, strokeWidth = 3) {
  const tailLen = size * 1.8;
  const headLen = size * 0.6;
  const headW = size * 0.5;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Tail
  ctx.beginPath();
  ctx.moveTo(x, y - tailLen);
  ctx.lineTo(x, y + headLen * 0.3);
  ctx.stroke();
  // Arrowhead
  ctx.beginPath();
  ctx.moveTo(x, y + headLen);
  ctx.lineTo(x - headW, y - headLen * 0.2);
  ctx.lineTo(x + headW, y - headLen * 0.2);
  ctx.closePath();
  ctx.fill();
}

/** Draw upward-pointing arrow (long tail, prominent head) */
export function drawArrowUp(ctx, x, y, size, color, strokeWidth = 3) {
  const tailLen = size * 1.8;
  const headLen = size * 0.6;
  const headW = size * 0.5;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Tail
  ctx.beginPath();
  ctx.moveTo(x, y + tailLen);
  ctx.lineTo(x, y - headLen * 0.3);
  ctx.stroke();
  // Arrowhead
  ctx.beginPath();
  ctx.moveTo(x, y - headLen);
  ctx.lineTo(x - headW, y + headLen * 0.2);
  ctx.lineTo(x + headW, y + headLen * 0.2);
  ctx.closePath();
  ctx.fill();
}

/** Draw fixation lock — bold cross with gap and center dot */
export function drawFixationLock(ctx, x, y, size, color = '#FFFFFF', strokeWidth = 3) {
  const armLen = size / 2;
  const gap = size * 0.12;
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y - gap); ctx.lineTo(x, y - armLen);
  ctx.moveTo(x, y + gap); ctx.lineTo(x, y + armLen);
  ctx.moveTo(x - gap, y); ctx.lineTo(x - armLen, y);
  ctx.moveTo(x + gap, y); ctx.lineTo(x + armLen, y);
  ctx.stroke();
  // Bold center dot
  ctx.beginPath();
  ctx.arc(x, y, strokeWidth, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// --- Paragraph text for alternating word target ---

const PARAGRAPH_WORDS = [
  'The', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy',
  'dog', 'while', 'the', 'bright', 'sun', 'sets', 'behind', 'the',
  'distant', 'hills', 'and', 'the', 'cool', 'evening', 'breeze',
  'carries', 'the', 'sweet', 'scent', 'of', 'flowers', 'through',
  'the', 'quiet', 'village', 'streets', 'as', 'birds', 'return',
  'to', 'their', 'nests', 'and', 'children', 'play', 'softly',
  'in', 'the', 'warm', 'garden', 'light', 'before', 'the', 'stars',
  'appear', 'above', 'the', 'trees',
];

/**
 * Lay out paragraph words into lines that fit within maxWidth.
 * Returns array of { word, index, x, y } objects.
 */
function layoutParagraph(ctx, fontSize, maxWidth, startX, startY) {
  ctx.font = `${fontSize}px sans-serif`;
  const spaceWidth = ctx.measureText(' ').width;
  const lineHeight = fontSize * 1.5;
  const layout = [];
  let lineX = 0;
  let lineY = 0;

  for (let i = 0; i < PARAGRAPH_WORDS.length; i++) {
    const word = PARAGRAPH_WORDS[i];
    const wordWidth = ctx.measureText(word).width;

    if (lineX + wordWidth > maxWidth && lineX > 0) {
      lineX = 0;
      lineY += lineHeight;
    }

    layout.push({
      word,
      index: i,
      x: startX + lineX,
      y: startY + lineY,
      width: wordWidth,
    });

    lineX += wordWidth + spaceWidth;
  }

  return layout;
}

// --- Target presets ---

export const targetPresets = {
  'ring-cross': {
    name: 'Ring & Cross',
    description: 'Ring for one eye, cross for the other',
    drawTarget1: drawRing,
    drawTarget2: drawCross,
  },
  'cross-ring': {
    name: 'Cross & Ring',
    description: 'Cross for one eye, ring for the other',
    drawTarget1: drawCross,
    drawTarget2: drawRing,
  },
  'triangle-square': {
    name: 'Triangle & Square (House)',
    description: 'Triangle roof + square base — aligned they form a house',
    drawTarget1: drawTriangleRoof,
    drawTarget2: drawSquareBase,
  },
  'vert-horiz': {
    name: 'Vertical & Horizontal (Plus)',
    description: 'Vertical line + horizontal line — aligned they form a plus sign',
    drawTarget1: drawVerticalLine,
    drawTarget2: drawHorizontalLine,
  },
  'arrows-vert': {
    name: 'Opposing Arrows (Vertical align)',
    description: 'Arrow pointing down + arrow pointing up — vertical alignment only',
    drawTarget1: drawArrowDown,
    drawTarget2: drawArrowUp,
  },
  'paragraph': {
    name: 'Alternating Word Paragraph',
    description: 'Text paragraph with alternating colored words',
    customRender: true,
  },
};

// --- Color utilities ---

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

export function drawAntiBleedBackground(ctx, w, h, config) {
  const level = config.antiBleedLevel || 0;
  if (level <= 0) return;
  const redBase = config.redColor || '#FF0000';
  const greenBase = config.greenColor || '#00FF00';
  ctx.fillStyle = scaleColor(redBase, level);
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = scaleColor(greenBase, level);
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
}

// --- Main render function ---

export function renderTargets(ctx, state, centerX, centerY, options = {}) {
  const {
    showFixation = true,
    showRed = true,
    showGreen = true,
    flashActive = false,
    scale = 1,
    displayType = 'distance',
    canvasHeight = 0,
    canvasWidth = 0,
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

  const movableX = centerX + targets.movableX * scale;
  const movableY = centerY + targets.movableY * scale;
  const fixedX = centerX + targets.fixedX * scale;
  const fixedY = centerY + targets.fixedY * scale;

  // Draw fixation lock in upper 1/3 of screen
  const lockY = canvasHeight > 0 ? canvasHeight / 3 : centerY;
  // showFixation=false means NO LOCK, period. Overrides lockMode.
  if (showFixation === true) {
    const lockMode = config.fixationLockMode;
    if (lockMode !== 'off') {
      const alpha = lockMode === 'pulse' ? 0.5 + 0.5 * Math.sin(Date.now() / 500) : 1;
      const lockColor = `rgba(255, 255, 255, ${alpha})`;
      drawFixationLock(ctx, centerX, lockY, lockSize, lockColor, 4 * scale);
    }
  }

  // --- Paragraph preset: custom interleaved word rendering ---
  if (preset.customRender && config.targetPreset === 'paragraph') {
    const fontSize = displayType === 'near'
      ? (config.paragraphFontSizeNear || 15)
      : (config.paragraphFontSizeDistance || 56);
    const scaledFontSize = fontSize * scale;
    const w = canvasWidth || centerX * 2;
    const maxWidth = w * 0.75;
    const startX = centerX - maxWidth / 2;
    const startY = centerY - scaledFontSize * 3; // start above center

    ctx.font = `${scaledFontSize}px sans-serif`;
    ctx.textBaseline = 'top';

    const layout = layoutParagraph(ctx, scaledFontSize, maxWidth, startX, startY);

    for (const item of layout) {
      const isOdd = item.index % 2 === 1;
      // Odd-indexed words = color1 (red by default, movable)
      // Even-indexed words = color2 (green by default, fixed)
      const isMovableColor = targets.movableIsRed ? !isOdd : isOdd;

      if (isMovableColor) {
        // This word belongs to the movable target color
        if (!showRed && targets.movableIsRed) continue;
        if (!showGreen && !targets.movableIsRed) continue;
        ctx.fillStyle = targets.movableIsRed ? colors.redTargetColor : colors.greenTargetColor;
        ctx.fillText(item.word, item.x + targets.movableX * scale, item.y + targets.movableY * scale);
      } else {
        // This word belongs to the fixed target color
        if (!showGreen && targets.movableIsRed) continue;
        if (!showRed && !targets.movableIsRed) continue;
        ctx.fillStyle = targets.movableIsRed ? colors.greenTargetColor : colors.redTargetColor;
        ctx.fillText(item.word, item.x + targets.fixedX * scale, item.y + targets.fixedY * scale);
      }
    }
    return;
  }

  // --- Standard two-target presets ---
  if (showRed) {
    if (targets.movableIsRed) {
      preset.drawTarget1(ctx, movableX, movableY, targetSize / 2, colors.redTargetColor, strokeWidth);
    } else {
      preset.drawTarget1(ctx, fixedX, fixedY, targetSize / 2, colors.redTargetColor, strokeWidth);
    }
  }

  if (showGreen) {
    if (targets.movableIsRed) {
      preset.drawTarget2(ctx, fixedX, fixedY, targetSize / 2, colors.greenTargetColor, strokeWidth);
    } else {
      preset.drawTarget2(ctx, movableX, movableY, targetSize / 2, colors.greenTargetColor, strokeWidth);
    }
  }
}
