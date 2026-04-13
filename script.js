const API_BASE = "https://gazecloud.onrender.com";
let isSessionActive = false;
let sessionStartTime = null;
let sessionData = [];
let sessionID = null;
let gazeInterval = null;
let lostFrames = 0;
let gazeMode = "idle";
let gazeCloudStartTime = null;
let gazeCloudDuration = 0;
let builtInCalibStart = null;
let builtInCalibDuration = 0;
let calibrationStarted = false;
let layoutImage = null;
let dataBuffer = [];
let blinkStartTime = null;
let isBlinking = false;
let LOST_FRAME_THRESHOLD = 100;
let BLINK_THRESHOLD = 120;
let hasCustomCalibration = false;
let lastValidTime = null;
let hasInitializedTracker = false;
let stableFrames = 0;
let isTrackingReady = false;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL = 3000; // 3 sec
let uploadQueue = [];
let isUploading = false;

// ─── FIX 3: track whether GazeCloud is actually running ───────────────────────
// We never call StopEyeTracking + StartEyeTracking between documents.
// Instead we simply flip gazeMode = "reading" once calibration is done.
let gazeCloudRunning = false;

// ─── Pending next-trial after heatmap close ────────────────────────────────────
let pendingNextTrialIndex = null;

function generateSessionID() {
  return crypto.randomUUID();
}

GazeCloudAPI.OnCalibrationComplete = function () {
  console.log("Built-in calibration completed.");
  $("begin-reading").disabled = false;
  builtInCalibDuration = performance.now() - builtInCalibStart;

  if (hasCustomCalibration && affine) {
    console.log("Reusing previous calibration");
    $("setup-page").classList.add("hidden");
    $("reading-page").classList.remove("hidden");
    gazeMode = "reading";
    isSessionActive = true;
    resetTrackingState();
    return;
  }

  $("setup-page").classList.add("hidden");
  $("custom-calibration-page").classList.remove("hidden");

  setTimeout(() => {
    calibrationGrid.style.display = "block";
    calibrationGrid.style.height = "400px";
    // Rebuild grid AFTER it is visible so clientWidth/Height are correct
    buildCalibrationGrid();
  }, 300);

  gazeMode = "calibration";
};

GazeCloudAPI.OnResult = function (gd) {
  const now = performance.now();

  // ── 1. HEAD POSE FILTER ────────────────────────────────────────────────────
  if (
    gd.HeadZ < 10 || gd.HeadZ > 100 ||
    Math.abs(gd.HeadYaw) > 30 ||
    Math.abs(gd.HeadPitch) > 30
  ) {
    setStatus("Keep head centred");
    return;
  }

  // ── 2. STABILITY ──────────────────────────────────────────────────────────
  if (gd.state === 0) {
    stableFrames++;

    if (stableFrames > 5) {
      if (!isTrackingReady) {
        console.log("✅ Tracking became stable");
      }
      isTrackingReady = true;
      setStatus("Tracking stable");
    }

  } else {
    stableFrames = Math.max(0, stableFrames - 1);

    if (stableFrames < 3) {
      isTrackingReady = false;
      setStatus("Adjust face / lighting…");
    }
  }

  // Always keep lastGaze updated (raw screen coords from GazeCloud)
  lastGaze = { x: gd.GazeX, y: gd.GazeY };

  // ── 3. CALIBRATION MODE ───────────────────────────────────────────────────
  // FIX 1: use raw screen coordinates for the gaze dot – it is position:fixed
  // so it lives in viewport space, same as GazeX/GazeY.
  if (gazeMode === "calibration" && isCalibrating) {
    gazePointEl.style.left = gd.GazeX + "px";
    gazePointEl.style.top  = gd.GazeY + "px";
    gazePointEl.style.display = "block";
    return; // don't do anything else during calibration
  }

  if (!isTrackingReady) {
    gazePointEl.style.left = gd.GazeX + "px";
    gazePointEl.style.top  = gd.GazeY + "px";
    gazePointEl.style.display = "block";
    return;
  }

  console.log({
    state: gd.state,
    stableFrames,
    isTrackingReady
  });

  // ── 4. BLINK / LOST-FRAME ─────────────────────────────────────────────────
  if (lastValidTime == null) {
    lastValidTime = now;
    return;
  }
  if (now - lastValidTime > LOST_FRAME_THRESHOLD) {
    if (!isBlinking) {
      isBlinking = true;
      blinkStartTime = lastValidTime;
      finalizeCurrentFixation(true);
    }
    return;
  }
  if (isBlinking) {
    isBlinking = false;
    blinkStartTime = null;
    prevX = null; prevY = null; prevTime = null;
    gazeBuffer = []; lastStable = null;
    return;
  }
  lastValidTime = now;

  // ── 5. READING MODE ───────────────────────────────────────────────────────
  if (gazeMode === "reading") {
    if (!isSessionActive) return;

    const settings = getSettings();
    const mapped   = mapGaze(gd.GazeX, gd.GazeY, settings.affine);
    const filtered = filterGaze(mapped.x, mapped.y, settings);

    // Velocity / saccade detection
    if (prevX != null) {
      const dx = filtered.x - prevX;
      const dy = filtered.y - prevY;
      const dt = now - prevTime;
      if (dt > 0 && dt < 200) {
        const velocity = (Math.hypot(dx, dy) / dt) * 1000;
        processVelocity(velocity, filtered, now, settings);
      }
    }
    prevX = filtered.x; prevY = filtered.y; prevTime = now;

    if (!isValidGaze(filtered.x, filtered.y)) return;

    // FIX 2: gaze-point is position:fixed → use raw viewport coords NOT mapped
    // (the dot is for visual feedback only; mapping is only for word detection)
    gazePointEl.style.left = gd.GazeX + "px";
    gazePointEl.style.top  = gd.GazeY + "px";
    gazePointEl.style.display = isBlinking ? "none" : "block";

    if (dataBuffer.length >= BATCH_SIZE) {
      uploadQueue.push(...dataBuffer);
      dataBuffer = [];
    }
    if (sessionData.length > 5000) sessionData.shift();

    dataBuffer.push({
      session_id: sessionID,
      participant_id: participantId,
      time: Math.round(performance.now() - sessionStartTime),
      x: Math.round(filtered.x),
      y: Math.round(filtered.y),
      document_id: currentStimulus?.document_id,
      trial_index: currentTrialIndex + 1
    });
  }
  console.log("MODE:", gazeMode, "Calibrating:", isCalibrating);
};

