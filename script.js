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
let LOST_FRAME_THRESHOLD = 100;   // ms (no data = lost)
let BLINK_THRESHOLD = 120;        // ms (blink duration)
let hasCustomCalibration = false;
let lastValidTime = null;
let hasInitializedTracker = false;

GazeCloudAPI.OnCalibrationComplete = function(){

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

  // Only show custom calibration if needed
  $("setup-page").classList.add("hidden");
  $("custom-calibration-page").classList.remove("hidden");

  setTimeout(() => {
    calibrationGrid.style.display = "block";
    calibrationGrid.style.height = "400px";
  }, 300);

  gazeMode = "calibration";
};

GazeCloudAPI.OnResult = function(gd) {
  console.log("OnResult firing...");
  console.log("RAW GAZE:", gd);
  if (gd.state !== 0) {
    console.warn("Tracking not stable yet:", gd.state);
    return;
  }
  
  const now = performance.now();
  if(lastValidTime==null){
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
    // reset tracking to avoid jump artifacts
    prevX = null;
    prevY = null;
    prevTime = null;
    gazeBuffer = [];
    lastStable = null;
    return; // skip this recovery frame
  }

  lastValidTime = now;

  // Always update raw gaze
  lastGaze = { x: gd.GazeX, y: gd.GazeY };

  if (gazeMode === "calibration") {
    // 👁️ Show raw gaze for calibration
    const rect = calibrationGrid.getBoundingClientRect();

    const localX = gd.GazeX - rect.left;
    const localY = gd.GazeY - rect.top;
    gazePointEl.style.left = localX + "px"; 
    gazePointEl.style.top = localY + "px";
    gazePointEl.style.display = "block";
  }

  else if (gazeMode === "reading") {
    if (!isSessionActive) return;


    const settings = getSettings();

    const mapped = mapGaze(gd.GazeX, gd.GazeY, settings.affine);
    console.log("RAW:", gd.GazeX, gd.GazeY);
    console.log("MAPPED:", mapped.x, mapped.y);
    const filtered = filterGaze(mapped.x, mapped.y, settings);

    if(prevX!= null){
      const dx = filtered.x - prevX;
      const dy = filtered.y - prevY;

      const distance = Math.sqrt(dx*dx+dy*dy);
      const dt = now - prevTime;

      if (dt > 0 && dt < 200){
        const velocity = (distance/dt) *1000;
        processVelocity(velocity,filtered,now, settings);
      }
      
    }

    prevX = filtered.x;
    prevY = filtered.y;
    prevTime = now;

    const x = filtered.x;
    const y = filtered.y;

    if(!isValidGaze(x,y)) return;

    gazePointEl.style.left = x + "px";
    gazePointEl.style.top = y + "px";
    gazePointEl.style.display = isBlinking ? "none" : "block";
    

    if(sessionData.length>5000){
      sessionData.shift();
    }

    // session logging
    dataBuffer.push({
      time: Math.round(performance.now() - sessionStartTime),
      x: Math.round(x),
      y: Math.round(y),
      document_id: currentStimulus?.document_id,
      trial_index: currentTrialIndex + 1
    });
    if(dataBuffer.length>=20){
      sessionData.push(...dataBuffer);
      dataBuffer=[];
    }
    console.log("Gaze:", gd.GazeX, gd.GazeY);
  }
};

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
        "Earth’s surface is divided into large tectonic plates that move",
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
        "Earth’s surface is divided into large [YELLOW: tectonic plates] that move",
        "slowly over time. Their interaction can produce **earthquakes**,",
        "mountains, and [BLUE: volcanic activity]. Studying plate motion helps",
        "scientists understand geological change and natural hazards."
      ],
      targets: ["tectonic plates", "earthquakes", "volcanic activity"]
    }
  ]
};

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

const gazePointEl = document.getElementById("gaze-point");
const calibrationGrid = document.getElementById("calibration-grid");
const textContainer = document.getElementById("text-container");

function $(id) { return document.getElementById(id); }

