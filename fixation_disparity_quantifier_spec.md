# Fixation Disparity Quantifier Webapp Spec

## Purpose

Build a proof-of-concept web application for in-phoropter binocular fixation disparity quantification using red/green dissociation, a distance mirrored chart at 25 ft, a near tablet target at approximately 60 cm, and a blind phone-based touch controller.

The system should allow a patient wearing a phoropter with:
- right eye viewing through a red lens
- left eye viewing through a green lens

to align dissociated monocular targets while fixating a central lock. The app should quantify alignment error at distance and near, convert the result into screen-space units and angular units, and estimate prism equivalent.

The design goal is to preserve measurable binocular misalignment while avoiding target similarity that would encourage excessive sensory fusion or autoconvergence.

## Core Functional Requirements

### 1. Multi-device system architecture

The system should consist of 4 coordinated web clients:

1. Desktop clinician console
   - main control center
   - launches sessions
   - shows pairing state
   - controls suppression check
   - controls fixation lock behavior
   - advances phases
   - shows live coordinates and measurements
   - copies results summary for EMR

2. Distance display client
   - runs on the exam lane display mirrored into the eye chart path
   - presents fixation lock and dissociated test targets at optical distance of 25 ft

3. Near display client
   - runs on a tablet positioned slightly below midline at configurable near working distance, default about 60 cm
   - receives the animated transition handoff from the distance client
   - becomes the active target plane after the quick simulated movement into near

4. Patient blind touch controller
   - runs on the patient's phone
   - paired using QR code
   - provides full-screen blind touch gesture capture
   - does not require patient visual feedback
   - allows swipe in all directions
   - translates gesture input into controlled movement of the movable target

### 2. Eye-color mapping

Because a red target is effectively invisible through a red lens and visible through a green lens:

- right eye through red lens should view the green target
- left eye through green lens should view the red target

This mapping must be configurable in software but the default should match the optical setup above.

### 3. Test targets

Default target set:
- one eye sees a ring
- the other eye sees a cross

Requirements:
- targets must support horizontal and vertical alignment in one task
- targets must not be so similar that the binocular system strongly fuses them
- target geometry should permit precise center-to-center alignment judgment
- target size should be configurable
- stroke thickness should be configurable
- luminance and contrast should be configurable
- a small library architecture should exist so other target pairs can be added later

Recommended default:
- red ring for left eye only
- green cross for right eye only

### 4. Fixation lock

A central fixation lock should exist to support controlled binocular fixation while still allowing manipulation of the dissociated alignment targets.

Requirements:
- visible to both eyes by default
- clinician can briefly flash it
- clinician can turn it off
- clinician can choose always-on, pulsed, flash-on-demand, or off
- fixation lock size and contrast configurable
- fixation lock should remain central during each test phase
- during the distance-to-near transition, the fixation lock should appear to move in depth with the targets

### 5. Suppression / simultaneous perception check

Include a brief pre-test check that confirms:
- both monocular targets can be perceived when shown separately and together
- simultaneous perception is present
- gross suppression can be flagged

Minimal workflow:
1. show red-only target
2. show green-only target
3. show both
4. ask clinician or patient-confirmed response through desktop control
5. allow pass/fail or uncertain result

### 6. Baseline geometry calibration

Before binocular measurement begins, the system must run a calibration step to reduce geometric errors caused by:
- display scaling
- screen pixel density
- mirror path geometry
- tablet placement
- target plane mismatch
- phoropter alignment relative to display center

Calibration requirements:
- monocular baseline calibration supported
- patient-confirmed alignment points used
- clinician can manually re-run calibration at any time
- calibration should store:
  - display resolution
  - physical display dimensions if known
  - viewing distance
  - tablet distance
  - tablet vertical offset
  - center reference point
  - any monocular alignment offsets

Calibration modes:
1. Distance display calibration
2. Near display calibration
3. Distance-to-near handoff calibration

### 7. Distance-to-near transition