// ─────────────────────────────────────────────────────────────────────────────
// STIMULI
// ─────────────────────────────────────────────────────────────────────────────
const STIMULI = {
  plain: [
    {
      document_id: "D1", topic: "Photosynthesis", cue_type: "none",
      lines: [
        "Green plants make food through photosynthesis using sunlight,",
        "water, and carbon dioxide from the air. Chlorophyll in leaves",
        "captures light energy and helps convert raw materials into",
        "glucose and oxygen, supporting plant growth and life on Earth."
      ],
      targets: ["photosynthesis", "light energy", "oxygen"]
    },
    {
      document_id: "D2", topic: "Human Brain", cue_type: "none",
      lines: [
        "The human brain controls memory, movement, emotion, and",
        "decision making through networks of neurons. These cells",
        "send electrical and chemical signals across synapses, allowing",
        "the body to respond quickly to internal and external changes."
      ],
      targets: ["decision making", "neurons", "synapses"]
    },
    {
      document_id: "D3", topic: "Water Cycle", cue_type: "none",
      lines: [
        "The water cycle describes how water moves through nature.",
        "Heat from the Sun causes evaporation from rivers and oceans,",
        "then vapor cools into clouds and returns as rain, sustaining",
        "soil moisture, agriculture, and life in many ecosystems."
      ],
      targets: ["water cycle", "evaporation", "rain"]
    },
    {
      document_id: "D4", topic: "Gravity", cue_type: "none",
      lines: [
        "Gravity is a natural force that attracts objects toward one",
        "another. It keeps planets in orbit around the Sun and gives",
        "weight to objects on Earth. Without gravity, everyday motion,",
        "falling bodies, and planetary stability would change completely."
      ],
      targets: ["gravity", "planets in orbit", "planetary stability"]
    },
    {
      document_id: "D5", topic: "Vaccination", cue_type: "none",
      lines: [
        "Vaccination helps the immune system recognize harmful",
        "microorganisms before real infection occurs. A vaccine presents",
        "a safe form of an antigen, allowing the body to build memory",
        "cells that respond faster and more effectively in the future."
      ],
      targets: ["vaccination", "antigen", "future"]
    },
    {
      document_id: "D6", topic: "Machine Learning", cue_type: "none",
      lines: [
        "Machine learning is a branch of artificial intelligence that",
        "allows computers to learn patterns from data. Instead of being",
        "fully programmed for every task, a model improves predictions",
        "by identifying relationships in examples during training."
      ],
      targets: ["machine learning", "model", "training"]
    },
    {
      document_id: "D7", topic: "Plate Tectonics", cue_type: "none",
      lines: [
        "Earth's surface is divided into large tectonic plates that move",
        "slowly over time. Their interaction can produce earthquakes,",
        "mountains, and volcanic activity. Studying plate motion helps",
        "scientists understand geological change and natural hazards."
      ],
      targets: ["tectonic plates", "earthquakes", "volcanic activity"]
    }
  ],
  cued: [
    {
      document_id: "D1", topic: "Photosynthesis", cue_type: "mixed",
      lines: [
        "Green plants make food through **photosynthesis** using sunlight,",
        "water, and carbon dioxide from the air. Chlorophyll in leaves",
        "captures [YELLOW: light energy] and helps convert raw materials into",
        "glucose and [BLUE: oxygen], supporting plant growth and life on Earth."
      ],
      targets: ["photosynthesis", "light energy", "oxygen"]
    },
    {
      document_id: "D2", topic: "Human Brain", cue_type: "mixed",
      lines: [
        "The human brain controls memory, movement, emotion, and",
        "[YELLOW: decision making] through networks of **neurons**. These cells",
        "send electrical and chemical signals across [BLUE: synapses], allowing",
        "the body to respond quickly to internal and external changes."
      ],
      targets: ["decision making", "neurons", "synapses"]
    },
    {
      document_id: "D3", topic: "Water Cycle", cue_type: "mixed",
      lines: [
        "The [YELLOW: water cycle] describes how water moves through nature.",
        "Heat from the Sun causes **evaporation** from rivers and oceans,",
        "then vapor cools into clouds and returns as [BLUE: rain], sustaining",
        "soil moisture, agriculture, and life in many ecosystems."
      ],
      targets: ["water cycle", "evaporation", "rain"]
    },
    {
      document_id: "D4", topic: "Gravity", cue_type: "mixed",
      lines: [
        "**Gravity** is a natural force that attracts objects toward one",
        "another. It keeps [YELLOW: planets in orbit] around the Sun and gives",
        "weight to objects on Earth. Without gravity, everyday motion,",
        "falling bodies, and [BLUE: planetary stability] would change completely."
      ],
      targets: ["gravity", "planets in orbit", "planetary stability"]
    },
    {
      document_id: "D5", topic: "Vaccination", cue_type: "mixed",
      lines: [
        "**Vaccination** helps the immune system recognize harmful",
        "microorganisms before real infection occurs. A vaccine presents",
        "a safe form of an [YELLOW: antigen], allowing the body to build memory",
        "cells that respond faster and more effectively in the [BLUE: future]."
      ],
      targets: ["vaccination", "antigen", "future"]
    },
    {
      document_id: "D6", topic: "Machine Learning", cue_type: "mixed",
      lines: [
        "[YELLOW: Machine learning] is a branch of artificial intelligence that",
        "allows computers to learn patterns from data. Instead of being",
        "fully programmed for every task, a [BLUE: model] improves predictions",
        "by identifying relationships in examples during **training**."
      ],
      targets: ["machine learning", "model", "training"]
    },
    {
      document_id: "D7", topic: "Plate Tectonics", cue_type: "mixed",
      lines: [
        "Earth's surface is divided into large [YELLOW: tectonic plates] that move",
        "slowly over time. Their interaction can produce **earthquakes**,",
        "mountains, and [BLUE: volcanic activity]. Studying plate motion helps",
        "scientists understand geological change and natural hazards."
      ],
      targets: ["tectonic plates", "earthquakes", "volcanic activity"]
    }
  ]
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
let isCalibrating = false;
let calibPairs = [];
let activePointIndex = 0;
let affine = null;
let lastGaze = { x: 0, y: 0 };
let participantId = "";
let currentCondition = "plain";
let currentDevice = "webcam-gazecloud";
let currentTrialIndex = 0;
let currentStimulusSet = [];
let currentStimulus = null;
let experimentLogs = [];
let currentHeatmapFilename = "";
let lastStable = null;
let gazeBuffer = [];
let readingStartTime = null;
let trialTimer = null;
let trialTimeLeft = 60;
let wordBoxes = [];
let lastHighlighted = null;
let fixationStart = null;
let fixationWord = null;
let trialFixationCount = 0;
let trialTargetFixationCount = 0;
let trialTargetDwell = 0;
let prevX = null;
let prevY = null;
let prevTime = null;

const gazePointEl    = document.getElementById("gaze-point");
const calibrationGrid = document.getElementById("calibration-grid");
const textContainer  = document.getElementById("text-container");

function $(id) { return document.getElementById(id); }
function setStatus(msg) {
  const el = $("status");
  if (el) el.textContent = msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// CALIBRATION GRID
// ─────────────────────────────────────────────────────────────────────────────
function buildCalibrationGrid() {
  calibrationGrid.innerHTML = "";
  const w = calibrationGrid.clientWidth;
  const h = calibrationGrid.clientHeight;
  if (h === 0) {
    console.warn("Calibration grid has zero height — retrying…");
    setTimeout(buildCalibrationGrid, 200);
    return;
  }
  const positions = [
    [0.1,0.1],[0.5,0.1],[0.9,0.1],
    [0.1,0.5],[0.5,0.5],[0.9,0.5],
    [0.1,0.9],[0.5,0.9],[0.9,0.9]
  ];
  positions.forEach(([rx, ry], idx) => {
    const el = document.createElement("div");
    el.style.cssText = `
      position:absolute;
      width:24px; height:24px;
      background:#2980b9;
      border-radius:50%;
      transform:translate(-50%,-50%);
      cursor:pointer;
      color:#fff;
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:11px;
      box-shadow:0 0 0 4px rgba(41,128,185,.25);
    `;
    el.style.left = (rx * w) + "px";
    el.style.top  = (ry * h) + "px";
    el.textContent = idx + 1;
    el.dataset.index = idx;
    calibrationGrid.appendChild(el);
  });
}

function startCalibration() {
  if (!isTrackingReady) {
    console.warn("Tracking not fully stable, but continuing calibration...");
  }
  isCalibrating = true;
  calibPairs = [];
  activePointIndex = 0;

  calibrationGrid.style.display = "block";
  calibrationGrid.offsetHeight; // force reflow

  buildCalibrationGrid();
  activateCalibrationPoint(0);
}

function activateCalibrationPoint(index) {
  const points = calibrationGrid.querySelectorAll("div");
  if (!points.length) { console.error("No calibration points found."); return; }
  if (index >= points.length) { finishCalibration(); return; }

  points.forEach(p => { p.style.background = "#2980b9"; p.onclick = null; });

  const point = points[index];
  point.style.background = "#e74c3c";
  point.style.boxShadow = "0 0 0 6px rgba(231,76,60,.3)";
  point.onclick = () => recordCalibrationPoint(point);
  activePointIndex = index;
}

// FIX 1: Record the SCREEN coordinates of the point (viewport-based),
// alongside the raw GazeX/GazeY which are also in viewport space.
// This makes the affine mapping consistent.
function recordCalibrationPoint(point) {
  // Small delay so the user's eyes have settled on the point
  setTimeout(() => {
    const rect = point.getBoundingClientRect();
    // screenX/Y = centre of the dot in viewport coords
    calibPairs.push({
      gazeX:   lastGaze.x,
      gazeY:   lastGaze.y,
      screenX: rect.left + rect.width  / 2,
      screenY: rect.top  + rect.height / 2,
    });
    activateCalibrationPoint(activePointIndex + 1);
  }, 150); // slightly longer delay = more accurate sample
}

// ─────────────────────────────────────────────────────────────────────────────
// CALIBRATION STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
function saveCalibrationState() {
  if (!participantId) return;
  const key = `gaze_calibration_${participantId}`;
  sessionStorage.setItem(key, JSON.stringify({ affine, filters: getSettings() }));
}

function loadCalibrationState(pid) {
  if (!pid) return false;
  const saved = sessionStorage.getItem(`gaze_calibration_${pid}`);
  if (!saved) return false;
  try {
    const parsed = JSON.parse(saved);
    if (!parsed?.affine || !parsed?.filters) { sessionStorage.removeItem(`gaze_calibration_${pid}`); return false; }
    affine = parsed.affine;
    hasCustomCalibration = true;
    const f = parsed.filters;
    $("smoothing").value  = f.smoothing;
    $("deadzone").value   = f.deadZone;
    $("velocity").value   = f.velocity;
    $("prediction").value = f.prediction;
    $("jitter").value     = f.jitter;
    $("saccade").value    = f.saccade;
    return true;
  } catch (e) {
    sessionStorage.removeItem(`gaze_calibration_${pid}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AFFINE COMPUTATION
// ─────────────────────────────────────────────────────────────────────────────
function computeAffine(pairs) {
  if (pairs.length < 3) return { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };
  let X = [], Y = [];
  pairs.forEach((p) => {
    X.push([p.gazeX, p.gazeY, 1, 0, 0, 0]);
    X.push([0, 0, 0, p.gazeX, p.gazeY, 1]);
    Y.push(p.screenX); Y.push(p.screenY);
  });
  function pseudoInverse(A, b) {
    let AT = A[0].map((_, i) => A.map((r) => r[i]));
    let ATA = AT.map((r) => AT[0].map((_, j) => r.reduce((s, v, k) => s + v * A[k][j], 0)));
    let ATb = AT.map((r) => r.reduce((s, v, k) => s + v * b[k], 0));
    const m = ATA.length;
    for (let i = 0; i < m; i++) {
      let max = i;
      for (let j = i + 1; j < m; j++) if (Math.abs(ATA[j][i]) > Math.abs(ATA[max][i])) max = j;
      if (Math.abs(ATA[max][i]) < 1e-10) return Array(m).fill(0);
      [ATA[i], ATA[max]] = [ATA[max], ATA[i]];
      [ATb[i], ATb[max]] = [ATb[max], ATb[i]];
      for (let j = i + 1; j < m; j++) {
        let f2 = ATA[j][i] / ATA[i][i];
        for (let k = i; k < m; k++) ATA[j][k] -= f2 * ATA[i][k];
        ATb[j] -= f2 * ATb[i];
      }
    }
    let x = Array(m).fill(0);
    for (let i = m - 1; i >= 0; i--) {
      let sum = ATb[i];
      for (let j = i + 1; j < m; j++) sum -= ATA[i][j] * x[j];
      x[i] = sum / ATA[i][i];
    }
    return x;
  }
  const sol = pseudoInverse(X, Y);
  return { a: sol[0], b: sol[1], c: sol[2], d: sol[3], e: sol[4], f: sol[5] };
}

function finishCalibration() {
  
  if (calibPairs.length < 6) {
    alert("Calibration failed. Try again.");
    return;
  }
  affine = computeAffine(calibPairs);
  if (!affine) {
    alert("Calibration error. Retry.");
    return;
  }
  hasCustomCalibration = true;
  saveCalibrationState();

  

  gazeMode = "reading";
  isCalibrating = false;
  participantId     = $("participant-id").value.trim() || ("P" + Math.floor(Math.random() * 100000));
  sessionID         = "S" + Date.now();
  currentCondition  = $("condition-select").value;
  currentDevice     = $("device-select").value;
  currentStimulusSet = STIMULI[currentCondition];
  currentTrialIndex = 0;
    
  isSessionActive   = true;
  sessionStartTime  = performance.now();
  sessionData       = [];
  

  
  calibrationGrid.style.display = "none";
  $("custom-calibration-page").classList.add("hidden");
  $("reading-page").classList.remove("hidden");
  $("calibration-result").textContent = "Calibration complete.";

  // Set mode to reading — GazeCloud is already running, no restart needed







  $("meta-participant").textContent = participantId;
  $("meta-condition").textContent   = currentCondition;
  $("meta-device").textContent      = currentDevice;
  prevX = prevY = prevTime = null;
  gazeBuffer = [];
  lastStable = null;  
  console.log("✅ Calibration completed. Switching to reading mode.");
  startReading();
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS & FILTERS
// ─────────────────────────────────────────────────────────────────────────────
function updateLabel(id, val) {
  if (id === "prediction" || id === "jitter") {
    $("val-" + id).textContent = Math.round(val * 100) + "%";
  } else if (id === "saccade") {
    $("val-" + id).textContent = val + "px/s";
  } else {
    $("val-" + id).textContent = val;
  }
}
["smoothing","deadzone","velocity","prediction","jitter","saccade"].forEach(id => {
  $(id).oninput = function () { updateLabel(id, this.value); };
});

$("toggle-advanced").onclick = function () {
  const adv = $("advanced-settings");
  const showing = adv.style.display === "block";
  adv.style.display = showing ? "none" : "block";
  this.textContent = showing ? "Advanced Settings" : "Hide Advanced Settings";
};

$("generate-id").onclick = function () {
  participantId = "P" + Math.floor(Math.random() * 100000);
  $("participant-id").value = participantId;
};

$("start-custom-calibration").onclick = function () { startCalibration(); };

$("start-calibration").onclick = function () {
  if (calibrationStarted) return;
  calibrationStarted = true;
  this.disabled = true;
  setStatus("Starting eye tracker…");
  gazeMode = "calibration";
  gazeCloudStartTime = performance.now();
  builtInCalibStart  = performance.now();
  GazeCloudAPI.StartEyeTracking();
  setInterval(flushData, FLUSH_INTERVAL);
  gazeCloudRunning = true;
};

// Begin reading without 9-point calibration (uses built-in calib result only)
$("begin-reading").onclick = function () {
  participantId     = $("participant-id").value.trim() || ("P" + Math.floor(Math.random() * 100000));
  loadCalibrationState(participantId);
  sessionID         = generateSessionID();
  currentCondition  = $("condition-select").value;
  currentDevice     = $("device-select").value;
  currentStimulusSet = STIMULI[currentCondition];
  currentTrialIndex = 0;
  experimentLogs    = [];
  isSessionActive   = true;
  sessionStartTime  = performance.now();
  sessionData       = [];

  $("meta-participant").textContent = participantId;
  $("meta-condition").textContent   = currentCondition;
  $("meta-device").textContent      = currentDevice;
  $("setup-page").classList.add("hidden");
  $("reading-page").classList.remove("hidden");

  gazeMode = "reading";
  startReading();
};

function getSettings() {
  return {
    affine,
    smoothing:  +$("smoothing").value,
    deadZone:   +$("deadzone").value,
    velocity:   +$("velocity").value,
    prediction: +$("prediction").value,
    jitter:     +$("jitter").value,
    saccade:    +$("saccade").value,
  };
}

function mapGaze(x, y, affineObj) {
  if (!affineObj) return { x, y };
  const { a, b, c, d, e, f } = affineObj;
  return { x: a * x + b * y + c, y: d * x + e * y + f };
}

function filterGaze(x, y, settings) {
  gazeBuffer.push({ x, y });
  const maxBuffer = Math.max(5, Math.min(10, settings.smoothing));
  if (gazeBuffer.length > maxBuffer) gazeBuffer.shift();
  let avgX = gazeBuffer.reduce((s, p) => s + p.x, 0) / gazeBuffer.length;
  let avgY = gazeBuffer.reduce((s, p) => s + p.y, 0) / gazeBuffer.length;
  if (!lastStable) { lastStable = { x: avgX, y: avgY }; return lastStable; }
  const dx = avgX - lastStable.x, dy = avgY - lastStable.y;
  const distance = Math.hypot(dx, dy);
  if (distance < settings.deadZone) {
    return { x: lastStable.x * 0.9 + avgX * 0.1, y: lastStable.y * 0.9 + avgY * 0.1 };
  }
  avgX = lastStable.x + dx * settings.prediction;
  avgY = lastStable.y + dy * settings.prediction;
  lastStable = { x: avgX, y: avgY };
  return lastStable;
}

function isValidGaze(x, y) {
  return !isNaN(x) && !isNaN(y) && x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRACKING STATE RESET (FIX 3: does NOT restart GazeCloud)
// ─────────────────────────────────────────────────────────────────────────────
function resetTrackingState() {
  lastStable   = null;
  gazeBuffer   = [];
  prevX = null; prevY = null; prevTime = null;

  isBlinking    = false;
  lastValidTime = null;

  // ✅ ADD THESE
  stableFrames = 0;
  isTrackingReady = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIAL / SESSION FLOW
// ─────────────────────────────────────────────────────────────────────────────
function startReading() { loadTrial(0); }

function loadTrial(index) {
  if (index >= currentStimulusSet.length) { finishExperiment(); return; }

  // Pause reading mode while we set up the new passage
  gazeMode = "idle";

  resetTrialState();

  currentTrialIndex = index;
  currentStimulus   = currentStimulusSet[index];

  updateTrialMeta();
  renderDocument(currentStimulus);
  window.cachedLayoutImage = null;

  readingStartTime = performance.now();
  startTrialTimer();

  resetTrackingState();
  gazePointEl.style.display = "block";
  lastValidTime = performance.now();

  // Only flip to reading AFTER word boxes are populated (renderDocument uses 150ms timeout)
  // Use 200ms to be safe, then the dot will start responding to gaze again
  setTimeout(() => {
    gazeMode = "reading";
  }, 200);
}

function resetTrialState() {
  lastStable = null;
  gazeBuffer = [];
  lastHighlighted = null;
  fixationStart   = null;
  fixationWord    = null;
  trialFixationCount       = 0;
  trialTargetFixationCount = 0;
  trialTargetDwell         = 0;
}

function startTrialTimer() {
  trialTimeLeft = 60;
  $("timer-display").textContent = trialTimeLeft;
  if (trialTimer) clearInterval(trialTimer);
  trialTimer = setInterval(() => {
    trialTimeLeft -= 1;
    $("timer-display").textContent = trialTimeLeft;
    if (trialTimeLeft <= 0) {
      clearInterval(trialTimer);
      nextDocument();
    }
  }, 1000);
}

async function completeTrial() {
  if (!currentStimulus) return;
  clearInterval(trialTimer);
  finalizeCurrentFixation(true);
  const readingTime = Math.round(performance.now() - readingStartTime);
  await saveTrialSummary({
    participant_id: participantId,
    session_id: sessionID,
    condition: currentCondition,
    device: currentDevice,
    document_id: currentStimulus.document_id,
    document_topic: currentStimulus.topic,
    trial_index: currentTrialIndex + 1,
    reading_time_ms: readingTime,
    total_fixations: trialFixationCount,
    total_target_fixations: trialTargetFixationCount,
    total_target_dwell_ms: trialTargetDwell,
    notes: "Auto-saved from reading trial"
  });
  $("trial-status").textContent = `Saved ${currentStimulus.document_id}. Fixations: ${trialFixationCount}, target fixations: ${trialTargetFixationCount}.`;
  if (dataBuffer.length > 0) { sessionData.push(...dataBuffer); dataBuffer = []; }
  await generateHeatmapForCurrentTrial();
}

// FIX 3: nextDocument no longer calls restartGazeTracking.
// After closing the heatmap modal, loadTrial is called directly.
async function nextDocument() {
  await completeTrial();
  // loadTrial is called from closeHeatmap() via pendingNextTrialIndex
  // OR immediately if heatmap was skipped/failed
  if (pendingNextTrialIndex === null) {
    _advanceTrial();
  }
}

function _advanceTrial() {
  currentTrialIndex++;
  if (currentTrialIndex >= currentStimulusSet.length) {
    finishExperiment();
    return;
  }
  loadTrial(currentTrialIndex);
}

// ─────────────────────────────────────────────────────────────────────────────
// HEATMAP
// ─────────────────────────────────────────────────────────────────────────────
async function captureLayoutImage() {
  const canvas = await html2canvas(textContainer, { backgroundColor: "#ffffff", scale: 1 });
  return canvas.toDataURL("image/png");
}
function showLoading(message) {
  const loader = $("loading-indicator");
  loader.classList.remove("hidden");
  loader.querySelector("p").textContent = message;
}
function hideLoading() { $("loading-indicator").classList.add("hidden"); }

async function generateHeatmapForCurrentTrial() {
  try {
    showLoading(`Generating heatmap for ${currentStimulus.document_id}…`);
    const rect = textContainer.getBoundingClientRect();
    if (!window.cachedLayoutImage) {
      window.cachedLayoutImage = await captureLayoutImage();
    }
    layoutImage = window.cachedLayoutImage;
    const response = await fetch(`${API_BASE}/generate-heatmap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participant_id: participantId,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        document_id: currentStimulus.document_id,
        device: currentDevice,
        layout_image: layoutImage
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Heatmap generation failed");
    currentHeatmapFilename = data.filename;
    hideLoading();
    // Signal that we need to advance after the modal is closed
    pendingNextTrialIndex = currentTrialIndex + 1;
    showHeatmap();
  } catch (e) {
    hideLoading();
    $("trial-status").textContent = "Heatmap failed — continuing";
    $("trial-status").style.color = "orange";
    // No heatmap: advance directly
    pendingNextTrialIndex = null;
    _advanceTrial();
  }
}

function showHeatmap() {
  if (!currentHeatmapFilename) return;
  const img   = $("heatmap-img");
  const modal = $("heatmap-modal");
  img.src = `${API_BASE}/heatmap/${currentHeatmapFilename}?t=${Date.now()}`;
  modal.style.display = "flex";
  modal.classList.add("active");
}

function closeHeatmap() {
  const modal = $("heatmap-modal");
  modal.style.display = "none";
  modal.classList.remove("active");

  if (pendingNextTrialIndex !== null) {
    const next = pendingNextTrialIndex;
    pendingNextTrialIndex = null;
    currentTrialIndex = next;
    if (currentTrialIndex >= currentStimulusSet.length) {
      finishExperiment();
    } else {
      loadTrial(currentTrialIndex);
    }
  }
}
window.closeHeatmap = closeHeatmap;

// ─────────────────────────────────────────────────────────────────────────────
// RENDERING
// ─────────────────────────────────────────────────────────────────────────────
function updateTrialMeta() {
  $("meta-document").textContent = `${currentTrialIndex + 1} / ${currentStimulusSet.length} (${currentStimulus.document_id})`;
  $("meta-topic").textContent = currentStimulus.topic;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m]));
}

