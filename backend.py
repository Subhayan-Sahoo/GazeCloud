import os
import sqlite3
import numpy as np
import matplotlib.pyplot as plt
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, validator
from scipy.ndimage import gaussian_filter
from fastapi.middleware.cors import CORSMiddleware
import re
from pathlib import Path
from collections import defaultdict
import time
import base64
from PIL import Image
import io
from typing import Optional

DB_PATH = "gaze.db"
HEATMAP_DIR = "heatmaps"
SIGMA = 15
REQUEST_LIMITS = defaultdict(list)
RATE_LIMIT = 200

os.makedirs(HEATMAP_DIR, exist_ok=True)

app = FastAPI(title="Reading Experiment Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://gazecloud.onrender.com"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class GazeLog(BaseModel):
    participant_id: str = Field(..., min_length=1, max_length=100)
    session_id: Optional[str] = Field(None, max_length=100)
    condition: str = Field(..., max_length=20)
    device: Optional[str] = Field(None, max_length=50)
    document_id: str = Field(..., max_length=20)
    document_topic: Optional[str] = Field(None, max_length=100)
    trial_index: int = Field(..., ge=1, le=20)
    word: Optional[str] = Field(None, max_length=200)
    cue_type: Optional[str] = Field(None, max_length=50)
    aoi: Optional[str] = Field(None, max_length=50)
    is_target_word: int = Field(0, ge=0, le=1)
    duration: int = Field(0, ge=0, le=60000)
    fixation_time: int = Field(..., ge=0)
    client_timestamp: int = Field(..., ge=0)
    x: int = Field(..., ge=0, le=10000)
    y: int = Field(..., ge=0, le=10000)
    sample_type: str = Field("gaze", max_length=30)

    @validator('participant_id')
    def validate_participant_id(cls, v):
        if not re.match(r'^[\w\-]+$', v):
            raise ValueError('Invalid participant ID')
        return v

class HeatmapRequest(BaseModel):
    participant_id: str = Field(..., min_length=1, max_length=100)
    width: int = Field(..., gt=0, le=10000)
    height: int = Field(..., gt=0, le=10000)
    document_id: Optional[str] = Field(None, max_length=20)
    device: Optional[str] = Field(None, max_length=50)
    layout_image: Optional[str] = None

class TrialSummary(BaseModel):
    participant_id: str = Field(..., min_length=1, max_length=100)
    session_id: Optional[str] = Field(None, max_length=100)  # ✅ NEW
    condition: str = Field(..., max_length=20)
    device: Optional[str] = Field(None, max_length=50)
    document_id: str = Field(..., max_length=20)
    document_topic: Optional[str] = Field(None, max_length=100)
    trial_index: int = Field(..., ge=1, le=20)
    reading_time_ms: int = Field(..., ge=0)
    total_fixations: int = Field(0, ge=0)
    total_target_fixations: int = Field(0, ge=0)
    total_target_dwell_ms: int = Field(0, ge=0)
    notes: Optional[str] = None


def sanitize_filename(name: str) -> str:
    safe_name = re.sub(r'[^\w\-]', '', name)
    return safe_name or "default"


def rate_limit(request: Request):
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    REQUEST_LIMITS[client_ip] = [t for t in REQUEST_LIMITS[client_ip] if now - t < 60]
    if len(REQUEST_LIMITS[client_ip]) >= RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many requests")
    REQUEST_LIMITS[client_ip].append(now)


def ensure_column(cur, table: str, column: str, col_type: str):
    cur.execute(f"PRAGMA table_info({table})")
    existing = {row[1] for row in cur.fetchall()}
    if column not in existing:
        cur.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")


def init_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS gaze_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            participant_id TEXT,
            layout TEXT,
            word TEXT,
            duration INTEGER,
            fixation_time INTEGER,
            x INTEGER,
            y INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    for col, typ in [
        ("condition", "TEXT"),
        ("device", "TEXT"),
        ("document_id", "TEXT"),
        ("document_topic", "TEXT"),
        ("trial_index", "INTEGER DEFAULT 0"),
        ("cue_type", "TEXT"),
        ("is_target_word", "INTEGER DEFAULT 0"),
        ("sample_type", "TEXT DEFAULT 'gaze'"),
        ("session_id", "TEXT"),
        ("aoi", "TEXT"),
        ("client_timestamp", "INTEGER")
    ]:
        ensure_column(cur, "gaze_logs", col, typ)
        

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trial_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            participant_id TEXT,
            condition TEXT,
            device TEXT,
            document_id TEXT,
            document_topic TEXT,
            trial_index INTEGER,
            reading_time_ms INTEGER,
            total_fixations INTEGER,
            total_target_fixations INTEGER,
            total_target_dwell_ms INTEGER,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    ensure_column(cur, "trial_summaries", "session_id", "TEXT")
    
    cur.execute("CREATE INDEX IF NOT EXISTS idx_participant ON gaze_logs(participant_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_trial_doc ON gaze_logs(participant_id, document_id, trial_index)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_trial_summary ON trial_summaries(participant_id, document_id, trial_index)")
    conn.commit()
    conn.close()


init_db()


def generate_heatmap(participant_id: str, width: int, height: int, document_id: str | None = None, device: str | None = None, layout_image: str | None = None):
    safe_id = sanitize_filename(participant_id)
    suffix = ""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    cur = conn.cursor()

    query = "SELECT x, y FROM gaze_logs WHERE participant_id = ? AND x IS NOT NULL AND y IS NOT NULL AND sample_type = 'gaze'"
    params = [participant_id]
    if document_id:
        query += " AND document_id = ?"
        params.append(document_id)
        suffix += f"_{sanitize_filename(document_id)}"
    if device:
        query += " AND device = ?"
        params.append(device)
        suffix += f"_{sanitize_filename(device)}"

    cur.execute(query, tuple(params))
    rows = cur.fetchall()
    conn.close()

    if len(rows) < 10:
        raise ValueError("Not enough gaze data (need at least 10 points)")

    heatmap = np.zeros((height, width), dtype=np.float32)
    for x, y in rows:
        x, y = int(x), int(y)
        if 0 <= x < width and 0 <= y < height:
            heatmap[y, x] += 1
    if np.sum(heatmap) == 0:
        raise ValueError("No valid gaze points within screen bounds")

    heatmap = gaussian_filter(heatmap, sigma=SIGMA)
    if np.max(heatmap) > 0:
        heatmap = heatmap / np.max(heatmap)
    background = None
    if layout_image:
        image_data = base64.b64decode(layout_image.split(",")[1])
        background = Image.open(io.BytesIO(image_data)).convert("RGB")

    plt.figure(figsize=(width / 100, height / 100), dpi=100)
    if background:
        background = background.resize((width, height))
        plt.imshow(background, extent=[0, width, height, 0])
    plt.imshow(heatmap, cmap="jet", alpha=0.6, origin="upper")
    plt.axis("off")

    filename = f"{safe_id}{suffix}.png"
    path = os.path.join(HEATMAP_DIR, filename)
    heatmap_dir_abs = Path(HEATMAP_DIR).resolve()
    path_abs = Path(path).resolve()
    if not str(path_abs).startswith(str(heatmap_dir_abs)):
        raise ValueError("Invalid path")
    try:
        plt.savefig(path, bbox_inches="tight", pad_inches=0, dpi=100)
    finally:
        plt.close()
    return path, filename


@app.post("/save-log")
def save_log(log: GazeLog, request: Request):
    rate_limit(request)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO gaze_logs (
            participant_id, session_id, layout, condition, device, document_id, document_topic,
            trial_index, word, cue_type, aoi, is_target_word, duration, fixation_time, client_timestamp, x, y, sample_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        log.participant_id,
        log.session_id,
        None,
        log.condition,
        log.device,
        log.document_id,
        log.document_topic,
        log.trial_index,
        log.word,
        log.cue_type,
        log.aoi,
        log.is_target_word,
        log.duration,
        log.fixation_time,
        log.client_timestamp,
        log.x,
        log.y,
        log.sample_type,
    ))
    conn.commit()
    conn.close()
    return {"status": "saved"}