After distance alignment is completed, the targets and fixation lock should:
- quickly animate as if moving forward in space
- enlarge smoothly to simulate approach
- shift downward in the visual field
- visually transition onto the near tablet
- remain fixed on the tablet once handoff completes

This animation should be:
- fast
- smooth
- symmetrical
- configurable in timing
- believable as one continuous spatial movement

The near tablet physical position should be configurable by:
- working distance
- vertical offset relative to primary gaze
- screen dimensions
- orientation

The tablet handoff should be calibrated using patient-confirmed alignment points so the animated path appears centered and natural.

## Measurement Workflow

### Phase A. Session setup
Clinician enters:
- patient identifier optional or blank
- examiner name optional
- date and time auto-filled
- distance display details
- near tablet details
- red/green eye mapping
- working distance
- target preset
- fixation lock mode
- trial count option
- calibration reset if needed

### Phase B. Pairing
- clinician console generates QR code
- patient scans QR code on phone
- patient controller joins same session over local Wi-Fi
- desktop shows connected status
- distance and near displays join same session

### Phase C. Suppression check
- run brief simultaneous perception sequence
- clinician records result

### Phase D. Calibration
1. distance calibration
2. near calibration
3. optional handoff calibration

### Phase E. Distance free 2D alignment
- patient fixates central lock
- dissociated ring and cross displayed
- one target fixed
- one target movable
- patient swipes blindly on phone to shift movable target in x and y
- motion is stepwise with acceleration
- no visual feedback required on phone
- clinician sees live x and y coordinates on desktop
- when aligned, clinician presses capture on desktop
- optionally repeat for multiple trials

### Phase F. Animated shift to near
- fixation lock and targets animate down and forward
- handoff occurs onto tablet
- near tablet becomes active target display
- patient makes vergence movement to new near lock

### Phase G. Near free 2D alignment
- same free 2D alignment repeated at near
- capture one or more trials

### Phase H. Results summary
Generate quantitative output for:
- distance x offset
- distance y offset
- near x offset
- near y offset
- average of repeated trials if enabled
- trial-to-trial variability
- estimated angular disparity
- estimated prism equivalent
- free-text interpretation box for clinician copy-paste to EMR

## Input Design for Patient Phone Controller

### Blind touch design goals
The patient cannot see the phone while in the phoropter. The controller must therefore support eyes-free use.

Requirements:
- full-screen touch capture
- swipes accepted in any direction
- no requirement for hitting visible buttons
- tolerant of imprecise finger placement
- should ignore accidental taps unless configured otherwise
- should support one-handed use
- should have large invisible gesture area covering most of screen

Recommended behavior:
- upward swipe moves target up
- downward swipe moves target down
- left swipe moves target left
- right swipe moves target right
- diagonal swipes move in combined x and y directions
- longer swipe increases step size
- faster swipe increases acceleration
- very small movement results in fine adjustment
- optional dead zone reduces accidental drift

Optional advanced behavior:
- short swipe = fine step
- medium swipe = medium step
- long swipe = coarse step
- sustained drag may repeatedly issue steps at an accelerated rate

### Movement model
Use stepwise translation with acceleration, not continuous velocity.

Recommended implementation:
- base step size in screen pixels
- acceleration multiplier based on gesture magnitude and speed
- cap max step per gesture
- allow clinician to tune sensitivity presets:
  - fine
  - normal
  - coarse

## Quantification Requirements

### Primary raw outputs
Store for each capture:
- x displacement in pixels
- y displacement in pixels
- x displacement in mm on display plane where possible
- y displacement in mm on display plane where possible

### Angular conversion
Convert screen displacement into angular units.

For small angles:
- angle radians ≈ displacement / viewing distance
- angle degrees = radians × 57.2958
- arcminutes = degrees × 60

Compute separately for:
- horizontal disparity
- vertical disparity
- vector magnitude

At distance:
- use optical viewing distance equivalent of 25 ft unless physical mirror geometry requires custom effective distance entry