function parseCueMarkup(line, targets) {
  let html = escapeHtml(line);
  html = html.replace(/\*\*(.*?)\*\*/g, '<span class="cue-bold target-mark">$1</span>');
  html = html.replace(/\[YELLOW:\s*(.*?)\]/g, '<span class="cue-yellow target-mark">$1</span>');
  html = html.replace(/\[BLUE:\s*(.*?)\]/g, '<span class="cue-blue target-mark">$1</span>');
  const tokenRegex = /(<span class="(?:cue-bold|cue-yellow|cue-blue) target-mark">.*?<\/span>)|([^\s]+)/g;
  let parts = [], match;
  while ((match = tokenRegex.exec(html)) !== null) {
    if (match[1]) {
      const textOnly = match[1].replace(/<[^>]+>/g, "");
      parts.push(`<span class="track-word is-target" data-word="${textOnly.toLowerCase()}" data-target="1">${match[1]}</span>`);
    } else if (match[2]) {
      const raw   = match[2];
      const clean = raw.replace(/[^a-zA-Z''-]/g, '').toLowerCase();
      const isT   = targets.some(t => clean && t.toLowerCase().includes(clean) && clean.length > 3);
      parts.push(`<span class="track-word ${isT ? 'is-target' : ''}" data-word="${clean}" data-target="${isT ? 1 : 0}">${raw}</span>`);
    }
  }
  return parts.join(' ');
}

