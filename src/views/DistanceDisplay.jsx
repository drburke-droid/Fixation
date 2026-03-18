import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { connectToHost } from '../lib/peer';
import TargetCanvas from '../components/TargetCanvas';

export default function DistanceDisplay() {
  const { sessionId: hostPeerId } = useParams();
  const [state, setState] = useState(null);
  const [flashActive, setFlashActive] = useState(false);
  const [transitionProgress, setTransitionProgress] = useState(null);
  const [status, setStatus] = useState('Connecting...');
  const [connected, setConnected] = useState(false);
  const [saccadeLockX, setSaccadeLockX] = useState(null);
  const clientRef = useRef(null);
  const mountedRef = useRef(true);
  const saccadeTimerRef = useRef(null);

  const runTransitionAnimation = useCallback(() => {
    const duration = 1200;
    const start = performance.now();
    const animate = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      setTransitionProgress(1 - Math.pow(1 - progress, 3));
      if (progress < 1) requestAnimationFrame(animate);
      else setTransitionProgress(null);
    };
    requestAnimationFrame(animate);
  }, []);

  const runSaccadeAnimation = useCallback((config) => {
    const { jumps, amplitude, pauseMs } = config;
    const maxAmp = Math.min(amplitude, window.innerWidth * 0.35);
    let step = 0;
    setSaccadeLockX(0);

    // Clear any existing timer
    if (saccadeTimerRef.current) clearInterval(saccadeTimerRef.current);

    // Brief initial pause showing lock at center
    setTimeout(() => {
      saccadeTimerRef.current = setInterval(() => {
        step++;
        if (step > jumps) {
          clearInterval(saccadeTimerRef.current);
          saccadeTimerRef.current = null;
          setSaccadeLockX(null); // End saccade, show targets
          return;
        }
        // Alternate left/right
        const dir = step % 2 === 1 ? 1 : -1;
        setSaccadeLockX(dir * maxAmp);
      }, pauseMs);
    }, 300);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const promise = connectToHost(hostPeerId, 'distance',
      (msg) => {
        if (!mountedRef.current) return;
        switch (msg.type) {
          case 'state-updated':
            setState(msg.state);
            if (msg.state.phase === 'transition') runTransitionAnimation();
            break;
          case 'target-moved':
            setState(prev => prev ? {
              ...prev, targets: { ...prev.targets, movableX: msg.x, movableY: msg.y }
            } : prev);
            break;
          case 'lock-flash':
            setFlashActive(true);
            setTimeout(() => setFlashActive(false), 500);
            break;
          case 'saccade-start':
            runSaccadeAnimation(msg.config);
            break;
          case 'saccade-stop':
            if (saccadeTimerRef.current) clearInterval(saccadeTimerRef.current);
            setSaccadeLockX(null);
            break;
        }
      },
      () => { if (mountedRef.current) setConnected(false); },
      (s) => {
        if (!mountedRef.current) return;
        setStatus(s);
        if (s === 'Connected!') setConnected(true);
        else if (s.includes('retrying') || s.includes('Disconnected')) setConnected(false);
      },
    );
    promise.then(client => {
      if (!mountedRef.current) { client.destroy(); return; }
      clientRef.current = client;
      setConnected(true);
    });
    return () => {
      mountedRef.current = false;
      if (saccadeTimerRef.current) clearInterval(saccadeTimerRef.current);
      clientRef.current?.destroy();
      promise._ctrl?.destroy();
    };
  }, [hostPeerId, runTransitionAnimation, runSaccadeAnimation]);

  const handleClick = () => document.documentElement.requestFullscreen?.().catch(() => {});

  if (!state || !connected) {
    return (
      <div className="display-fullscreen" onClick={handleClick}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
        <div style={{ color: '#8b949e', fontSize: '14px' }}>{status}</div>
        <div style={{ color: '#484f58', fontSize: '12px', marginTop: 8 }}>Host: {hostPeerId}</div>
        <div style={{ color: '#484f58', fontSize: '11px', marginTop: 12 }}>Retrying automatically</div>
      </div>
    );
  }

  return (
    <div className="display-fullscreen" onClick={handleClick}>
      <TargetCanvas state={state} flashActive={flashActive} transitionProgress={transitionProgress}
        displayType="distance" saccadeLockX={saccadeLockX} />
    </div>
  );
}
