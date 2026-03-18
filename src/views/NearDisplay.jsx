import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { connectToHost } from '../lib/peer';
import TargetCanvas from '../components/TargetCanvas';

export default function NearDisplay() {
  const { sessionId: hostPeerId } = useParams();
  const [state, setState] = useState(null);
  const [flashActive, setFlashActive] = useState(false);
  const [status, setStatus] = useState('Connecting...');
  const [failed, setFailed] = useState(false);
  const clientRef = useRef(null);
  const mountedRef = useRef(true);

  const doConnect = useCallback(() => {
    clientRef.current?.destroy();
    clientRef.current = null;
    setState(null);
    setFailed(false);
    setStatus('Connecting...');

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
        setStatus('Disconnected');
        setFailed(true);
      },
      (statusMsg) => { if (mountedRef.current) setStatus(statusMsg); },
    ).then(client => {
      if (!mountedRef.current) { client.destroy(); return; }
      clientRef.current = client;
      setStatus('Connected');
    }).catch(err => {
      if (!mountedRef.current) return;
      setStatus(`Failed: ${err?.message || err}`);
      setFailed(true);
    });
  }, [hostPeerId]);

  useEffect(() => {
    mountedRef.current = true;
    doConnect();
    return () => {
      mountedRef.current = false;
      clientRef.current?.destroy();
    };
  }, [doConnect]);

  const handleClick = () => {
    if (failed) { doConnect(); return; }
    document.documentElement.requestFullscreen?.().catch(() => {});
  };

  if (!state) {
    return (
      <div className="display-fullscreen" onClick={handleClick}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', cursor: 'pointer' }}>
        <div style={{ color: '#8b949e', fontSize: '14px' }}>{status}</div>
        <div style={{ color: '#484f58', fontSize: '12px', marginTop: 8 }}>Host: {hostPeerId}</div>
        {failed && <div style={{ color: '#58a6ff', fontSize: '14px', marginTop: 16 }}>Click to retry</div>}
      </div>
    );
  }

  return (
    <div className="display-fullscreen" onClick={handleClick}>
      <TargetCanvas state={state} flashActive={flashActive} displayType="near" />
    </div>
  );
}
