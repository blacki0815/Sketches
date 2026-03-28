// app.js – SkizzenGemeinsam (v3: zoom, undo/redo, smooth curves, PNG export)
import {
  db, ref, set, push, onValue,
  onDisconnect, remove, get, update
} from "./firebase.js";

// ─── STATE ────────────────────────────────────────────────────────
let username  = "";
let boardCode = "";
let userId    = localStorage.getItem("sg_userId") || crypto.randomUUID().slice(0, 8);
localStorage.setItem("sg_userId", userId);

let color     = "#e8e8f0";
let brushSize = 4;
let tool      = "pen";
let isDrawing = false;
let remoteStrokes = {};

// Undo / Redo stacks (local stroke keys only)
let undoStack = [];   // array of strokeKeys pushed by THIS user
let redoStack = [];   // array of {key, data} for redo

// Zoom / Pan
let zoom    = 1;
let panX    = 0;
let panY    = 0;
let isPinching   = false;
let lastPinchDist = 0;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;

const canvas  = document.getElementById("main-canvas");
const ctx     = canvas.getContext("2d");
const wrapper = document.getElementById("canvas-wrapper");

// ─── RESIZE ───────────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width  = wrapper.clientWidth;
  canvas.height = wrapper.clientHeight;
  redrawAll(remoteStrokes);
}
window.addEventListener("resize", resizeCanvas);

// ─── TRANSFORM HELPERS ────────────────────────────────────────────
// Screen → world coordinates
function toWorld(sx, sy) {
  return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
}

function applyTransform() {
  ctx.setTransform(zoom, 0, 0, zoom, panX, panY);
}

function updateZoomDisplay() {
  document.getElementById("zoom-display").textContent = Math.round(zoom * 100) + "%";
}

// ─── DRAW HELPERS ─────────────────────────────────────────────────
function drawSegment(x1, y1, x2, y2, col, size, drawTool) {
  ctx.save();
  applyTransform();
  ctx.globalCompositeOperation = drawTool === "eraser" ? "destination-out" : "source-over";
  ctx.strokeStyle = col;
  ctx.lineWidth   = size;
  ctx.lineCap     = "round";
  ctx.lineJoin    = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

// Smooth curve through points using cardinal spline
function drawSmoothStroke(pts, col, size, drawTool) {
  if (!pts || pts.length < 2) return;
  ctx.save();
  applyTransform();
  ctx.globalCompositeOperation = drawTool === "eraser" ? "destination-out" : "source-over";
  ctx.strokeStyle = col;
  ctx.lineWidth   = size;
  ctx.lineCap     = "round";
  ctx.lineJoin    = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);

  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
  ctx.restore();
}

function redrawAll(strokes) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  for (const sid in strokes) {
    const s = strokes[sid];
    if (!s || !s.points || s.points.length < 1) continue;
    if (s.hidden) continue;
    drawSmoothStroke(s.points, s.color, s.size, s.tool);
  }
}

// ─── FIREBASE PATHS ───────────────────────────────────────────────
const meRef      = () => ref(db, `boards/${boardCode}/users/${userId}`);
const strokesRef = () => ref(db, `boards/${boardCode}/strokes`);

// ─── CURRENT STROKE ───────────────────────────────────────────────
let currentStrokeKey = null;
let currentStrokePts = [];

// Raw points buffer → smoothed every N points
const SMOOTH_WINDOW = 3;

function smoothedPoints(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    out.push({
      x: (pts[i - 1].x + pts[i].x + pts[i + 1].x) / 3,
      y: (pts[i - 1].y + pts[i].y + pts[i + 1].y) / 3,
    });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  const src  = e.touches ? e.touches[0] : e;
  const sx   = src.clientX - rect.left;
  const sy   = src.clientY - rect.top;
  return toWorld(sx, sy);
}

