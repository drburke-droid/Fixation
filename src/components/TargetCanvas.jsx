import { useRef, useEffect, useCallback } from 'react';
import { renderTargets, drawAntiBleedBackground, drawFixationLock } from '../lib/targets';

/**
 * Full-screen canvas for rendering dissociated targets and fixation lock.
 * Used by both distance and near display clients.
 * saccadeLockX: horizontal offset of fixation lock during saccade sequence (null = normal)
 */
export default function TargetCanvas({ state, flashActive = false, transitionProgress = null, displayType = 'distance', saccadeLockX = null }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !state) return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const centerX = w / 2;
    const centerY = h / 2;

    // Clear
    ctx.fillStyle = state.config?.backgroundColor || '#000000';
    ctx.fillRect(0, 0, w, h);

    // Anti-bleed background compensation — raises baseline luminance to mask filter bleed-through
    if (state.config?.antiBleedLevel > 0) {
      drawAntiBleedBackground(ctx, w, h, state.config);
    }

    const phase = state.phase;
    const ap = state.autoProtocol;

    // Auto protocol: FULL override — controls ALL rendering, never falls through
    if (ap?.active) {
      const apShowRed = ap.showRed === true;
      const apShowGreen = ap.showGreen === true;
      const apShowLock = ap.showLock === true;

      renderTargets(ctx, state, centerX, centerY, {
        showFixation: apShowLock,
        showRed: apShowRed,
        showGreen: apShowGreen,
        displayType,
        canvasHeight: h, canvasWidth: w,
      });

      // Draw instruction text — wide container, above targets
      if (ap.message) {
        const fontSize = Math.min(h * 0.06, w / 14);
        ctx.font = `500 ${fontSize}px -apple-system, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const maxW = w * 0.75;

        const allLines = [];
        for (const rawLine of ap.message.split('\n')) {
          if (!rawLine.trim()) continue;
          const words = rawLine.split(' ');
          let cur = '';
          for (const word of words) {
            const test = cur ? `${cur} ${word}` : word;
            if (ctx.measureText(test).width > maxW && cur) {
              allLines.push(cur);
              cur = word;
            } else {
              cur = test;
            }
          }
          if (cur) allLines.push(cur);
        }

        const lineH = fontSize * 1.5;
        const blockH = allLines.length * lineH;
        // Targets sit in middle 10-20% of screen. Use top and bottom zones.
        // If text fits in top zone (above 40%), put it there. Otherwise split.
        const topZoneEnd = h * 0.38;
        const bottomZoneStart = h * 0.62;

        if (blockH <= topZoneEnd - h * 0.05) {
          // Fits in top zone — center it there
          const startY = (topZoneEnd - blockH) / 2 + h * 0.03;
          allLines.forEach((line, i) => {
            ctx.fillText(line, centerX, startY + i * lineH);
          });
        } else {
          // Split: first half in top, rest in bottom
          const midIdx = Math.ceil(allLines.length / 2);
          const topLines = allLines.slice(0, midIdx);
          const bottomLines = allLines.slice(midIdx);
          const topStart = topZoneEnd - topLines.length * lineH;
          topLines.forEach((line, i) => {
            ctx.fillText(line, centerX, topStart + i * lineH);
          });
          bottomLines.forEach((line, i) => {
            ctx.fillText(line, centerX, bottomZoneStart + i * lineH);
          });
        }
      }

      animRef.current = requestAnimationFrame(draw);
      return;
    }

    // Saccade sequence — show only the fixation lock jumping horizontally (always visible, bold)
    if (saccadeLockX !== null) {
      const lockSize = (state.config?.fixationLockSizePx || 50) * 1.5;
      const lockY = h / 3;
      drawFixationLock(ctx, centerX + saccadeLockX, lockY, lockSize, '#FFFFFF', 5);
      animRef.current = requestAnimationFrame(draw);
      return;
    }

    // Color calibration — show one target at a time for dissociation verification
    if (phase === 'color-cal-distance' || phase === 'color-cal-near') {
      const step = state.colorCalibration?.step || 'red';
      const showRed = step === 'red';
      const showGreen = step === 'green';
      renderTargets(ctx, state, centerX, centerY, {
        showFixation: true,
        showRed,
        showGreen,
        flashActive,
        displayType: phase === 'color-cal-near' ? 'near' : 'distance',
        canvasHeight: h, canvasWidth: w,
      });
      // Label which color is shown
      ctx.fillStyle = '#555';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Color calibration: ${step.toUpperCase()} target only`, centerX, h - 30);
    }
    // Suppression check — selectively show targets
    else if (phase === 'suppression') {
      const suppStep = state._suppressionStep || 'both';
      const showRed = suppStep === 'red' || suppStep === 'both';
      const showGreen = suppStep === 'green' || suppStep === 'both';
      renderTargets(ctx, state, centerX, centerY, {
        showFixation: true, showRed, showGreen, flashActive, displayType, canvasHeight: h, canvasWidth: w,
      });
    }
    // Transition animation
    else if (phase === 'transition' && transitionProgress !== null) {
      const scale = 1 + transitionProgress * 1.5;
      const yShift = transitionProgress * h * 0.3;
      renderTargets(ctx, state, centerX, centerY + yShift, {
        showFixation: true, showRed: true, showGreen: true, flashActive, scale, displayType, canvasHeight: h, canvasWidth: w,
      });
    }
    // Alignment phases
    else if (phase === 'distance-align' || phase === 'near-align') {
      renderTargets(ctx, state, centerX, centerY, {
        showFixation: true, showRed: true, showGreen: true, flashActive, displayType, canvasHeight: h, canvasWidth: w,
      });
    }
    // Calibration phases
    else if (phase?.startsWith('calibration')) {
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(centerX, 0);
      ctx.lineTo(centerX, h);
      ctx.moveTo(0, centerY);
      ctx.lineTo(w, centerY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(centerX, centerY, 10, 0, Math.PI * 2);
      ctx.strokeStyle = '#FFFF00';
      ctx.lineWidth = 2;
      ctx.stroke();

      renderTargets(ctx, state, centerX, centerY, {
        showFixation: true, showRed: true, showGreen: true, flashActive, displayType, canvasHeight: h, canvasWidth: w,
      });
    }
    // Idle / waiting
    else {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#555';
      ctx.font = '16px sans-serif';
      const messages = {
        'setup': 'Connected — waiting for session to start',
        'pairing': 'Connected — waiting for all devices',
        'transition': 'Transitioning to near...',
        'results': 'Session complete',
      };
      ctx.fillText(messages[phase] || 'Connected — standby', centerX, centerY);
    }

    animRef.current = requestAnimationFrame(draw);
  }, [state, flashActive, transitionProgress, displayType, saccadeLockX]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [draw]);

  // Mirror the canvas horizontally for distance display (viewed through mirror)
  const mirrored = displayType === 'distance' && state?.config?.mirrorDistance !== false;

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: 'block',
        width: '100vw',
        height: '100vh',
        background: '#000',
        transform: mirrored ? 'scaleX(-1)' : undefined,
      }}
    />
  );
}
