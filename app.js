// app.js – SkizzenGemeinsam v4 (shapes, text tool, background, clean toolbar)
import {
  db, ref, set, push, onValue,
  onDisconnect, remove, get, update
} from "./firebase.js";

// ─── STATE ────────────────────────────────────────────────────────
let username  = "";
let boardCode = "";
let userId    = localStorage.getItem("sg_userId") || crypto.randomUUID().slice(0, 8);
localStorage.setItem("sg_userId", userId);

let color      = "#e8e8f0";
let brushSize  = 4;
let tool       = "pen";
let activeShape = "rect";
let isDrawing  = false;
let remoteStrokes = {};

// Undo / Redo
let undoStack = [];
let redoStack = [];

// Zoom / Pan
let zoom = 1, panX = 0, panY = 0;
const MIN_ZOOM = 0.2, MAX_ZOOM = 8;

// Pinch
let isPinching = false, lastPinchDist = 0;

// Shape preview
let shapeStart = null;

// Text tool
let textPos = null;

const canvas  = document.getElementById("main-canvas");
const ctx     = canvas.getContext("2d");
const wrapper = document.getElementById("canvas-wrapper");
const textInput = document.getElementById("text-input");

// ─── RESIZE ───────────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width  = wrapper.clientWidth;
  canvas.height = wrapper.clientHeight;
  redrawAll(remoteStrokes);
}
window.addEventListener("resize", resizeCanvas);

// ─── TRANSFORM ────────────────────────────────────────────────────
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
function setStrokeStyle(col, size, drawTool) {
  ctx.globalCompositeOperation = drawTool === "eraser" ? "destination-out" : "source-over";
  ctx.strokeStyle = col;
  ctx.fillStyle   = col;
  ctx.lineWidth   = size;
  ctx.lineCap     = "round";
  ctx.lineJoin    = "round";
}

