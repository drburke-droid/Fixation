import { Peer } from 'peerjs';

/**
 * PeerJS wrapper for WebRTC peer-to-peer communication.
 * Clinician acts as host; display clients and controller connect as peers.
 */

const CONNECT_TIMEOUT = 15000; // 15s timeout for connections

/**
 * Create a PeerJS host (clinician side).
 * Returns a promise that resolves with { peer, peerId, connections, broadcast, destroy }.
 */
export function createHost(onPeerConnect, onPeerDisconnect, onMessage, customId = null) {
  return new Promise((resolve, reject) => {
    const peerId = customId ? `fdq-${customId}` : undefined;
    const peer = peerId ? new Peer(peerId) : new Peer();
    const connections = new Map();

    const timeout = setTimeout(() => {
      peer.destroy();
      reject(new Error('Timed out connecting to signaling server'));
    }, CONNECT_TIMEOUT);

    peer.on('open', (id) => {
      clearTimeout(timeout);
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
    });

    peer.on('error', (err) => {
      clearTimeout(timeout);
      console.error('Host peer error:', err);
      reject(err);
    });
  });
}

/**
 * Connect to a PeerJS host (display / controller side).
 * Includes timeout and status callbacks for UI feedback.
 */
export function connectToHost(hostPeerId, role, onMessage, onDisconnect, onStatus) {
  return new Promise((resolve, reject) => {
    onStatus?.('Creating peer...');
    const peer = new Peer();

    const timeout = setTimeout(() => {
      onStatus?.('Connection timed out');
      peer.destroy();
      reject(new Error('Connection timed out'));
    }, CONNECT_TIMEOUT);

    peer.on('open', (myId) => {
      onStatus?.(`Peer ready (${myId}), connecting to host...`);
      console.log('Client peer open:', myId, '→ connecting to', hostPeerId);

      const conn = peer.connect(hostPeerId);

      conn.on('open', () => {
        clearTimeout(timeout);
        onStatus?.('Connected!');
        console.log('Connected to host:', hostPeerId);
        conn.send({ type: 'join', role });

        resolve({
          peer,
          conn,
          send: (msg) => {
            if (conn.open) conn.send(msg);
          },
          destroy: () => {
            conn.close();
            peer.destroy();
          },
        });
      });

      conn.on('data', (msg) => {
        onMessage?.(msg);
      });

      conn.on('close', () => {
        console.log('Disconnected from host');
        onDisconnect?.();
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        console.error('Connection error:', err);
        onStatus?.(`Connection error: ${err.type || err.message || err}`);
        reject(err);
      });
    });

    peer.on('error', (err) => {
      clearTimeout(timeout);
      console.error('Client peer error:', err);
      onStatus?.(`Peer error: ${err.type || err.message || err}`);
      reject(err);
    });

    peer.on('disconnected', () => {
      onStatus?.('Disconnected from signaling server');
    });
  });
}
