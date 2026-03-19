import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { createHost } from '../lib/peer';
import {
  createSession, setPhase, setClientConnected, moveTarget,
  resetTarget, updateConfig, updateSuppression, updateCalibration,
  captureTrial,
} from '../lib/sessionStore';
import {
  computeTrialMetrics, computeTrialStats, generateEMRSummary, getPrismLabels, formatPrism,
  prismDioptersToPx, computeFDCurve, analyzeTrackingTrajectory, analyzeRecoveryDynamics, pearsonCorrelation,
  extractPhaseMetrics, smoothPositionData,
} from '../lib/measurement';
import { renderTargets } from '../lib/targets';

const PHASES = [
  { key: 'setup', label: 'Setup' },
  { key: 'pairing', label: 'Pairing' },
  { key: 'color-cal-distance', label: 'Color Cal (Dist)' },
  { key: 'color-cal-near', label: 'Color Cal (Near)' },
  { key: 'suppression', label: 'Suppression' },
  { key: 'calibration-distance', label: 'Cal (Dist)' },
  { key: 'calibration-near', label: 'Cal (Near)' },
  { key: 'distance-align', label: 'Distance' },
  { key: 'transition', label: 'Transition' },
  { key: 'near-align', label: 'Near' },
  { key: 'results', label: 'Results' },
];

const LOCK_MODES = ['always', 'pulse', 'flash', 'off'];

// Auto protocol: continuous fixation tracking + vertical alignment
const AUTO_STEPS = [
  // Introduction
  { id: 'welcome', dur: 5000, msg: 'Welcome to the\nFixation Disparity Assessment', red: false, green: false, lock: false, move: false },
  { id: 'intro-left', dur: 4000, msg: 'Your left eye\nsees this target', red: true, green: false, lock: false, move: false },
  { id: 'intro-right', dur: 4000, msg: 'Your right eye\nsees this target', red: false, green: true, lock: false, move: false },
  { id: 'intro-lock', dur: 4000, msg: 'Both eyes see\nthis fixation target', red: false, green: false, lock: true, move: false },
  { id: 'intro-both', dur: 4000, msg: 'Now you see\nall targets together', red: true, green: true, lock: true, move: false },
  { id: 'intro-move', dur: 15000, msg: 'Drag your finger on your phone\nto move the target.\nTry putting the cross inside\nthe circle.\nTap phone screen when centred.', red: true, green: true, lock: true, move: true },
  { id: 'intro-blink', dur: 6000, msg: 'If you lose a target try blinking.\nIf that doesn\'t work\nsay "I lost it".\nThe test will begin now.', red: true, green: true, lock: true, move: false },

  // === HORIZONTAL FD: Continuous tracking with ring/cross ===
  // Phase 1: With fixation lock (20s)
  { id: 'h-lock-start', dur: 2000, msg: 'Keep the targets aligned.', red: true, green: true, lock: true, move: true, reset: true, marker: 'H: Lock On' },
  { id: 'h-lock', dur: 20000, msg: '', red: true, green: true, lock: true, move: true, record: true },
  // Phase 2: Lock disappears immediately — no warning
  { id: 'h-nolock', dur: 30000, msg: '', red: true, green: true, lock: false, move: true, record: true, marker: 'H: Dissociated' },

  // === VERTICAL FD: Opposing arrows ===
  { id: 'v-instruct', dur: 5000, msg: 'Now align these arrows.\nMove the arrow up or down\nto match the other.', red: true, green: true, lock: false, move: true, reset: true, marker: 'V: Instructions', preset: 'arrows-vert' },
  { id: 'v-track', dur: 30000, msg: '', red: true, green: true, lock: false, move: true, record: true, marker: 'V: Tracking', preset: 'arrows-vert' },

  // Complete
  { id: 'complete', dur: 0, msg: 'Test complete.\nThank you.', red: false, green: false, lock: false, move: false, marker: 'Complete' },
];

