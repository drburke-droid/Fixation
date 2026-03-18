import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import {
  createSession, getSession, updateSession, updateConfig,
  setClientConnected, moveTarget, resetTarget, captureTrial,
  updateSuppression, updateCalibration,
} from './session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

// Serve built frontend in production
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));

// LAN IP endpoint for QR code generation
function getLanIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push(iface.address);
      }
    }
  }
  // Prefer 192.168.x.x (home LAN), then 10.x.x.x, then anything else
  return candidates.find(ip => ip.startsWith('192.168.'))
      || candidates.find(ip => ip.startsWith('10.'))
      || candidates[0]
      || null;
}

app.get('/api/network-info', (req, res) => {
  res.json({ lanIp: getLanIp() });
});

// Track which socket belongs to which session/role
const socketMeta = new Map();

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // --- Create Session ---
  socket.on('create-session', (data, callback) => {
    const session = createSession(data?.config || {});
    if (data?.patientId) session.patientId = data.patientId;
    if (data?.examiner) session.examiner = data.examiner;

    socket.join(session.sessionId);
    setClientConnected(session.sessionId, 'clinician', true);
    socketMeta.set(socket.id, { sessionId: session.sessionId, role: 'clinician' });

    if (callback) callback({ success: true, session });
    console.log(`Session created: ${session.sessionId}`);
  });

  // --- Join Session ---
  socket.on('join-session', ({ sessionId, role }, callback) => {
    const session = getSession(sessionId);
    if (!session) {
      if (callback) callback({ success: false, error: 'Session not found' });
      return;
    }

    socket.join(sessionId);
    setClientConnected(sessionId, role, true);
    socketMeta.set(socket.id, { sessionId, role });

    if (callback) callback({ success: true, session });
    socket.to(sessionId).emit('client-connected', { role });
    socket.to(sessionId).emit('state-updated', session);
    console.log(`${role} joined session ${sessionId}`);
  });

  // --- Move Target ---
  socket.on('move-target', ({ dx, dy }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const session = moveTarget(meta.sessionId, dx, dy);
    if (session) {
      io.to(meta.sessionId).emit('target-moved', {
        x: session.targets.movableX,
        y: session.targets.movableY,
      });
    }
  });

  // --- Capture Trial ---
  socket.on('capture-trial', (_, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const result = captureTrial(meta.sessionId);
    if (result) {
      io.to(meta.sessionId).emit('trial-captured', result.trial);
      io.to(meta.sessionId).emit('state-updated', result.session);
      if (callback) callback({ success: true, trial: result.trial });
    }
  });

  // --- Advance Phase ---
  socket.on('advance-phase', ({ phase }, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const session = updateSession(meta.sessionId, { phase });
    if (session) {
      // Reset target position when entering alignment phases
      if (phase === 'distance-align' || phase === 'near-align') {
        resetTarget(meta.sessionId);
      }
      io.to(meta.sessionId).emit('phase-changed', { phase });
      io.to(meta.sessionId).emit('state-updated', session);
      if (callback) callback({ success: true });
    }
  });

  // --- Update Config ---
  socket.on('update-config', (configUpdates, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const session = updateConfig(meta.sessionId, configUpdates);
    if (session) {
      io.to(meta.sessionId).emit('state-updated', session);
      if (callback) callback({ success: true });
    }
  });

  // --- Suppression Response ---
  socket.on('suppression-response', (data, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const session = updateSuppression(meta.sessionId, { ...data, completed: true });
    if (session) {
      io.to(meta.sessionId).emit('state-updated', session);
      if (callback) callback({ success: true });
    }
  });

  // --- Flash Lock ---
  socket.on('flash-lock', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    io.to(meta.sessionId).emit('lock-flash');
  });

  // --- Toggle Lock Mode ---
  socket.on('toggle-lock', ({ mode }, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const session = updateConfig(meta.sessionId, { fixationLockMode: mode });
    if (session) {
      io.to(meta.sessionId).emit('state-updated', session);
      if (callback) callback({ success: true });
    }
  });

  // --- Reset Target ---
  socket.on('reset-target', (_, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const session = resetTarget(meta.sessionId);
    if (session) {
      io.to(meta.sessionId).emit('target-moved', { x: 0, y: 0 });
      io.to(meta.sessionId).emit('state-updated', session);
      if (callback) callback({ success: true });
    }
  });

  // --- Update Sensitivity ---
  socket.on('update-sensitivity', ({ preset }, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const session = updateConfig(meta.sessionId, { movementSensitivity: preset });
    if (session) {
      io.to(meta.sessionId).emit('state-updated', session);
      if (callback) callback({ success: true });
    }
  });

  // --- Calibration Update ---
  socket.on('calibration-update', ({ display, data }, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const session = updateCalibration(meta.sessionId, display, data);
    if (session) {
      io.to(meta.sessionId).emit('state-updated', session);
      if (callback) callback({ success: true });
    }
  });

  // --- Update Summary Text ---
  socket.on('update-summary', ({ text }, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const session = updateSession(meta.sessionId, { summaryText: text });
    if (session) {
      if (callback) callback({ success: true });
    }
  });

  // --- Update Session Info ---
  socket.on('update-session-info', ({ patientId, examiner }, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const updates = {};
    if (patientId !== undefined) updates.patientId = patientId;
    if (examiner !== undefined) updates.examiner = examiner;
    const session = updateSession(meta.sessionId, updates);
    if (session) {
      io.to(meta.sessionId).emit('state-updated', session);
      if (callback) callback({ success: true });
    }
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (meta) {
      const session = setClientConnected(meta.sessionId, meta.role, false);
      if (session) {
        socket.to(meta.sessionId).emit('client-disconnected', { role: meta.role });
        socket.to(meta.sessionId).emit('state-updated', session);
      }
      socketMeta.delete(socket.id);
    }
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Fixation Disparity Quantifier server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
