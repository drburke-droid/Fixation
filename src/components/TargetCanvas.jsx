import { useRef, useEffect, useCallback } from 'react';
import { renderTargets } from '../lib/targets';

/**
 * Full-screen canvas for rendering dissociated targets and fixation lock.
 * Used by both distance and near display clients.
 */
export default function TargetCanvas({ state, flashActive = false, transitionProgress = null }) {
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

    const phase = state.phase;

    // During suppression check, selectively show targets
    if (phase === 'suppression') {
      const suppStep = state._suppressionStep || 'both';
      const showRed = suppStep === 'red' || suppStep === 'both';
      const showGreen = suppStep === 'green' || suppStep === 'both';
      renderTargets(ctx, state, centerX, centerY, {
        showFixation: true,
        showRed,
        showGreen,
        flashActive,
      });
    }
    // During transition animation
    else if (phase === 'transition' && transitionProgress !== null) {
      const scale = 1 + transitionProgress * 1.5;
      const yShift = transitionProgress * h * 0.3;
      renderTargets(ctx, state, centerX, centerY + yShift, {
        showFixation: true,
        showRed: true,
        showGreen: true,
        flashActive,
        scale,
      });
    }
    // Normal alignment phases
    else if (phase === 'distance-align' || phase === 'near-align') {
      renderTargets(ctx, state, centerX, centerY, {
        showFixation: true,
        showRed: true,
        showGreen: true,
        flashActive,
      });
    }
    // Calibration phases
    else if (phase?.startsWith('calibration')) {
      // Show a calibration crosshair
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

      // Show center marker
      ctx.beginPath();
      ctx.arc(centerX, centerY, 10, 0, Math.PI * 2);
      ctx.strokeStyle = '#FFFF00';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Show calibration target if movable
      renderTargets(ctx, state, centerX, centerY, {
        showFixation: true,
        showRed: true,
        showGreen: true,
        flashActive,
      });
    }
    // Idle / waiting phases — show phase-appropriate status
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
  }, [state, flashActive, transitionProgress]);

  // Handle resize
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

  // Animation loop
  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width: '100vw', height: '100vh', background: '#000' }}
    />
  );
}