function buildCalibrationGrid() {
  calibrationGrid.innerHTML = "";
  const w = calibrationGrid.clientWidth, h = calibrationGrid.clientHeight;
  if (h==0){
    console.warn("Calibration grid has zero height.");
    return;
  }
  const positions = [[0.1,0.1],[0.5,0.1],[0.9,0.1],[0.1,0.5],[0.5,0.5],[0.9,0.5],[0.1,0.9],[0.5,0.9],[0.9,0.9]];
  positions.forEach(([rx, ry], idx) => {
    const el = document.createElement("div");
    el.style.cssText = `
      position:absolute;
      width:22px;
      height:22px;
      background:#2980b9;
      border-radius:50%;
      transform:translate(-50%,-50%);
      cursor:pointer;
      color:#fff;
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:11px;
    `;
    el.style.left = (rx * w) + "px";
    el.style.top = (ry * h) + "px";
    el.textContent = idx + 1;
    el.dataset.index = idx;
    calibrationGrid.appendChild(el);
  });
}

function startCalibration() {
  isCalibrating = true;
  calibPairs = [];
  activePointIndex = 0;
  $("start-calibration").disabled = true;

  calibrationGrid.style.display = "block";
  calibrationGrid.offsetHeight;

  buildCalibrationGrid();
  activateCalibrationPoint(0);
}
function activateCalibrationPoint(index) {
  const points = calibrationGrid.querySelectorAll("div");

  if (!points.length) {
    console.error("Calibration points not created.");
    return;
  }

  if (index >= points.length) {
    finishCalibration();
    return;
  }

  points.forEach(p => {
    p.style.background = "#2980b9";
    p.onclick = null;
  });

  const point = points[index];
  if (!point) return;   // ✅ extra safety

  point.style.background = "#e74c3c";
  point.onclick = () => recordCalibrationPoint(point);

  activePointIndex = index;
}

function saveCalibrationState() {
  if (!participantId) return;

  const settings = getSettings();

  const key = `gaze_calibration_${participantId}`;

  sessionStorage.setItem(key, JSON.stringify({
    affine,
    filters: settings
  }));
}

function loadCalibrationState(participantId) {
  if (!participantId) return false;

  const key = `gaze_calibration_${participantId}`;
  const saved = sessionStorage.getItem(key);

  if (!saved) return false;

  try {
    const parsed = JSON.parse(saved);

    if (!parsed || !parsed.affine || !parsed.filters) {
      sessionStorage.removeItem(key);
      return false;
    }

    affine = parsed.affine;
    hasCustomCalibration = true;

    const f = parsed.filters;

    $("smoothing").value = f.smoothing;
    $("deadzone").value = f.deadZone;
    $("velocity").value = f.velocity;
    $("prediction").value = f.prediction;
    $("jitter").value = f.jitter;
    $("saccade").value = f.saccade;

    console.log("Loaded calibration for:", participantId);
    return true;

  } catch (e) {
    sessionStorage.removeItem(key);
    return false;
  }
}

function recordCalibrationPoint(point) {
  setTimeout(() => {
    const rect = point.getBoundingClientRect();
    calibPairs.push({
      gazeX: lastGaze.x,
      gazeY: lastGaze.y,
      screenX: rect.left + rect.width / 2,
      screenY: rect.top + rect.height / 2,
    });
    activateCalibrationPoint(activePointIndex + 1);
  }, 100);
}

function restartGazeTracking() {
  console.log("Restarting tracking cleanly...");

  isBlinking = false;
  blinkStartTime = null;
  lastValidTime = null;

  try {
    GazeCloudAPI.StopEyeTracking();
  } catch (e) {}

  resetTrackingState();

  setTimeout(() => {

    if (!hasInitializedTracker) {
      console.log("First-time start with calibration...");
      GazeCloudAPI.StartEyeTracking();
      hasInitializedTracker = true;
    } else {
      console.log("Restart WITHOUT recalibration...");
      GazeCloudAPI.StartEyeTracking(); 
      // still required, but now treated as warm restart
    }

    setTimeout(() => {
      gazeMode = "reading";
    }, 800);

  }, 800);
}

