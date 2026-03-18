import { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { createHost } from '../lib/peer';
import {
  createSession, setPhase, setClientConnected, moveTarget,
  resetTarget, updateConfig, updateSuppression, updateCalibration,
  captureTrial,
} from '../lib/sessionStore';
import { computeTrialStats, generateEMRSummary } from '../lib/measurement';
import { renderTargets } from '../lib/targets';

const PHASES = [
  { key: 'setup', label: 'Setup' },
  { key: 'pairing', label: 'Pairing' },
  { key: 'color-cal-distance', label: 'Color Cal (Dist)' },
  { key: 'color-cal-near', label: 'Color Cal (Near)' },
  { key: 'suppression', label: 'Suppression Check' },
  { key: 'calibration-distance', label: 'Distance Calibration' },
  { key: 'calibration-near', label: 'Near Calibration' },
  { key: 'calibration-handoff', label: 'Handoff Calibration' },
  { key: 'distance-align', label: 'Distance Alignment' },
  { key: 'transition', label: 'Transition to Near' },
  { key: 'near-align', label: 'Near Alignment' },
  { key: 'results', label: 'Results' },
];

const LOCK_MODES = ['always', 'pulse', 'flash', 'off'];

export default function Clinician() {
  // Session state — clinician is the authoritative source
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

  // Helper: update session state + broadcast to peers + persist color settings
  const updateSession = useCallback((updater) => {
    const prev = sessionRef.current;
    if (!prev) return;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    sessionRef.current = next;
    setSession({ ...next });
    hostRef.current?.broadcast({ type: 'state-updated', state: next });
    // Persist color calibration settings to localStorage
    try {
      localStorage.setItem('fdq-color-cal', JSON.stringify({
        redColor: next.config.redColor,
        greenColor: next.config.greenColor,
        colorCalibration: next.colorCalibration,
      }));
    } catch (_) {}
  }, []);

  // Compute base URL for QR codes
  useEffect(() => {
    const origin = window.location.origin;
    const path = window.location.pathname;
    // For HashRouter, base is origin + path + #
    setBaseUrl(`${origin}${path}#`);
  }, []);

  // Cleanup peer on unmount
  useEffect(() => {
    return () => { hostRef.current?.destroy(); };
  }, []);

  // --- Actions ---
  const handleCreateSession = useCallback(() => {
    if (!roomName.trim()) return;
    setConnecting(true);
    setPeerError(null);

    createHost(
      // onPeerConnect
      (role) => {
        const s = sessionRef.current;
        if (s) {
          const next = setClientConnected(s, role, true);
          sessionRef.current = next;
          setSession({ ...next });
          hostRef.current?.sendTo(role, { type: 'state-updated', state: next });
        }
      },
      // onPeerDisconnect
      (role) => {
        const s = sessionRef.current;
        if (s) {
          const next = setClientConnected(s, role, false);
          sessionRef.current = next;
          setSession({ ...next });
        }
      },
      // onMessage
      (msg) => {
        const s = sessionRef.current;
        if (!s) return;
        switch (msg.type) {
          case 'move-target': {
            const next = moveTarget(s, msg.dx, msg.dy);
            sessionRef.current = next;
            setSession({ ...next });
            hostRef.current?.broadcast({
              type: 'target-moved',
              x: next.targets.movableX,
              y: next.targets.movableY,
            });
            break;
          }
          default:
            break;
        }
      },
      // customId — use room name for stable URLs
      roomName.trim(),
    ).then((host) => {
      hostRef.current = host;
      setPeerId(host.peerId);
      setConnecting(false);
      // Create the session once peer is ready, restore saved color calibration
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
      console.error('Failed to create host:', err);
      setConnecting(false);
      if (err?.type === 'unavailable-id') {
        setPeerError(`Room "${roomName}" is already in use. Choose a different name or wait a moment.`);
      } else {
        setPeerError(`Connection failed: ${err?.message || err}`);
      }
    });
  }, [patientId, examiner, roomName]);

  const handleAdvancePhase = useCallback((phase) => {
    updateSession(prev => {
      const next = setPhase(prev, phase);
      return next;
    });
  }, [updateSession]);

  const handleCaptureTrial = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    const { session: next, trial } = captureTrial(s);
    const reset = { ...next, targets: { ...next.targets, movableX: 0, movableY: 0 } };
    sessionRef.current = reset;
    setSession({ ...reset });
    hostRef.current?.broadcast({ type: 'state-updated', state: reset });
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
    const distTrials = s.trials.filter(t => t.phase === 'distance');
    const nearTrials = s.trials.filter(t => t.phase === 'near');
    const distStats = computeTrialStats(distTrials);
    const nearStats = computeTrialStats(nearTrials);
    const text = generateEMRSummary(s, distStats, nearStats);
    setSummaryText(text);
  }, []);

  const handleCopyToClipboard = useCallback(() => {
    navigator.clipboard.writeText(summaryText).then(() => {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    });
  }, [summaryText]);

  // Computed stats
  const distTrials = session?.trials.filter(t => t.phase === 'distance') || [];
  const nearTrials = session?.trials.filter(t => t.phase === 'near') || [];
  const distStats = computeTrialStats(distTrials);
  const nearStats = computeTrialStats(nearTrials);
  const currentPhase = session?.phase || 'setup';
  const phaseIndex = PHASES.findIndex(p => p.key === currentPhase);

  // --- No session yet ---
  if (!session) {
    return (
      <div style={{ maxWidth: 600, margin: '40px auto', padding: '0 20px' }}>
        <h1 style={{ fontSize: '20px', marginBottom: '4px' }}>Fixation Disparity Quantifier</h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', fontSize: '13px' }}>
          In-phoropter binocular fixation disparity quantification
        </p>
        <div className="panel">
          <h3>New Session</h3>
          {peerError && (
            <p style={{ color: 'var(--danger)', fontSize: '12px', marginBottom: 8 }}>
              {peerError}
            </p>
          )}
          <div className="field-group">
            <label>Room Name (stable URL identifier)</label>
            <input value={roomName} onChange={e => setRoomName(e.target.value)}
              placeholder="e.g. lane1, exam-room-2" style={{ width: '100%' }} />
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Display URLs stay the same as long as this name doesn't change
            </span>
          </div>
          <div className="field-group">
            <label>Patient ID (optional)</label>
            <input value={patientId} onChange={e => setPatientId(e.target.value)}
              placeholder="Leave blank if not needed" style={{ width: '100%' }} />
          </div>
          <div className="field-group">
            <label>Examiner (optional)</label>
            <input value={examiner} onChange={e => setExaminer(e.target.value)}
              placeholder="Your name" style={{ width: '100%' }} />
          </div>
          <button className="primary" onClick={handleCreateSession}
            disabled={connecting || !roomName.trim()} style={{ marginTop: 8 }}>
            {connecting ? 'Connecting...' : 'Start Session'}
          </button>
        </div>
      </div>
    );
  }

  // --- Active session ---
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Left: Controls */}
      <div style={{
        width: '380px', minWidth: '380px',
        borderRight: '1px solid var(--border)',
        overflowY: 'auto', padding: '12px',
      }}>
        <div style={{ marginBottom: 12 }}>
          <h2 style={{ fontSize: '16px', marginBottom: '2px' }}>FDQ Console</h2>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Room: {roomName} | Session: {session.sessionId}
          </span>
        </div>

        {/* Phase Stepper */}
        <div className="panel">
          <h3>Phase</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {PHASES.map((p, i) => (
              <button key={p.key} onClick={() => handleAdvancePhase(p.key)}
                style={{
                  fontSize: '11px', padding: '3px 8px',
                  background: p.key === currentPhase ? 'var(--accent)' : undefined,
                  borderColor: p.key === currentPhase ? 'var(--accent)' : undefined,
                  opacity: i <= phaseIndex ? 1 : 0.5,
                }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Connection Status */}
        <div className="panel">
          <h3>Connections</h3>
          {['clinician', 'distance', 'near', 'controller'].map(role => (
            <div key={role} style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
              <span className={`status-dot ${session.clients[role] ? 'connected' : 'disconnected'}`} />
              <span style={{ fontSize: '13px', textTransform: 'capitalize' }}>{role}</span>
            </div>
          ))}
        </div>

        {/* QR / Pairing */}
        {(currentPhase === 'setup' || currentPhase === 'pairing') && peerId && (
          <div className="panel">
            <h3>Pairing</h3>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Phone Controller
                </div>
                <div style={{ background: '#fff', padding: 8, borderRadius: 6, display: 'inline-block' }}>
                  <QRCodeSVG value={`${baseUrl}/controller/${peerId}`} size={100} />
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: 4, wordBreak: 'break-all', maxWidth: 180 }}>
                  {baseUrl}/controller/{peerId}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Display URLs
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: 4, wordBreak: 'break-all' }}>
                  Distance: {baseUrl}/distance/{peerId}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                  Near: {baseUrl}/near/{peerId}
                </div>
              </div>
            </div>
            <button className="primary" onClick={() => handleAdvancePhase('pairing')}
              style={{ marginTop: 8, fontSize: '12px' }}>
              Begin Pairing
            </button>
          </div>
        )}

        {/* Configuration */}
        <div className="panel">
          <h3>Configuration</h3>
          <div className="field-row" style={{ marginBottom: 8 }}>
            <div>
              <label>Target Preset</label>
              <select value={session.config.targetPreset}
                onChange={e => handleUpdateConfig({ targetPreset: e.target.value })}>
                <option value="ring-cross">Ring &amp; Cross</option>
                <option value="cross-ring">Cross &amp; Ring</option>
                <option value="triangle-square">House (Triangle+Square)</option>
                <option value="vert-horiz">Plus (Vert+Horiz Lines)</option>
                <option value="paragraph">Alternating Word Paragraph</option>
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
          <div className="field-row" style={{ marginBottom: 8 }}>
            <div>
              <label>Distance Target (px)</label>
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
            <div className="field-row" style={{ marginBottom: 8 }}>
              <div>
                <label>Paragraph Font Dist (px)</label>
                <input type="number" value={session.config.paragraphFontSizeDistance}
                  onChange={e => handleUpdateConfig({ paragraphFontSizeDistance: Number(e.target.value) })}
                  style={{ width: '100%' }} />
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>56 ≈ 20/30 on 55" 4K @ 25ft</span>
              </div>
              <div>
                <label>Paragraph Font Near (px)</label>
                <input type="number" value={session.config.paragraphFontSizeNear}
                  onChange={e => handleUpdateConfig({ paragraphFontSizeNear: Number(e.target.value) })}
                  style={{ width: '100%' }} />
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>15 ≈ 11pt</span>
              </div>
            </div>
          )}
          <div className="field-row" style={{ marginBottom: 8 }}>
            <div>
              <label>Display PPI</label>
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
          <div className="field-row" style={{ marginBottom: 8 }}>
            <div>
              <label>Distance (mm)</label>
              <input type="number" value={session.config.distanceOpticalDistanceMm}
                onChange={e => handleUpdateConfig({ distanceOpticalDistanceMm: Number(e.target.value) })}
                style={{ width: '100%' }} />
            </div>
            <div>
              <label>Near Distance (mm)</label>
              <input type="number" value={session.config.nearDistanceMm}
                onChange={e => handleUpdateConfig({ nearDistanceMm: Number(e.target.value) })}
                style={{ width: '100%' }} />
            </div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={session.config.mirrorDistance}
                onChange={e => handleUpdateConfig({ mirrorDistance: e.target.checked })} />
              <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}>Mirror distance display</span>
            </label>
          </div>
          <div style={{ marginBottom: 8, padding: '8px', background: 'var(--bg-tertiary)', borderRadius: 6 }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }}>
              Anti-bleed compensation: {session.config.antiBleedLevel}%
            </label>
            <input type="range" min="0" max="50" value={session.config.antiBleedLevel}
              onChange={e => handleUpdateConfig({ antiBleedLevel: Number(e.target.value) })}
              style={{ width: '100%' }} />
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
              Raises background luminance to mask filter bleed-through at near
            </span>
            <div className="field-row" style={{ marginTop: 6 }}>
              <div>
                <label>Red intensity: {session.config.redIntensity}%</label>
                <input type="range" min="10" max="100" value={session.config.redIntensity}
                  onChange={e => handleUpdateConfig({ redIntensity: Number(e.target.value) })}
                  style={{ width: '100%' }} />
              </div>
              <div>
                <label>Green intensity: {session.config.greenIntensity}%</label>
                <input type="range" min="10" max="100" value={session.config.greenIntensity}
                  onChange={e => handleUpdateConfig({ greenIntensity: Number(e.target.value) })}
                  style={{ width: '100%' }} />
              </div>
            </div>
          </div>
          <div className="field-row">
            <div>
              <label>Right Eye Sees</label>
              <select value={session.config.rightEyeSees}
                onChange={e => handleUpdateConfig({
                  rightEyeSees: e.target.value,
                  leftEyeSees: e.target.value === 'green' ? 'red' : 'green',
                })}>
                <option value="green">Green</option>
                <option value="red">Red</option>
              </select>
            </div>
            <div>
              <label>Movable Target</label>
              <select value={session.targets.movableIsRed ? 'red' : 'green'}
                onChange={e => {
                  const isRed = e.target.value === 'red';
                  updateSession(prev => ({
                    ...prev,
                    targets: { ...prev.targets, movableIsRed: isRed },
                  }));
                }}>
                <option value="red">Red (Ring)</option>
                <option value="green">Green (Cross)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Fixation Lock */}
        <div className="panel">
          <h3>Fixation Lock</h3>
          <div className="btn-row" style={{ marginBottom: 8 }}>
            {LOCK_MODES.map(mode => (
              <button key={mode} onClick={() => handleSetLockMode(mode)}
                style={{
                  fontSize: '12px', textTransform: 'capitalize',
                  background: session.config.fixationLockMode === mode ? 'var(--accent)' : undefined,
                  borderColor: session.config.fixationLockMode === mode ? 'var(--accent)' : undefined,
                }}>
                {mode}
              </button>
            ))}
          </div>
          <button onClick={handleFlashLock} style={{ fontSize: '12px' }}>Flash Now</button>
          <div style={{ marginTop: 8 }}>
            <label>Lock Size (px)</label>
            <input type="number" value={session.config.fixationLockSizePx}
              onChange={e => handleUpdateConfig({ fixationLockSizePx: Number(e.target.value) })}
              style={{ width: 80 }} />
          </div>
        </div>

        {/* Suppression Check */}
        {currentPhase === 'suppression' && (
          <div className="panel">
            <h3>Suppression Check</h3>
            <div className="btn-row" style={{ marginBottom: 8 }}>
              <button onClick={() => setSuppressionStep('red')}
                className={suppressionStep === 'red' ? 'accent' : ''}>Show Red Only</button>
              <button onClick={() => setSuppressionStep('green')}
                className={suppressionStep === 'green' ? 'accent' : ''}>Show Green Only</button>
              <button onClick={() => setSuppressionStep('both')}
                className={suppressionStep === 'both' ? 'accent' : ''}>Show Both</button>
            </div>
            <div style={{ marginTop: 8, fontSize: '12px' }}>
              <div style={{ marginBottom: 6 }}>Patient Response:</div>
              <div className="btn-row">
                <button className="primary" onClick={() => handleRecordSuppression({
                  redSeen: true, greenSeen: true, bothSeen: true, result: 'pass',
                })}>Both Seen — Pass</button>
                <button className="danger" onClick={() => handleRecordSuppression({
                  redSeen: suppressionStep !== 'green',
                  greenSeen: suppressionStep !== 'red',
                  bothSeen: false, result: 'fail',
                })}>Suppression — Fail</button>
                <button onClick={() => handleRecordSuppression({
                  redSeen: null, greenSeen: null, bothSeen: null, result: 'uncertain',
                })}>Uncertain</button>
              </div>
            </div>
          </div>
        )}

        {/* Color Calibration */}
        {(currentPhase === 'color-cal-distance' || currentPhase === 'color-cal-near') && (
          <div className="panel">
            <h3>Color Calibration — {currentPhase === 'color-cal-distance' ? 'Distance' : 'Near'}</h3>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: 8 }}>
              Verify red/green dissociation. Show each target and confirm the correct eye cannot see it through its matching lens.
            </p>
            <div className="btn-row" style={{ marginBottom: 10 }}>
              <button
                className={session.colorCalibration?.step === 'red' ? 'accent' : ''}
                onClick={() => updateSession(prev => ({
                  ...prev,
                  colorCalibration: { ...prev.colorCalibration, step: 'red' },
                }))}>
                Show RED Only
              </button>
              <button
                className={session.colorCalibration?.step === 'green' ? 'accent' : ''}
                onClick={() => updateSession(prev => ({
                  ...prev,
                  colorCalibration: { ...prev.colorCalibration, step: 'green' },
                }))}>
                Show GREEN Only
              </button>
            </div>
            <div style={{ fontSize: '12px', marginBottom: 10, padding: '8px', background: 'var(--bg-tertiary)', borderRadius: 6 }}>
              {session.colorCalibration?.step === 'red' ? (
                <>
                  <div style={{ color: '#ff6666', marginBottom: 4 }}>RED target displayed</div>
                  <div>Patient through <b>RED lens</b>: should <b>NOT</b> see target</div>
                  <div>Patient through <b>GREEN lens</b>: should see target</div>
                </>
              ) : (
                <>
                  <div style={{ color: '#66ff66', marginBottom: 4 }}>GREEN target displayed</div>
                  <div>Patient through <b>GREEN lens</b>: should <b>NOT</b> see target</div>
                  <div>Patient through <b>RED lens</b>: should see target</div>
                </>
              )}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: 6 }}>
              Adjust colors if target bleeds through wrong lens:
            </div>
            <div className="field-row" style={{ marginBottom: 8 }}>
              <div>
                <label>Red Color</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="color" value={session.config.redColor}
                    onChange={e => handleUpdateConfig({ redColor: e.target.value })}
                    style={{ width: 36, height: 30, padding: 2 }} />
                  <input value={session.config.redColor}
                    onChange={e => handleUpdateConfig({ redColor: e.target.value })}
                    style={{ width: 80 }} />
                </div>
              </div>
              <div>
                <label>Green Color</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="color" value={session.config.greenColor}
                    onChange={e => handleUpdateConfig({ greenColor: e.target.value })}
                    style={{ width: 36, height: 30, padding: 2 }} />
                  <input value={session.config.greenColor}
                    onChange={e => handleUpdateConfig({ greenColor: e.target.value })}
                    style={{ width: 80 }} />
                </div>
              </div>
            </div>
            <div className="btn-row">
              <button className="primary" onClick={() => {
                const key = currentPhase === 'color-cal-distance' ? 'distanceCompleted' : 'nearCompleted';
                updateSession(prev => ({
                  ...prev,
                  colorCalibration: { ...prev.colorCalibration, [key]: true },
                }));
              }}>
                Dissociation Confirmed
              </button>
              <button className="danger" onClick={() => {
                const key = currentPhase === 'color-cal-distance' ? 'distanceCompleted' : 'nearCompleted';
                updateSession(prev => ({
                  ...prev,
                  colorCalibration: { ...prev.colorCalibration, [key]: false },
                }));
              }}>
                Bleed-through Detected
              </button>
            </div>
            <div style={{ marginTop: 6, fontSize: '11px', color: 'var(--text-muted)' }}>
              Distance: {session.colorCalibration?.distanceCompleted ? 'Confirmed' : 'Pending'} |{' '}
              Near: {session.colorCalibration?.nearCompleted ? 'Confirmed' : 'Pending'}
            </div>
          </div>
        )}

        {/* Calibration */}
        {currentPhase?.startsWith('calibration') && (
          <div className="panel">
            <h3>Calibration</h3>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: 8 }}>
              Use the display targets to confirm alignment. Patient adjusts until centered.
            </p>
            <div className="btn-row">
              <button className="primary" onClick={() => handleCompleteCalibration('distance')}>
                Complete Distance Cal</button>
              <button className="primary" onClick={() => handleCompleteCalibration('near')}>
                Complete Near Cal</button>
              <button onClick={() => handleCompleteCalibration('handoff')}>
                Complete Handoff Cal</button>
            </div>
            <div style={{ marginTop: 8, fontSize: '11px', color: 'var(--text-muted)' }}>
              Distance: {session.calibration.distance.completed ? 'Done' : 'Pending'} |{' '}
              Near: {session.calibration.near.completed ? 'Done' : 'Pending'} |{' '}
              Handoff: {session.calibration.handoff.completed ? 'Done' : 'Pending'}
            </div>
          </div>
        )}

        {/* Alignment Controls */}
        {(currentPhase === 'distance-align' || currentPhase === 'near-align') && (
          <div className="panel">
            <h3>{currentPhase === 'distance-align' ? 'Distance' : 'Near'} Alignment</h3>
            <div className="btn-row" style={{ marginBottom: 8 }}>
              <button className="primary" onClick={handleCaptureTrial}>Capture Trial</button>
              <button onClick={handleResetTarget}>Re-center Target</button>
            </div>
            {currentPhase === 'distance-align' && (
              <button className="accent" onClick={() => handleAdvancePhase('transition')}>
                Advance to Near →</button>
            )}
            {currentPhase === 'near-align' && (
              <button className="accent" onClick={() => handleAdvancePhase('results')}>
                Finish → Results</button>
            )}
          </div>
        )}

        {/* Transition */}
        {currentPhase === 'transition' && (
          <div className="panel">
            <h3>Distance → Near Transition</h3>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Animation in progress. Wait for targets to settle on near display.
            </p>
            <button className="primary" onClick={() => handleAdvancePhase('near-align')}
              style={{ marginTop: 8 }}>Begin Near Alignment</button>
          </div>
        )}

        {/* Quick Actions */}
        <div className="panel">
          <h3>Quick Actions</h3>
          <div className="btn-row">
            <button onClick={handleResetTarget}>Re-center</button>
            <button onClick={handleFlashLock}>Flash Lock</button>
            <button onClick={() => {
              const s = sessionRef.current;
              if (s) hostRef.current?.broadcast({ type: 'state-updated', state: s });
            }}>Resend State</button>
            <button className="danger" onClick={() => {
              sessionRef.current = null;
              setSession(null);
            }}>End Session</button>
          </div>
        </div>
      </div>

      {/* Right: Telemetry & Results */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
        {/* Live Telemetry */}
        <div className="panel">
          <h3>Live Telemetry</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '13px' }}>
            <div><span style={{ color: 'var(--text-secondary)' }}>Phase: </span>
              {PHASES.find(p => p.key === currentPhase)?.label || currentPhase}</div>
            <div><span style={{ color: 'var(--text-secondary)' }}>Sensitivity: </span>
              {session.config.movementSensitivity}</div>
            <div><span style={{ color: 'var(--text-secondary)' }}>Lock: </span>
              {session.config.fixationLockMode}</div>
            <div><span style={{ color: 'var(--text-secondary)' }}>Target X: </span>
              <span style={{ fontFamily: 'monospace', color: 'var(--accent)' }}>
                {session.targets.movableX.toFixed(1)} px</span></div>
            <div><span style={{ color: 'var(--text-secondary)' }}>Target Y: </span>
              <span style={{ fontFamily: 'monospace', color: 'var(--accent)' }}>
                {session.targets.movableY.toFixed(1)} px</span></div>
            <div><span style={{ color: 'var(--text-secondary)' }}>Size: </span>
              D:{session.config.distanceTargetSizePx} / N:{session.config.nearTargetSizePx} px</div>
          </div>
        </div>

        {/* Mini Preview */}
        <div className="panel">
          <h3>Target Preview</h3>
          <ClinicianPreview session={session} />
        </div>

        {/* Suppression Result */}
        {session.suppressionCheck.completed && (
          <div className="panel">
            <h3>Suppression Check Result</h3>
            <div style={{ fontSize: '13px' }}>
              <span style={{
                color: session.suppressionCheck.result === 'pass' ? 'var(--success)' :
                       session.suppressionCheck.result === 'fail' ? 'var(--danger)' : 'var(--warning)',
                fontWeight: 'bold',
              }}>{session.suppressionCheck.result?.toUpperCase()}</span>
              <span style={{ color: 'var(--text-secondary)', marginLeft: 8 }}>
                Red: {session.suppressionCheck.redSeen ? 'Yes' : 'No'} |{' '}
                Green: {session.suppressionCheck.greenSeen ? 'Yes' : 'No'} |{' '}
                Both: {session.suppressionCheck.bothSeen ? 'Yes' : 'No'}
              </span>
            </div>
          </div>
        )}

        {/* Trials Table */}
        {session.trials.length > 0 && (
          <div className="panel">
            <h3>Captured Trials</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['#','Phase','X (px)','Y (px)','X (mm)','Y (mm)','X (arcmin)','Y (arcmin)','H Prism','V Prism','Vector'].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {session.trials.map((t, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={tdStyle}>{t.trialNumber}</td>
                      <td style={tdStyle}>{t.phase}</td>
                      <td style={tdStyle}>{t.xPx}</td>
                      <td style={tdStyle}>{t.yPx}</td>
                      <td style={tdStyle}>{t.xMm}</td>
                      <td style={tdStyle}>{t.yMm}</td>
                      <td style={tdStyle}>{t.xArcMin}</td>
                      <td style={tdStyle}>{t.yArcMin}</td>
                      <td style={tdStyle}>{t.horizontalPrism}</td>
                      <td style={tdStyle}>{t.verticalPrism}</td>
                      <td style={tdStyle}>{t.vectorPrism}</td>
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
            <h3>Trial Statistics</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {distStats && <StatsBlock title="Distance" stats={distStats} />}
              {nearStats && <StatsBlock title="Near" stats={nearStats} />}
            </div>
          </div>
        )}

        {/* EMR Summary */}
        {(currentPhase === 'results' || session.trials.length > 0) && (
          <div className="panel">
            <h3>EMR Summary</h3>
            <button onClick={handleGenerateSummary} style={{ marginBottom: 8, fontSize: '12px' }}>
              Generate Summary</button>
            <textarea value={summaryText} onChange={e => setSummaryText(e.target.value)}
              rows={8} style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px', resize: 'vertical' }}
              placeholder="Click 'Generate Summary' or type your own..." />
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button className="primary" onClick={handleCopyToClipboard}>
                {copySuccess ? 'Copied!' : 'Copy to Clipboard'}</button>
            </div>
            <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: 6 }}>
              Prism values are estimates derived from subjective alignment displacement, not objective ocular motor recording.
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
      const w = canvas.width;
      const h = canvas.height;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      renderTargets(ctx, session, w / 2, h / 2, {
        showFixation: true, showRed: true, showGreen: true, scale: 0.5,
      });
      animRef.current = requestAnimationFrame(draw);
    };
    animRef.current = requestAnimationFrame(draw);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [session]);

  return (
    <canvas ref={canvasRef} width={320} height={200}
      style={{ borderRadius: 6, border: '1px solid var(--border)', display: 'block' }} />
  );
}

