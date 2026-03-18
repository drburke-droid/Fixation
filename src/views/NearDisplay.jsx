import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { connectToHost } from '../lib/peer';
import TargetCanvas from '../components/TargetCanvas';

export default function NearDisplay() {
  const { sessionId: hostPeerId } = useParams();
  const [state, setState] = useState(null);
  const [flashActive, setFlashActive] = useState(false);
  const [status, setStatus] = useState('Connecting...');
  const [connected, setConnected] = useState(false);
  const clientRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const promise = connectToHost(hostPeerId, 'near',
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
        setConnected(false);
      },
      (statusMsg) => {
        if (!mountedRef.current) return;
        setStatus(statusMsg);
        if (statusMsg === 'Connected!') setConnected(true);
        else if (statusMsg.includes('retrying') || statusMsg.includes('Disconnected')) setConnected(false);
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

  const handleClick = () => {
    document.documentElement.requestFullscreen?.().catch(() => {});
  };

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
      <TargetCanvas state={state} flashActive={flashActive} displayType="near" />
    </div>
  );
}