At near:
- use clinician-entered measured working distance, default 60 cm

### Prism estimate
Provide prism estimate derived from displacement angle and viewing distance.

Suggested output set:
- prism diopters horizontal
- prism diopters vertical
- resultant vector prism estimate

For small angles:
- prism diopters ≈ 100 × tan(theta)
- for very small angles, prism diopters ≈ 100 × theta in radians

The software should clearly label prism values as estimates derived from subjective alignment displacement, not objective ocular motor recording.

### Trial statistics
If repeat-trial mode is enabled, compute:
- mean x and y
- median x and y
- standard deviation
- radial repeatability
- range
- confidence note if variability exceeds threshold

## Clinician Console Requirements

The desktop webapp should include:

### Live control panel
- start session
- generate QR
- connect displays
- choose eye-color mapping
- choose target preset
- choose fixed vs movable target assignment
- enable or disable fixation lock
- flash fixation lock briefly
- run suppression check
- start calibration
- capture distance trial
- advance to near
- capture near trial
- repeat trial
- end session
- reset session

### Live telemetry
- connection status for phone, distance display, near tablet
- current phase
- current movable target x and y position
- target size
- active display plane
- current sensitivity preset

### Result pane
- table of all captures
- averaged values
- angular values
- prism estimate
- free-text interpretation / summary field
- copy-to-clipboard button for EMR use

## Display Client Requirements

### Distance display
- full-screen mode
- mirror-safe presentation mode if needed
- pixel-precise rendering
- configurable background color
- isolated rendering layers for:
  - binocular fixation lock
  - red-only target
  - green-only target
- low latency updates from controller

### Near tablet display
- full-screen mode
- same rendering engine as distance display
- receives transition handoff state
- can be calibrated independently
- remains stable after handoff

## Networking and Sync

### Pairing
Use QR code session pairing over local Wi-Fi.

Workflow:
1. desktop creates session token
2. QR code encodes local session URL and token
3. phone joins as controller
4. distance display joins as lane display
5. tablet joins as near display

### Transport
Recommended:
- WebSocket-based low-latency messaging
- shared session state on local host server or lightweight backend
- heartbeat / reconnect support
- graceful reconnect if one client drops

### Latency requirements
- target movement should feel immediate
- clinician phase changes should propagate quickly
- animation handoff should be synchronized between displays

## Suggested Technical Stack

This is a proof-of-concept webapp. Suggested stack:

- Frontend: React or Next.js
- Realtime sync: WebSockets using Socket.IO or native WebSocket
- Rendering: HTML5 Canvas or SVG layered rendering
- QR pairing: QR code library
- State management: lightweight centralized session store
- Clipboard export: native browser clipboard API
- Optional PWA support for phone controller

Canvas is likely preferred over DOM positioning for precise, low-latency rendering and animation.

## Data Model

Suggested session object:

```json
{
  "sessionId": "string",
  "createdAt": "ISO datetime",
  "patientId": "string or blank",
  "examiner": "string or blank",
  "config": {
    "distanceOpticalDistanceMm": 7620,
    "nearDistanceMm": 600,
    "nearVerticalOffsetMm": 50,
    "rightEyeSees": "green",
    "leftEyeSees": "red",
    "targetPreset": "ring-cross",
    "fixationLockMode": "always|flash|off|pulse",
    "movementSensitivity": "fine|normal|coarse",
    "repeatTrials": true
  },
  "calibration": {
    "distance": {},
    "near": {},
    "handoff": {}
  },
  "suppressionCheck": {
    "redSeen": true,
    "greenSeen": true,
    "bothSeen": true,
    "notes": ""
  },
  "trials": [
    {
      "phase": "distance|near",
      "trialNumber": 1,
      "xPx": 0,
      "yPx": 0,
      "xMm": 0,
      "yMm": 0,
      "xArcMin": 0,
      "yArcMin": 0,
      "horizontalPrism": 0,
      "verticalPrism": 0,
      "vectorPrism": 0,
      "capturedAt": "ISO datetime"
    }
  ],
  "summaryText": ""
}
```