function onDown(e) {
  // Two-finger touch → pinch zoom, not drawing
  if (e.touches && e.touches.length === 2) {
    isPinching    = true;
    lastPinchDist = pinchDistance(e.touches);
    isDrawing     = false;
    return;
  }
  e.preventDefault();
  isDrawing = true;
  redoStack = [];   // new stroke clears redo history

  const { x, y } = pointerPos(e);
  currentStrokePts = [{ x, y }];

  const strokeRef  = push(strokesRef());
  currentStrokeKey = strokeRef.key;

  const strokeData = {
    color:  tool === "eraser" ? "#000000" : color,
    size:   brushSize,
    tool,
    owner:  userId,
    hidden: false,
    points: [{ x, y }]
  };
  set(strokeRef, strokeData);
  undoStack.push(currentStrokeKey);

  // Draw dot for single tap
  ctx.save();
  applyTransform();
  ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

let lastCursorSync = 0;

function onMove(e) {
  // Pinch zoom
  if (e.touches && e.touches.length === 2) {
    e.preventDefault();
    const dist  = pinchDistance(e.touches);
    const delta = dist / lastPinchDist;
    lastPinchDist = dist;

    // Zoom around pinch midpoint
    const rect = canvas.getBoundingClientRect();
    const mx   = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - rect.left;
    const my   = ((e.touches[0].clientY + e.touches[1].clientY) / 2) - rect.top;
    zoomAround(mx, my, delta);
    return;
  }

  e.preventDefault();

  // Cursor sync
  const now = Date.now();
  if (now - lastCursorSync > 60) {
    lastCursorSync = now;
    const { x, y } = pointerPos(e);
    update(meRef(), { x, y });
  }

  if (!isDrawing || !currentStrokeKey) return;

  const { x, y } = pointerPos(e);
  const last = currentStrokePts[currentStrokePts.length - 1];
  const dx = x - last.x, dy = y - last.y;
  if (dx * dx + dy * dy < 1) return;

  currentStrokePts.push({ x, y });
  const smoothed = smoothedPoints(currentStrokePts);

  // Full local redraw for smooth preview
  redrawAll(remoteStrokes);
  drawSmoothStroke(smoothed, tool === "eraser" ? "#000" : color, brushSize, tool);

  // Push latest point to Firebase
  const idx = currentStrokePts.length - 1;
  set(ref(db, `boards/${boardCode}/strokes/${currentStrokeKey}/points/${idx}`), { x, y });
}

function onUp(e) {
  if (isPinching) { isPinching = false; return; }
  if (!isDrawing) return;
  isDrawing = false;

  // Final smooth + push smoothed points to Firebase
  if (currentStrokeKey && currentStrokePts.length > 1) {
    const smoothed = smoothedPoints(currentStrokePts);
    set(ref(db, `boards/${boardCode}/strokes/${currentStrokeKey}/points`), smoothed);
  }

  currentStrokeKey = null;
  currentStrokePts = [];
}

canvas.addEventListener("mousedown",  onDown);
canvas.addEventListener("mousemove",  onMove);
canvas.addEventListener("mouseup",    onUp);
canvas.addEventListener("mouseleave", onUp);
canvas.addEventListener("touchstart", onDown, { passive: false });
canvas.addEventListener("touchmove",  onMove, { passive: false });
canvas.addEventListener("touchend",   onUp);

// ─── PINCH HELPERS ────────────────────────────────────────────────
function pinchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

// ─── ZOOM ─────────────────────────────────────────────────────────
function zoomAround(cx, cy, factor) {
  const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
  const ratio   = newZoom / zoom;
  panX = cx - ratio * (cx - panX);
  panY = cy - ratio * (cy - panY);
  zoom = newZoom;
  updateZoomDisplay();
  redrawAll(remoteStrokes);
}

// Mouse wheel zoom
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const rect   = canvas.getBoundingClientRect();
  const cx     = e.clientX - rect.left;
  const cy     = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  zoomAround(cx, cy, factor);
}, { passive: false });

document.getElementById("zoom-in-btn").addEventListener("click", () => {
  zoomAround(canvas.width / 2, canvas.height / 2, 1.25);
});
document.getElementById("zoom-out-btn").addEventListener("click", () => {
  zoomAround(canvas.width / 2, canvas.height / 2, 0.8);
});
document.getElementById("zoom-reset-btn").addEventListener("click", () => {
  zoom = 1; panX = 0; panY = 0;
  updateZoomDisplay();
  redrawAll(remoteStrokes);
});