function resetTrackingState() {
  lastStable = null;
  gazeBuffer = [];
  prevX = null;
  prevY = null;
  prevTime = null;
}

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
        let f = ATA[j][i] / ATA[i][i];
        for (let k = i; k < m; k++) ATA[j][k] -= f * ATA[i][k];
        ATb[j] -= f * ATb[i];
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
  let sol = pseudoInverse(X, Y);
  return { a: sol[0], b: sol[1], c: sol[2], d: sol[3], e: sol[4], f: sol[5] };
}
function finishCalibration() {
  
  gazePointEl.style.display = "block";  // ✅ show dot
  isCalibrating = false;
  affine = computeAffine(calibPairs);

  hasCustomCalibration = true;

  saveCalibrationState();

  $("custom-calibration-page").classList.add("hidden");
  $("reading-page").classList.remove("hidden");

  $("calibration-result").textContent = "Calibration complete.";

  // ✅ SET MODE TO READING
  gazeMode = "reading";

  // ✅ START SESSION AUTOMATICALLY
  participantId = $("participant-id").value.trim() || ("P" + Math.floor(Math.random() * 100000));
  sessionID = "S" + Date.now();
  currentCondition = $("condition-select").value;
  currentDevice = $("device-select").value;
  currentStimulusSet = STIMULI[currentCondition];
  currentTrialIndex = 0;

  isSessionActive = true;
  sessionStartTime = performance.now();
  sessionData = [];

  $("meta-participant").textContent = participantId;
  $("meta-condition").textContent = currentCondition;
  $("meta-device").textContent = currentDevice;

  // ✅ THIS WAS MISSING
  startReading();
}

function updateLabel(id, val) {
  if (id === "prediction" || id === "jitter") {
    $("val-" + id).textContent = Math.round(val * 100) + "%";
  } else if (id === "saccade") {
    $("val-" + id).textContent = val + "px/s";
  } else {
    $("val-" + id).textContent = val;
  }
}
["smoothing", "deadzone", "velocity", "prediction", "jitter", "saccade"].forEach((id) => {
  $(id).oninput = function () { updateLabel(id, this.value); };
});
$("toggle-advanced").onclick = function () {
  const adv = $("advanced-settings");
  if (adv.style.display === "none" || adv.style.display === "") {
    adv.style.display = "block";
    this.textContent = "Hide Advanced Settings";
  } else {
    adv.style.display = "none";
    this.textContent = "Advanced Settings";
  }
};
$("generate-id").onclick = function () {
  participantId = "P" + Math.floor(Math.random() * 100000);
  $("participant-id").value = participantId;
};
$("start-custom-calibration").onclick = function() {
  startCalibration();
};
$("start-calibration").onclick = function() {
  if (calibrationStarted) return;
  calibrationStarted = true;

  this.disabled = true;
  console.log("Starting recorder...")
  gazeMode = "calibration";
  gazeCloudStartTime = performance.now();
  GazeCloudAPI.StartEyeTracking();
  builtInCalibStart = performance.now();
};
$("begin-reading").onclick = function () {

  participantId = $("participant-id").value.trim() || ("P" + Math.floor(Math.random() * 100000));
  loadCalibrationState(participantId);
  sessionID = "S" + Date.now();
  currentCondition = $("condition-select").value;
  currentDevice = $("device-select").value;
  currentStimulusSet = STIMULI[currentCondition];
  currentTrialIndex = 0;
  experimentLogs = [];
  // ✅ START SESSION HERE
  isSessionActive = true;
  sessionStartTime = performance.now();
  sessionData = [];
  $("meta-participant").textContent = participantId;
  $("meta-condition").textContent = currentCondition;
  $("meta-device").textContent = currentDevice;
  $("setup-page").classList.add("hidden");
  $("reading-page").classList.remove("hidden");
  startReading();
};

function getSettings() {
  return {
    affine,
    smoothing: +$("smoothing").value,
    deadZone: +$("deadzone").value,
    velocity: +$("velocity").value,
    prediction: +$("prediction").value,
    jitter: +$("jitter").value,
    saccade: +$("saccade").value,
  };
}



function mapGaze(x, y, affineObj) {
  if (!affineObj) return { x, y };
  const { a, b, c, d, e, f } = affineObj;
  return { x: a * x + b * y + c, y: d * x + e * y + f };
}