## Calibration Details

### Distance calibration
Goal:
- identify true visual center
- correct monocular display offset
- confirm display scale if physical dimensions known

Suggested process:
1. show monocular calibration marker to one eye
2. patient aligns second marker until centered
3. repeat for fellow eye
4. derive monocular offset baseline
5. store zero-reference transform

### Near calibration
Same process at near on the tablet.

### Handoff calibration
Goal:
- ensure the animated path from distance display to tablet appears smooth and centered

Suggested process:
1. show transitional anchor points
2. patient confirms apparent alignment
3. clinician adjusts path origin, scale, and terminal landing point
4. store transform matrix or simplified mapping parameters

## Interpretation Guidance

The app should not diagnose. It should quantify alignment task results and present them neutrally.

Suggested summary wording style:
- subjective binocular alignment task completed at distance and near under red/green dissociation
- free 2D alignment offsets recorded
- values converted to screen, angular, and estimated prism units
- repeatability good / moderate / poor
- interpretation entered by clinician manually

## EMR Summary Box

Provide a free-text box prefilled with a structured draft that the clinician can edit and copy.

Example template:

```text
Fixation disparity quantifier performed in-phoropter with red/green dissociation at optical distance 25 ft and near at 60 cm. Patient completed free 2D alignment of dissociated ring/cross targets using blind phone controller. Distance alignment offset: X = [ ] px / [ ] mm / [ ] arcmin, Y = [ ] px / [ ] mm / [ ] arcmin, estimated prism: horiz [ ], vert [ ]. Near alignment offset: X = [ ] px / [ ] mm / [ ] arcmin, Y = [ ] px / [ ] mm / [ ] arcmin, estimated prism: horiz [ ], vert [ ]. Suppression check: [ ]. Trial repeatability: [ ]. Clinical interpretation: [ ].
```

## Non-Goals for Version 1

Do not build these initially unless trivial:
- eye tracking
- automated head tracking
- cloud account system
- EMR integration API
- formal normative database
- automated prism prescription recommendation
- objective torsional measurement
- machine learning interpretation layer

## Edge Cases to Handle

- patient phone disconnects mid-test
- tablet disconnects during transition
- orientation mismatch on tablet
- distance display scaling changed by browser zoom
- browser enters non-fullscreen unexpectedly
- patient makes very large swipe accidentally
- clinician needs instant recenter
- one target is not visible because color mapping is wrong
- suppression suspected
- repeated trials highly variable

## Acceptance Criteria for Proof of Concept

The proof of concept is successful if it can:
1. pair desktop, distance display, tablet, and phone via local Wi-Fi
2. show dissociated ring/cross targets with correct color-eye mapping
3. allow blind 2D patient control of one target via swipes
4. support fixation lock on, flash, and off behavior
5. run suppression check
6. perform baseline calibration at distance and near
7. capture distance and near alignment values
8. animate a believable quick distance-to-near handoff
9. convert offsets to px, mm, arcmin, and estimated prism
10. provide editable copy-paste summary text for EMR

## Recommended Build Order

1. Single-screen rendering of ring/cross with one movable target
2. Desktop manual keyboard control for target movement
3. Phone QR pairing and blind swipe controller
4. Distance measurement capture and unit conversion
5. Near tablet client
6. Distance-to-near animation handoff
7. Calibration workflows
8. Suppression check
9. Repeat-trial statistics
10. EMR summary generator

## Notes for the Agentic Coding System

- Prioritize deterministic rendering and calibration clarity over visual polish.
- Keep all geometric transforms explicit and inspectable.
- Build the rendering engine so each target layer can be independently shown, hidden, recolored, scaled, and translated.
- Keep measurement math centralized in a dedicated module with unit-tested conversion functions.
- Use a session-state architecture where any client can reconnect and recover current state.
- Treat this as a research/prototype instrument, not a regulated medical device.