function StatsBlock({ title, stats }) {
  return (
    <div>
      <div style={{ fontWeight: 'bold', fontSize: '13px', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: '12px', fontFamily: 'monospace', lineHeight: 1.8 }}>
        <div>Trials: {stats.count}</div>
        <div>Mean X: {stats.meanX_px} px / {stats.meanX_mm} mm / {stats.meanX_arcmin} arcmin</div>
        <div>Mean Y: {stats.meanY_px} px / {stats.meanY_mm} mm / {stats.meanY_arcmin} arcmin</div>
        <div>Median X: {stats.medianX_px} px | Median Y: {stats.medianY_px} px</div>
        <div>SD X: {stats.stdX_px} px | SD Y: {stats.stdY_px} px</div>
        <div>Range X: {stats.rangeX_px} px | Range Y: {stats.rangeY_px} px</div>
        <div>H Prism: {stats.meanH_prism} pd | V Prism: {stats.meanV_prism} pd</div>
        <div>Radial Repeatability: {stats.radialRepeatability} mm</div>
        <div style={{
          color: stats.variabilityNote === 'Good repeatability' ? 'var(--success)' :
                 stats.variabilityNote === 'High variability' ? 'var(--danger)' : 'var(--warning)',
        }}>{stats.variabilityNote}</div>
      </div>
    </div>
  );
}

const thStyle = { textAlign: 'left', padding: '6px 8px', color: 'var(--text-secondary)', fontWeight: 500, whiteSpace: 'nowrap' };
const tdStyle = { padding: '5px 8px', fontFamily: 'monospace', whiteSpace: 'nowrap' };