async function sendSessionInChunks() {
  const chunkSize = 500;

  if (!rateLimit(participantId)) {
    console.warn("Rate limit exceeded");
    return;
  }

  for (let i = 0; i < sessionData.length; i += chunkSize) {
    const chunk = sessionData.slice(i, i + chunkSize);

    await fetch(`${API_BASE}/save-full-session`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        participant_id: participantId,
        session_id: sessionID,
        samples: chunk
      })
    });
  }
}


function filterGaze(x, y, settings) {
  gazeBuffer.push({ x, y });
  const maxBuffer = Math.max(5, Math.min(10, settings.smoothing));
  if (gazeBuffer.length > maxBuffer) gazeBuffer.shift();
  let avgX = gazeBuffer.reduce((s, p) => s + p.x, 0) / gazeBuffer.length;
  let avgY = gazeBuffer.reduce((s, p) => s + p.y, 0) / gazeBuffer.length;
  if (!lastStable) {
    lastStable = { x: avgX, y: avgY };
    return lastStable;
  }
  const dx = avgX - lastStable.x, dy = avgY - lastStable.y;
  const distance = Math.hypot(dx, dy);
  if (distance < settings.deadZone) {
    return{
      x: lastStable.x * 0.9 + avgX * 0.1,
      y: lastStable.y * 0.9 + avgY * 0.1
    };
  }
  const alpha =  settings.prediction;
  avgX = lastStable.x + dx * alpha;
  avgY = lastStable.y + dy * alpha;
  lastStable = { x: avgX, y: avgY };
  return lastStable;
}

function isValidGaze(x, y) {
  return (
    !isNaN(x) &&
    !isNaN(y) &&
    x > 0 &&
    y > 0 &&
    x < window.innerWidth &&
    y < window.innerHeight
  );
}