function renderDocument(stimulus) {
  textContainer.innerHTML = "";
  stimulus.lines.forEach((line, idx) => {
    const p = document.createElement("p");
    p.className = "reading-line";
    p.dataset.aoi = `AOI-S${idx + 1}`;
    if (currentCondition === "cued") {
      p.innerHTML = parseCueMarkup(line, stimulus.targets);
    } else {
      p.innerHTML = line.split(/\s+/).map(word => {
        const clean = word.replace(/[^a-zA-Z''-]/g, '').toLowerCase();
        const isT   = stimulus.targets.some(t => clean && t.toLowerCase().includes(clean) && clean.length > 3);
        return `<span class="track-word ${isT ? 'is-target':''}" data-word="${clean}" data-target="${isT?1:0}">${escapeHtml(word)}</span>`;
      }).join(" ");
    }
    textContainer.appendChild(p);
  });
  setTimeout(updateWordBoxes, 150);
}

function updateWordBoxes() {
  wordBoxes = Array.from(document.querySelectorAll(".track-word")).map(el => {
    const r = el.getBoundingClientRect();
    return {
      el,
      left:   r.left   + window.scrollX,
      top:    r.top    + window.scrollY,
      right:  r.right  + window.scrollX,
      bottom: r.bottom + window.scrollY,
    };
  });
}

