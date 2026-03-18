import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { connectToHost } from '../lib/peer';
import TargetCanvas from '../components/TargetCanvas';

export default function NearDisplay() {
  const { sessionId: hostPeerId } = useParams();
  const [state, setState] = useState(null);
  const [flashActive, setFlashActive] = useState(false);
  const connRef = useRef(null);

  useEffect(() => {
    let destroyed = false;

    connectToHost(hostPeerId, 'near',
      (msg) => {
        if (destroyed) return;
        switch (msg.type) {
          case 'state-updated':
            setState(msg.state);
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
  }, [hostPeerId]);

  const handleClick = () => {
    document.documentElement.requestFullscreen?.().catch(() => {});
  };

  return (
    <div className="display-fullscreen" onClick={handleClick}>
      <TargetCanvas state={state} flashActive={flashActive} />
    </div>
  );
}