function drawSmoothStroke(pts, col, size, drawTool) {
  if (!pts || pts.length < 1) return;
  ctx.save();
  applyTransform();
  setStrokeStyle(col, size, drawTool);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) {
    ctx.arc(pts[0].x, pts[0].y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.stroke();
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i+1].x) / 2;
      const my = (pts[i].y + pts[i+1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawShape(s) {
  const { shape, x1, y1, x2, y2, color: col, size, tool: t } = s;
  ctx.save();
  applyTransform();
  setStrokeStyle(col, size, t);
  ctx.beginPath();

  const w = x2 - x1, h = y2 - y1;

  if (shape === "line") {
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

  } else if (shape === "rect") {
    ctx.strokeRect(x1, y1, w, h);

  } else if (shape === "ellipse") {
    ctx.ellipse(x1 + w/2, y1 + h/2, Math.abs(w/2), Math.abs(h/2), 0, 0, Math.PI*2);
    ctx.stroke();

  } else if (shape === "triangle") {
    ctx.moveTo(x1 + w/2, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x1, y2);
    ctx.closePath(); ctx.stroke();

  } else if (shape === "arrow") {
    // Shaft
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    // Arrowhead
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const hw = Math.max(size * 3, 12);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - hw * Math.cos(angle - Math.PI/7), y2 - hw * Math.sin(angle - Math.PI/7));
    ctx.lineTo(x2 - hw * Math.cos(angle + Math.PI/7), y2 - hw * Math.sin(angle + Math.PI/7));
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawTextStroke(s) {
  if (!s.text) return;
  ctx.save();
  applyTransform();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = s.color;
  ctx.font = `${s.size * 3 + 8}px ${getComputedStyle(document.body).getPropertyValue('--font-mono').trim() || 'monospace'}`;
  ctx.fillText(s.text, s.x, s.y);
  ctx.restore();
}

function redrawAll(strokes) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  for (const sid in strokes) {
    const s = strokes[sid];
    if (!s || s.hidden) continue;
    if (s.type === "shape") {
      drawShape(s);
    } else if (s.type === "text") {
      drawTextStroke(s);
    } else {
      if (s.points && s.points.length > 0)
        drawSmoothStroke(s.points, s.color, s.size, s.tool);
    }
  }
}

// ─── FIREBASE ─────────────────────────────────────────────────────
const meRef      = () => ref(db, `boards/${boardCode}/users/${userId}`);
const strokesRef = () => ref(db, `boards/${boardCode}/strokes`);

// ─── SMOOTH HELPER ────────────────────────────────────────────────
function smoothedPoints(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    out.push({
      x: (pts[i-1].x + pts[i].x + pts[i+1].x) / 3,
      y: (pts[i-1].y + pts[i].y + pts[i+1].y) / 3,
    });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ─── POINTER HELPERS ──────────────────────────────────────────────
function screenPos(e) {
  const rect = canvas.getBoundingClientRect();
  const src  = e.touches ? e.touches[0] : e;
  return { sx: src.clientX - rect.left, sy: src.clientY - rect.top };
}
function worldPos(e) {
  const { sx, sy } = screenPos(e);
  return toWorld(sx, sy);
}

// ─── STROKE STATE ─────────────────────────────────────────────────
let currentStrokeKey = null;
let currentStrokePts = [];
let lastCursorSync   = 0;

// ─── POINTER DOWN ─────────────────────────────────────────────────
function onDown(e) {
  if (e.touches && e.touches.length === 2) {
    isPinching = true; isDrawing = false;
    lastPinchDist = pinchDist(e.touches);
    return;
  }
  e.preventDefault();

  // Close any open dropdowns
  closeDropdowns();

  const { x, y } = worldPos(e);

  // TEXT TOOL
  if (tool === "text") {
    commitText();
    textPos = { x, y };
    placeTextInput(x, y);
    return;
  }

  isDrawing = true;
  redoStack = [];

  // SHAPE TOOL
  if (tool === "shape") {
    shapeStart = { x, y };
    currentStrokeKey = push(strokesRef()).key;
    undoStack.push(currentStrokeKey);
    return;
  }

  // PEN / ERASER
  currentStrokePts = [{ x, y }];
  const strokeRef  = push(strokesRef());
  currentStrokeKey = strokeRef.key;
  undoStack.push(currentStrokeKey);

  set(strokeRef, {
    type: "pen", color: tool === "eraser" ? "#000000" : color,
    size: brushSize, tool, owner: userId, hidden: false,
    points: [{ x, y }]
  });

  // dot
  ctx.save(); applyTransform();
  ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, brushSize/2, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

// ─── POINTER MOVE ─────────────────────────────────────────────────
function onMove(e) {
  if (e.touches && e.touches.length === 2) {
    e.preventDefault();
    const d = pinchDist(e.touches);
    const factor = d / lastPinchDist;
    lastPinchDist = d;
    const rect = canvas.getBoundingClientRect();
    const mx = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - rect.left;
    const my = ((e.touches[0].clientY + e.touches[1].clientY) / 2) - rect.top;
    zoomAround(mx, my, factor);
    return;
  }
  e.preventDefault();

  // cursor sync
  const now = Date.now();
  if (now - lastCursorSync > 60) {
    lastCursorSync = now;
    const { x, y } = worldPos(e);
    update(meRef(), { x, y });
  }

  if (!isDrawing || !currentStrokeKey) return;
  const { x, y } = worldPos(e);

  // SHAPE PREVIEW
  if (tool === "shape" && shapeStart) {
    redrawAll(remoteStrokes);
    drawShape({
      shape: activeShape, tool: "pen",
      x1: shapeStart.x, y1: shapeStart.y, x2: x, y2: y,
      color, size: brushSize
    });
    return;
  }

  // PEN
  const last = currentStrokePts[currentStrokePts.length - 1];
  const dx = x - last.x, dy = y - last.y;
  if (dx*dx + dy*dy < 1) return;

  currentStrokePts.push({ x, y });
  const smoothed = smoothedPoints(currentStrokePts);
  redrawAll(remoteStrokes);
  drawSmoothStroke(smoothed, tool === "eraser" ? "#000" : color, brushSize, tool);

  const idx = currentStrokePts.length - 1;
  set(ref(db, `boards/${boardCode}/strokes/${currentStrokeKey}/points/${idx}`), { x, y });
}

// ─── POINTER UP ───────────────────────────────────────────────────
function onUp(e) {
  if (isPinching) { isPinching = false; return; }
  if (!isDrawing) return;
  isDrawing = false;

  const { x, y } = worldPos(e);

  // SHAPE COMMIT
  if (tool === "shape" && shapeStart && currentStrokeKey) {
    const data = {
      type: "shape", shape: activeShape,
      x1: shapeStart.x, y1: shapeStart.y, x2: x, y2: y,
      color, size: brushSize, tool: "pen",
      owner: userId, hidden: false
    };
    set(ref(db, `boards/${boardCode}/strokes/${currentStrokeKey}`), data);
    shapeStart = null;
    currentStrokeKey = null;
    return;
  }

  // PEN COMMIT – push final smoothed points
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

// ─── TEXT TOOL ────────────────────────────────────────────────────
function placeTextInput(wx, wy) {
  // Convert world → screen
  const sx = wx * zoom + panX;
  const sy = wy * zoom + panY;
  const fontSize = (brushSize * 3 + 8) * zoom;

  textInput.style.left     = sx + "px";
  textInput.style.top      = (sy - fontSize) + "px";
  textInput.style.fontSize = fontSize + "px";
  textInput.style.color    = color;
  textInput.value = "";
  textInput.classList.remove("hidden");
  textInput.focus();

  // Auto-resize
  textInput.oninput = () => {
    textInput.style.width  = "auto";
    textInput.style.height = "auto";
    textInput.style.width  = textInput.scrollWidth + "px";
    textInput.style.height = textInput.scrollHeight + "px";
  };
}

function commitText() {
  const val = textInput.value.trim();
  textInput.classList.add("hidden");
  textInput.value = "";
  if (!val || !textPos) { textPos = null; return; }

  const strokeRef = push(strokesRef());
  const key = strokeRef.key;
  undoStack.push(key);
  redoStack = [];

  set(strokeRef, {
    type: "text", text: val,
    x: textPos.x, y: textPos.y,
    color, size: brushSize,
    owner: userId, hidden: false
  });
  textPos = null;
}

textInput.addEventListener("keydown", e => {
  if (e.key === "Escape") { textInput.classList.add("hidden"); textInput.value = ""; textPos = null; }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); }
});

// ─── PINCH ────────────────────────────────────────────────────────
function pinchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx*dx + dy*dy);
}

// ─── ZOOM ─────────────────────────────────────────────────────────
function zoomAround(cx, cy, factor) {
  const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
  const r  = nz / zoom;
  panX = cx - r * (cx - panX);
  panY = cy - r * (cy - panY);
  zoom = nz;
  updateZoomDisplay();
  redrawAll(remoteStrokes);
}
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  zoomAround(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 0.9);
}, { passive: false });

