// app.js – Hauptlogik für SkizzenGemeinsam
import {
  db, ref, set, push, onValue, onChildAdded, onChildRemoved,
  onDisconnect, serverTimestamp, remove, get, update
} from "./firebase.js";

// ─── STATE ────────────────────────────────────────────────────────
let username   = "";
let boardCode  = "";
let userId     = crypto.randomUUID().slice(0, 8);
let color      = "#1a1a2e";
let brushSize  = 4;
let tool       = "pen";
let isDrawing  = false;
let lastX = 0, lastY = 0;
let remoteStrokes = {};   // strokId → { points, color, size, tool }
let remoteUsers   = {};   // userId  → { name, color, x, y }

// Canvas
const canvas  = document.getElementById("main-canvas");
const ctx     = canvas.getContext("2d");

// ─── UTILITY ─────────────────────────────────────────────────────
function randomCode(len = 6) {
  return Math.random().toString(36).slice(2, 2 + len);
}

function userColor(uid) {
  const palette = ["#e63946","#2a9d8f","#f4a261","#457b9d","#a8dadc","#e9c46a","#8338ec","#06d6a0"];
  let hash = 0;
  for (const c of uid) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return palette[Math.abs(hash) % palette.length];
}

function showToast(msg, duration = 2500) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.classList.add("hidden"), 300);
  }, duration);
}

function resizeCanvas() {
  const w = canvas.parentElement.clientWidth;
  const h = canvas.parentElement.clientHeight;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  canvas.width  = w;
  canvas.height = h;
  ctx.putImageData(img, 0, 0);
}

// ─── CANVAS DRAW HELPERS ──────────────────────────────────────────
function drawSegment(x1, y1, x2, y2, col, size, drawTool) {
  ctx.save();
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

function redrawAll(strokes) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const sid in strokes) {
    const s = strokes[sid];
    if (!s || !s.points || s.points.length < 2) continue;
    for (let i = 1; i < s.points.length; i++) {
      const p = s.points[i - 1], q = s.points[i];
      drawSegment(p.x, p.y, q.x, q.y, s.color, s.size, s.tool);
    }
  }
}

// ─── FIREBASE PATHS ───────────────────────────────────────────────
const boardRef    = () => ref(db, `boards/${boardCode}`);
const strokesRef  = () => ref(db, `boards/${boardCode}/strokes`);
const usersRef    = () => ref(db, `boards/${boardCode}/users`);
const meRef       = () => ref(db, `boards/${boardCode}/users/${userId}`);
const savedRef    = () => ref(db, `saved/${userId}`);

// ─── REALTIME SYNC ────────────────────────────────────────────────
let localStrokeRef  = null;
let localStrokeData = null;   // { points:[], color, size, tool }

function startStroke(x, y) {
  localStrokeData = { color, size: brushSize, tool, points: [{ x, y }] };
  localStrokeRef = push(strokesRef());
  set(localStrokeRef, localStrokeData);
}

function continueStroke(x, y) {
  if (!localStrokeRef || !localStrokeData) return;
  const last = localStrokeData.points.at(-1);
  const dx = x - last.x, dy = y - last.y;
  if (dx * dx + dy * dy < 4) return;   // skip tiny moves

  // draw locally immediately
  drawSegment(last.x, last.y, x, y, color, brushSize, tool);

  localStrokeData.points.push({ x, y });
  // push only the new point to Firebase (delta update)
  const newPointRef = ref(db, `boards/${boardCode}/strokes/${localStrokeRef.key}/points/${localStrokeData.points.length - 1}`);
  set(newPointRef, { x, y });
}

function endStroke() {
  localStrokeRef  = null;
  localStrokeData = null;
}

// Listen for strokes from OTHERS (live & history)
function listenStrokes() {
  onValue(strokesRef(), snap => {
    const data = snap.val() || {};
    remoteStrokes = data;
    redrawAll(remoteStrokes);
  });
}

// ─── CURSOR SYNC ──────────────────────────────────────────────────
let cursorThrottle = 0;

function syncCursor(x, y) {
  const now = Date.now();
  if (now - cursorThrottle < 50) return;   // max 20/s
  cursorThrottle = now;
  update(meRef(), { x, y });
}

function listenUsers() {
  onValue(usersRef(), snap => {
    const data = snap.val() || {};
    remoteUsers = data;
    renderUserDots();
    renderRemoteCursors();
  });
}

function renderUserDots() {
  const container = document.getElementById("users-online");
  container.innerHTML = "";
  for (const uid in remoteUsers) {
    const u = remoteUsers[uid];
    const dot = document.createElement("div");
    dot.className = "user-dot";
    dot.style.background = userColor(uid);
    dot.textContent = (u.name || "?")[0].toUpperCase();
    dot.title = u.name || uid;
    container.appendChild(dot);
  }
}

