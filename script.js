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

GazeCloudAPI.OnCalibrationComplete = function(){
  console.log("Built-in calibration completed.");
  
  builtInCalibDuration = performance.now() - builtInCalibStart;
  $("setup-page").classList.add("hidden");
  $("custom-calibration-page").classList.remove("hidden");

  setTimeout(() => {
    calibrationGrid.style.display = "block";
    calibrationGrid.style.height = "400px";

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        startCalibration();
      });
    });
  }, 300);
  gazeMode = "calibration";
};

GazeCloudAPI.OnResult = function(gd) {
  if (gd.state !== 0) return;

  // Always update raw gaze
  lastGaze = { x: gd.GazeX, y: gd.GazeY };

  if (gazeMode === "calibration") {
    // 👁️ Show raw gaze for calibration
    gazePointEl.style.left = gd.GazeX + "px";
    gazePointEl.style.top = gd.GazeY + "px";
    gazePointEl.style.display = "block";
  }

  else if (gazeMode === "reading") {
    if (!isSessionActive) return;

    const settings = getSettings();

    const mapped = mapGaze(gd.GazeX, gd.GazeY, settings.affine);
    const filtered = filterGaze(mapped.x, mapped.y, settings);

    const x = filtered.x;
    const y = filtered.y;

    gazePointEl.style.left = x + "px";
    gazePointEl.style.top = y + "px";
    gazePointEl.style.display = "block";

    // session logging
    sessionData.push({
      time: Math.round(performance.now() - sessionStartTime),
      x: Math.round(x),
      y: Math.round(y),
      document_id: currentStimulus?.document_id,
      trial_index: currentTrialIndex + 1
    });

    // word detection
    const w = findWord(x, y);
    if (w) highlightWord(w);
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
  gazePointEl.style.display = "none";
  isCalibrating = false;
  affine = computeAffine(calibPairs);
  gazeMode = "idle";

  $("custom-calibration-page").classList.add("hidden");
  $("reading-page").classList.remove("hidden");
  $("calibration-result").textContent = "Calibration complete.";
  $("begin-reading").disabled = false;

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
  if (distance < settings.deadZone) return lastStable;
  const alpha =  0.4;
  avgX = lastStable.x + dx * alpha;
  avgY = lastStable.y + dy * alpha;
  lastStable = { x: avgX, y: avgY };
  return lastStable;
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
function highlightWord(w) {
  if (lastHighlighted && lastHighlighted !== w) {
    finalizeCurrentFixation();
  }
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
    const layoutImage = await captureLayoutImage();
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
    console.error(e);
  }
}
function showHeatmap() {
  if (!currentHeatmapFilename) return;
  const img = $("heatmap-img");
  img.src = `${API_BASE}/heatmap/${currentHeatmapFilename}?t=${Date.now()}`;
  const modal = $("heatmap-modal");
  modal.style.display = "flex";
  modal.classList.remove("modal-hidden");
}
function closeHeatmap() {
  $("heatmap-modal").style.display = "none";
  $("heatmap-modal").classList.add("modal-hidden");
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
  await generateHeatmapForCurrentTrial();
}
function startReading() {
  loadTrial(0);
}
function loadTrial(index) {
  if (index >= currentStimulusSet.length) {
    finishExperiment();
    return;
  }
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
})

async function finishExperiment() {
  clearInterval(trialTimer);
  isSessionActive = false; // ✅ stop session
  gazePointEl.style.display = "none";
  //try { GazeCloudAPI.StopEyeTracking(); } catch (e) {}
  stopGazeCloudTracking()
  
  await fetch(`${API_BASE}/save-full-session`,{
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      participant_id: participantId,
      session_id: sessionID,
      gazecloud_runtime_ms: gazeCloudDuration,
      built_in_calibration_ms: builtInCalibDuration,
      samples: sessionData
    })
  });
  
  console.log("SESSION DATA:", sessionData); // optional debug
  $("trial-status").textContent = "Experiment finished.";
  $("download-csv").classList.remove("hidden");
}
window.onload = function(){
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