// ─── UNDO / REDO ──────────────────────────────────────────────────
async function undo() {
  if (!undoStack.length) return;
  const key  = undoStack.pop();
  const snap = await get(ref(db, `boards/${boardCode}/strokes/${key}`));
  if (!snap.exists()) return;
  const data = snap.val();
  redoStack.push({ key, data });
  await update(ref(db, `boards/${boardCode}/strokes/${key}`), { hidden: true });
}

async function redo() {
  if (!redoStack.length) return;
  const { key, data } = redoStack.pop();
  undoStack.push(key);
  await update(ref(db, `boards/${boardCode}/strokes/${key}`), { hidden: false });
}

document.getElementById("undo-btn").addEventListener("click", undo);
document.getElementById("redo-btn").addEventListener("click", redo);

// Keyboard shortcuts
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
});

// ─── REALTIME STROKES ─────────────────────────────────────────────
function listenStrokes() {
  onValue(strokesRef(), snap => {
    remoteStrokes = snap.val() || {};
    redrawAll(remoteStrokes);
  });
}

// ─── USERS / CURSORS ──────────────────────────────────────────────
function userColor(uid) {
  const palette = ["#e63946","#2a9d8f","#f4a261","#457b9d","#a8dadc","#e9c46a","#8338ec","#06d6a0"];
  let h = 0;
  for (const c of uid) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return palette[Math.abs(h) % palette.length];
}

function listenUsers() {
  onValue(ref(db, `boards/${boardCode}/users`), snap => {
    const data = snap.val() || {};
    renderUserDots(data);
    renderRemoteCursors(data);
  });
}

function renderUserDots(users) {
  const container = document.getElementById("users-online");
  container.innerHTML = "";
  for (const uid in users) {
    const u   = users[uid];
    const dot = document.createElement("div");
    dot.className        = "user-dot";
    dot.style.background = userColor(uid);
    dot.textContent      = (u.name || "?")[0].toUpperCase();
    dot.title            = u.name || uid;
    container.appendChild(dot);
  }
}