function renderRemoteCursors() {
  const layer = document.getElementById("cursors-layer");
  // remove cursors for users no longer present
  for (const el of layer.querySelectorAll("[data-uid]")) {
    if (!remoteUsers[el.dataset.uid]) el.remove();
  }
  for (const uid in remoteUsers) {
    if (uid === userId) continue;
    const u = remoteUsers[uid];
    let el = layer.querySelector(`[data-uid="${uid}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "remote-cursor";
      el.dataset.uid = uid;
      const col = userColor(uid);
      el.innerHTML = `
        <svg viewBox="0 0 18 18" fill="${col}" xmlns="http://www.w3.org/2000/svg">
          <path d="M2 2l14 6-7 2-2 7z"/>
        </svg>
        <div class="remote-cursor-label" style="background:${col}">${u.name || uid}</div>`;
      layer.appendChild(el);
    }
    if (u.x !== undefined && u.y !== undefined) {
      el.style.left = u.x + "px";
      el.style.top  = u.y + "px";
    }
  }
}

// ─── JOIN BOARD ────────────────────────────────────────────────────
async function joinBoard(code) {
  boardCode = code;
  document.getElementById("board-code-display").textContent = code;

  // Register user presence
  const myColor = userColor(userId);
  const me = { name: username, color: myColor, x: 0, y: 0 };
  await set(meRef(), me);
  onDisconnect(meRef()).remove();

  // Update URL so sharing is easy
  const url = new URL(window.location.href);
  url.searchParams.set("board", code);
  window.history.replaceState({}, "", url);

  listenStrokes();
  listenUsers();

  showScreen("canvas-screen");
}

// ─── SAVE / LOAD ──────────────────────────────────────────────────
async function saveBoard() {
  const thumb = canvas.toDataURL("image/jpeg", 0.4);
  const saved = {
    code:      boardCode,
    savedAt:   Date.now(),
    thumbnail: thumb,
    name:      username
  };
  const key = boardCode;
  await set(ref(db, `saved/${userId}/${key}`), saved);
  showToast("✅ Board gespeichert!");
}

async function loadSavedBoards() {
  const snap = await get(ref(db, `saved/${userId}`));
  if (!snap.exists()) return;
  const data = snap.val();
  const section = document.getElementById("saved-boards-section");
  const list    = document.getElementById("saved-boards-list");
  list.innerHTML = "";
  let count = 0;
  for (const key in data) {
    const b = data[key];
    const card = document.createElement("div");
    card.className = "board-card";
    card.innerHTML = `
      <div class="board-code">${b.code}</div>
      <div class="board-date">${new Date(b.savedAt).toLocaleDateString("de-DE")}</div>
      ${b.thumbnail ? `<img class="board-thumb" src="${b.thumbnail}" alt="thumb"/>` : ""}
    `;
    card.addEventListener("click", () => {
      document.getElementById("board-code-input").value = b.code;
    });
    list.appendChild(card);
    count++;
  }
  if (count > 0) section.classList.remove("hidden");
}

// ─── CLEAR BOARD ──────────────────────────────────────────────────
async function clearBoard() {
  if (!confirm("Wirklich alle Striche löschen?")) return;
  await remove(strokesRef());
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  remoteStrokes = {};
  showToast("🗑 Board geleert");
}

// ─── SCREEN MANAGEMENT ────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  if (id === "canvas-screen") resizeCanvas();
}

// ─── CANVAS EVENTS ────────────────────────────────────────────────
function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  if (e.touches) {
    return {
      x: e.touches[0].clientX - rect.left,
      y: e.touches[0].clientY - rect.top
    };
  }
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener("pointerdown", e => {
  isDrawing = true;
  const { x, y } = getPos(e);
  lastX = x; lastY = y;
  startStroke(x, y);
});

canvas.addEventListener("pointermove", e => {
  const { x, y } = getPos(e);
  syncCursor(x, y);
  if (!isDrawing) return;
  continueStroke(x, y);
  lastX = x; lastY = y;
});

canvas.addEventListener("pointerup",     () => { isDrawing = false; endStroke(); });
canvas.addEventListener("pointercancel", () => { isDrawing = false; endStroke(); });
canvas.addEventListener("pointerleave",  () => { if (isDrawing) { isDrawing = false; endStroke(); } });

window.addEventListener("resize", () => {
  resizeCanvas();
  redrawAll(remoteStrokes);
});

// ─── TOOLBAR EVENTS ───────────────────────────────────────────────
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

document.querySelectorAll(".color-swatch").forEach(swatch => {
  swatch.addEventListener("click", () => {
    document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
    swatch.classList.add("active");
    color = swatch.dataset.color;
    document.getElementById("custom-color").value = color;
    tool = "pen";
    document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
    document.querySelector('[data-tool="pen"]').classList.add("active");
  });
});

document.getElementById("custom-color").addEventListener("input", e => {
  color = e.target.value;
  document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
});

// ─── HEADER BUTTONS ───────────────────────────────────────────────
document.getElementById("save-btn").addEventListener("click", saveBoard);
document.getElementById("clear-btn").addEventListener("click", clearBoard);

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
  showScreen("home-screen");
  loadSavedBoards();
});

// ─── HOME SCREEN EVENTS ───────────────────────────────────────────
document.getElementById("join-btn").addEventListener("click", () => {
  const name = document.getElementById("username-input").value.trim();
  if (!name) { showToast("⚠ Bitte gib einen Namen ein."); return; }
  username = name;
  const code = document.getElementById("board-code-input").value.trim() || randomCode();
  joinBoard(code);
});

// Allow Enter key in inputs
["username-input", "board-code-input"].forEach(id => {
  document.getElementById(id).addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("join-btn").click();
  });
});

// ─── INIT ─────────────────────────────────────────────────────────
(function init() {
  // Pre-fill board code from URL
  const params = new URLSearchParams(window.location.search);
  const urlBoard = params.get("board");
  if (urlBoard) {
    document.getElementById("board-code-input").value = urlBoard;
  }

  // Try load saved boards for this userId (stored in localStorage)
  const stored = localStorage.getItem("sg_userId");
  if (stored) {
    userId = stored;
  } else {
    localStorage.setItem("sg_userId", userId);
  }

  loadSavedBoards();
  resizeCanvas();
})();