@app.post("/save-trial-summary")
def save_trial_summary(summary: TrialSummary, request: Request):
    rate_limit(request)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO trial_summaries (
            participant_id, session_id, condition, device, document_id, document_topic, trial_index,
            reading_time_ms, total_fixations, total_target_fixations, total_target_dwell_ms, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        summary.participant_id, summary.session_id, summary.condition, summary.device, summary.document_id,
        summary.document_topic, summary.trial_index, summary.reading_time_ms,
        summary.total_fixations, summary.total_target_fixations, summary.total_target_dwell_ms,
        summary.notes
    ))
    conn.commit()
    conn.close()
    return {"status": "saved"}

@app.post("/save-full-session")
async def save_full_session(data: dict):
    return {"status": "received"}


@app.post("/generate-heatmap")
def generate_heatmap_endpoint(req: HeatmapRequest, request: Request):
    rate_limit(request)
    try:
        _, filename = generate_heatmap(req.participant_id, req.width, req.height, req.document_id, req.device, req.layout_image)
        return {"status": "ok", "filename": filename}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@app.get("/heatmap/{filename}")
def get_heatmap(filename: str, request: Request):
    rate_limit(request)
    safe_filename = sanitize_filename(Path(filename).stem) + ".png"
    path = os.path.join(HEATMAP_DIR, safe_filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Heatmap not found. Please generate it first.")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-cache, no-store, must-revalidate"})


@app.get("/export-csv/{participant_id}")
def export_csv(participant_id: str, request: Request):
    rate_limit(request)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    cur = conn.cursor()
    cur.execute("""
        SELECT participant_id, session_id, condition, device, document_id, document_topic, trial_index, word,
               cue_type, is_target_word, duration, fixation_time, x, y, sample_type, created_at
        FROM gaze_logs WHERE participant_id = ? ORDER BY id ASC
    """, (participant_id,))
    rows = cur.fetchall()
    conn.close()
    if not rows:
        raise HTTPException(status_code=404, detail="No data found for participant")
    out_path = f"/tmp/{sanitize_filename(participant_id)}_gaze_export.csv"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("participant_id,condition,device,document_id,document_topic,trial_index,word,cue_type,is_target_word,duration,fixation_time,x,y,sample_type,created_at\n")
        for row in rows:
            safe = ["" if v is None else str(v).replace(',', ';') for v in row]
            f.write(",".join(safe) + "\n")
    return FileResponse(out_path, media_type="text/csv", filename=f"{sanitize_filename(participant_id)}_gaze_export.csv")


@app.get("/")
def read_root():
    return {
        "message": "Reading Experiment Backend",
        "endpoints": {
            "POST /save-log": "Save gaze sample/fixation data",
            "POST /save-trial-summary": "Save per-document summary",
            "POST /generate-heatmap": "Generate document heatmap",
            "GET /heatmap/{filename}": "Get heatmap image",
            "GET /export-csv/{participant_id}": "Export all participant logs as CSV"
        }
    }


@app.get("/health")
def health_check():
    return {"status": "healthy", "timestamp": time.time()}
