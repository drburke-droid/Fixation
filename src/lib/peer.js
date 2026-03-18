import { Peer } from 'peerjs';

/**
 * PeerJS wrapper for WebRTC peer-to-peer communication.
 * Clinician acts as host; display clients and controller connect as peers.
 */

/**
 * Create a PeerJS host (clinician side).
 * Returns a promise that resolves with { peer, peerId, connections, broadcast, destroy }.
 */
export function createHost(onPeerConnect, onPeerDisconnect, onMessage, customId = null) {
  return new Promise((resolve, reject) => {
    // Use custom ID prefixed with 'fdq-' for namespace, or let PeerJS auto-generate
    const peerId = customId ? `fdq-${customId}` : undefined;
    const peer = peerId ? new Peer(peerId) : new Peer();
    const connections = new Map(); // role -> DataConnection

    peer.on('open', (id) => {
      console.log('Host peer opened:', id);

      peer.on('connection', (conn) => {
        conn.on('open', () => {
          console.log('Peer connected:', conn.peer);
        });

        conn.on('data', (msg) => {
          // Handle join message to register role
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
      console.error('Host peer error:', err);
      reject(err);
    });
  });
}

/**
 * Connect to a PeerJS host (display / controller side).
 * Returns a promise that resolves with { peer, conn, send, destroy }.
 */
export function connectToHost(hostPeerId, role, onMessage, onDisconnect) {
  return new Promise((resolve, reject) => {
    const peer = new Peer();

    peer.on('open', () => {
      const conn = peer.connect(hostPeerId, { reliable: true });

      conn.on('open', () => {
        console.log('Connected to host:', hostPeerId);
        // Announce our role
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
        console.error('Connection error:', err);
        reject(err);
      });
    });

    peer.on('error', (err) => {
      console.error('Client peer error:', err);
      reject(err);
    });
  });
}