function renderRemoteCursors(users) {
  const layer = document.getElementById("cursors-layer");
  layer.querySelectorAll("[data-uid]").forEach(el => {
    if (!users[el.dataset.uid]) el.remove();
  });
  for (const uid in users) {
    if (uid === userId) continue;
    const u   = users[uid];
    const col = userColor(uid);
    let el = layer.querySelector(`[data-uid="${uid}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className   = "remote-cursor";
      el.dataset.uid = uid;
      el.innerHTML   = `
        <svg viewBox="0 0 18 18" fill="${col}" xmlns="http://www.w3.org/2000/svg">
          <path d="M2 2l14 6-7 2-2 7z"/>
        </svg>
        <div class="remote-cursor-label" style="background:${col}">${u.name || uid}</div>`;
      layer.appendChild(el);
    }
    if (u.x !== undefined) {
      // Convert world coords back to screen coords for cursor display
      el.style.left = (u.x * zoom + panX) + "px";
      el.style.top  = (u.y * zoom + panY) + "px";
    }
  }
}

// ─── JOIN BOARD ───────────────────────────────────────────────────
async function joinBoard(code) {
  boardCode = code;
  document.getElementById("board-code-display").textContent = code;

  await set(meRef(), { name: username, color: userColor(userId), x: 0, y: 0 });
  onDisconnect(meRef()).remove();

  const url = new URL(window.location.href);
  url.searchParams.set("board", code);
  window.history.replaceState({}, "", url);

  listenStrokes();
  listenUsers();
  showScreen("canvas-screen");
  setTimeout(resizeCanvas, 50);
}

// ─── SAVE / CLEAR / EXPORT ────────────────────────────────────────
async function saveBoard() {
  const thumb = canvas.toDataURL("image/jpeg", 0.4);
  await set(ref(db, `saved/${userId}/${boardCode}`), {
    code: boardCode, savedAt: Date.now(), thumbnail: thumb
  });
  showToast("✅ Board gespeichert!");
}

async function clearBoard() {
  if (!confirm("Wirklich alle Striche löschen?")) return;
  await remove(strokesRef());
  remoteStrokes = {};
  undoStack = [];
  redoStack = [];
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  showToast("🗑 Board geleert");
}

function exportPNG() {
  // Draw canvas content onto a white-bg offscreen canvas for clean export
  const off   = document.createElement("canvas");
  off.width   = canvas.width;
  off.height  = canvas.height;
  const offCtx = off.getContext("2d");
  offCtx.fillStyle = "#0f0f17";
  offCtx.fillRect(0, 0, off.width, off.height);
  offCtx.drawImage(canvas, 0, 0);

  const link  = document.createElement("a");
  link.download = `skizze-${boardCode}-${Date.now()}.png`;
  link.href   = off.toDataURL("image/png");
  link.click();
  showToast("📥 PNG gespeichert!");
}

async function loadSavedBoards() {
  const snap = await get(ref(db, `saved/${userId}`));
  if (!snap.exists()) return;
  const data    = snap.val();
  const section = document.getElementById("saved-boards-section");
  const list    = document.getElementById("saved-boards-list");
  list.innerHTML = "";
  for (const key in data) {
    const b    = data[key];
    const card = document.createElement("div");
    card.className = "board-card";
    card.innerHTML = `
      <div class="board-code">${b.code}</div>
      <div class="board-date">${new Date(b.savedAt).toLocaleDateString("de-DE")}</div>
      ${b.thumbnail ? `<img class="board-thumb" src="${b.thumbnail}" alt=""/>` : ""}`;
    card.addEventListener("click", () => {
      document.getElementById("board-code-input").value = b.code;
    });
    list.appendChild(card);
  }
  section.classList.remove("hidden");
}

// ─── SCREEN ───────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ─── TOAST ────────────────────────────────────────────────────────
function showToast(msg, ms = 2500) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(t._t);
  t._t = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.classList.add("hidden"), 350);
  }, ms);
}

// ─── TOOLBAR ──────────────────────────────────────────────────────
document.querySelectorAll(".tool-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    tool = btn.dataset.tool;
    canvas.style.cursor = tool === "eraser" ? "cell" : "crosshair";
  });
});

document.getElementById("size-slider").addEventListener("input", e => {
  brushSize = +e.target.value;
  document.getElementById("size-display").textContent = brushSize;
});

document.querySelectorAll(".color-swatch").forEach(sw => {
  sw.addEventListener("click", () => {
    document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
    sw.classList.add("active");
    color = sw.dataset.color;
    document.getElementById("custom-color").value = color;
    tool = "pen";
    document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
    document.querySelector('[data-tool="pen"]').classList.add("active");
  });
});

document.getElementById("custom-color").addEventListener("input", e => {
  color = e.target.value;
  document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
  tool = "pen";
  document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
  document.querySelector('[data-tool="pen"]').classList.add("active");
});

// ─── HEADER BUTTONS ───────────────────────────────────────────────
document.getElementById("save-btn").addEventListener("click", saveBoard);
document.getElementById("clear-btn").addEventListener("click", clearBoard);
document.getElementById("export-btn").addEventListener("click", exportPNG);

document.getElementById("copy-link-btn").addEventListener("click", () => {
  const url = new URL(window.location.href);
  url.searchParams.set("board", boardCode);
  navigator.clipboard.writeText(url.toString())
    .then(() => showToast("🔗 Link kopiert!"))
    .catch(() => showToast("Board-Code: " + boardCode));
});

document.getElementById("back-btn").addEventListener("click", async () => {
  await remove(meRef());
  boardCode = "";
  undoStack = [];
  redoStack = [];
  showScreen("home-screen");
  loadSavedBoards();
});

// ─── HOME ─────────────────────────────────────────────────────────
document.getElementById("join-btn").addEventListener("click", () => {
  const name = document.getElementById("username-input").value.trim();
  if (!name) { showToast("⚠ Bitte gib einen Namen ein."); return; }
  username = name;
  const code = document.getElementById("board-code-input").value.trim()
    || Math.random().toString(36).slice(2, 8);
  joinBoard(code);
});

["username-input", "board-code-input"].forEach(id =>
  document.getElementById(id).addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("join-btn").click();
  })
);

// ─── INIT ─────────────────────────────────────────────────────────
const urlBoard = new URLSearchParams(window.location.search).get("board");
if (urlBoard) document.getElementById("board-code-input").value = urlBoard;

loadSavedBoards();
resizeCanvas();
updateZoomDisplay();
