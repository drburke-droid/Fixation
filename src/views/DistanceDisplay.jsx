import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { connectToHost } from '../lib/peer';
import TargetCanvas from '../components/TargetCanvas';

export default function DistanceDisplay() {
  const { sessionId: hostPeerId } = useParams();
  const [state, setState] = useState(null);
  const [flashActive, setFlashActive] = useState(false);
  const [transitionProgress, setTransitionProgress] = useState(null);
  const connRef = useRef(null);

  const runTransitionAnimation = useCallback(() => {
    const duration = 1200;
    const start = performance.now();
    const animate = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setTransitionProgress(eased);
      if (progress < 1) requestAnimationFrame(animate);
      else setTransitionProgress(null);
    };
    requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    let destroyed = false;

    connectToHost(hostPeerId, 'distance',
      (msg) => {
        if (destroyed) return;
        switch (msg.type) {
          case 'state-updated':
            setState(msg.state);
            if (msg.state.phase === 'transition') runTransitionAnimation();
            break;
          case 'target-moved':
            setState(prev => prev ? {
              ...prev,
              targets: { ...prev.targets, movableX: msg.x, movableY: msg.y }
            } : prev);
            break;
          case 'lock-flash':
            setFlashActive(true);
            setTimeout(() => setFlashActive(false), 500);
            break;
          case 'phase-changed':
            setState(prev => prev ? { ...prev, phase: msg.phase } : prev);
            if (msg.phase === 'transition') runTransitionAnimation();
            break;
        }
      },
      () => { if (!destroyed) setState(null); }
    ).then(client => {
      if (destroyed) { client.destroy(); return; }
      connRef.current = client;
    }).catch(err => console.error('Failed to connect:', err));

    return () => {
      destroyed = true;
      connRef.current?.destroy();
    };
  }, [hostPeerId, runTransitionAnimation]);

  const handleClick = () => {
    document.documentElement.requestFullscreen?.().catch(() => {});
  };

  return (
    <div className="display-fullscreen" onClick={handleClick}>
      <TargetCanvas state={state} flashActive={flashActive} transitionProgress={transitionProgress} />
    </div>
  );
}