function escapeHtml(s) {
  return s.replace(/[&<>\"]/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}
function parseCueMarkup(line, targets) {
  let html = escapeHtml(line);
  html = html.replace(/\*\*(.*?)\*\*/g, '<span class="cue-bold target-mark">$1</span>');
  html = html.replace(/\[YELLOW:\s*(.*?)\]/g, '<span class="cue-yellow target-mark">$1</span>');
  html = html.replace(/\[BLUE:\s*(.*?)\]/g, '<span class="cue-blue target-mark">$1</span>');
  const tokenRegex = /(<span class="(?:cue-bold|cue-yellow|cue-blue) target-mark">.*?<\/span>)|([^\s]+)/g;
  let parts = [];
  let match;
  while ((match = tokenRegex.exec(html)) !== null) {
    if (match[1]) {
      const textOnly = match[1].replace(/<[^>]+>/g, "");
      parts.push(`<span class="track-word is-target" data-word="${textOnly.toLowerCase()}" data-target="1">${match[1]}</span>`);
    } else if (match[2]) {
      const raw = match[2];
      const clean = raw.replace(/[^a-zA-Z’'-]/g, '').toLowerCase();
      const isTarget = targets.some(t => clean && t.toLowerCase().includes(clean) && clean.length > 3);
      parts.push(`<span class="track-word ${isTarget ? 'is-target' : ''}" data-word="${clean}" data-target="${isTarget ? 1 : 0}">${raw}</span>`);
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
      p.innerHTML = line.split(/\s+/).map((word) => {
        const clean = word.replace(/[^a-zA-Z’'-]/g, '').toLowerCase();
        const isTarget = stimulus.targets.some(t => clean && t.toLowerCase().includes(clean) && clean.length > 3);
        return `<span class="track-word ${isTarget ? 'is-target' : ''}" data-word="${clean}" data-target="${isTarget ? 1 : 0}">${escapeHtml(word)}</span>`;
      }).join(" ");
    }
    textContainer.appendChild(p);
  });
  setTimeout(updateWordBoxes, 150);
}
function updateWordBoxes() {
  wordBoxes = Array.from(document.querySelectorAll(".track-word")).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      el,
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      right: r.right + window.scrollX,
      bottom: r.bottom + window.scrollY,
    };
  });
}
function findWord(x, y) {
  return wordBoxes.find((w) => x >= w.left && x <= w.right && y >= w.top && y <= w.bottom);
}
async function saveToDB(entry) {
  try {
    const response = await fetch(`${API_BASE}/save-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    return await response.json();
  } catch (e) {
    console.error("DB save failed:", e);

    const status= $("trial-status");
    if (status) {
      status.textContent = "⚠️ Data save failed (network issue)";
      status.style.color = "red";
    }
    return null;
  }
}
async function saveTrialSummary(summary) {
  try {
    const response = await fetch(`${API_BASE}/save-trial-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summary),
    });
    return await response.json();
  } catch (e) {
    console.error("Trial summary save failed:", e);
  }
}
function finalizeCurrentFixation(force = false) {
  if (lastHighlighted && fixationStart) {
    const duration = performance.now() - fixationStart;
    const MIN_FIXATION_time = 80;
    if(duration<MIN_FIXATION_time){
      if (force && lastHighlighted){
        lastHighlighted.el.classList.remove("currently-looking");
        lastHighlighted = null;
      }
      fixationStart = null;
      return;
    }
    const parentLine = lastHighlighted.el.closest(".reading-line");
    const wordRect = lastHighlighted.el.getBoundingClientRect();
    const containerRect = textContainer.getBoundingClientRect();
    const cx = Math.round(wordRect.left + wordRect.width / 2 - containerRect.left);
    const cy = Math.round(wordRect.top + wordRect.height / 2 - containerRect.top);
    const isTarget = +(lastHighlighted.el.dataset.target || 0);
    const row = {
      participant_id: participantId,
      session_id: sessionID,
      condition: currentCondition,
      device: currentDevice,
      document_id: currentStimulus.document_id,
      document_topic: currentStimulus.topic,
      trial_index: currentTrialIndex + 1,
      word: (lastHighlighted.el.innerText || lastHighlighted.el.textContent || "").trim(),
      cue_type: currentStimulus.cue_type,
      aoi: parentLine ? parentLine.dataset.aoi: null,
      is_target_word: isTarget,
      duration: Math.round(duration),
      fixation_time: Math.round(performance.now()),
      client_timestamp: Math.round(performance.now()),
      x: cx,
      y: cy,
      sample_type: "gaze"
    };
    experimentLogs.push(row);
    saveToDB(row);
    trialFixationCount += 1;
    if (isTarget) {
      trialTargetFixationCount += 1;
      trialTargetDwell += Math.round(duration);
    }
  }
  if (force && lastHighlighted) {
    lastHighlighted.el.classList.remove("currently-looking");
    lastHighlighted = null;
    fixationStart = null;
    fixationWord = null;
  }
}

function handleSaccade(point, time) {
    if (lastHighlighted) {
        finalizeCurrentFixation();
        lastHighlighted = null;
    }
}

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

    if (lastHighlighted && lastHighlighted !== w) {
        finalizeCurrentFixation();
    }

    if (!lastHighlighted) {
        fixationStart = time;
    }

    lastHighlighted = w;
    highlightWord(w);
}



function highlightWord(w) {
  
  if (!fixationWord || fixationWord !== w) {
    fixationWord = w;
    fixationStart = performance.now();
  }
  if (lastHighlighted) lastHighlighted.el.classList.remove("currently-looking");
  w.el.classList.add("currently-looking");
  lastHighlighted = w;
}
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
    showLoading(`Generating heatmap for ${currentStimulus.document_id}...`);
    const rect = textContainer.getBoundingClientRect();
    if(!window.cachedLayoutImage){
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
    showHeatmap();
  } catch (e) {
    hideLoading();
    $("trial-status").textContent = "❌ Heatmap failed";
    $("trial-status").style.color = "red";
  }
}
function showHeatmap() {
  console.log("showHeatmap triggered",currentHeatmapFilename);
  if (!currentHeatmapFilename) {
    console.warn("blocked heatmap: filename empty");
    return;
  }
  const img = $("heatmap-img");
  img.src = `${API_BASE}/heatmap/${currentHeatmapFilename}?t=${Date.now()}`;
  const modal = $("heatmap-modal");
  modal.style.display = "flex";
  modal.classList.add("active");
}