export default function Clinician() {
  const sessionRef = useRef(null);
  const [session, setSession] = useState(null);
  const hostRef = useRef(null);
  const [peerId, setPeerId] = useState(null);
  const [baseUrl, setBaseUrl] = useState('');

  // Setup form
  const [roomName, setRoomName] = useState('lane1');
  const [patientId, setPatientId] = useState('');
  const [examiner, setExaminer] = useState('');
  const [summaryText, setSummaryText] = useState('');
  const [copySuccess, setCopySuccess] = useState(false);
  const [suppressionStep, setSuppressionStep] = useState('red');
  const [peerError, setPeerError] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [hostStatus, setHostStatus] = useState('');

  // Trial workflow
  const [trialState, setTrialState] = useState('idle'); // idle | waiting | saccading | adjusting | tracking
  const [trialProtocol, setTrialProtocol] = useState('closeEyes'); // closeEyes | saccade | tracking
  const [eyesOpenTime, setEyesOpenTime] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [saccadeProgress, setSaccadeProgress] = useState(0);
  const saccadeTimerRef = useRef(null);
  const trackingTimerRef = useRef(null);
  const trackingStartRef = useRef(null);
  const recoveryTimerRef = useRef(null);
  const autoTimerRef = useRef(null);
  const autoRecordRef = useRef(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoStepLabel, setAutoStepLabel] = useState('');
  const doubleTapHandlerRef = useRef(null);

  // Collapsible sections
  const [showConfig, setShowConfig] = useState(false);
  const [showCalibration, setShowCalibration] = useState(false);
  const [showPairing, setShowPairing] = useState(true);

  // Stable message handler ref — avoids TDZ issues with minified builds
  const peerMessageHandlerRef = useRef(null);

  // Timer for eyes-open duration
  useEffect(() => {
    if (trialState !== 'adjusting' && trialState !== 'tracking') return;
    if (!eyesOpenTime) return;
    const iv = setInterval(() => setElapsed(Date.now() - eyesOpenTime), 100);
    return () => clearInterval(iv);
  }, [trialState, eyesOpenTime]);

  const updateSession = useCallback((updater) => {
    const prev = sessionRef.current;
    if (!prev) return;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    sessionRef.current = next;
    setSession({ ...next });
    hostRef.current?.broadcast({ type: 'state-updated', state: next });
    try {
      localStorage.setItem('fdq-color-cal', JSON.stringify({
        redColor: next.config.redColor,
        greenColor: next.config.greenColor,
        colorCalibration: next.colorCalibration,
      }));
    } catch (_) {}
  }, []);

  useEffect(() => {
    const origin = window.location.origin;
    const path = window.location.pathname;
    setBaseUrl(`${origin}${path}#`);
  }, []);

  useEffect(() => {
    return () => {
      hostRef.current?.destroy();
      if (trackingTimerRef.current) clearInterval(trackingTimerRef.current);
      if (saccadeTimerRef.current) clearInterval(saccadeTimerRef.current);
    };
  }, []);

  // --- Peer host + session creation ---
  const handleCreateSession = useCallback(() => {
    if (!roomName.trim()) return;
    setConnecting(true);
    setPeerError(null);

    createHost(
      (role) => {
        const s = sessionRef.current;
        if (s) {
          const next = setClientConnected(s, role, true);
          sessionRef.current = next;
          setSession({ ...next });
          hostRef.current?.sendTo(role, { type: 'state-updated', state: next });
        }
      },
      (role) => {
        const s = sessionRef.current;
        if (s) {
          const next = setClientConnected(s, role, false);
          sessionRef.current = next;
          setSession({ ...next });
        }
      },
      (msg) => peerMessageHandlerRef.current?.(msg),
      roomName.trim(),
      (statusMsg) => setHostStatus(statusMsg),
    ).then((host) => {
      hostRef.current = host;
      setPeerId(host.peerId);
      setConnecting(false);
      const s = createSession({ patientId, examiner });
      try {
        const saved = JSON.parse(localStorage.getItem('fdq-color-cal'));
        if (saved) {
          if (saved.redColor) s.config.redColor = saved.redColor;
          if (saved.greenColor) s.config.greenColor = saved.greenColor;
          if (saved.colorCalibration) s.colorCalibration = saved.colorCalibration;
        }
      } catch (_) {}
      sessionRef.current = s;
      setSession({ ...s });
    }).catch(err => {
      setConnecting(false);
      if (err?.type === 'unavailable-id') {
        setPeerError(`Room "${roomName}" is already in use.`);
      } else {
        setPeerError(`Connection failed: ${err?.message || err}`);
      }
    });
  }, [patientId, examiner, roomName]);

  // --- Actions ---
  const handleAdvancePhase = useCallback((phase) => {
    updateSession(prev => setPhase(prev, phase));
  }, [updateSession]);

  const doCapture = useCallback((protocol) => {
    const s = sessionRef.current;
    if (!s) return;
    const timeToAlignMs = eyesOpenTime ? Date.now() - eyesOpenTime : null;
    const { session: next } = captureTrial(s, protocol);
    if (timeToAlignMs !== null) {
      next.trials[next.trials.length - 1].timeToAlignMs = timeToAlignMs;
    }
    sessionRef.current = next;
    setSession({ ...next });
    hostRef.current?.broadcast({ type: 'state-updated', state: next });
    setTrialState('idle');
    setEyesOpenTime(null);
    setElapsed(0);
    setSaccadeProgress(0);
    if (recoveryTimerRef.current) { clearInterval(recoveryTimerRef.current); recoveryTimerRef.current = null; }
  }, [eyesOpenTime]);

  // Log current position to positionLog
  const logPosition = useCallback((type) => {
    const s = sessionRef.current;
    if (!s) return;
    const phase = s.phase === 'distance-align' ? 'distance' : 'near';
    const entry = {
      t: Date.now(),
      x: s.targets.movableX,
      y: s.targets.movableY,
      protocol: trialProtocol,
      phase,
      type, // 'tap' | 'track' | 'capture'
    };
    s.positionLog = [...(s.positionLog || []), entry];
    sessionRef.current = s;
  }, [trialProtocol]);

  const handleCaptureTrial = useCallback(() => {
    logPosition('capture');
    doCapture(trialProtocol);
  }, [doCapture, trialProtocol, logPosition]);

  // Called when controller sends double-tap
  const handleDoubleTapCapture = useCallback(() => {
    if (trialState === 'adjusting') {
      logPosition('tap');
      doCapture(trialProtocol);
    } else if (trialState === 'tracking') {
      logPosition('tap');
      const s = sessionRef.current;
      if (s) setSession({ ...s });
    }
  }, [doCapture, trialProtocol, trialState, logPosition]);

  doubleTapHandlerRef.current = handleDoubleTapCapture;

  // Start continuous tracking at ~30fps
  const handleStartTracking = useCallback(() => {
    updateSession(prev => resetTarget(prev));
    setTrialProtocol('tracking');
    setTrialState('tracking');
    setEyesOpenTime(Date.now());
    trackingStartRef.current = Date.now();

    if (trackingTimerRef.current) clearInterval(trackingTimerRef.current);
    trackingTimerRef.current = setInterval(() => {
      const s = sessionRef.current;
      if (!s) return;
      const phase = s.phase === 'distance-align' ? 'distance' : 'near';
      const entry = {
        t: Date.now(),
        x: s.targets.movableX,
        y: s.targets.movableY,
        protocol: 'tracking',
        phase,
        type: 'track',
      };
      s.positionLog = [...(s.positionLog || []), entry];
      sessionRef.current = s;
    }, 33); // ~30fps
  }, [updateSession]);

  const handleStopTracking = useCallback(() => {
    if (trackingTimerRef.current) {
      clearInterval(trackingTimerRef.current);
      trackingTimerRef.current = null;
    }
    // Force a re-render to show updated log
    const s = sessionRef.current;
    if (s) setSession({ ...s });
    setTrialState('idle');
    setEyesOpenTime(null);
    setElapsed(0);
  }, []);

  // ===== AUTO PROTOCOL ENGINE =====
  // Fully timer-based — continuous 30fps recording, no double-tap needed
  const autoAdvance = useCallback((stepIdx) => {
    const s = sessionRef.current;
    if (!s || stepIdx >= AUTO_STEPS.length) {
      // Protocol complete — stop recording, update state
      if (autoRecordRef.current) { clearInterval(autoRecordRef.current); autoRecordRef.current = null; }
      const fin = { ...s, autoProtocol: { ...s.autoProtocol, active: false, message: '', stepId: 'done' } };
      sessionRef.current = fin;
      setSession({ ...fin });
      hostRef.current?.broadcast({ type: 'state-updated', state: fin });
      setAutoRunning(false);
      setAutoStepLabel('Complete');
      return;
    }

    const step = AUTO_STEPS[stepIdx];
    setAutoStepLabel(`${step.id} (${stepIdx + 1}/${AUTO_STEPS.length})`);

    // Reset targets if needed
    if (step.reset) {
      s.targets = { ...s.targets, movableX: 0, movableY: 0 };
    }

    // Switch target preset if specified
    if (step.preset) {
      s.config = { ...s.config, targetPreset: step.preset };
    }

    // Add phase marker
    if (step.marker) {
      s.autoProtocol.phaseMarkers = [...(s.autoProtocol.phaseMarkers || []), { t: Date.now(), label: step.marker }];
    }

    // Update auto protocol display state
    const ap = {
      ...s.autoProtocol,
      active: true,
      stepIndex: stepIdx,
      stepId: step.id,
      message: step.msg || '',
      showRed: step.red !== false,
      showGreen: step.green !== false,
      showLock: step.lock !== false,
      allowMove: step.move === true,
    };
    const next = { ...s, autoProtocol: ap };
    sessionRef.current = next;
    setSession({ ...next });
    hostRef.current?.broadcast({ type: 'state-updated', state: next });

    // Start/stop continuous recording based on step
    if (step.record && !autoRecordRef.current) {
      autoRecordRef.current = setInterval(() => {
        const rs = sessionRef.current;
        if (!rs) return;
        const phase = rs.phase === 'near-align' ? 'near' : 'distance';
        rs.positionLog = [...(rs.positionLog || []), {
          t: Date.now(), x: rs.targets.movableX, y: rs.targets.movableY,
          protocol: 'auto', phase, type: 'track',
        }];
        sessionRef.current = rs;
      }, 33);
    } else if (!step.record && autoRecordRef.current) {
      clearInterval(autoRecordRef.current);
      autoRecordRef.current = null;
    }

    // Handle saccade steps — run sequence then auto-advance
    if (step.runSaccade) {
      const cfg = s.config;
      hostRef.current?.broadcast({
        type: 'saccade-start',
        config: { jumps: cfg.saccadeJumps || 16, amplitude: cfg.saccadeAmplitudePx || 900, pauseMs: cfg.saccadePauseDurationMs || 600 },
      });
      const totalTime = 300 + ((cfg.saccadeJumps || 16) + 1) * (cfg.saccadePauseDurationMs || 600);
      autoTimerRef.current = setTimeout(() => autoAdvance(stepIdx + 1), totalTime);
      return;
    }

    // All other steps advance on timer
    if (step.dur > 0) {
      autoTimerRef.current = setTimeout(() => autoAdvance(stepIdx + 1), step.dur);
    }
    // dur === 0 means hold (protocol end)
  }, []);

  const handleStartAutoProtocol = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    // Ensure we're in an alignment phase
    if (s.phase !== 'distance-align' && s.phase !== 'near-align') {
      const next = { ...s, phase: 'distance-align', targets: { ...s.targets, movableX: 0, movableY: 0, fixedX: 0, fixedY: 0 } };
      sessionRef.current = next;
      setSession({ ...next });
      hostRef.current?.broadcast({ type: 'state-updated', state: next });
    }
    // Reset protocol state
    s.autoProtocol = { ...s.autoProtocol, active: true, startTime: Date.now(), phaseMarkers: [], stepIndex: 0 };
    s.positionLog = [];
    sessionRef.current = s;
    setAutoRunning(true);
    setTrialState('idle');
    autoAdvance(0);
  }, [autoAdvance]);

  const handleStopAutoProtocol = useCallback(() => {
    if (autoTimerRef.current) { clearTimeout(autoTimerRef.current); autoTimerRef.current = null; }
    if (autoRecordRef.current) { clearInterval(autoRecordRef.current); autoRecordRef.current = null; }
    const s = sessionRef.current;
    if (s) {
      s.autoProtocol = { ...s.autoProtocol, active: false, message: '' };
      sessionRef.current = s;
      setSession({ ...s });
      hostRef.current?.broadcast({ type: 'state-updated', state: s });
    }
    setAutoRunning(false);
  }, []);

  const handleNewTrial = useCallback((protocol) => {
    setTrialProtocol(protocol);
    updateSession(prev => resetTarget(prev));
    setTrialState('waiting');
    setEyesOpenTime(null);
    setElapsed(0);
    setSaccadeProgress(0);
  }, [updateSession]);

  const handleEyesOpen = useCallback(() => {
    setTrialState('adjusting');
    setEyesOpenTime(Date.now());
  }, []);

  const handleStartSaccade = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    // Reset targets first
    const next = resetTarget(s);
    sessionRef.current = next;
    setSession({ ...next });
    hostRef.current?.broadcast({ type: 'state-updated', state: next });

    setTrialState('saccading');
    setSaccadeProgress(0);

    const cfg = s.config;
    const jumps = cfg.saccadeJumps || 8;
    const amplitude = cfg.saccadeAmplitudePx || 300;
    const pauseMs = cfg.saccadePauseDurationMs || 200;

    // Tell displays to start their local saccade animation
    hostRef.current?.broadcast({
      type: 'saccade-start',
      config: { jumps, amplitude, pauseMs },
    });

    // Track progress locally and transition to adjusting when done
    let step = 0;
    const totalTime = 300 + (jumps + 1) * pauseMs; // 300ms initial pause + jumps * pause

    if (saccadeTimerRef.current) clearInterval(saccadeTimerRef.current);
    saccadeTimerRef.current = setInterval(() => {
      step++;
      setSaccadeProgress(Math.min(step / jumps, 1));
      if (step > jumps) {
        clearInterval(saccadeTimerRef.current);
        saccadeTimerRef.current = null;
        // Saccade done — transition to adjusting + start recovery logging
        setTrialState('adjusting');
        setEyesOpenTime(Date.now());
        setSaccadeProgress(1);
        // Record recovery trajectory at 30fps
        if (recoveryTimerRef.current) clearInterval(recoveryTimerRef.current);
        recoveryTimerRef.current = setInterval(() => {
          const rs = sessionRef.current;
          if (!rs) return;
          const phase = rs.phase === 'distance-align' ? 'distance' : 'near';
          rs.positionLog = [...(rs.positionLog || []), {
            t: Date.now(), x: rs.targets.movableX, y: rs.targets.movableY,
            protocol: 'saccade', phase, type: 'recovery',
          }];
          sessionRef.current = rs;
        }, 33);
      }
    }, pauseMs);
  }, []);

  const handleFlashLock = useCallback(() => {
    hostRef.current?.broadcast({ type: 'lock-flash' });
  }, []);

  const handleSetLockMode = useCallback((mode) => {
    updateSession(prev => updateConfig(prev, { fixationLockMode: mode }));
  }, [updateSession]);

  const handleResetTarget = useCallback(() => {
    updateSession(prev => resetTarget(prev));
  }, [updateSession]);

  const handleSetSensitivity = useCallback((preset) => {
    updateSession(prev => updateConfig(prev, { movementSensitivity: preset }));
  }, [updateSession]);

  const handleUpdateConfig = useCallback((updates) => {
    updateSession(prev => updateConfig(prev, updates));
  }, [updateSession]);

  const handleRecordSuppression = useCallback((data) => {
    updateSession(prev => updateSuppression(prev, data));
  }, [updateSession]);

  const handleCompleteCalibration = useCallback((display) => {
    updateSession(prev => updateCalibration(prev, display, { completed: true }));
  }, [updateSession]);

  const handleGenerateSummary = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    const dt = s.trials.filter(t => t.phase === 'distance');
    const nt = s.trials.filter(t => t.phase === 'near');
    setSummaryText(generateEMRSummary(s, computeTrialStats(dt), computeTrialStats(nt)));
  }, []);

  const handleCopyToClipboard = useCallback(() => {
    navigator.clipboard.writeText(summaryText).then(() => {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    });
  }, [summaryText]);

  // --- Live prism computation ---
  const livePrism = useMemo(() => {
    if (!session) return null;
    const phase = session.phase;
    const isNear = phase === 'near-align' || phase === 'color-cal-near' || phase === 'calibration-near';
    const ppi = isNear ? session.config.nearDisplayPPI : session.config.displayPPI;
    const dist = isNear ? session.config.nearDistanceMm : session.config.distanceOpticalDistanceMm;
    return computeTrialMetrics(session.targets.movableX, session.targets.movableY, ppi, dist);
  }, [session]);

  const liveLabels = useMemo(() => {
    if (!session) return null;
    return getPrismLabels(session.targets.movableX, session.targets.movableY, session.config, session.targets);
  }, [session]);

  // --- Stable message handler (set AFTER all callbacks are defined to avoid TDZ) ---
  peerMessageHandlerRef.current = (msg) => {
    const s = sessionRef.current;
    if (!s) return;
    if (msg.type === 'move-target') {
      const next = moveTarget(s, msg.dx, msg.dy);
      sessionRef.current = next;
      setSession({ ...next });
      hostRef.current?.broadcast({
        type: 'target-moved',
        x: next.targets.movableX,
        y: next.targets.movableY,
      });
    } else if (msg.type === 'double-tap') {
      doubleTapHandlerRef.current?.();
    }
  };

  // --- Computed stats ---
  const distTrials = session?.trials.filter(t => t.phase === 'distance') || [];
  const nearTrials = session?.trials.filter(t => t.phase === 'near') || [];
  const distStats = computeTrialStats(distTrials);
  const nearStats = computeTrialStats(nearTrials);
  const currentPhase = session?.phase || 'setup';
  const phaseIndex = PHASES.findIndex(p => p.key === currentPhase);
  const isAlignPhase = currentPhase === 'distance-align' || currentPhase === 'near-align';

  // ========== NO SESSION ==========
  if (!session) {
    return (
      <div style={{ maxWidth: 520, margin: '60px auto', padding: '0 24px', animation: 'fade-in 0.4s ease' }}>
        <h1 style={{ fontSize: '22px', marginBottom: '4px', fontWeight: 700, letterSpacing: '-0.03em' }}>Fixation Disparity Quantifier</h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '28px', fontSize: '13px', letterSpacing: '-0.01em' }}>
          In-phoropter binocular fixation disparity quantification
        </p>
        <div className="panel" style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.04)', padding: '24px' }}>
          <h3>New Session</h3>
          {peerError && <p style={{ color: 'var(--danger)', fontSize: '12px', marginBottom: 8 }}>{peerError}</p>}
          {connecting && hostStatus && (
            <p style={{ color: 'var(--warning)', fontSize: '12px', marginBottom: 8 }}>{hostStatus}</p>
          )}
          <div className="field-group">
            <label>Room Name</label>
            <input value={roomName} onChange={e => setRoomName(e.target.value)}
              placeholder="e.g. lane1" style={{ width: '100%' }} />
          </div>
          <div className="field-group">
            <label>Patient ID (optional)</label>
            <input value={patientId} onChange={e => setPatientId(e.target.value)} style={{ width: '100%' }} />
          </div>
          <div className="field-group">
            <label>Examiner (optional)</label>
            <input value={examiner} onChange={e => setExaminer(e.target.value)} style={{ width: '100%' }} />
          </div>
          <button className="primary" onClick={handleCreateSession}
            disabled={connecting || !roomName.trim()} style={{ marginTop: 12, width: '100%', padding: '10px', fontSize: '14px', fontWeight: 600 }}>
            {connecting ? 'Connecting...' : 'Start Session'}
          </button>
        </div>
      </div>
    );
  }

  // ========== ACTIVE SESSION ==========
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* ===== LEFT: Controls ===== */}
      <div style={{
        width: '360px', minWidth: '360px',
        borderRight: '1px solid var(--border)',
        background: 'rgba(8, 8, 14, 0.5)',
        overflowY: 'auto', padding: '12px',
      }}>
        {/* Header */}
        <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <h2 style={{ fontSize: '15px', margin: 0, fontWeight: 700, letterSpacing: '-0.03em' }}>FDQ Console</h2>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: 2 }}>
            Peer: <b style={{ color: 'var(--accent)', fontSize: '11px', fontFamily: 'monospace' }}>{peerId}</b>
            {' | '}
            {['clinician','distance','near','controller'].map(r =>
              <span key={r} style={{ color: session.clients[r] ? 'var(--success)' : 'var(--text-muted)', marginRight: 3, transition: 'color 0.3s ease' }}>
                {r[0].toUpperCase()}
              </span>
            )}
          </div>
        </div>

        {/* Phase stepper */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: 10 }}>
          {PHASES.map((p, i) => (
            <button key={p.key} onClick={() => handleAdvancePhase(p.key)}
              style={{
                fontSize: '10px', padding: '3px 8px', borderRadius: '20px',
                background: p.key === currentPhase ? 'linear-gradient(135deg, #1558c0, #388bfd)' : undefined,
                borderColor: p.key === currentPhase ? 'rgba(107,170,255,0.3)' : undefined,
                boxShadow: p.key === currentPhase ? '0 0 12px rgba(107,170,255,0.15)' : undefined,
                opacity: i <= phaseIndex ? 1 : 0.35,
                transition: 'all 0.2s ease',
              }}>{p.label}</button>
          ))}
        </div>

        {/* ===== AUTO PROTOCOL ===== */}
        {autoRunning && (
          <div className="panel" style={{ borderColor: 'rgba(52,211,153,0.3)', background: 'rgba(16,30,20,0.75)', boxShadow: '0 0 20px rgba(52,211,153,0.08)' }}>
            <h3 style={{ color: 'var(--success)' }}>Auto Protocol Running</h3>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: 8 }}>
              Step: <b style={{ color: 'var(--text-primary)' }}>{autoStepLabel}</b>
            </div>
            <div style={{
              height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', marginBottom: 10, overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', borderRadius: 2, transition: 'width 0.3s ease',
                width: `${((session.autoProtocol?.stepIndex || 0) + 1) / AUTO_STEPS.length * 100}%`,
                background: 'linear-gradient(90deg, #34d399, #6baaff)',
              }} />
            </div>
            <button className="danger" onClick={handleStopAutoProtocol}
              style={{ fontSize: '12px', padding: '8px 16px' }}>
              Stop Protocol
            </button>
          </div>
        )}

        {/* Auto Protocol Start Button (when idle and in alignment phase) */}
        {!autoRunning && isAlignPhase && trialState === 'idle' && (
          <button onClick={handleStartAutoProtocol}
            style={{
              width: '100%', padding: '12px', fontSize: '14px', fontWeight: 700, marginBottom: 10,
              borderRadius: '12px', letterSpacing: '0.02em',
              background: 'linear-gradient(135deg, #0d7a3e, #34d399, #0d7a3e)',
              borderColor: 'rgba(52,211,153,0.3)', color: '#fff',
              boxShadow: '0 4px 20px rgba(52,211,153,0.15), inset 0 1px 0 rgba(255,255,255,0.1)',
            }}>
            START AUTO PROTOCOL
          </button>
        )}

        {/* ===== TRIAL WORKFLOW (main area during alignment) ===== */}
        {isAlignPhase && (
          <div className="panel" style={{ borderColor: 'rgba(107,170,255,0.25)', borderWidth: 1, boxShadow: '0 0 24px rgba(107,170,255,0.06), 0 4px 16px rgba(0,0,0,0.2)', background: 'rgba(16,20,35,0.75)' }}>
            <h3 style={{ color: 'var(--accent)', letterSpacing: '-0.02em' }}>
              {currentPhase === 'distance-align' ? 'Distance' : 'Near'} Trial
              {trialProtocol === 'saccade' && <span style={{ fontSize: '11px', color: 'var(--warning)', marginLeft: 6, fontWeight: 500 }}>SACCADE</span>}
              {trialProtocol === 'closeEyes' && trialState !== 'idle' && <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 6, fontWeight: 500 }}>CLOSE EYES</span>}
            </h3>

            {/* IDLE: choose protocol */}
            {trialState === 'idle' && (
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: 6 }}>Choose protocol:</div>
                <div style={{ display: 'flex', gap: 5, marginBottom: 6 }}>
                  <button className="primary" onClick={() => handleNewTrial('closeEyes')}
                    style={{ flex: 1, padding: '8px', fontSize: '11px', borderRadius: '10px', fontWeight: 600 }}>
                    Close Eyes
                  </button>
                  <button className="accent" onClick={() => handleNewTrial('saccade')}
                    style={{ flex: 1, padding: '8px', fontSize: '11px', borderRadius: '10px', fontWeight: 600 }}>
                    Saccade
                  </button>
                  <button onClick={handleStartTracking}
                    style={{ flex: 1, padding: '8px', fontSize: '11px', borderRadius: '10px', fontWeight: 600, background: 'linear-gradient(135deg, #5c1690, #7b2fbe)', borderColor: 'rgba(156,39,176,0.3)', color: '#fff' }}>
                    Tracking
                  </button>
                  <button onClick={() => {
                    // Start prism sweep protocol
                    const s = sessionRef.current;
                    if (!s) return;
                    const seq = s.config.prismSweepSequence || [6,4,2,0,-2,-4,-6];
                    const isNear = s.phase === 'near-align';
                    const ppi = isNear ? s.config.nearDisplayPPI : s.config.displayPPI;
                    const dist = isNear ? s.config.nearDistanceMm : s.config.distanceOpticalDistanceMm;
                    const offsetPx = prismDioptersToPx(seq[0], dist, ppi);
                    const next = { ...s, prismSweepIndex: 0, prismSweepResults: [],
                      targets: { ...s.targets, fixedX: offsetPx, movableX: 0, movableY: 0 } };
                    sessionRef.current = next;
                    setSession({ ...next });
                    hostRef.current?.broadcast({ type: 'state-updated', state: next });
                    setTrialProtocol('prismSweep');
                    setTrialState('adjusting');
                    setEyesOpenTime(Date.now());
                  }}
                    style={{ flex: 1, padding: '8px', fontSize: '11px', borderRadius: '10px', fontWeight: 600, background: 'linear-gradient(135deg, #b85c00, #e67e00)', borderColor: 'rgba(230,126,0,0.3)', color: '#fff' }}>
                    Prism Sweep
                  </button>
                </div>
                <p style={{ fontSize: '8px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  Close Eyes | Saccade | Tracking (30fps) | Prism Sweep (FD curve)
                </p>
              </div>
            )}

            {/* TRACKING: continuous recording */}
            {trialState === 'tracking' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '6px 10px', borderRadius: '8px', background: 'rgba(244,67,54,0.06)', border: '1px solid rgba(244,67,54,0.12)' }}>
                  <div style={{
                    width: 10, height: 10, borderRadius: '50%', background: '#f44336',
                    animation: 'recording-pulse 1.2s ease-in-out infinite',
                    boxShadow: '0 0 8px rgba(244,67,54,0.4)',
                  }} />
                  <span style={{ fontSize: '13px', color: '#f44336', fontWeight: 600, letterSpacing: '0.02em' }}>
                    REC {(elapsed / 1000).toFixed(0)}s
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                    {session.positionLog?.filter(p => p.type === 'track').length || 0} pts
                  </span>
                </div>
                <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: 8 }}>
                  Patient maintains alignment. Double-tap marks events.
                </p>
                <button className="danger" onClick={handleStopTracking}
                  style={{ width: '100%', padding: '12px', fontSize: '14px', fontWeight: 600, borderRadius: '10px' }}>
                  Stop Recording
                </button>
              </div>
            )}

            {/* WAITING: protocol-specific instructions */}
            {trialState === 'waiting' && trialProtocol === 'closeEyes' && (
              <div>
                <p style={{ fontSize: '13px', color: 'var(--warning)', marginBottom: 8 }}>
                  Targets reset. Patient's eyes should be closed.
                </p>
                <button className="accent" onClick={handleEyesOpen}
                  style={{ width: '100%', padding: '12px', fontSize: '14px', fontWeight: 600, borderRadius: '10px' }}>
                  Eyes Open — Start Adjusting
                </button>
              </div>
            )}
            {trialState === 'waiting' && trialProtocol === 'saccade' && (
              <div>
                <p style={{ fontSize: '13px', color: 'var(--warning)', marginBottom: 8 }}>
                  Targets reset. Ready to run saccade sequence.
                </p>
                <button className="accent" onClick={handleStartSaccade}
                  style={{ width: '100%', padding: '12px', fontSize: '14px', fontWeight: 600, borderRadius: '10px' }}>
                  Start Saccade Sequence
                </button>
                <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: 4 }}>
                  {session.config.saccadeJumps} jumps, {session.config.saccadeAmplitudePx}px amplitude, {session.config.saccadePauseDurationMs}ms pause
                </p>
              </div>
            )}

            {/* SACCADING: animation in progress */}
            {trialState === 'saccading' && (
              <div>
                <p style={{ fontSize: '13px', color: '#ff9800', marginBottom: 6 }}>
                  Saccade sequence running...
                </p>
                <div style={{
                  height: 5, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginBottom: 8,
                }}>
                  <div style={{
                    height: '100%', width: `${saccadeProgress * 100}%`,
                    background: 'linear-gradient(90deg, #ff9800, #ffb74d)', borderRadius: 4, transition: 'width 0.2s ease',
                    boxShadow: '0 0 8px rgba(255,152,0,0.3)',
                  }} />
                </div>
                <button className="danger" onClick={() => {
                  if (saccadeTimerRef.current) clearInterval(saccadeTimerRef.current);
                  hostRef.current?.broadcast({ type: 'saccade-stop' });
                  setTrialState('idle');
                  setSaccadeProgress(0);
                }} style={{ fontSize: '11px' }}>Cancel</button>
              </div>
            )}

            {/* ADJUSTING: patient aligns targets */}
            {trialState === 'adjusting' && (
              <div>
                {/* Prism sweep status */}
                {trialProtocol === 'prismSweep' && (() => {
                  const seq = session.config.prismSweepSequence || [6,4,2,0,-2,-4,-6];
                  const idx = session.prismSweepIndex || 0;
                  const demand = seq[idx] || 0;
                  return (
                    <div style={{ fontSize: '12px', marginBottom: 8, padding: '6px 10px', borderRadius: '8px', background: 'rgba(230,126,0,0.08)', border: '1px solid rgba(230,126,0,0.15)' }}>
                      Step {idx + 1}/{seq.length}: <b>{demand > 0 ? `${demand} BO` : demand < 0 ? `${Math.abs(demand)} BI` : '0 (baseline)'}</b>
                    </div>
                  );
                })()}
                <p style={{ fontSize: '12px', color: 'var(--success)', marginBottom: 4 }}>
                  Patient adjusting... ({(elapsed / 1000).toFixed(1)}s)
                  {trialProtocol === 'saccade' && <span style={{ color: 'var(--text-muted)' }}> — double-tap or capture</span>}
                </p>
                <button className="primary" onClick={() => {
                  if (trialProtocol === 'prismSweep') {
                    // Capture prism sweep step and advance
                    const s = sessionRef.current;
                    if (!s) return;
                    const seq = s.config.prismSweepSequence || [6,4,2,0,-2,-4,-6];
                    const idx = s.prismSweepIndex || 0;
                    const isNear = s.phase === 'near-align';
                    const ppi = isNear ? s.config.nearDisplayPPI : s.config.displayPPI;
                    const dist = isNear ? s.config.nearDistanceMm : s.config.distanceOpticalDistanceMm;
                    const metrics = computeTrialMetrics(s.targets.movableX, s.targets.movableY, ppi, dist);
                    const result = { demandPrism: seq[idx], measuredFD: metrics.horizontalPrism, xPx: s.targets.movableX, yPx: s.targets.movableY, capturedAt: new Date().toISOString() };
                    const nextIdx = idx + 1;
                    let next;
                    if (nextIdx < seq.length) {
                      const nextOffset = prismDioptersToPx(seq[nextIdx], dist, ppi);
                      next = { ...s, prismSweepIndex: nextIdx, prismSweepResults: [...(s.prismSweepResults||[]), result],
                        targets: { ...s.targets, fixedX: nextOffset, movableX: 0, movableY: 0 } };
                    } else {
                      // Sweep complete
                      next = { ...s, prismSweepIndex: nextIdx, prismSweepResults: [...(s.prismSweepResults||[]), result],
                        targets: { ...s.targets, fixedX: 0, movableX: 0, movableY: 0 } };
                      setTrialState('idle');
                    }
                    sessionRef.current = next;
                    setSession({ ...next });
                    hostRef.current?.broadcast({ type: 'state-updated', state: next });
                  } else {
                    handleCaptureTrial();
                  }
                }}
                  style={{
                    width: '100%', padding: '14px', fontSize: '16px', fontWeight: 700,
                    background: 'linear-gradient(135deg, #1a8a40, #2ea043, #1a8a40)',
                    borderColor: 'rgba(52,211,153,0.25)', marginBottom: 8, borderRadius: '12px',
                    boxShadow: '0 4px 20px rgba(46,160,67,0.2), inset 0 1px 0 rgba(255,255,255,0.08)',
                    letterSpacing: '0.02em', transition: 'all 0.2s ease',
                  }}>
                  {trialProtocol === 'prismSweep'
                    ? `CAPTURE & ${(session.prismSweepIndex || 0) + 1 < (session.config.prismSweepSequence || []).length ? 'NEXT STEP' : 'FINISH'}`
                    : 'LOCK IN MEASUREMENT'}
                </button>
                <button onClick={handleResetTarget} style={{ fontSize: '11px' }}>Re-center</button>
              </div>
            )}

            {/* Quick actions */}
            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <select value={session.config.movementSensitivity}
                onChange={e => handleSetSensitivity(e.target.value)}
                style={{ fontSize: '11px' }}>
                <option value="fine">Fine</option>
                <option value="normal">Normal</option>
                <option value="coarse">Coarse</option>
              </select>
              <button onClick={handleFlashLock} style={{ fontSize: '11px' }}>Flash Lock</button>
              <button onClick={() => {
                const s = sessionRef.current;
                if (s) hostRef.current?.broadcast({ type: 'state-updated', state: s });
              }} style={{ fontSize: '11px' }}>Resend</button>
              <button onClick={() => { setTrialState('idle'); setSaccadeProgress(0); }}
                style={{ fontSize: '11px' }}>Back</button>
            </div>

            {/* Advance */}
            <div style={{ marginTop: 10 }}>
              {currentPhase === 'distance-align' && (
                <button className="accent" onClick={() => handleAdvancePhase('transition')}
                  style={{ fontSize: '12px' }}>Advance to Near →</button>
              )}
              {currentPhase === 'near-align' && (
                <button className="accent" onClick={() => handleAdvancePhase('results')}
                  style={{ fontSize: '12px' }}>Finish → Results</button>
              )}
            </div>
          </div>
        )}

        {/* Fixation Lock — prominent toggle */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button onClick={() => handleSetLockMode(session.config.fixationLockMode === 'off' ? 'always' : 'off')}
            style={{
              flex: 1, padding: '10px', fontSize: '13px', fontWeight: 600, borderRadius: '10px',
              background: session.config.fixationLockMode !== 'off'
                ? 'linear-gradient(135deg, #1255a8, #1976d2, #1565c0)' : 'var(--bg-tertiary)',
              borderColor: session.config.fixationLockMode !== 'off'
                ? 'rgba(25,118,210,0.35)' : 'var(--border)',
              color: session.config.fixationLockMode !== 'off' ? '#fff' : 'var(--text-muted)',
              boxShadow: session.config.fixationLockMode !== 'off'
                ? '0 0 16px rgba(25,118,210,0.2), inset 0 1px 0 rgba(255,255,255,0.08)' : 'none',
              transition: 'all 0.25s ease',
            }}>
            Lock {session.config.fixationLockMode !== 'off' ? 'ON' : 'OFF'}
          </button>
          <button onClick={handleFlashLock}
            style={{ padding: '8px 12px', fontSize: '12px' }}>Flash</button>
          <select value={session.config.fixationLockMode}
            onChange={e => handleSetLockMode(e.target.value)}
            style={{ fontSize: '11px', padding: '4px' }}>
            {LOCK_MODES.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        {/* Pairing (collapsible) */}
        <div className="panel" style={{ padding: '10px' }}>
          <div onClick={() => setShowPairing(!showPairing)}
            style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
            {showPairing ? '▾' : '▸'} Pairing & Connections
          </div>
          {showPairing && peerId && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                {['clinician','distance','near','controller'].map(role => (
                  <span key={role} style={{ fontSize: '11px' }}>
                    <span className={`status-dot ${session.clients[role] ? 'connected' : 'disconnected'}`} />
                    {role}
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ background: '#fff', padding: 8, borderRadius: '10px', display: 'inline-block', boxShadow: '0 2px 12px rgba(0,0,0,0.25)' }}>
                  <QRCodeSVG value={`${baseUrl}/controller/${peerId}`} size={80} />
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace', lineHeight: 1.8 }}>
                  <div>Controller: .../{peerId}</div>
                  <div>Distance: .../{peerId}</div>
                  <div>Near: .../{peerId}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Suppression check panel */}
        {currentPhase === 'suppression' && (
          <div className="panel">
            <h3>Suppression Check</h3>
            <div className="btn-row" style={{ marginBottom: 8 }}>
              <button onClick={() => setSuppressionStep('red')}
                className={suppressionStep === 'red' ? 'accent' : ''}>Red Only</button>
              <button onClick={() => setSuppressionStep('green')}
                className={suppressionStep === 'green' ? 'accent' : ''}>Green Only</button>
              <button onClick={() => setSuppressionStep('both')}
                className={suppressionStep === 'both' ? 'accent' : ''}>Both</button>
            </div>
            <div className="btn-row">
              <button className="primary" onClick={() => handleRecordSuppression({
                redSeen: true, greenSeen: true, bothSeen: true, result: 'pass',
              })}>Pass</button>
              <button className="danger" onClick={() => handleRecordSuppression({
                redSeen: false, greenSeen: false, bothSeen: false, result: 'fail',
              })}>Fail</button>
              <button onClick={() => handleRecordSuppression({
                redSeen: null, greenSeen: null, bothSeen: null, result: 'uncertain',
              })}>Uncertain</button>
            </div>
          </div>
        )}

        {/* Color calibration panel */}
        {(currentPhase === 'color-cal-distance' || currentPhase === 'color-cal-near') && (
          <div className="panel">
            <h3>Color Calibration — {currentPhase === 'color-cal-distance' ? 'Distance' : 'Near'}</h3>
            <div className="btn-row" style={{ marginBottom: 8 }}>
              <button className={session.colorCalibration?.step === 'red' ? 'accent' : ''}
                onClick={() => updateSession(prev => ({
                  ...prev, colorCalibration: { ...prev.colorCalibration, step: 'red' },
                }))}>RED Only</button>
              <button className={session.colorCalibration?.step === 'green' ? 'accent' : ''}
                onClick={() => updateSession(prev => ({
                  ...prev, colorCalibration: { ...prev.colorCalibration, step: 'green' },
                }))}>GREEN Only</button>
            </div>
            <div style={{ fontSize: '11px', padding: 6, background: 'var(--bg-tertiary)', borderRadius: 4, marginBottom: 8 }}>
              {session.colorCalibration?.step === 'red'
                ? 'RED shown — should be INVISIBLE through red lens'
                : 'GREEN shown — should be INVISIBLE through green lens'}
            </div>
            <div className="field-row" style={{ marginBottom: 6 }}>
              <div>
                <label>Red</label>
                <input type="color" value={session.config.redColor}
                  onChange={e => handleUpdateConfig({ redColor: e.target.value })}
                  style={{ width: 50, height: 28 }} />
              </div>
              <div>
                <label>Green</label>
                <input type="color" value={session.config.greenColor}
                  onChange={e => handleUpdateConfig({ greenColor: e.target.value })}
                  style={{ width: 50, height: 28 }} />
              </div>
            </div>
            <div className="btn-row">
              <button className="primary" onClick={() => {
                const key = currentPhase === 'color-cal-distance' ? 'distanceCompleted' : 'nearCompleted';
                updateSession(prev => ({
                  ...prev, colorCalibration: { ...prev.colorCalibration, [key]: true },
                }));
              }}>Confirmed</button>
              <button className="danger" onClick={() => {
                const key = currentPhase === 'color-cal-distance' ? 'distanceCompleted' : 'nearCompleted';
                updateSession(prev => ({
                  ...prev, colorCalibration: { ...prev.colorCalibration, [key]: false },
                }));
              }}>Bleed-through</button>
            </div>
          </div>
        )}

        {/* Calibration (collapsible) */}
        {currentPhase?.startsWith('calibration') && (
          <div className="panel" style={{ padding: '10px' }}>
            <div onClick={() => setShowCalibration(!showCalibration)}
              style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
              {showCalibration ? '▾' : '▸'} Calibration
            </div>
            {showCalibration && (
              <div style={{ marginTop: 8 }}>
                <div className="btn-row">
                  <button className="primary" onClick={() => handleCompleteCalibration('distance')}>Dist Cal Done</button>
                  <button className="primary" onClick={() => handleCompleteCalibration('near')}>Near Cal Done</button>
                </div>
                <div style={{ marginTop: 6, fontSize: '10px', color: 'var(--text-muted)' }}>
                  Dist: {session.calibration.distance.completed ? '✓' : '—'} |
                  Near: {session.calibration.near.completed ? '✓' : '—'}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Transition */}
        {currentPhase === 'transition' && (
          <div className="panel">
            <h3>Transition</h3>
            <button className="primary" onClick={() => handleAdvancePhase('near-align')}>
              Begin Near Alignment</button>
          </div>
        )}

        {/* Configuration (collapsible) */}
        <div className="panel" style={{ padding: '10px' }}>
          <div onClick={() => setShowConfig(!showConfig)}
            style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
            {showConfig ? '▾' : '▸'} Configuration
          </div>
          {showConfig && (
            <div style={{ marginTop: 8 }}>
              <div className="field-row" style={{ marginBottom: 6 }}>
                <div>
                  <label>Target Preset</label>
                  <select value={session.config.targetPreset}
                    onChange={e => handleUpdateConfig({ targetPreset: e.target.value })}>
                    <option value="ring-cross">Ring & Cross</option>
                    <option value="cross-ring">Cross & Ring</option>
                    <option value="triangle-square">House</option>
                    <option value="vert-horiz">Plus Lines</option>
                    <option value="arrows-vert">Arrows (V only)</option>
                    <option value="paragraph">Paragraph</option>
                  </select>
                </div>
                <div>
                  <label>Sensitivity</label>
                  <select value={session.config.movementSensitivity}
                    onChange={e => handleSetSensitivity(e.target.value)}>
                    <option value="fine">Fine</option>
                    <option value="normal">Normal</option>
                    <option value="coarse">Coarse</option>
                  </select>
                </div>
              </div>
              <div className="field-row" style={{ marginBottom: 6 }}>
                <div>
                  <label>Dist Target (px)</label>
                  <input type="number" value={session.config.distanceTargetSizePx}
                    onChange={e => handleUpdateConfig({ distanceTargetSizePx: Number(e.target.value) })}
                    style={{ width: '100%' }} />
                </div>
                <div>
                  <label>Near Target (px)</label>
                  <input type="number" value={session.config.nearTargetSizePx}
                    onChange={e => handleUpdateConfig({ nearTargetSizePx: Number(e.target.value) })}
                    style={{ width: '100%' }} />
                </div>
                <div>
                  <label>Stroke</label>
                  <input type="number" value={session.config.strokeWidth}
                    onChange={e => handleUpdateConfig({ strokeWidth: Number(e.target.value) })}
                    style={{ width: '100%' }} />
                </div>
              </div>
              {session.config.targetPreset === 'paragraph' && (
                <div className="field-row" style={{ marginBottom: 6 }}>
                  <div>
                    <label>Para Font Dist (px)</label>
                    <input type="number" value={session.config.paragraphFontSizeDistance}
                      onChange={e => handleUpdateConfig({ paragraphFontSizeDistance: Number(e.target.value) })}
                      style={{ width: '100%' }} />
                  </div>
                  <div>
                    <label>Para Font Near (px)</label>
                    <input type="number" value={session.config.paragraphFontSizeNear}
                      onChange={e => handleUpdateConfig({ paragraphFontSizeNear: Number(e.target.value) })}
                      style={{ width: '100%' }} />
                  </div>
                </div>
              )}
              <div className="field-row" style={{ marginBottom: 6 }}>
                <div>
                  <label>Saccade jumps</label>
                  <input type="number" value={session.config.saccadeJumps}
                    onChange={e => handleUpdateConfig({ saccadeJumps: Number(e.target.value) })}
                    style={{ width: '100%' }} />
                </div>
                <div>
                  <label>Amplitude (px)</label>
                  <input type="number" value={session.config.saccadeAmplitudePx}
                    onChange={e => handleUpdateConfig({ saccadeAmplitudePx: Number(e.target.value) })}
                    style={{ width: '100%' }} />
                </div>
                <div>
                  <label>Pause (ms)</label>
                  <input type="number" value={session.config.saccadePauseDurationMs}
                    onChange={e => handleUpdateConfig({ saccadePauseDurationMs: Number(e.target.value) })}
                    style={{ width: '100%' }} />
                </div>
              </div>
              <div className="field-row" style={{ marginBottom: 6 }}>
                <div>
                  <label>Dist PPI</label>
                  <input type="number" value={session.config.displayPPI}
                    onChange={e => handleUpdateConfig({ displayPPI: Number(e.target.value) })}
                    style={{ width: '100%' }} />
                </div>
                <div>
                  <label>Near PPI</label>
                  <input type="number" value={session.config.nearDisplayPPI}
                    onChange={e => handleUpdateConfig({ nearDisplayPPI: Number(e.target.value) })}
                    style={{ width: '100%' }} />
                </div>
              </div>
              <div className="field-row" style={{ marginBottom: 6 }}>
                <div>
                  <label>Dist (mm)</label>
                  <input type="number" value={session.config.distanceOpticalDistanceMm}
                    onChange={e => handleUpdateConfig({ distanceOpticalDistanceMm: Number(e.target.value) })}
                    style={{ width: '100%' }} />
                </div>
                <div>
                  <label>Near (mm)</label>
                  <input type="number" value={session.config.nearDistanceMm}
                    onChange={e => handleUpdateConfig({ nearDistanceMm: Number(e.target.value) })}
                    style={{ width: '100%' }} />
                </div>
              </div>
              <div style={{ marginBottom: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={session.config.mirrorDistance}
                    onChange={e => handleUpdateConfig({ mirrorDistance: e.target.checked })} />
                  <span style={{ fontSize: '12px' }}>Mirror distance display</span>
                </label>
              </div>
              <div style={{ marginBottom: 6 }}>
                <label>Anti-bleed: {session.config.antiBleedLevel}%</label>
                <input type="range" min="0" max="50" value={session.config.antiBleedLevel}
                  onChange={e => handleUpdateConfig({ antiBleedLevel: Number(e.target.value) })}
                  style={{ width: '100%' }} />
              </div>
              <div className="field-row">
                <div>
                  <label>Red int: {session.config.redIntensity}%</label>
                  <input type="range" min="10" max="100" value={session.config.redIntensity}
                    onChange={e => handleUpdateConfig({ redIntensity: Number(e.target.value) })}
                    style={{ width: '100%' }} />
                </div>
                <div>
                  <label>Green int: {session.config.greenIntensity}%</label>
                  <input type="range" min="10" max="100" value={session.config.greenIntensity}
                    onChange={e => handleUpdateConfig({ greenIntensity: Number(e.target.value) })}
                    style={{ width: '100%' }} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <button onClick={handleResetTarget} style={{ fontSize: '11px' }}>Re-center</button>
          <button onClick={() => {
            const s = sessionRef.current;
            if (s) hostRef.current?.broadcast({ type: 'state-updated', state: s });
          }} style={{ fontSize: '11px' }}>Resend</button>
          <button onClick={() => {
            // Force recreate the host peer — fixes stale signaling issues
            const oldHost = hostRef.current;
            const s = sessionRef.current;
            if (!oldHost || !s) return;
            oldHost.destroy();
            hostRef.current = null;
            setPeerId(null);
            setHostStatus('Reconnecting host...');
            createHost(
              (role) => {
                const ss = sessionRef.current;
                if (ss) {
                  const next = setClientConnected(ss, role, true);
                  sessionRef.current = next;
                  setSession({ ...next });
                  hostRef.current?.sendTo(role, { type: 'state-updated', state: next });
                }
              },
              (role) => {
                const ss = sessionRef.current;
                if (ss) {
                  const next = setClientConnected(ss, role, false);
                  sessionRef.current = next;
                  setSession({ ...next });
                }
              },
              (msg) => peerMessageHandlerRef.current?.(msg),
              roomName.trim(),
              (statusMsg) => setHostStatus(statusMsg),
            ).then((host) => {
              hostRef.current = host;
              setPeerId(host.peerId);
              setHostStatus('Host reconnected: ' + host.peerId);
              // Update clients to disconnected until they reconnect
              const next = { ...sessionRef.current,
                clients: { clinician: true, distance: false, near: false, controller: false },
              };
              sessionRef.current = next;
              setSession({ ...next });
            }).catch(err => {
              setHostStatus('Reconnect failed: ' + (err?.message || err));
            });
          }} style={{ fontSize: '11px', color: 'var(--warning)' }}>Force Reconnect</button>
          <button className="danger" onClick={() => {
            hostRef.current?.destroy();
            sessionRef.current = null;
            setSession(null);
          }} style={{ fontSize: '11px' }}>End</button>
        </div>
        {hostStatus && (
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: 4 }}>{hostStatus}</div>
        )}
      </div>

      {/* ===== RIGHT: Live Data & Results ===== */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
        {/* === LIVE PRISM READOUT === */}
        <div className="panel" style={{ borderColor: 'rgba(107,170,255,0.15)', background: 'rgba(12,16,30,0.70)', backdropFilter: 'blur(20px) saturate(1.5)', WebkitBackdropFilter: 'blur(20px) saturate(1.5)', boxShadow: '0 0 30px rgba(107,170,255,0.05), 0 8px 32px rgba(0,0,0,0.25)' }}>
          <h3 style={{ color: 'var(--accent)', marginBottom: 10, letterSpacing: '-0.02em' }}>Live Position</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 2 }}>Horizontal</div>
              <div style={{
                fontSize: '32px', fontWeight: 700, fontFamily: "'SF Mono', 'Fira Code', monospace",
                color: livePrism ? (Math.abs(livePrism.horizontalPrism) < 0.1 ? 'var(--success)' : 'var(--text-primary)') : 'var(--text-muted)',
                letterSpacing: '-0.02em', transition: 'color 0.3s ease',
              }}>
                {livePrism ? formatPrism(livePrism.horizontalPrism, liveLabels?.hBase || '') : '—'}
              </div>
              {liveLabels?.hType && (
                <div style={{ fontSize: '12px', fontWeight: 600, color: liveLabels.hType.includes('Eso') ? '#ff9800' : '#2196f3' }}>
                  {liveLabels.hType}
                </div>
              )}
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                {livePrism ? `${livePrism.xPx.toFixed(1)} px / ${livePrism.xArcMin.toFixed(1)} arcmin` : ''}
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 2 }}>Vertical</div>
              <div style={{
                fontSize: '32px', fontWeight: 700, fontFamily: "'SF Mono', 'Fira Code', monospace",
                color: livePrism ? (Math.abs(livePrism.verticalPrism) < 0.1 ? 'var(--success)' : 'var(--text-primary)') : 'var(--text-muted)',
                letterSpacing: '-0.02em', transition: 'color 0.3s ease',
              }}>
                {livePrism ? formatPrism(livePrism.verticalPrism, liveLabels?.vBase || '') : '—'}
              </div>
              {liveLabels?.vType && (
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#ab47bc' }}>
                  {liveLabels.vType}
                </div>
              )}
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                {livePrism ? `${livePrism.yPx.toFixed(1)} px / ${livePrism.yArcMin.toFixed(1)} arcmin` : ''}
              </div>
            </div>
          </div>
          {livePrism && (
            <div style={{ textAlign: 'center', marginTop: 8, fontSize: '12px', color: 'var(--text-secondary)' }}>
              Vector: {livePrism.vectorPrism.toFixed(2)} pd
              {liveLabels?.movableEye && (
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: 8 }}>
                  (movable eye: {liveLabels.movableEye})
                </span>
              )}
            </div>
          )}
        </div>

        {/* Preview */}
        <div className="panel" style={{ padding: '8px', overflow: 'hidden' }}>
          <ClinicianPreview session={session} />
        </div>

        {/* Suppression result */}
        {session.suppressionCheck.completed && (
          <div style={{
            padding: '8px 12px', borderRadius: '10px', marginBottom: 10, fontSize: '12px', fontWeight: 500,
            background: session.suppressionCheck.result === 'pass' ? 'rgba(52,211,153,0.06)' :
                        session.suppressionCheck.result === 'fail' ? 'rgba(248,113,113,0.06)' : 'rgba(251,191,36,0.06)',
            border: `1px solid ${session.suppressionCheck.result === 'pass' ? 'rgba(52,211,153,0.2)' :
                     session.suppressionCheck.result === 'fail' ? 'rgba(248,113,113,0.2)' : 'rgba(251,191,36,0.2)'}`,
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}>
            Suppression: <b>{session.suppressionCheck.result?.toUpperCase()}</b>
          </div>
        )}

        {/* === TRIAL TABLE === */}
        {session.trials.length > 0 && (
          <div className="panel">
            <h3>Locked-In Trials</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['#','Proto','Phase','Horizontal','Vertical','Vector','Type','Time'].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {session.trials.map((t, i) => {
                    const labels = getPrismLabels(t.xPx, t.yPx, session.config, session.targets);
                    return (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={tdStyle}>{t.trialNumber}</td>
                        <td style={{ ...tdStyle, fontSize: '10px' }}>{t.protocol === 'saccade' ? 'SAC' : 'CE'}</td>
                        <td style={tdStyle}>{t.phase}</td>
                        <td style={{ ...tdStyle, fontWeight: 'bold' }}>
                          {formatPrism(t.horizontalPrism, labels.hBase)}
                        </td>
                        <td style={{ ...tdStyle, fontWeight: 'bold' }}>
                          {formatPrism(t.verticalPrism, labels.vBase)}
                        </td>
                        <td style={tdStyle}>{t.vectorPrism.toFixed(2)} pd</td>
                        <td style={{ ...tdStyle, fontSize: '10px' }}>
                          {labels.hType && <div style={{ color: labels.hType.includes('Eso') ? '#ff9800' : '#2196f3' }}>{labels.hType}</div>}
                          {labels.vType && <div style={{ color: '#ab47bc' }}>{labels.vType}</div>}
                        </td>
                        <td style={tdStyle}>{t.timeToAlignMs ? (t.timeToAlignMs / 1000).toFixed(1) + 's' : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Position Graph */}
        {(session.positionLog?.length > 0 || session.trials.length > 0) && (
          <div className="panel">
            <h3>Position Over Time</h3>
            <PositionGraph positionLog={session.positionLog || []} trials={session.trials} config={session.config} targets={session.targets} />
          </div>
        )}

        {/* Horizontal alignment graph — vertical orientation, time flows down */}
        {session.autoProtocol?.phaseMarkers?.length > 0 && session.positionLog?.length > 10 && (
          <div className="panel">
            <h3>Horizontal Alignment</h3>
            <HorizontalTimelineGraph positionLog={session.positionLog || []} phaseMarkers={session.autoProtocol.phaseMarkers} startTime={session.autoProtocol.startTime} />
          </div>
        )}

        {/* Vertical alignment graph — horizontal orientation */}
        {session.autoProtocol?.phaseMarkers?.length > 0 && session.positionLog?.length > 10 && (
          <div className="panel">
            <h3>Vertical Alignment</h3>
            <VerticalTimelineGraph positionLog={session.positionLog || []} phaseMarkers={session.autoProtocol.phaseMarkers} startTime={session.autoProtocol.startTime} />
          </div>
        )}

        {/* Phase Analysis — extracted from continuous signal */}
        {session.autoProtocol?.phaseMarkers?.length > 0 && session.positionLog?.length > 10 && (
          <div className="panel">
            <h3>Phase Analysis (from continuous signal)</h3>
            <PhaseMetricsTable positionLog={session.positionLog} phaseMarkers={session.autoProtocol.phaseMarkers} config={session.config} />
          </div>
        )}

        {/* FD Curve (Prism Sweep) */}
        {session.prismSweepResults?.length >= 2 && (
          <div className="panel">
            <h3>Forced Vergence FD Curve</h3>
            <FDCurveGraph sweepResults={session.prismSweepResults} />
          </div>
        )}

        {/* Tracking Analysis */}
        {session.positionLog?.filter(p => p.type === 'track').length > 10 && (
          <div className="panel">
            <h3>Tracking Analysis</h3>
            <TrackingAnalysisPanel trackPoints={session.positionLog.filter(p => p.type === 'track')} />
          </div>
        )}

        {/* Recovery Dynamics */}
        {session.positionLog?.filter(p => p.type === 'recovery').length > 5 && (
          <div className="panel">
            <h3>Recovery Dynamics</h3>
            <RecoveryDynamicsGraph recoveryPoints={session.positionLog.filter(p => p.type === 'recovery')} />
          </div>
        )}

        {/* H-V Scatter Plot */}
        {session.trials.length >= 2 && (
          <div className="panel">
            <h3>H-V Scatter</h3>
            <HVScatterPlot trials={session.trials} />
          </div>
        )}

        {/* Statistics */}
        {(distStats || nearStats) && (
          <div className="panel">
            <h3>Statistics</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {distStats && <StatsBlock title="Distance" stats={distStats} />}
              {nearStats && <StatsBlock title="Near" stats={nearStats} />}
            </div>
          </div>
        )}

        {/* EMR Summary */}
        {(currentPhase === 'results' || session.trials.length > 0) && (
          <div className="panel">
            <h3>EMR Summary</h3>
            <button onClick={handleGenerateSummary} style={{ marginBottom: 6, fontSize: '11px' }}>
              Generate</button>
            <textarea value={summaryText} onChange={e => setSummaryText(e.target.value)}
              rows={6} style={{ width: '100%', fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: '11px', resize: 'vertical', borderRadius: '8px', lineHeight: 1.6 }}
              placeholder="Click Generate or type..." />
            <div style={{ marginTop: 6 }}>
              <button className="primary" onClick={handleCopyToClipboard} style={{ fontSize: '12px' }}>
                {copySuccess ? 'Copied!' : 'Copy to Clipboard'}</button>
            </div>
            <p style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: 4 }}>
              Prism values are estimates from subjective alignment, not objective recording.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ClinicianPreview({ session }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session) return;
    const draw = () => {
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      renderTargets(ctx, session, w / 2, h / 2, {
        showFixation: true, showRed: true, showGreen: true, scale: 0.25,
        canvasHeight: h, canvasWidth: w,
      });
      animRef.current = requestAnimationFrame(draw);
    };
    animRef.current = requestAnimationFrame(draw);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [session]);

  return <canvas ref={canvasRef} width={960} height={540}
    style={{ borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)', display: 'block', width: '100%', boxShadow: 'inset 0 1px 4px rgba(0,0,0,0.3)' }} />;
}

function StatsBlock({ title, stats }) {
  return (
    <div style={{ fontSize: '11px', fontFamily: "'SF Mono', 'Fira Code', monospace", lineHeight: 1.8, padding: '8px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)' }}>
      <div style={{ fontWeight: 700, fontSize: '12px', marginBottom: 6, letterSpacing: '-0.01em' }}>{title} ({stats.count} trials)</div>
      <div>H prism: {stats.meanH_prism} pd (SD {stats.stdX_px} px)</div>
      <div>V prism: {stats.meanV_prism} pd (SD {stats.stdY_px} px)</div>
      <div>Mean: {stats.meanX_arcmin}' × {stats.meanY_arcmin}' arcmin</div>
      <div style={{
        color: stats.variabilityNote === 'Good repeatability' ? 'var(--success)' :
               stats.variabilityNote === 'High variability' ? 'var(--danger)' : 'var(--warning)',
      }}>{stats.variabilityNote}</div>
    </div>
  );
}

/** Position-over-time graph — shows tracking data and discrete captures */
function PositionGraph({ positionLog, trials, config, targets }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const pad = { top: 20, right: 20, bottom: 30, left: 50 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    // Combine all data points
    const allPoints = [...(positionLog || [])];
    const trialPoints = (trials || []).map(t => ({
      t: new Date(t.capturedAt).getTime(), x: t.xPx, y: t.yPx,
      type: 'capture', protocol: t.protocol || 'closeEyes',
    }));
    allPoints.push(...trialPoints);

    if (allPoints.length === 0) return;

    allPoints.sort((a, b) => a.t - b.t);
    const t0 = allPoints[0].t;
    const tMax = allPoints[allPoints.length - 1].t - t0 || 1000;

    // Compute Y range
    let maxAbs = 10;
    for (const p of allPoints) {
      maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y));
    }
    maxAbs = Math.ceil(maxAbs * 1.2);

    const toX = (t) => pad.left + ((t - t0) / tMax) * plotW;
    const toY = (v) => pad.top + plotH / 2 - (v / maxAbs) * (plotH / 2);

    // Grid
    ctx.strokeStyle = '#21262d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, toY(0));
    ctx.lineTo(w - pad.right, toY(0));
    ctx.stroke();

    // Y axis labels
    ctx.fillStyle = '#484f58';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`+${maxAbs}px`, pad.left - 4, pad.top + 4);
    ctx.fillText('0', pad.left - 4, toY(0) + 3);
    ctx.fillText(`-${maxAbs}px`, pad.left - 4, pad.top + plotH);

    // X axis labels
    ctx.textAlign = 'center';
    const secs = tMax / 1000;
    for (let s = 0; s <= secs; s += Math.max(1, Math.floor(secs / 5))) {
      const tx = toX(t0 + s * 1000);
      ctx.fillText(`${s}s`, tx, h - 5);
    }

    // Draw tracking line (continuous)
    const trackPts = allPoints.filter(p => p.type === 'track');
    if (trackPts.length > 1) {
      // Horizontal (blue)
      ctx.strokeStyle = '#42a5f5';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      trackPts.forEach((p, i) => {
        const px = toX(p.t), py = toY(p.x);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.stroke();

      // Vertical (orange)
      ctx.strokeStyle = '#ffa726';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      trackPts.forEach((p, i) => {
        const px = toX(p.t), py = toY(p.y);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    // Draw tap markers (triangles)
    const tapPts = allPoints.filter(p => p.type === 'tap');
    for (const p of tapPts) {
      const px = toX(p.t);
      ctx.fillStyle = '#66bb6a';
      ctx.beginPath();
      ctx.moveTo(px, toY(0) - 4);
      ctx.lineTo(px - 4, toY(0) + 4);
      ctx.lineTo(px + 4, toY(0) + 4);
      ctx.closePath();
      ctx.fill();
    }

    // Draw capture markers (circles)
    const capPts = allPoints.filter(p => p.type === 'capture');
    for (const p of capPts) {
      const px = toX(p.t);
      // H
      ctx.fillStyle = '#42a5f5';
      ctx.beginPath();
      ctx.arc(px, toY(p.x), 4, 0, Math.PI * 2);
      ctx.fill();
      // V
      ctx.fillStyle = '#ffa726';
      ctx.beginPath();
      ctx.arc(px, toY(p.y), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Legend
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#42a5f5';
    ctx.fillText('— H (px)', w - 100, 14);
    ctx.fillStyle = '#ffa726';
    ctx.fillText('— V (px)', w - 50, 14);
  }, [positionLog, trials, config, targets]);

  return <canvas ref={canvasRef} width={600} height={200}
    style={{ width: '100%', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)', boxShadow: 'inset 0 1px 4px rgba(0,0,0,0.3)' }} />;
}

/** Phase metrics table — automatic extraction from continuous signal */
function PhaseMetricsTable({ positionLog, phaseMarkers, config }) {
  const metrics = useMemo(() => extractPhaseMetrics(positionLog, phaseMarkers), [positionLog, phaseMarkers]);
  if (!metrics.length) return null;

  const isNear = false; // TODO: detect from phase
  const ppi = isNear ? config.nearDisplayPPI : config.displayPPI;
  const dist = isNear ? config.nearDistanceMm : config.distanceOpticalDistanceMm;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', fontSize: '11px' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            {['Phase', 'Initial H', 'Settled H', 'Settled V', 'Settle Time', 'Var H', 'Var V'].map(h => (
              <th key={h} style={thStyle}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metrics.filter(m => m.samples > 5).map((m, i) => {
            const initH = computeTrialMetrics(m.initialX, m.initialY, ppi, dist);
            const settH = computeTrialMetrics(m.settledX, m.settledY, ppi, dist);
            return (
              <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                <td style={{ ...tdStyle, fontSize: '10px', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.label}</td>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{initH.horizontalPrism.toFixed(2)} pd</td>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{settH.horizontalPrism.toFixed(2)} pd</td>
                <td style={tdStyle}>{settH.verticalPrism.toFixed(2)} pd</td>
                <td style={tdStyle}>{m.timeToSettleS}s</td>
                <td style={tdStyle}>{m.settledVarX.toFixed(1)} px</td>
                <td style={tdStyle}>{m.settledVarY.toFixed(1)} px</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: 6 }}>
        Initial H = fixation disparity at phase onset. Settled = after patient aligned. Var = stability of settled position.
      </p>
    </div>
  );
}

/**
 * Horizontal graph: VERTICAL orientation — time flows downward, eye position along X.
 * From patient perspective: right eye on right side.
 * Exo = right eye moves right, Eso = crosses midline to left.
 * Smoothed with moving average.
 */
function HorizontalTimelineGraph({ positionLog, phaseMarkers, startTime }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !positionLog?.length) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const pad = { left: 60, right: 20, top: 35, bottom: 30 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, w, h);

    // Smooth the data
    const raw = [...positionLog].filter(p => p.type === 'track').sort((a, b) => a.t - b.t);
    const smoothed = smoothPositionData(raw, 7);
    if (smoothed.length < 2) return;

    const t0 = startTime || smoothed[0].t;
    const tEnd = smoothed[smoothed.length - 1].t;
    const tRange = Math.max(tEnd - t0, 1000);

    let maxAbs = 10;
    for (const p of smoothed) maxAbs = Math.max(maxAbs, Math.abs(p.x));
    maxAbs = Math.ceil(maxAbs * 1.3);

    // Time flows DOWN (Y axis), position along X axis
    // +X (right) = exo (right eye moves right from patient perspective)
    // -X (left) = eso (right eye crosses to left)
    const toX = v => pad.left + plotW / 2 + (v / maxAbs) * (plotW / 2);
    const toY = t => pad.top + ((t - t0) / tRange) * plotH;

    // Center line (zero = aligned)
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(toX(0), pad.top); ctx.lineTo(toX(0), h - pad.bottom); ctx.stroke();

    // Labels at top
    ctx.fillStyle = '#555b6e'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('← Eso', pad.left + plotW * 0.2, pad.top - 18);
    ctx.fillText('Exo →', pad.left + plotW * 0.8, pad.top - 18);
    ctx.fillStyle = '#42a5f5'; ctx.font = '11px sans-serif';
    ctx.fillText('Right Eye — Horizontal Position', pad.left + plotW / 2, pad.top - 6);

    // X axis position labels
    ctx.fillStyle = '#555b6e'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
    for (let v = -maxAbs; v <= maxAbs; v += Math.ceil(maxAbs / 3)) {
      if (v === 0) continue;
      ctx.fillText(`${v}px`, toX(v), pad.top - 22);
    }

    // Time labels on left (Y axis)
    ctx.textAlign = 'right';
    const totalS = tRange / 1000;
    const tickInt = totalS > 120 ? 30 : totalS > 60 ? 10 : totalS > 20 ? 5 : 2;
    for (let s = 0; s <= totalS; s += tickInt) {
      const ty = toY(t0 + s * 1000);
      ctx.fillText(`${s}s`, pad.left - 8, ty + 3);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, ty); ctx.lineTo(w - pad.right, ty); ctx.stroke();
    }

    // Phase markers (horizontal bands with labels on right)
    const markers = phaseMarkers || [];
    ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
    for (let i = 0; i < markers.length; i++) {
      const my = toY(markers[i].t);
      const nextY = i + 1 < markers.length ? toY(markers[i + 1].t) : h - pad.bottom;

      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(107,170,255,0.03)';
        ctx.fillRect(pad.left, my, plotW, nextY - my);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(pad.left, my); ctx.lineTo(w - pad.right, my); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText(markers[i].label, w - pad.right + 4, my + 10);
    }

    // Draw the smoothed trace
    ctx.strokeStyle = '#42a5f5'; ctx.lineWidth = 2; ctx.globalAlpha = 0.85;
    ctx.beginPath();
    smoothed.forEach((p, i) => {
      const px = toX(p.x), py = toY(p.t);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }, [positionLog, phaseMarkers, startTime]);

  return <canvas ref={canvasRef} width={500} height={700}
    style={{ width: '100%', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)' }} />;
}

/**
 * Vertical graph: HORIZONTAL orientation — time flows right, eye position along Y.
 * Right hyper = target moves up (patient moves it down) = negative Y in data = plotted upward.
 * Right hypo = target moves down = positive Y in data = plotted downward.
 * Smoothed.
 */
function VerticalTimelineGraph({ positionLog, phaseMarkers, startTime }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !positionLog?.length) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const pad = { left: 55, right: 20, top: 25, bottom: 25 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, w, h);

    const raw = [...positionLog].filter(p => p.type === 'track').sort((a, b) => a.t - b.t);
    const smoothed = smoothPositionData(raw, 7);
    if (smoothed.length < 2) return;

    const t0 = startTime || smoothed[0].t;
    const tEnd = smoothed[smoothed.length - 1].t;
    const tRange = Math.max(tEnd - t0, 1000);

    let maxAbs = 10;
    for (const p of smoothed) maxAbs = Math.max(maxAbs, Math.abs(p.y));
    maxAbs = Math.ceil(maxAbs * 1.3);

    // Time along X, vertical position along Y
    // In data: +Y = patient moved target DOWN = right eye is HYPO (or left hyper)
    // Display: +Y data plots DOWNWARD on graph (right hypo = down on graph)
    // -Y data = patient moved target UP = right eye is HYPER = plots UPWARD
    const toX = t => pad.left + ((t - t0) / tRange) * plotW;
    const toY = v => pad.top + plotH / 2 + (v / maxAbs) * (plotH / 2); // +v = down on graph

    // Zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, toY(0)); ctx.lineTo(w - pad.right, toY(0)); ctx.stroke();

    // Labels
    ctx.fillStyle = '#ffa726'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Right Eye — Vertical Position', pad.left, pad.top - 8);
    ctx.fillStyle = '#555b6e'; ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('R Hyper ↑', pad.left - 4, pad.top + 10);
    ctx.fillText('R Hypo ↓', pad.left - 4, h - pad.bottom - 4);

    // Y axis labels
    ctx.font = '9px monospace';
    for (let v = -maxAbs; v <= maxAbs; v += Math.ceil(maxAbs / 3)) {
      if (v === 0) continue;
      ctx.fillText(`${v}px`, pad.left - 8, toY(v) + 3);
    }

    // Time labels
    ctx.textAlign = 'center';
    const totalS = tRange / 1000;
    const tickInt = totalS > 120 ? 30 : totalS > 60 ? 10 : totalS > 20 ? 5 : 2;
    for (let s = 0; s <= totalS; s += tickInt) {
      ctx.fillText(`${s}s`, toX(t0 + s * 1000), h - 5);
    }

    // Phase markers
    const markers = phaseMarkers || [];
    ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    for (let i = 0; i < markers.length; i++) {
      const mx = toX(markers[i].t);
      const nextX = i + 1 < markers.length ? toX(markers[i + 1].t) : w - pad.right;
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,152,0,0.03)';
        ctx.fillRect(mx, pad.top, nextX - mx, plotH);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(mx, pad.top); ctx.lineTo(mx, h - pad.bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText(markers[i].label, (mx + nextX) / 2, pad.top - 2);
    }

    // Smoothed trace
    ctx.strokeStyle = '#ffa726'; ctx.lineWidth = 2; ctx.globalAlpha = 0.85;
    ctx.beginPath();
    smoothed.forEach((p, i) => {
      const px = toX(p.t), py = toY(p.y);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }, [positionLog, phaseMarkers, startTime]);

  return <canvas ref={canvasRef} width={700} height={250}
    style={{ width: '100%', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)' }} />;
}

/** FD Curve graph — plots the Ogle-type forced vergence S-curve */
function FDCurveGraph({ sweepResults }) {
  const canvasRef = useRef(null);
  const curve = useMemo(() => computeFDCurve(sweepResults), [sweepResults]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !curve) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const pad = { top: 20, right: 20, bottom: 30, left: 55 };
    const pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    const pts = curve.points;
    const maxD = Math.max(...pts.map(p => Math.abs(p.demand)), 1) * 1.2;
    const maxF = Math.max(...pts.map(p => Math.abs(p.fd)), 0.5) * 1.3;

    const toX = d => pad.left + ((d + maxD) / (2 * maxD)) * pw;
    const toY = f => pad.top + ph / 2 - (f / maxF) * (ph / 2);

    // Grid
    ctx.strokeStyle = '#21262d'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, toY(0)); ctx.lineTo(w - pad.right, toY(0)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(toX(0), pad.top); ctx.lineTo(toX(0), h - pad.bottom); ctx.stroke();

    // Labels
    ctx.fillStyle = '#555b6e'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('BO ←', pad.left + 30, h - 5);
    ctx.fillText('→ BI', w - pad.right - 30, h - 5);
    ctx.textAlign = 'right';
    ctx.fillText('Eso', pad.left - 4, pad.top + 10);
    ctx.fillText('Exo', pad.left - 4, h - pad.bottom - 4);

    // Curve line
    ctx.strokeStyle = '#6baaff'; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, i) => { const x = toX(p.demand), y = toY(p.fd); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke();

    // Points
    pts.forEach(p => {
      ctx.fillStyle = '#6baaff';
      ctx.beginPath(); ctx.arc(toX(p.demand), toY(p.fd), 4, 0, Math.PI * 2); ctx.fill();
    });

    // X-intercept
    if (curve.xIntercept !== null) {
      const xi = toX(curve.xIntercept);
      ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(xi, pad.top); ctx.lineTo(xi, h - pad.bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fbbf24'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(`Assoc. phoria: ${curve.xIntercept.toFixed(1)} pd`, xi, pad.top - 4);
    }

    // Slope annotation
    ctx.fillStyle = '#9298a8'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(`Slope: ${curve.slope.toFixed(3)}`, w - pad.right, pad.top + 10);
  }, [curve]);

  return <canvas ref={canvasRef} width={600} height={220}
    style={{ width: '100%', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)' }} />;
}

/** Tracking trajectory analysis panel */
function TrackingAnalysisPanel({ trackPoints }) {
  const analysis = useMemo(() => analyzeTrackingTrajectory(trackPoints), [trackPoints]);
  if (!analysis) return null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: '12px', fontFamily: "'SF Mono', monospace" }}>
      <div><span style={{ color: 'var(--text-muted)' }}>Duration:</span> {analysis.durationS}s ({analysis.samples} pts)</div>
      <div><span style={{ color: 'var(--text-muted)' }}>Mean drift:</span> {analysis.meanDriftVelocity} px/s</div>
      <div><span style={{ color: 'var(--text-muted)' }}>Peak drift:</span> {analysis.peakDriftVelocity} px/s</div>
      <div><span style={{ color: 'var(--text-muted)' }}>Correction freq:</span> {analysis.correctionFrequency} Hz</div>
      <div><span style={{ color: 'var(--text-muted)' }}>Drift bias X:</span> {analysis.driftBiasX} px</div>
      <div><span style={{ color: 'var(--text-muted)' }}>Drift bias Y:</span> {analysis.driftBiasY} px</div>
      <div><span style={{ color: 'var(--text-muted)' }}>Dom. frequency:</span> {analysis.dominantFrequency} Hz</div>
    </div>
  );
}

/** Recovery dynamics graph — shows trajectory after saccade disruption */
function RecoveryDynamicsGraph({ recoveryPoints }) {
  const canvasRef = useRef(null);
  const analysis = useMemo(() => analyzeRecoveryDynamics(recoveryPoints), [recoveryPoints]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analysis) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const pad = { top: 20, right: 20, bottom: 30, left: 50 };
    const pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    const pts = analysis.points;
    if (pts.length < 2) return;
    const maxT = pts[pts.length - 1].t || 1;
    const maxAbs = Math.max(analysis.peakDisplacementX, analysis.peakDisplacementY, 5) * 1.2;

    const toX = t => pad.left + (t / maxT) * pw;
    const toY = v => pad.top + ph / 2 - (v / maxAbs) * (ph / 2);

    // Zero line
    ctx.strokeStyle = '#21262d'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, toY(0)); ctx.lineTo(w - pad.right, toY(0)); ctx.stroke();

    // H line (blue)
    ctx.strokeStyle = '#42a5f5'; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, i) => { i === 0 ? ctx.moveTo(toX(p.t), toY(p.x)) : ctx.lineTo(toX(p.t), toY(p.x)); });
    ctx.stroke();

    // V line (orange)
    ctx.strokeStyle = '#ffa726'; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, i) => { i === 0 ? ctx.moveTo(toX(p.t), toY(p.y)) : ctx.lineTo(toX(p.t), toY(p.y)); });
    ctx.stroke();

    // Stabilize marker
    if (analysis.timeToStabilize < maxT) {
      const sx = toX(analysis.timeToStabilize);
      ctx.strokeStyle = '#34d399'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(sx, pad.top); ctx.lineTo(sx, h - pad.bottom); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Annotations
    ctx.fillStyle = '#9298a8'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`${analysis.damping} | settle: ${analysis.timeToStabilize}s | oscillations: ${analysis.oscillationCount}`, pad.left, h - 5);
  }, [analysis]);

  return <canvas ref={canvasRef} width={600} height={180}
    style={{ width: '100%', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)' }} />;
}

/** H-V Scatter plot — horizontal vs vertical FD across trials */
function HVScatterPlot({ trials }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || trials.length < 1) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const pad = { top: 20, right: 20, bottom: 30, left: 50 };
    const pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    const hs = trials.map(t => t.horizontalPrism);
    const vs = trials.map(t => t.verticalPrism);
    const maxH = Math.max(...hs.map(Math.abs), 0.5) * 1.3;
    const maxV = Math.max(...vs.map(Math.abs), 0.5) * 1.3;

    const toX = v => pad.left + ((v + maxH) / (2 * maxH)) * pw;
    const toY = v => pad.top + ((v + maxV) / (2 * maxV)) * ph;

    // Crosshair
    ctx.strokeStyle = '#21262d'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(toX(0), pad.top); ctx.lineTo(toX(0), h - pad.bottom); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad.left, toY(0)); ctx.lineTo(w - pad.right, toY(0)); ctx.stroke();

    // Labels
    ctx.fillStyle = '#555b6e'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Eso →', w - pad.right - 20, toY(0) - 4);
    ctx.fillText('← Exo', pad.left + 20, toY(0) - 4);
    ctx.textAlign = 'right';
    ctx.fillText('Hyper', pad.left - 4, pad.top + 10);
    ctx.fillText('Hypo', pad.left - 4, h - pad.bottom - 4);

    // Protocol colors
    const colors = { closeEyes: '#42a5f5', saccade: '#ffa726', tracking: '#ab47bc', prismSweep: '#66bb6a' };

    // Plot points
    trials.forEach(t => {
      const x = toX(t.horizontalPrism), y = toY(t.verticalPrism);
      ctx.fillStyle = colors[t.protocol] || '#6baaff';
      ctx.beginPath();
      if (t.phase === 'near') {
        ctx.rect(x - 4, y - 4, 8, 8); ctx.fill();
      } else {
        ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      }
    });

    // Correlation
    const r = pearsonCorrelation(hs, vs);
    ctx.fillStyle = '#9298a8'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(`r = ${r.toFixed(3)} (n=${trials.length})`, w - pad.right, pad.top - 4);

    // Legend
    ctx.textAlign = 'left'; ctx.font = '9px sans-serif';
    let lx = pad.left;
    Object.entries(colors).forEach(([k, c]) => {
      ctx.fillStyle = c; ctx.fillRect(lx, h - 10, 8, 8);
      ctx.fillStyle = '#555b6e'; ctx.fillText(k, lx + 10, h - 3);
      lx += ctx.measureText(k).width + 20;
    });
  }, [trials]);

  return <canvas ref={canvasRef} width={400} height={300}
    style={{ width: '100%', maxWidth: 400, borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)' }} />;
}

const thStyle = { textAlign: 'left', padding: '6px 8px', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em' };
const tdStyle = { padding: '6px 8px', fontFamily: "'SF Mono', 'Fira Code', monospace", whiteSpace: 'nowrap', fontSize: '12px' };
