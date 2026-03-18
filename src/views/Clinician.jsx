import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { createHost } from '../lib/peer';
import {
  createSession, setPhase, setClientConnected, moveTarget,
  resetTarget, updateConfig, updateSuppression, updateCalibration,
  captureTrial,
} from '../lib/sessionStore';
import { computeTrialMetrics, computeTrialStats, generateEMRSummary } from '../lib/measurement';
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

  // Trial workflow
  const [trialState, setTrialState] = useState('idle'); // idle | waiting | adjusting
  const [eyesOpenTime, setEyesOpenTime] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  // Collapsible sections
  const [showConfig, setShowConfig] = useState(false);
  const [showCalibration, setShowCalibration] = useState(false);
  const [showPairing, setShowPairing] = useState(true);

  // Timer for eyes-open duration
  useEffect(() => {
    if (trialState !== 'adjusting' || !eyesOpenTime) return;
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
    return () => { hostRef.current?.destroy(); };
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
      (msg) => {
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
        }
      },
      roomName.trim(),
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

  const handleCaptureTrial = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    const timeToAlignMs = eyesOpenTime ? Date.now() - eyesOpenTime : null;
    const { session: next, trial } = captureTrial(s);
    // Add time-to-align to the trial
    if (timeToAlignMs !== null) {
      next.trials[next.trials.length - 1].timeToAlignMs = timeToAlignMs;
    }
    sessionRef.current = next;
    setSession({ ...next });
    hostRef.current?.broadcast({ type: 'state-updated', state: next });
    setTrialState('idle');
    setEyesOpenTime(null);
    setElapsed(0);
  }, [eyesOpenTime]);

  const handleNewTrial = useCallback(() => {
    updateSession(prev => resetTarget(prev));
    setTrialState('waiting');
    setEyesOpenTime(null);
    setElapsed(0);
  }, [updateSession]);

  const handleEyesOpen = useCallback(() => {
    setTrialState('adjusting');
    setEyesOpenTime(Date.now());
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
      <div style={{ maxWidth: 600, margin: '40px auto', padding: '0 20px' }}>
        <h1 style={{ fontSize: '20px', marginBottom: '4px' }}>Fixation Disparity Quantifier</h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', fontSize: '13px' }}>
          In-phoropter binocular fixation disparity quantification
        </p>
        <div className="panel">
          <h3>New Session</h3>
          {peerError && <p style={{ color: 'var(--danger)', fontSize: '12px', marginBottom: 8 }}>{peerError}</p>}
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
            disabled={connecting || !roomName.trim()} style={{ marginTop: 8 }}>
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
        overflowY: 'auto', padding: '10px',
      }}>
        {/* Header */}
        <div style={{ marginBottom: 8 }}>
          <h2 style={{ fontSize: '15px', margin: 0 }}>FDQ Console</h2>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
            Room: {roomName} | {['clinician','distance','near','controller'].map(r =>
              <span key={r} style={{ color: session.clients[r] ? 'var(--success)' : 'var(--text-muted)' }}>
                {r[0].toUpperCase()}
              </span>
            )}
          </span>
        </div>

        {/* Phase stepper */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', marginBottom: 10 }}>
          {PHASES.map((p, i) => (
            <button key={p.key} onClick={() => handleAdvancePhase(p.key)}
              style={{
                fontSize: '10px', padding: '2px 6px',
                background: p.key === currentPhase ? 'var(--accent)' : undefined,
                borderColor: p.key === currentPhase ? 'var(--accent)' : undefined,
                opacity: i <= phaseIndex ? 1 : 0.4,
              }}>{p.label}</button>
          ))}
        </div>

        {/* ===== TRIAL WORKFLOW (main area during alignment) ===== */}
        {isAlignPhase && (
          <div className="panel" style={{ borderColor: 'var(--accent)', borderWidth: 2 }}>
            <h3 style={{ color: 'var(--accent)' }}>
              {currentPhase === 'distance-align' ? 'Distance' : 'Near'} Trial
            </h3>

            {/* Trial state machine */}
            {trialState === 'idle' && (
              <div>
                <button className="primary" onClick={handleNewTrial}
                  style={{ width: '100%', padding: '10px', fontSize: '14px' }}>
                  New Trial (Reset Targets)
                </button>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 6 }}>
                  Instruct patient to close eyes
                </p>
              </div>
            )}
            {trialState === 'waiting' && (
              <div>
                <p style={{ fontSize: '13px', color: 'var(--warning)', marginBottom: 8 }}>
                  Targets reset. Patient's eyes should be closed.
                </p>
                <button className="accent" onClick={handleEyesOpen}
                  style={{ width: '100%', padding: '10px', fontSize: '14px' }}>
                  Eyes Open — Start Adjusting
                </button>
              </div>
            )}
            {trialState === 'adjusting' && (
              <div>
                <p style={{ fontSize: '12px', color: 'var(--success)', marginBottom: 4 }}>
                  Patient adjusting... ({(elapsed / 1000).toFixed(1)}s)
                </p>
                <button className="primary" onClick={handleCaptureTrial}
                  style={{
                    width: '100%', padding: '14px', fontSize: '16px',
                    background: '#238636', marginBottom: 8,
                  }}>
                  LOCK IN MEASUREMENT
                </button>
                <button onClick={handleResetTarget} style={{ fontSize: '11px' }}>
                  Re-center
                </button>
              </div>
            )}

            {/* Quick actions during alignment */}
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

        {/* Fixation Lock (compact) */}
        <div className="panel" style={{ padding: '10px' }}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)', marginRight: 4 }}>Lock:</span>
            {LOCK_MODES.map(mode => (
              <button key={mode} onClick={() => handleSetLockMode(mode)}
                style={{
                  fontSize: '10px', padding: '2px 6px', textTransform: 'capitalize',
                  background: session.config.fixationLockMode === mode ? 'var(--accent)' : undefined,
                  borderColor: session.config.fixationLockMode === mode ? 'var(--accent)' : undefined,
                }}>{mode}</button>
            ))}
            <button onClick={handleFlashLock} style={{ fontSize: '10px', padding: '2px 6px' }}>Flash</button>
          </div>
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
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ background: '#fff', padding: 6, borderRadius: 4, display: 'inline-block' }}>
                  <QRCodeSVG value={`${baseUrl}/controller/${peerId}`} size={80} />
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                  <div>Controller: .../controller/{peerId}</div>
                  <div>Distance: .../distance/{peerId}</div>
                  <div>Near: .../near/{peerId}</div>
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
          <button className="danger" onClick={() => {
            sessionRef.current = null;
            setSession(null);
          }} style={{ fontSize: '11px' }}>End</button>
        </div>
      </div>

      {/* ===== RIGHT: Live Data & Results ===== */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
        {/* === LIVE PRISM READOUT === */}
        <div className="panel" style={{ borderColor: 'var(--accent)', borderWidth: 2 }}>
          <h3 style={{ color: 'var(--accent)', marginBottom: 8 }}>Live Position</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Horizontal</div>
              <div style={{
                fontSize: '32px', fontWeight: 'bold', fontFamily: 'monospace',
                color: livePrism ? (Math.abs(livePrism.horizontalPrism) < 0.1 ? 'var(--success)' : 'var(--text-primary)') : 'var(--text-muted)',
              }}>
                {livePrism ? livePrism.horizontalPrism.toFixed(2) : '—'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>prism diopters</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                {livePrism ? `${livePrism.xPx.toFixed(1)} px / ${livePrism.xArcMin.toFixed(1)} arcmin` : ''}
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Vertical</div>
              <div style={{
                fontSize: '32px', fontWeight: 'bold', fontFamily: 'monospace',
                color: livePrism ? (Math.abs(livePrism.verticalPrism) < 0.1 ? 'var(--success)' : 'var(--text-primary)') : 'var(--text-muted)',
              }}>
                {livePrism ? livePrism.verticalPrism.toFixed(2) : '—'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>prism diopters</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                {livePrism ? `${livePrism.yPx.toFixed(1)} px / ${livePrism.yArcMin.toFixed(1)} arcmin` : ''}
              </div>
            </div>
          </div>
          {livePrism && (
            <div style={{ textAlign: 'center', marginTop: 8, fontSize: '12px', color: 'var(--text-secondary)' }}>
              Vector: {livePrism.vectorPrism.toFixed(2)} pd
            </div>
          )}
        </div>

        {/* Preview */}
        <div className="panel" style={{ padding: '10px' }}>
          <ClinicianPreview session={session} />
        </div>

        {/* Suppression result */}
        {session.suppressionCheck.completed && (
          <div style={{
            padding: '6px 10px', borderRadius: 6, marginBottom: 10, fontSize: '12px',
            background: session.suppressionCheck.result === 'pass' ? '#0d1f0d' :
                        session.suppressionCheck.result === 'fail' ? '#1f0d0d' : '#1f1a0d',
            border: `1px solid ${session.suppressionCheck.result === 'pass' ? 'var(--success)' :
                     session.suppressionCheck.result === 'fail' ? 'var(--danger)' : 'var(--warning)'}`,
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
                    {['#','Phase','H (pd)','V (pd)','Vector','X (px)','Y (px)','Time (s)'].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {session.trials.map((t, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={tdStyle}>{t.trialNumber}</td>
                      <td style={tdStyle}>{t.phase}</td>
                      <td style={{ ...tdStyle, fontWeight: 'bold' }}>{t.horizontalPrism.toFixed(2)}</td>
                      <td style={{ ...tdStyle, fontWeight: 'bold' }}>{t.verticalPrism.toFixed(2)}</td>
                      <td style={tdStyle}>{t.vectorPrism.toFixed(2)}</td>
                      <td style={tdStyle}>{t.xPx}</td>
                      <td style={tdStyle}>{t.yPx}</td>
                      <td style={tdStyle}>{t.timeToAlignMs ? (t.timeToAlignMs / 1000).toFixed(1) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
              rows={6} style={{ width: '100%', fontFamily: 'monospace', fontSize: '11px', resize: 'vertical' }}
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
        showFixation: true, showRed: true, showGreen: true, scale: 0.4,
        canvasHeight: h, canvasWidth: w,
      });
      animRef.current = requestAnimationFrame(draw);
    };
    animRef.current = requestAnimationFrame(draw);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [session]);

  return <canvas ref={canvasRef} width={300} height={180}
    style={{ borderRadius: 4, border: '1px solid var(--border)', display: 'block', width: '100%' }} />;
}

function StatsBlock({ title, stats }) {
  return (
    <div style={{ fontSize: '11px', fontFamily: 'monospace', lineHeight: 1.7 }}>
      <div style={{ fontWeight: 'bold', fontSize: '12px', marginBottom: 4 }}>{title} ({stats.count} trials)</div>
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

const thStyle = { textAlign: 'left', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: 500, whiteSpace: 'nowrap', fontSize: '11px' };
const tdStyle = { padding: '4px 6px', fontFamily: 'monospace', whiteSpace: 'nowrap' };
