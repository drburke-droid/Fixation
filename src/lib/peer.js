import { Peer } from 'peerjs';

/**
 * PeerJS wrapper for WebRTC peer-to-peer communication.
 */

const PEER_OPEN_TIMEOUT = 15000;
const CONN_TIMEOUT = 12000;
const RETRY_DELAY_BASE = 2000;
const RETRY_DELAY_MAX = 10000;
const HOST_CREATE_RETRIES = 4;

function waitForPeerOpen(peer, timeout = PEER_OPEN_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (peer.open) { resolve(peer.id); return; }
    const timer = setTimeout(() => reject(new Error('Peer open timed out')), timeout);
    peer.on('open', (id) => { clearTimeout(timer); resolve(id); });
    peer.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Create a PeerJS host with retry logic for unavailable IDs.
 * Tries the exact ID first, then appends -2, -3, etc.
 * Also tries with a random ID as last resort.
 */
export function createHost(onPeerConnect, onPeerDisconnect, onMessage, customId = null, onStatus) {
  const baseId = customId ? `fdq-${customId}` : null;

  function setupHost(peer, connections, resolve) {
    peer.on('connection', (conn) => {
      console.log('Incoming connection from:', conn.peer);
      conn.on('open', () => console.log('Connection open:', conn.peer));
      conn.on('data', (msg) => {
        if (msg.type === 'join') {
          connections.set(msg.role, conn);
          conn._role = msg.role;
          onPeerConnect?.(msg.role, conn);
        }
        onMessage?.(msg, conn);
      });
      conn.on('close', () => {
        if (conn._role) { connections.delete(conn._role); onPeerDisconnect?.(conn._role); }
      });
      conn.on('error', (err) => {
        console.error('Conn error:', err);
        if (conn._role) { connections.delete(conn._role); onPeerDisconnect?.(conn._role); }
      });
    });

    // Handle signaling server disconnect
    peer.on('disconnected', () => {
      if (!peer.destroyed) {
        console.log('Host disconnected from signaling, reconnecting...');
        try { peer.reconnect(); } catch (_) {}
      }
    });

    resolve({
      peer,
      peerId: peer.id,
      connections,
      broadcast: (msg) => {
        for (const conn of connections.values()) { if (conn.open) conn.send(msg); }
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
  }

  return new Promise((resolve, reject) => {
    const connections = new Map();
    let attempt = 0;

    function tryCreate() {
      attempt++;
      let peerId;
      if (!baseId) {
        peerId = undefined; // random
      } else if (attempt === 1) {
        peerId = baseId;
      } else if (attempt <= HOST_CREATE_RETRIES) {
        peerId = `${baseId}-${attempt}`;
      } else {
        peerId = undefined; // fallback to random
      }

      onStatus?.(`Creating host${peerId ? ` (${peerId})` : ' (random ID)'}... attempt ${attempt}`);
      console.log(`Host attempt ${attempt}, ID:`, peerId || 'random');

      const peer = peerId ? new Peer(peerId) : new Peer();

      waitForPeerOpen(peer).then((id) => {
        console.log('Host peer opened:', id);
        onStatus?.(`Host ready: ${id}`);
        setupHost(peer, connections, resolve);
      }).catch((err) => {
        console.error(`Host attempt ${attempt} failed:`, err.type || err.message || err);
        peer.destroy();

        if (attempt <= HOST_CREATE_RETRIES + 1) {
          const delay = attempt === 1 ? 1500 : 500; // longer first retry (wait for stale ID to expire)
          onStatus?.(`ID unavailable, retrying in ${delay}ms...`);
          setTimeout(tryCreate, delay);
        } else {
          reject(new Error(`Could not create host after ${attempt} attempts`));
        }
      });
    }

    tryCreate();
  });
}

/**
 * Persistent client connection — never gives up, auto-reconnects.
 */
export function connectToHost(hostPeerId, role, onMessage, onDisconnect, onStatus) {
  let destroyed = false;
  let peer = null;
  let activeConn = null;
  let attempt = 0;
  let resolvePromise = null;
  let resolved = false;

  const result = {
    send: (msg) => { if (activeConn?.open) activeConn.send(msg); },
    destroy: () => {
      destroyed = true;
      activeConn?.close(); activeConn = null;
      peer?.destroy(); peer = null;
    },
    connected: false,
  };

  function getDelay() {
    return Math.min(RETRY_DELAY_BASE * Math.pow(1.3, attempt), RETRY_DELAY_MAX);
  }

  function ensurePeer() {
    return new Promise((resolve, reject) => {
      if (peer && peer.open && !peer.destroyed && !peer.disconnected) {
        resolve(); return;
      }
      if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }

      onStatus?.(`Creating peer... (attempt ${attempt + 1})`);
      peer = new Peer();

      peer.on('error', (err) => {
        console.error('Peer error:', err.type, err);
        if (err.type === 'peer-unavailable') {
          onStatus?.('Host not found — is the clinician console running?');
          scheduleRetry('Host not found');
        }
      });

      peer.on('disconnected', () => {
        if (!destroyed && peer && !peer.destroyed) {
          try { peer.reconnect(); } catch (_) {}
        }
      });

      waitForPeerOpen(peer).then(() => resolve()).catch((err) => {
        try { peer.destroy(); } catch (_) {} peer = null;
        reject(err);
      });
    });
  }

  function tryConnect() {
    if (destroyed) return;
    attempt++;

    ensurePeer().then(() => {
      if (destroyed) return;
      onStatus?.(`Connecting to host... (attempt ${attempt})`);

      const conn = peer.connect(hostPeerId);
      if (!conn) { scheduleRetry('Failed to create connection'); return; }

      const connTimeout = setTimeout(() => {
        try { conn.close(); } catch (_) {}
        scheduleRetry('Connection timed out');
      }, CONN_TIMEOUT);

      let opened = false;

      conn.on('open', () => {
        if (opened) return; opened = true;
        clearTimeout(connTimeout);
        if (destroyed) { conn.close(); return; }
        activeConn = conn;
        result.connected = true;
        attempt = 0;
        onStatus?.('Connected!');
        conn.send({ type: 'join', role });
        if (!resolved && resolvePromise) { resolved = true; resolvePromise(result); }
      });

      conn.on('data', (msg) => onMessage?.(msg));

      conn.on('close', () => {
        clearTimeout(connTimeout);
        if (destroyed) return;
        const was = result.connected;
        result.connected = false; activeConn = null;
        if (was) { onDisconnect?.(); scheduleRetry('Connection lost'); }
      });

      conn.on('error', (err) => {
        clearTimeout(connTimeout);
        if (opened) return;
        scheduleRetry(err.message || 'Connection error');
      });
    }).catch(() => {
      if (!destroyed) scheduleRetry('Signaling server unreachable');
    });
  }

  function scheduleRetry(reason) {
    if (destroyed) return;
    const delay = getDelay();
    onStatus?.(`${reason} — retry in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
    setTimeout(tryConnect, delay);
  }

  const promise = new Promise((resolve) => { resolvePromise = resolve; tryConnect(); });
  promise._ctrl = result;
  return promise;
}
