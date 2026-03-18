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
  const [error, setError] = useState(null);
  const [sensitivity, setSensitivity] = useState('normal');
  const connRef = useRef(null);
  const touchRef = useRef({ lastX: 0, lastY: 0, lastEmit: 0 });
  const mountedRef = useRef(true);

  const attemptConnect = useCallback(() => {
    setConnected(false);
    setError(null);
    setStatus('Connecting...');

    // Destroy previous connection if any
    connRef.current?.destroy();
    connRef.current = null;

    connectToHost(
      hostPeerId,
      'controller',
      // onMessage
      (msg) => {
        if (!mountedRef.current) return;
        if (msg.type === 'state-updated' && msg.state?.config) {
          setSensitivity(msg.state.config.movementSensitivity || 'normal');
        }
      },
      // onDisconnect
      () => {
        if (!mountedRef.current) return;
        setConnected(false);
        setStatus('Disconnected from host');
        setError('Connection lost. Tap to retry.');
      },
      // onStatus
      (statusMsg) => {
        if (!mountedRef.current) return;
        setStatus(statusMsg);
      },
    ).then(client => {
      if (!mountedRef.current) { client.destroy(); return; }
      connRef.current = client;
      setConnected(true);
      setError(null);
      setStatus('Connected');
    }).catch(err => {
      if (!mountedRef.current) return;
      console.error('Failed to connect:', err);
      setError(`Failed: ${err?.message || err}. Tap to retry.`);
      setStatus('Not connected');
    });
  }, [hostPeerId]);

  useEffect(() => {
    mountedRef.current = true;
    attemptConnect();
    return () => {
      mountedRef.current = false;
      connRef.current?.destroy();
    };
  }, [attemptConnect]);

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
    // If not connected and user taps, retry
    if (!connected && error) {
      attemptConnect();
      return;
    }
    const touch = e.touches[0];
    touchRef.current = {
      lastX: touch.clientX,
      lastY: touch.clientY,
      lastEmit: performance.now(),
    };
  }, [connected, error, attemptConnect]);

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
      connRef.current?.send({
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
          <div style={{ color: '#8b949e', fontSize: '16px', marginBottom: '12px' }}>
            {status}
          </div>
          {error && (
            <div style={{ color: '#f85149', fontSize: '14px', marginBottom: '16px' }}>
              {error}
            </div>
          )}
          <div style={{ color: '#484f58', fontSize: '12px', marginTop: '8px' }}>
            Host: {hostPeerId}
          </div>
          {error && (
            <div style={{ color: '#58a6ff', fontSize: '14px', marginTop: '20px' }}>
              Tap anywhere to retry
            </div>
          )}
        </div>
      )}
    </div>
  );
}
