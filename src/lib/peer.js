import { Peer } from 'peerjs';

/**
 * PeerJS wrapper for WebRTC peer-to-peer communication.
 * Clinician acts as host; display clients and controller connect as peers.
 */

const PEER_OPEN_TIMEOUT = 10000;
const CONN_TIMEOUT = 10000;
const MAX_RETRIES = 5;
const RETRY_DELAY = 2000;

/**
 * Wait for a Peer to open, with timeout.
 */
function waitForPeerOpen(peer, timeout = PEER_OPEN_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (peer.open) { resolve(peer.id); return; }
    const timer = setTimeout(() => {
      reject(new Error('Peer open timed out'));
    }, timeout);
    peer.on('open', (id) => { clearTimeout(timer); resolve(id); });
    peer.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Create a PeerJS host (clinician side).
 */
export function createHost(onPeerConnect, onPeerDisconnect, onMessage, customId = null) {
  return new Promise((resolve, reject) => {
    const peerId = customId ? `fdq-${customId}` : undefined;
    const peer = peerId ? new Peer(peerId) : new Peer();
    const connections = new Map();

    waitForPeerOpen(peer).then((id) => {
      console.log('Host peer opened:', id);

      peer.on('connection', (conn) => {
        console.log('Incoming connection from:', conn.peer);

        conn.on('open', () => {
          console.log('Connection open with:', conn.peer);
        });

        conn.on('data', (msg) => {
          if (msg.type === 'join') {
            connections.set(msg.role, conn);
            conn._role = msg.role;
            onPeerConnect?.(msg.role, conn);
          }
          onMessage?.(msg, conn);
        });

        conn.on('close', () => {
          if (conn._role) {
            connections.delete(conn._role);
            onPeerDisconnect?.(conn._role);
          }
        });

        conn.on('error', (err) => {
          console.error('Connection error:', err);
          if (conn._role) {
            connections.delete(conn._role);
            onPeerDisconnect?.(conn._role);
          }
        });
      });

      resolve({
        peer,
        peerId: id,
        connections,
        broadcast: (msg) => {
          for (const conn of connections.values()) {
            if (conn.open) conn.send(msg);
          }
        },
        sendTo: (role, msg) => {
          const conn = connections.get(role);
          if (conn?.open) conn.send(msg);
        },
        destroy: () => {
          for (const conn of connections.values()) conn.close();
          peer.destroy();
        },
      });
    }).catch((err) => {
      console.error('Host peer error:', err);
      peer.destroy();
      reject(err);
    });
  });
}

/**
 * Connect to a PeerJS host (display / controller side).
 * Creates one Peer, then retries the connection to the host automatically.
 */
export function connectToHost(hostPeerId, role, onMessage, onDisconnect, onStatus) {
  let destroyed = false;
  let peer = null;
  let activeConn = null;

  const result = {
    send: (msg) => { if (activeConn?.open) activeConn.send(msg); },
    destroy: () => {
      destroyed = true;
      activeConn?.close();
      peer?.destroy();
    },
    connected: false,
  };

  function tryConnect(resolve, reject, attempt = 1) {
    if (destroyed) return;

    // Step 1: ensure we have an open peer
    if (!peer || peer.destroyed || peer.disconnected) {
      onStatus?.(`Creating peer... (attempt ${attempt}/${MAX_RETRIES})`);
      peer = new Peer();

      peer.on('error', (err) => {
        console.error('Peer error:', err.type, err);
        // peer-unavailable means the host ID doesn't exist
        if (err.type === 'peer-unavailable') {
          onStatus?.('Host not found — is the clinician console running?');
        }
      });
    }

    const startConnection = () => {
      if (destroyed) return;
      onStatus?.(`Connecting to host... (attempt ${attempt}/${MAX_RETRIES})`);

      const conn = peer.connect(hostPeerId);
      if (!conn) {
        retryOrFail(resolve, reject, attempt, 'Failed to create connection');
        return;
      }

      const connTimeout = setTimeout(() => {
        onStatus?.('Connection timed out');
        conn.close();
        retryOrFail(resolve, reject, attempt, 'Connection timed out');
      }, CONN_TIMEOUT);

      conn.on('open', () => {
        clearTimeout(connTimeout);
        if (destroyed) { conn.close(); return; }

        activeConn = conn;
        result.connected = true;
        onStatus?.('Connected!');
        console.log('Connected to host:', hostPeerId);
        conn.send({ type: 'join', role });
        resolve(result);
      });

      conn.on('data', (msg) => {
        onMessage?.(msg);
      });

      conn.on('close', () => {
        if (destroyed) return;
        result.connected = false;
        activeConn = null;
        console.log('Disconnected from host');
        onDisconnect?.();
      });

      conn.on('error', (err) => {
        clearTimeout(connTimeout);
        console.error('Connection error:', err);
        retryOrFail(resolve, reject, attempt, err.message || 'Connection error');
      });
    };

    if (peer.open) {
      startConnection();
    } else {
      waitForPeerOpen(peer).then(() => {
        onStatus?.(`Peer ready, connecting to host... (attempt ${attempt}/${MAX_RETRIES})`);
        startConnection();
      }).catch((err) => {
        console.error('Peer open failed:', err);
        // Destroy broken peer so next retry creates a fresh one
        peer.destroy();
        peer = null;
        retryOrFail(resolve, reject, attempt, 'Signaling server unreachable');
      });
    }
  }

  function retryOrFail(resolve, reject, attempt, reason) {
    if (destroyed) return;
    if (attempt >= MAX_RETRIES) {
      onStatus?.(`Failed after ${MAX_RETRIES} attempts: ${reason}`);
      reject(new Error(reason));
      return;
    }
    const delay = RETRY_DELAY * attempt;
    onStatus?.(`${reason} — retrying in ${delay / 1000}s... (${attempt}/${MAX_RETRIES})`);
    setTimeout(() => tryConnect(resolve, reject, attempt + 1), delay);
  }

  const promise = new Promise((resolve, reject) => {
    tryConnect(resolve, reject, 1);
  });

  // Return the promise but also attach the destroy handle
  promise._ctrl = result;
  return promise;
}