function findWord(x, y) {
  return wordBoxes.find(w => x >= w.left && x <= w.right && y >= w.top && y <= w.bottom);
}

// ─────────────────────────────────────────────────────────────────────────────
// FIXATION / SACCADE
// ─────────────────────────────────────────────────────────────────────────────
function processVelocity(velocity, point, time, settings) {
  if (velocity < settings.saccade) {
    handleFixation(point, time);
  } else {
    handleSaccade(point, time);
  }
}

function handleFixation(point, time) {
  const w = findWord(point.x, point.y);
  if (!w) return;
  if (lastHighlighted && lastHighlighted !== w) finalizeCurrentFixation();
  if (!lastHighlighted) fixationStart = time;
  lastHighlighted = w;
  highlightWord(w);
}

function handleSaccade(point, time) {
  if (lastHighlighted) { finalizeCurrentFixation(); lastHighlighted = null; }
}

function highlightWord(w) {
  if (!fixationWord || fixationWord !== w) {
    fixationWord  = w;
    fixationStart = performance.now();
  }
  if (lastHighlighted) lastHighlighted.el.classList.remove("currently-looking");
  w.el.classList.add("currently-looking");
  lastHighlighted = w;
}

function finalizeCurrentFixation(force = false) {
  if (lastHighlighted && fixationStart) {
    const duration = performance.now() - fixationStart;
    const MIN_FIXATION = 80;
    if (duration < MIN_FIXATION) {
      if (force && lastHighlighted) { lastHighlighted.el.classList.remove("currently-looking"); lastHighlighted = null; }
      fixationStart = null;
      return;
    }
    const parentLine  = lastHighlighted.el.closest(".reading-line");
    const wordRect    = lastHighlighted.el.getBoundingClientRect();
    const containerRect = textContainer.getBoundingClientRect();
    const cx = Math.round(wordRect.left + wordRect.width  / 2 - containerRect.left);
    const cy = Math.round(wordRect.top  + wordRect.height / 2 - containerRect.top);
    const isTarget = +(lastHighlighted.el.dataset.target || 0);
    const row = {
      participant_id: participantId,
      session_id:     sessionID,
      condition:      currentCondition,
      device:         currentDevice,
      document_id:    currentStimulus.document_id,
      document_topic: currentStimulus.topic,
      trial_index:    currentTrialIndex + 1,
      word: (lastHighlighted.el.innerText || lastHighlighted.el.textContent || "").trim(),
      cue_type:       currentStimulus.cue_type,
      aoi:            parentLine ? parentLine.dataset.aoi : null,
      is_target_word: isTarget,
      duration:       Math.round(duration),
      fixation_time:  Math.round(performance.now()),
      client_timestamp: Math.round(performance.now()),
      x: cx, y: cy,
      sample_type: "gaze"
    };
    experimentLogs.push(row);
    saveToDB(row);
    trialFixationCount++;
    if (isTarget) { trialTargetFixationCount++; trialTargetDwell += Math.round(duration); }
  }
  if (force && lastHighlighted) {
    lastHighlighted.el.classList.remove("currently-looking");
    lastHighlighted = null;
    fixationStart   = null;
    fixationWord    = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NETWORK
// ─────────────────────────────────────────────────────────────────────────────
async function saveToDB(entry) {
  try {
    const response = await fetch(`${API_BASE}/save-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry)
    });
    return await response.json();
  } catch (e) {
    console.error("DB save failed:", e);
    return null;
  }
}

async function saveTrialSummary(summary) {
  try {
    const response = await fetch(`${API_BASE}/save-trial-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summary)
    });
    return await response.json();
  } catch (e) {
    console.error("Trial summary save failed:", e);
  }
}

