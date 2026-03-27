// app.js – SkizzenGemeinsam (fixed)
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

const canvas = document.getElementById("main-canvas");
const ctx    = canvas.getContext("2d");

// ─── RESIZE CANVAS ────────────────────────────────────────────────
function resizeCanvas() {
  const wrapper = document.getElementById("canvas-wrapper");
  canvas.width  = wrapper.clientWidth;
  canvas.height = wrapper.clientHeight;
  redrawAll(remoteStrokes);
}

window.addEventListener("resize", resizeCanvas);

// ─── DRAW HELPERS ─────────────────────────────────────────────────
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
    if (!s || !s.points || s.points.length < 1) continue;
    const pts = s.points;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i - 1] && pts[i]) {
        drawSegment(pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y, s.color, s.size, s.tool);
      }
    }
  }
}

// ─── FIREBASE PATHS ───────────────────────────────────────────────
const meRef      = () => ref(db, `boards/${boardCode}/users/${userId}`);
const strokesRef = () => ref(db, `boards/${boardCode}/strokes`);

// ─── CURRENT STROKE ───────────────────────────────────────────────
let currentStrokeKey = null;
let currentStrokePts = [];

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  const src  = e.touches ? e.touches[0] : e;
  return {
    x: src.clientX - rect.left,
    y: src.clientY - rect.top
  };
}

function onDown(e) {
  e.preventDefault();
  isDrawing = true;
  const { x, y } = pointerPos(e);

  currentStrokePts = [{ x, y }];

  // Create stroke entry in Firebase
  const strokeRef  = push(strokesRef());
  currentStrokeKey = strokeRef.key;

  set(strokeRef, {
    color: tool === "eraser" ? "#000000" : color,
    size:  brushSize,
    tool,
    points: [{ x, y }]
  });

  // Draw start dot immediately
  ctx.save();
  ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

let lastCursorSync = 0;

function onMove(e) {
  e.preventDefault();
  const { x, y } = pointerPos(e);

  // Cursor sync throttled to ~16fps
  const now = Date.now();
  if (now - lastCursorSync > 60) {
    lastCursorSync = now;
    update(meRef(), { x, y });
  }

  if (!isDrawing || !currentStrokeKey) return;

  const last = currentStrokePts[currentStrokePts.length - 1];
  const dx = x - last.x, dy = y - last.y;
  if (dx * dx + dy * dy < 2) return;

  // Draw locally immediately
  drawSegment(last.x, last.y, x, y, tool === "eraser" ? "#000" : color, brushSize, tool);

  currentStrokePts.push({ x, y });
  const idx = currentStrokePts.length - 1;

  // Push only new point
  set(ref(db, `boards/${boardCode}/strokes/${currentStrokeKey}/points/${idx}`), { x, y });
}

function onUp(e) {
  if (!isDrawing) return;
  isDrawing = false;
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

// ─── REALTIME: listen all strokes ────────────────────────────────
function listenStrokes() {
  onValue(strokesRef(), snap => {
    const data = snap.val() || {};
    remoteStrokes = data;
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
    dot.className  = "user-dot";
    dot.style.background = userColor(uid);
    dot.textContent = (u.name || "?")[0].toUpperCase();
    dot.title = u.name || uid;
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
    if (u.x !== undefined) { el.style.left = u.x + "px"; el.style.top = u.y + "px"; }
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

// ─── SAVE / CLEAR ─────────────────────────────────────────────────
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
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  showToast("🗑 Board geleert");
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

// ─── SCREEN HELPER ────────────────────────────────────────────────
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
