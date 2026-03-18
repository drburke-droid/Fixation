import { Peer } from 'peerjs';

/**
 * PeerJS wrapper for WebRTC peer-to-peer communication.
 * Clinician acts as host; display clients and controller connect as peers.
 */

const PEER_OPEN_TIMEOUT = 12000;
const CONN_TIMEOUT = 12000;
const RETRY_DELAY_BASE = 2000;
const RETRY_DELAY_MAX = 10000;

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
 * Persistent client connection to a PeerJS host.
 * Never gives up — retries forever with capped backoff.
 * Auto-reconnects on disconnect.
 */
export function connectToHost(hostPeerId, role, onMessage, onDisconnect, onStatus) {
  let destroyed = false;
  let peer = null;
  let activeConn = null;
  let attempt = 0;
  let reconnecting = false;
  let resolvePromise = null;
  let resolved = false;

  const result = {
    send: (msg) => { if (activeConn?.open) activeConn.send(msg); },
    destroy: () => {
      destroyed = true;
      activeConn?.close();
      activeConn = null;
      peer?.destroy();
      peer = null;
    },
    connected: false,
    reconnect: () => { if (!destroyed) scheduleRetry('Manual reconnect'); },
  };

  function getDelay() {
    return Math.min(RETRY_DELAY_BASE * Math.pow(1.3, attempt), RETRY_DELAY_MAX);
  }

  function ensurePeer() {
    return new Promise((resolve, reject) => {
      if (peer && peer.open && !peer.destroyed && !peer.disconnected) {
        resolve();
        return;
      }
      // Destroy old peer cleanly
      if (peer) {
        try { peer.destroy(); } catch (_) {}
        peer = null;
      }

      onStatus?.(`Creating peer... (attempt ${attempt + 1})`);
      peer = new Peer();

      // Handle peer-level errors (like host not found)
      const errorHandler = (err) => {
        console.error('Peer error:', err.type, err);
        if (err.type === 'peer-unavailable') {
          onStatus?.('Host not found — is the clinician console running?');
          scheduleRetry('Host not found');
        }
      };
      peer.on('error', errorHandler);

      // Handle signaling server disconnect — auto reconnect peer
      peer.on('disconnected', () => {
        if (!destroyed && peer && !peer.destroyed) {
          console.log('Peer disconnected from signaling, reconnecting...');
          try { peer.reconnect(); } catch (_) {}
        }
      });

      waitForPeerOpen(peer).then(() => resolve()).catch((err) => {
        console.error('Peer open failed:', err);
        try { peer.destroy(); } catch (_) {}
        peer = null;
        reject(err);
      });
    });
  }

  function tryConnect() {
    if (destroyed) return;
    attempt++;
    reconnecting = true;

    ensurePeer().then(() => {
      if (destroyed) return;
      onStatus?.(`Connecting to host... (attempt ${attempt})`);

      const conn = peer.connect(hostPeerId);
      if (!conn) {
        scheduleRetry('Failed to create connection');
        return;
      }

      const connTimeout = setTimeout(() => {
        onStatus?.('Connection timed out');
        try { conn.close(); } catch (_) {}
        scheduleRetry('Connection timed out');
      }, CONN_TIMEOUT);

      let opened = false;

      conn.on('open', () => {
        if (opened) return;
        opened = true;
        clearTimeout(connTimeout);
        if (destroyed) { conn.close(); return; }

        activeConn = conn;
        result.connected = true;
        reconnecting = false;
        attempt = 0; // Reset backoff on success
        onStatus?.('Connected!');
        console.log('Connected to host:', hostPeerId);
        conn.send({ type: 'join', role });

        // Resolve the initial promise if not yet resolved
        if (!resolved && resolvePromise) {
          resolved = true;
          resolvePromise(result);
        }
      });

      conn.on('data', (msg) => {
        onMessage?.(msg);
      });

      conn.on('close', () => {
        clearTimeout(connTimeout);
        if (destroyed) return;
        const wasConnected = result.connected;
        result.connected = false;
        activeConn = null;
        console.log('Disconnected from host');
        if (wasConnected) {
          onDisconnect?.();
          // Auto-reconnect after disconnect
          onStatus?.('Disconnected — reconnecting...');
          scheduleRetry('Connection lost');
        }
      });

      conn.on('error', (err) => {
        clearTimeout(connTimeout);
        if (opened) return; // Already connected, ignore stale errors
        console.error('Connection error:', err);
        scheduleRetry(err.message || 'Connection error');
      });

    }).catch((err) => {
      if (destroyed) return;
      console.error('Peer setup failed:', err);
      scheduleRetry('Signaling server unreachable');
    });
  }

  function scheduleRetry(reason) {
    if (destroyed) return;
    const delay = getDelay();
    onStatus?.(`${reason} — retrying in ${Math.round(delay / 1000)}s... (attempt ${attempt})`);
    setTimeout(() => tryConnect(), delay);
  }

  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
    tryConnect();
  });

  promise._ctrl = result;
  return promise;
}
