import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { createHost } from '../lib/peer';
import {
  createSession, setPhase, setClientConnected, moveTarget,
  resetTarget, updateConfig, updateSuppression, updateCalibration,
  captureTrial,
} from '../lib/sessionStore';
import { computeTrialMetrics, computeTrialStats, generateEMRSummary, getPrismLabels, formatPrism } from '../lib/measurement';
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
      // During tracking, double-tap just logs a marker
      logPosition('tap');
      const s = sessionRef.current;
      if (s) setSession({ ...s });
    }
  }, [doCapture, trialProtocol, trialState, logPosition]);

  // Keep ref in sync so message handler always has latest version
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
        // Saccade done — transition to adjusting
        setTrialState('adjusting');
        setEyesOpenTime(Date.now());
        setSaccadeProgress(1);
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
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <button className="primary" onClick={() => handleNewTrial('closeEyes')}
                    style={{ flex: 1, padding: '10px', fontSize: '12px', borderRadius: '10px', fontWeight: 600 }}>
                    Close Eyes
                  </button>
                  <button className="accent" onClick={() => handleNewTrial('saccade')}
                    style={{ flex: 1, padding: '10px', fontSize: '12px', borderRadius: '10px', fontWeight: 600 }}>
                    Saccade
                  </button>
                  <button onClick={handleStartTracking}
                    style={{ flex: 1, padding: '10px', fontSize: '12px', borderRadius: '10px', fontWeight: 600, background: 'linear-gradient(135deg, #5c1690, #7b2fbe)', borderColor: 'rgba(156,39,176,0.3)', color: '#fff', boxShadow: '0 0 12px rgba(123,47,190,0.15)' }}>
                    Tracking
                  </button>
                </div>
                <p style={{ fontSize: '9px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  Close Eyes: close → open → adjust → capture |
                  Saccade: lock jumps L/R → adjust → double-tap |
                  Tracking: continuous 30fps recording while patient maintains alignment
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
                <p style={{ fontSize: '12px', color: 'var(--success)', marginBottom: 4 }}>
                  Patient adjusting... ({(elapsed / 1000).toFixed(1)}s)
                  {trialProtocol === 'saccade' && (
                    <span style={{ color: 'var(--text-muted)' }}> — awaiting double-tap or capture</span>
                  )}
                </p>
                <button className="primary" onClick={handleCaptureTrial}
                  style={{
                    width: '100%', padding: '14px', fontSize: '16px', fontWeight: 700,
                    background: 'linear-gradient(135deg, #1a8a40, #2ea043, #1a8a40)',
                    borderColor: 'rgba(52,211,153,0.25)', marginBottom: 8, borderRadius: '12px',
                    boxShadow: '0 4px 20px rgba(46,160,67,0.2), inset 0 1px 0 rgba(255,255,255,0.08)',
                    letterSpacing: '0.02em', transition: 'all 0.2s ease',
                  }}>
                  LOCK IN MEASUREMENT
                </button>
                <button onClick={handleResetTarget} style={{ fontSize: '11px' }}>
                  Re-center
                </button>
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
        showFixation: true, showRed: true, showGreen: true, scale: 0.1,
        canvasHeight: h, canvasWidth: w,
      });
      animRef.current = requestAnimationFrame(draw);
    };
    animRef.current = requestAnimationFrame(draw);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [session]);

  return <canvas ref={canvasRef} width={300} height={180}
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

const thStyle = { textAlign: 'left', padding: '6px 8px', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em' };
const tdStyle = { padding: '6px 8px', fontFamily: "'SF Mono', 'Fira Code', monospace", whiteSpace: 'nowrap', fontSize: '12px' };
