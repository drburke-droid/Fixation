import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { connectToHost } from '../lib/peer';
import TargetCanvas from '../components/TargetCanvas';

export default function NearDisplay() {
  const { sessionId: hostPeerId } = useParams();
  const [state, setState] = useState(null);
  const [flashActive, setFlashActive] = useState(false);
  const [status, setStatus] = useState('Connecting...');
  const [error, setError] = useState(null);
  const connRef = useRef(null);
  const mountedRef = useRef(true);

  const attemptConnect = useCallback(() => {
    setError(null);
    setStatus('Connecting...');
    connRef.current?.destroy();

    connectToHost(hostPeerId, 'near',
      (msg) => {
        if (!mountedRef.current) return;
        switch (msg.type) {
          case 'state-updated':
            setState(msg.state);
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
        }
      },
      () => {
        if (!mountedRef.current) return;
        setState(null);
        setError('Disconnected. Click to retry.');
      },
      (statusMsg) => {
        if (mountedRef.current) setStatus(statusMsg);
      },
    ).then(client => {
      if (!mountedRef.current) { client.destroy(); return; }
      connRef.current = client;
      setStatus('Connected');
    }).catch(err => {
      if (!mountedRef.current) return;
      setError(`${err?.message || err}. Click to retry.`);
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

  const handleClick = () => {
    if (error) { attemptConnect(); return; }
    document.documentElement.requestFullscreen?.().catch(() => {});
  };

  if (!state) {
    return (
      <div className="display-fullscreen" onClick={handleClick}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', cursor: 'pointer' }}>
        <div style={{ color: '#8b949e', fontSize: '16px' }}>{status}</div>
        {error && <div style={{ color: '#f85149', fontSize: '14px', marginTop: 8 }}>{error}</div>}
        <div style={{ color: '#484f58', fontSize: '12px', marginTop: 8 }}>Host: {hostPeerId}</div>
      </div>
    );
  }

  return (
    <div className="display-fullscreen" onClick={handleClick}>
      <TargetCanvas state={state} flashActive={flashActive} />
    </div>
  );
}