function closeHeatmap() {
  const modal = $("heatmap-modal");
  $("heatmap-modal").style.display = "none";
  $("heatmap-modal").classList.add("modal-hidden");
  modal.style.display = "none";
  modal.classList.remove("active");
}
window.closeHeatmap = closeHeatmap;
function updateTrialMeta() {
  $("meta-document").textContent = `${currentTrialIndex + 1} / ${currentStimulusSet.length} (${currentStimulus.document_id})`;
  $("meta-topic").textContent = currentStimulus.topic;
}
function resetTrialState() {
  lastStable = null;
  gazeBuffer = [];
  lastHighlighted = null;
  fixationStart = null;
  fixationWord = null;
  trialFixationCount = 0;
  trialTargetFixationCount = 0;
  trialTargetDwell = 0;
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
  if(dataBuffer.length > 0){
    sessionData.push(...dataBuffer);
    dataBuffer = [];
  }
  await generateHeatmapForCurrentTrial();
  stopGazeCloudTracking();
}
function startReading() {
  loadTrial(0);
}
async function loadTrial(index) {
  if (index >= currentStimulusSet.length) {
    finishExperiment();
    return;
  }

  console.log("Starting tracking for new passage...");

  stopGazeCloudTracking(); // ✅ ensure clean stop

  await new Promise(r => setTimeout(r, 500)); // ✅ camera settle time

  restartGazeTracking();

  resetTrialState();

  currentTrialIndex = index;
  currentStimulus = currentStimulusSet[index];

  updateTrialMeta();
  renderDocument(currentStimulus);

  readingStartTime = performance.now();
  startTrialTimer();
}
async function nextDocument() {
  await completeTrial();
  currentTrialIndex++;
  if(currentTrialIndex>=currentStimulusSet.length){
    finishExperiment();
    return;
  }
  loadTrial(currentTrialIndex);
}

const rateMap = new Map();

function rateLimit(user) {
  const now = Date.now();
  const window = 1000; // 1 sec

  if (!rateMap.has(user)) {
    rateMap.set(user, []);
  }

  const timestamps = rateMap.get(user).filter(t => now - t < window);

  if (timestamps.length > 10) return false;

  timestamps.push(now);
  rateMap.set(user, timestamps);
  return true;
}

function stopGazeCloudTracking(){
  try{
    GazeCloudAPI.StopEyeTracking();
  }catch (e) {}

  if (gazeCloudStartTime){
    gazeCloudDuration = performance.now() - gazeCloudStartTime;
    console.log("GazeCloud runtime (ms):", gazeCloudDuration);
  }
}
window.addEventListener("beforeunload", () => {
  stopGazeCloudTracking();

  if(dataBuffer.length>0){
    sessionData.push(...dataBuffer);
    dataBuffer = [];
  }

  if (sessionData.length > 0) {
    navigator.sendBeacon(
      `${API_BASE}/save-full-session`,
      JSON.stringify({
        participant_id: participantId,
        session_id: sessionID,
        samples: sessionData
      })
    );
  }
});

async function finishExperiment() {
  clearInterval(trialTimer);
  isSessionActive = false; // ✅ stop session
  gazePointEl.style.display = "none";
  //try { GazeCloudAPI.StopEyeTracking(); } catch (e) {}
  stopGazeCloudTracking()

  if (dataBuffer.length > 0) {
    sessionData.push(...dataBuffer);
    dataBuffer = [];
  }

  if (!sessionData || sessionData.length === 0) {
    console.warn("No session data to save!");
    return;
  }
  
  await sendSessionInChunks();
  
  console.log("SESSION DATA:", sessionData); // optional debug
  $("trial-status").textContent = "Experiment finished.";
  $("download-csv").classList.remove("hidden");
}
window.onload = function(){
  currentHeatmapFilename = "";
  isSessionActive = false;
  gazeMode = 'idle';
  sessionStorage.clear();
  $("heatmap-modal").style.display = "none";
  setInterval(() => {
    if (gazeCloudStartTime) {
      const runtime = performance.now() - gazeCloudStartTime;

      const el = $("runtime-display");
      if(el){
        el.textContent = Math.floor(runtime/1000) + "s";
      }
    }
  }, 1000);
  $("next-document").onclick = async function () { await nextDocument(); };
  $("finish-experiment").onclick = async function () { await completeTrial(); finishExperiment(); };
  $("download-csv").onclick = function () {
    window.open(`${API_BASE}/export-csv/${encodeURIComponent(participantId)}`, "_blank");
  };
};