const rateMap = new Map();
function rateLimit(user) {
  const now = Date.now(), window = 1000;
  if (!rateMap.has(user)) rateMap.set(user, []);
  const ts = rateMap.get(user).filter(t => now - t < window);
  if (ts.length > 10) return false;
  ts.push(now); rateMap.set(user, ts);
  return true;
}

async function sendSessionInChunks() {
  if (!rateLimit(participantId)) { console.warn("Rate limit exceeded"); return; }
  const chunkSize = 500;
  for (let i = 0; i < sessionData.length; i += chunkSize) {
    await fetch(`${API_BASE}/save-full-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participant_id: participantId, session_id: sessionID, samples: sessionData.slice(i, i + chunkSize) })
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FINISH
// ─────────────────────────────────────────────────────────────────────────────
function stopGazeCloudTracking() {
  try { GazeCloudAPI.StopEyeTracking(); } catch (e) {}
  gazeCloudRunning = false;
  if (gazeCloudStartTime) {
    gazeCloudDuration = performance.now() - gazeCloudStartTime;
  }
}

async function finishExperiment() {
  clearInterval(trialTimer);
  isSessionActive = false;
  gazePointEl.style.display = "none";
  stopGazeCloudTracking();

  if (dataBuffer.length > 0) { sessionData.push(...dataBuffer); dataBuffer = []; }
  if (sessionData.length > 0) await sendSessionInChunks();

  $("trial-status").textContent = "Experiment finished.";
  $("download-csv").classList.remove("hidden");
}

window.addEventListener("beforeunload", () => {
  stopGazeCloudTracking();
  if (dataBuffer.length > 0) { sessionData.push(...dataBuffer); dataBuffer = []; }
  if (sessionData.length > 0) {
    navigator.sendBeacon(`${API_BASE}/save-full-session`, JSON.stringify({
      participant_id: participantId,
      session_id: sessionID,
      samples: sessionData
    }));
  }
});
window.addEventListener("beforeunload", () => {
  navigator.sendBeacon(
    `${API_BASE}/log-batch`,
    JSON.stringify({ data: uploadQueue })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ON LOAD
// ─────────────────────────────────────────────────────────────────────────────
window.onload = function () {
  currentHeatmapFilename = "";
  isSessionActive = false;
  gazeMode = "idle";
  sessionStorage.clear();
  $("heatmap-modal").style.display = "none";

  setInterval(() => {
    if (gazeCloudStartTime) {
      const el = $("runtime-display");
      if (el) el.textContent = Math.floor((performance.now() - gazeCloudStartTime) / 1000) + "s";
    }
  }, 1000);

  $("next-document").onclick = async function () {
    await nextDocument();
  };

  $("finish-experiment").onclick = async function () {
    await completeTrial();
    // pendingNextTrialIndex might be set by completeTrial; clear it so closeHeatmap advances to finish
    pendingNextTrialIndex = null;
    await finishExperiment();
  };

  $("download-csv").onclick = function () {
    window.open(`${API_BASE}/export-csv/${encodeURIComponent(participantId)}`, "_blank");
  };
};
async function flushData() {
  if (isUploading || uploadQueue.length === 0) return;

  isUploading = true;

  const batch = uploadQueue.splice(0, BATCH_SIZE);

  try {
    await fetch(`${API_BASE}/log-batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ data: batch,
        screen_width: window.innerWidth,
        screen_height: window.innerHeight
       })
    });
  } catch (err) {
    console.error("Upload failed, retrying...", err);
    uploadQueue.unshift(...batch); // put back
  }

  isUploading = false;
}