document.getElementById("zoom-in-btn").addEventListener("click",    () => zoomAround(canvas.width/2, canvas.height/2, 1.25));
document.getElementById("zoom-out-btn").addEventListener("click",   () => zoomAround(canvas.width/2, canvas.height/2, 0.8));
document.getElementById("zoom-reset-btn").addEventListener("click", () => { zoom=1; panX=0; panY=0; updateZoomDisplay(); redrawAll(remoteStrokes); });

// ─── UNDO / REDO ──────────────────────────────────────────────────
async function undo() {
  if (!undoStack.length) return;
  const key  = undoStack.pop();
  const snap = await get(ref(db, `boards/${boardCode}/strokes/${key}`));
  if (!snap.exists()) return;
  redoStack.push({ key, data: snap.val() });
  await update(ref(db, `boards/${boardCode}/strokes/${key}`), { hidden: true });
}
async function redo() {
  if (!redoStack.length) return;
  const { key } = redoStack.pop();
  undoStack.push(key);
  await update(ref(db, `boards/${boardCode}/strokes/${key}`), { hidden: false });
}
document.getElementById("undo-btn").addEventListener("click", undo);
document.getElementById("redo-btn").addEventListener("click", redo);
document.addEventListener("keydown", e => {
  if ((e.ctrlKey||e.metaKey) && e.key==="z" && !e.shiftKey) { e.preventDefault(); undo(); }
  if ((e.ctrlKey||e.metaKey) && (e.key==="y"||(e.key==="z"&&e.shiftKey))) { e.preventDefault(); redo(); }
});

// ─── REALTIME LISTEN ──────────────────────────────────────────────
function listenStrokes() {
  onValue(strokesRef(), snap => {
    remoteStrokes = snap.val() || {};
    redrawAll(remoteStrokes);
  });
}

