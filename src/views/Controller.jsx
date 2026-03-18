import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { connectToHost } from '../lib/peer';

const SENSITIVITY = {
  fine:   { baseStep: 0.5, accelDivisor: 200, maxStep: 3 },
  normal: { baseStep: 2,   accelDivisor: 100, maxStep: 15 },
  coarse: { baseStep: 5,   accelDivisor: 50,  maxStep: 40 },
};

const DEAD_ZONE = 5;
const EMIT_INTERVAL = 30;

export default function Controller() {
  const { sessionId: hostPeerId } = useParams();
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Initializing...');
  const [sensitivity, setSensitivity] = useState('normal');
  const clientRef = useRef(null);
  const touchRef = useRef({ lastX: 0, lastY: 0, lastEmit: 0 });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const promise = connectToHost(
      hostPeerId,
      'controller',
      (msg) => {
        if (!mountedRef.current) return;
        if (msg.type === 'state-updated' && msg.state?.config) {
          setSensitivity(msg.state.config.movementSensitivity || 'normal');
        }
      },
      () => {
        if (!mountedRef.current) return;
        setConnected(false);
      },
      (statusMsg) => {
        if (mountedRef.current) setStatus(statusMsg);
      },
    );

    promise.then(client => {
      if (!mountedRef.current) { client.destroy(); return; }
      clientRef.current = client;
      setConnected(true);
    });

    return () => {
      mountedRef.current = false;
      clientRef.current?.destroy();
      promise._ctrl?.destroy();
    };
  }, [hostPeerId]);

  // Watch for reconnection via status changes
  useEffect(() => {
    if (status === 'Connected!') setConnected(true);
    else if (status.includes('retrying') || status.includes('Disconnected') || status.includes('timed out')) {
      setConnected(false);
    }
  }, [status]);

  const computeStep = useCallback((dx, dy, elapsed) => {
    const sens = SENSITIVITY[sensitivity] || SENSITIVITY.normal;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < DEAD_ZONE) return { stepX: 0, stepY: 0 };
    const speed = elapsed > 0 ? distance / elapsed : 0;
    const accel = 1 + distance / sens.accelDivisor + speed * 0.5;
    const stepMag = Math.min(sens.baseStep * accel, sens.maxStep);
    return {
      stepX: (dx / distance) * stepMag,
      stepY: (dy / distance) * stepMag,
    };
  }, [sensitivity]);

  const handleTouchStart = useCallback((e) => {
    e.preventDefault();
    const touch = e.touches[0];
    touchRef.current = {
      lastX: touch.clientX,
      lastY: touch.clientY,
      lastEmit: performance.now(),
    };
  }, []);

  const handleTouchMove = useCallback((e) => {
    e.preventDefault();
    if (!connected) return;
    const now = performance.now();
    const ref = touchRef.current;
    if (now - ref.lastEmit < EMIT_INTERVAL) return;

    const touch = e.touches[0];
    const dx = touch.clientX - ref.lastX;
    const dy = touch.clientY - ref.lastY;
    const elapsed = now - ref.lastEmit;
    const { stepX, stepY } = computeStep(dx, dy, elapsed);

    if (stepX !== 0 || stepY !== 0) {
      clientRef.current?.send({
        type: 'move-target',
        dx: Math.round(stepX * 100) / 100,
        dy: Math.round(stepY * 100) / 100,
      });
    }

    ref.lastX = touch.clientX;
    ref.lastY = touch.clientY;
    ref.lastEmit = now;
  }, [computeStep, connected]);

  const handleTouchEnd = useCallback((e) => {
    e.preventDefault();
  }, []);

  useEffect(() => {
    const prevent = (e) => e.preventDefault();
    document.addEventListener('touchmove', prevent, { passive: false });
    return () => document.removeEventListener('touchmove', prevent);
  }, []);

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
        background: '#111', touchAction: 'none', userSelect: 'none',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {connected ? (
        <>
          <div style={{ color: '#3fb950', fontSize: '16px', marginBottom: '20px', textAlign: 'center' }}>
            Connected
          </div>
          <div style={{ color: '#8b949e', fontSize: '14px', textAlign: 'center', padding: '0 40px' }}>
            Swipe anywhere to move the target
          </div>
          <div style={{ color: '#484f58', fontSize: '12px', marginTop: '10px' }}>
            Sensitivity: {sensitivity}
          </div>
          <div style={{
            position: 'absolute', top: '15%', left: '10%', right: '10%', bottom: '15%',
            border: '1px dashed #21262d', borderRadius: '20px', pointerEvents: 'none',
          }} />
        </>
      ) : (
        <div style={{ textAlign: 'center', padding: '20px' }}>
          <div style={{
            width: 30, height: 30, border: '3px solid #333', borderTopColor: '#58a6ff',
            borderRadius: '50%', margin: '0 auto 16px',
            animation: 'spin 1s linear infinite',
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <div style={{ color: '#8b949e', fontSize: '14px', marginBottom: '8px', padding: '0 20px' }}>
            {status}
          </div>
          <div style={{ color: '#484f58', fontSize: '12px' }}>
            Host: {hostPeerId}
          </div>
          <div style={{ color: '#484f58', fontSize: '11px', marginTop: '16px' }}>
            Retrying automatically — keep this screen open
          </div>
        </div>
      )}
    </div>
  );
}