// ─── USERS ────────────────────────────────────────────────────────
function userColor(uid) {
  const p = ["#e63946","#2a9d8f","#f4a261","#457b9d","#a8dadc","#e9c46a","#8338ec","#06d6a0"];
  let h = 0;
  for (const c of uid) h = (h*31 + c.charCodeAt(0)) & 0xffffffff;
  return p[Math.abs(h) % p.length];
}
function listenUsers() {
  onValue(ref(db, `boards/${boardCode}/users`), snap => {
    const data = snap.val() || {};
    renderUserDots(data); renderRemoteCursors(data);
  });
}
function renderUserDots(users) {
  const el = document.getElementById("users-online");
  el.innerHTML = "";
  for (const uid in users) {
    const u = users[uid], dot = document.createElement("div");
    dot.className = "user-dot";
    dot.style.background = userColor(uid);
    dot.textContent = (u.name||"?")[0].toUpperCase();
    dot.title = u.name || uid;
    el.appendChild(dot);
  }
}
function renderRemoteCursors(users) {
  const layer = document.getElementById("cursors-layer");
  layer.querySelectorAll("[data-uid]").forEach(el => { if (!users[el.dataset.uid]) el.remove(); });
  for (const uid in users) {
    if (uid === userId) continue;
    const u = users[uid], col = userColor(uid);
    let el = layer.querySelector(`[data-uid="${uid}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "remote-cursor"; el.dataset.uid = uid;
      el.innerHTML = `<svg viewBox="0 0 18 18" fill="${col}" xmlns="http://www.w3.org/2000/svg"><path d="M2 2l14 6-7 2-2 7z"/></svg><div class="remote-cursor-label" style="background:${col}">${u.name||uid}</div>`;
      layer.appendChild(el);
    }
    if (u.x !== undefined) { el.style.left=(u.x*zoom+panX)+"px"; el.style.top=(u.y*zoom+panY)+"px"; }
  }
}

// ─── JOIN ─────────────────────────────────────────────────────────
async function joinBoard(code) {
  boardCode = code;
  document.getElementById("board-code-display").textContent = code;
  await set(meRef(), { name: username, color: userColor(userId), x:0, y:0 });
  onDisconnect(meRef()).remove();
  const url = new URL(window.location.href);
  url.searchParams.set("board", code);
  window.history.replaceState({}, "", url);
  listenStrokes(); listenUsers();
  showScreen("canvas-screen");
  setTimeout(resizeCanvas, 50);
}

// ─── SAVE / CLEAR / EXPORT ────────────────────────────────────────
async function saveBoard() {
  const thumb = canvas.toDataURL("image/jpeg", 0.4);
  await set(ref(db, `saved/${userId}/${boardCode}`), { code: boardCode, savedAt: Date.now(), thumbnail: thumb });
  showToast("Board gespeichert");
}
async function clearBoard() {
  if (!confirm("Wirklich alle Striche löschen?")) return;
  await remove(strokesRef());
  remoteStrokes = {}; undoStack = []; redoStack = [];
  ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,canvas.width,canvas.height); ctx.restore();
  showToast("Board geleert");
}
function exportPNG() {
  const off = document.createElement("canvas");
  off.width = canvas.width; off.height = canvas.height;
  const oc = off.getContext("2d");
  // fill with current bg color
  const bgClass = wrapper.className;
  oc.fillStyle = bgClass.includes("bg-light") ? "#f5f5f0" : "#0f0f17";
  oc.fillRect(0, 0, off.width, off.height);
  oc.drawImage(canvas, 0, 0);
  const a = document.createElement("a");
  a.download = `skizze-${boardCode}-${Date.now()}.png`;
  a.href = off.toDataURL("image/png");
  a.click();
  showToast("PNG exportiert");
}
async function loadSavedBoards() {
  const snap = await get(ref(db, `saved/${userId}`));
  if (!snap.exists()) return;
  const data = snap.val();
  const section = document.getElementById("saved-boards-section");
  const list = document.getElementById("saved-boards-list");
  list.innerHTML = "";
  for (const key in data) {
    const b = data[key], card = document.createElement("div");
    card.className = "board-card";
    card.innerHTML = `<div class="board-code">${b.code}</div><div class="board-date">${new Date(b.savedAt).toLocaleDateString("de-DE")}</div>${b.thumbnail?`<img class="board-thumb" src="${b.thumbnail}" alt=""/>` : ""}`;
    card.addEventListener("click", () => { document.getElementById("board-code-input").value = b.code; });
    list.appendChild(card);
  }
  section.classList.remove("hidden");
}

// ─── BACKGROUND ───────────────────────────────────────────────────
function setBackground(bg) {
  wrapper.className = "";   // clear
  if (bg === "light") wrapper.classList.add("bg-light");
  if (bg === "grid")  wrapper.classList.add("bg-grid");
  if (bg === "dots")  wrapper.classList.add("bg-dots");
  // Update active state in dropdown
  document.querySelectorAll(".bg-item").forEach(i => i.classList.toggle("active", i.dataset.bg === bg));
}

// ─── DROPDOWN HELPERS ─────────────────────────────────────────────
function closeDropdowns() {
  document.querySelectorAll(".dropdown-wrap.open").forEach(d => d.classList.remove("open"));
}
function toggleDropdown(wrapId) {
  const wrap = document.getElementById(wrapId).closest(".dropdown-wrap");
  const isOpen = wrap.classList.contains("open");
  closeDropdowns();
  if (!isOpen) wrap.classList.add("open");
}
document.addEventListener("click", e => {
  if (!e.target.closest(".dropdown-wrap")) closeDropdowns();
});

// ─── TOOLBAR WIRING ───────────────────────────────────────────────
// Tool buttons (pen, eraser, text)
document.querySelectorAll(".tool-btn:not(#shape-trigger)").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tool === "shape") return; // handled separately
    commitText();
    document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    tool = btn.dataset.tool;
    canvas.style.cursor = tool === "eraser" ? "cell" : tool === "text" ? "text" : "crosshair";
  });
});

// Shape trigger
document.getElementById("shape-trigger").addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("shape-trigger");
});

// Shape items
document.querySelectorAll(".dropdown-item[data-shape]").forEach(item => {
  item.addEventListener("click", () => {
    activeShape = item.dataset.shape;
    tool = "shape";
    // Update trigger icon label
    document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
    document.getElementById("shape-trigger").classList.add("active");
    canvas.style.cursor = "crosshair";
    closeDropdowns();
  });
});

// Background trigger
document.getElementById("bg-trigger").addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("bg-trigger");
});
document.querySelectorAll(".bg-item").forEach(item => {
  item.addEventListener("click", () => { setBackground(item.dataset.bg); closeDropdowns(); });
});

// Size slider
document.getElementById("size-slider").addEventListener("input", e => {
  brushSize = +e.target.value;
  document.getElementById("size-display").textContent = brushSize + "px";
});

// Color swatches
document.querySelectorAll(".color-swatch").forEach(sw => {
  sw.addEventListener("click", () => {
    document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
    sw.classList.add("active");
    color = sw.dataset.color;
    document.getElementById("custom-color").value = color;
    if (tool !== "shape" && tool !== "text") {
      tool = "pen";
      document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
      document.querySelector('[data-tool="pen"]').classList.add("active");
      canvas.style.cursor = "crosshair";
    }
  });
});
document.getElementById("custom-color").addEventListener("input", e => {
  color = e.target.value;
  document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
});

// ─── HEADER ACTIONS ───────────────────────────────────────────────
document.getElementById("save-btn").addEventListener("click", saveBoard);
document.getElementById("clear-btn").addEventListener("click", clearBoard);
document.getElementById("export-btn").addEventListener("click", exportPNG);
document.getElementById("copy-link-btn").addEventListener("click", () => {
  const url = new URL(window.location.href);
  url.searchParams.set("board", boardCode);
  navigator.clipboard.writeText(url.toString())
    .then(() => showToast("Link kopiert"))
    .catch(() => showToast("Board-Code: " + boardCode));
});
document.getElementById("back-btn").addEventListener("click", async () => {
  commitText();
  await remove(meRef());
  boardCode = ""; undoStack = []; redoStack = [];
  showScreen("home-screen");
  loadSavedBoards();
});

// ─── HOME ─────────────────────────────────────────────────────────
document.getElementById("join-btn").addEventListener("click", () => {
  const name = document.getElementById("username-input").value.trim();
  if (!name) { showToast("Bitte gib einen Namen ein"); return; }
  username = name;
  const code = document.getElementById("board-code-input").value.trim() || Math.random().toString(36).slice(2,8);
  joinBoard(code);
});
["username-input","board-code-input"].forEach(id =>
  document.getElementById(id).addEventListener("keydown", e => { if (e.key==="Enter") document.getElementById("join-btn").click(); })
);

// ─── SCREEN ───────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ─── TOAST ────────────────────────────────────────────────────────
function showToast(msg, ms=2500) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.remove("hidden");
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.classList.remove("show"); setTimeout(()=>t.classList.add("hidden"),350); }, ms);
}

// ─── INIT ─────────────────────────────────────────────────────────
const urlBoard = new URLSearchParams(window.location.search).get("board");
if (urlBoard) document.getElementById("board-code-input").value = urlBoard;
loadSavedBoards();
resizeCanvas();
updateZoomDisplay();
