"use strict";

/* ============================================================
   Image Morphing — feature-point + Delaunay triangulation
   Pipeline: correspondence points -> Delaunay mesh on mean shape
             -> per-triangle affine warp -> cross-dissolve -> animate
   ============================================================ */

const state = {
  imgA: null,
  imgB: null,
  W: 0,
  H: 0,
  pointsA: [], // {x,y} in canvas space
  pointsB: [],
  pending: null, // { from: 'a'|'b', x, y }
  dragging: null, // { index, canvas: 'a'|'b' }
  triangles: [], // [i,j,k] indices, computed from mean points
  frames: [], // array of ImageData/canvas dataURL for playback
  playing: false,
  playTimer: null,
  currentFrame: 0,
};

const POINT_R = 6;

// ---------- DOM ----------
const el = (id) => document.getElementById(id);

const fileA = el("file-a"), fileB = el("file-b");
const previewA = el("preview-a"), previewB = el("preview-b");
const dropA = el("drop-a"), dropB = el("drop-b");

const panelEditor = el("panel-editor");
const panelSettings = el("panel-settings");
const panelPreview = el("panel-preview");

const canvasA = el("canvas-a"), ctxA = canvasA.getContext("2d");
const canvasB = el("canvas-b"), ctxB = canvasB.getContext("2d");

const btnUndo = el("btn-undo"), btnClear = el("btn-clear"), btnResetCorners = el("btn-reset-corners");
const pairCountEl = el("pair-count");

const optFrames = el("opt-frames"), optFramesVal = el("opt-frames-val");
const optFps = el("opt-fps"), optFpsVal = el("opt-fps-val");
const optEasing = el("opt-easing");
const optMesh = el("opt-mesh");
const btnGenerate = el("btn-generate");
const progressWrap = el("progress-wrap"), progressFill = el("progress-fill"), progressText = el("progress-text");

const canvasResult = el("canvas-result"), ctxResult = canvasResult.getContext("2d");
const btnPlay = el("btn-play");
const scrub = el("scrub");
const frameIndicator = el("frame-indicator");
const btnExportFrame = el("btn-export-frame");
const btnExportVideo = el("btn-export-video");
const exportStatus = el("export-status");

// ---------- Image loading ----------
function loadImageFile(file, onLoad) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => onLoad(img);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

fileA.addEventListener("change", () => {
  if (!fileA.files[0]) return;
  loadImageFile(fileA.files[0], (img) => {
    state.imgA = img;
    previewA.src = img.src;
    previewA.hidden = false;
    maybeInit();
  });
});

fileB.addEventListener("change", () => {
  if (!fileB.files[0]) return;
  loadImageFile(fileB.files[0], (img) => {
    state.imgB = img;
    previewB.src = img.src;
    previewB.hidden = false;
    maybeInit();
  });
});

[dropA, dropB].forEach((zone, i) => {
  const input = i === 0 ? fileA : fileB;
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.style.borderColor = "var(--accent)"; });
  zone.addEventListener("dragleave", () => { zone.style.borderColor = ""; });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.style.borderColor = "";
    if (e.dataTransfer.files[0]) {
      input.files = e.dataTransfer.files;
      input.dispatchEvent(new Event("change"));
    }
  });
});

function maybeInit() {
  if (!state.imgA || !state.imgB) return;

  // working resolution based on image A aspect ratio, capped for performance
  const MAX_DIM = 560;
  const ar = state.imgA.width / state.imgA.height;
  if (ar >= 1) {
    state.W = Math.min(MAX_DIM, state.imgA.width);
    state.H = Math.round(state.W / ar);
  } else {
    state.H = Math.min(MAX_DIM, state.imgA.height);
    state.W = Math.round(state.H * ar);
  }

  [canvasA, canvasB, canvasResult].forEach((c) => { c.width = state.W; c.height = state.H; });

  state.pointsA = [];
  state.pointsB = [];
  addCornerPoints();
  panelEditor.hidden = false;
  panelSettings.hidden = false;
  panelPreview.hidden = true;
  drawEditor();
  panelEditor.scrollIntoView({ behavior: "smooth", block: "start" });
}

// draw image into canvas using "cover" fit (fills entire canvas, crops overflow)
function drawCover(ctx, img, w, h) {
  const ar = img.width / img.height;
  const car = w / h;
  let sx, sy, sw, sh;
  if (ar > car) {
    sh = img.height;
    sw = sh * car;
    sy = 0;
    sx = (img.width - sw) / 2;
  } else {
    sw = img.width;
    sh = sw / car;
    sx = 0;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
}

function addCornerPoints() {
  const { W, H } = state;
  const pts = [
    [0, 0], [W / 2, 0], [W - 1, 0],
    [0, H / 2], [W - 1, H / 2],
    [0, H - 1], [W / 2, H - 1], [W - 1, H - 1],
  ];
  pts.forEach(([x, y]) => {
    state.pointsA.push({ x, y });
    state.pointsB.push({ x, y });
  });
  recomputeTriangulation();
}

// ---------- Point editor ----------
function canvasPos(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - rect.left;
  const cy = (evt.touches ? evt.touches[0].clientY : evt.clientY) - rect.top;
  return { x: cx * scaleX, y: cy * scaleY };
}

function findNearPoint(pts, x, y, radius = 10) {
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - x, dy = pts[i].y - y;
    if (Math.sqrt(dx * dx + dy * dy) <= radius) return i;
  }
  return -1;
}

function setupCanvasInteraction(canvas, which) {
  canvas.addEventListener("pointerdown", (e) => {
    if (!state.imgA || !state.imgB) return;
    e.preventDefault();
    const { x, y } = canvasPos(canvas, e);
    const pts = which === "a" ? state.pointsA : state.pointsB;
    const hitIdx = findNearPoint(pts, x, y);

    if (hitIdx >= 0) {
      state.dragging = { index: hitIdx, canvas: which };
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (state.pending && state.pending.from !== which) {
      // complete the pair
      if (state.pending.from === "a") {
        state.pointsA.push({ x: state.pending.x, y: state.pending.y });
        state.pointsB.push({ x, y });
      } else {
        state.pointsB.push({ x: state.pending.x, y: state.pending.y });
        state.pointsA.push({ x, y });
      }
      state.pending = null;
      recomputeTriangulation();
    } else {
      state.pending = { from: which, x, y };
    }
    drawEditor();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!state.dragging || state.dragging.canvas !== which) return;
    const { x, y } = canvasPos(canvas, e);
    const pts = which === "a" ? state.pointsA : state.pointsB;
    pts[state.dragging.index].x = Math.max(0, Math.min(state.W - 1, x));
    pts[state.dragging.index].y = Math.max(0, Math.min(state.H - 1, y));
    drawEditor();
  });

  const endDrag = () => {
    if (state.dragging) {
      state.dragging = null;
      recomputeTriangulation();
      drawEditor();
    }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const { x, y } = canvasPos(canvas, e);
    const pts = which === "a" ? state.pointsA : state.pointsB;
    const hitIdx = findNearPoint(pts, x, y);
    if (hitIdx >= 0) {
      state.pointsA.splice(hitIdx, 1);
      state.pointsB.splice(hitIdx, 1);
      recomputeTriangulation();
      drawEditor();
    }
  });
}
setupCanvasInteraction(canvasA, "a");
setupCanvasInteraction(canvasB, "b");

function drawEditor() {
  drawOneEditor(ctxA, state.imgA, state.pointsA, "a");
  drawOneEditor(ctxB, state.imgB, state.pointsB, "b");
  pairCountEl.textContent = state.pointsA.length;
}

function drawOneEditor(ctx, img, pts, which) {
  ctx.clearRect(0, 0, state.W, state.H);
  if (img) drawCover(ctx, img, state.W, state.H);

  if (optMesh && optMesh.checked && state.triangles.length) {
    ctx.strokeStyle = "rgba(124,92,255,0.55)";
    ctx.lineWidth = 1;
    state.triangles.forEach(([i, j, k]) => {
      ctx.beginPath();
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[j].x, pts[j].y);
      ctx.lineTo(pts[k].x, pts[k].y);
      ctx.closePath();
      ctx.stroke();
    });
  }

  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, POINT_R, 0, Math.PI * 2);
    ctx.fillStyle = i < 8 ? "rgba(79,209,255,0.85)" : "rgba(124,92,255,0.9)";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  if (state.pending && state.pending.from === which) {
    ctx.beginPath();
    ctx.arc(state.pending.x, state.pending.y, POINT_R, 0, Math.PI * 2);
    ctx.strokeStyle = "#ff5c7a";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

btnUndo.addEventListener("click", () => {
  if (state.pending) { state.pending = null; }
  else if (state.pointsA.length > 8) {
    state.pointsA.pop();
    state.pointsB.pop();
    recomputeTriangulation();
  }
  drawEditor();
});

btnClear.addEventListener("click", () => {
  state.pointsA = [];
  state.pointsB = [];
  state.pending = null;
  addCornerPoints();
  drawEditor();
});

btnResetCorners.addEventListener("click", () => {
  state.pointsA = state.pointsA.slice(8);
  state.pointsB = state.pointsB.slice(8);
  const { W, H } = state;
  const corners = [
    [0, 0], [W / 2, 0], [W - 1, 0],
    [0, H / 2], [W - 1, H / 2],
    [0, H - 1], [W / 2, H - 1], [W - 1, H - 1],
  ];
  const newA = corners.map(([x, y]) => ({ x, y }));
  const newB = corners.map(([x, y]) => ({ x, y }));
  state.pointsA = newA.concat(state.pointsA);
  state.pointsB = newB.concat(state.pointsB);
  recomputeTriangulation();
  drawEditor();
});

optMesh.addEventListener("change", drawEditor);

// ---------- Delaunay triangulation (Bowyer-Watson) ----------
// Computed on the mean of pointsA/pointsB so the same mesh topology
// is reused to warp both source images toward any intermediate shape.
function delaunayTriangulate(points) {
  const n = points.length;
  if (n < 3) return [];

  // super-triangle large enough to contain all points
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(...points.map((p) => p.y));
  const dx = maxX - minX || 1, dy = maxY - minY || 1;
  const dmax = Math.max(dx, dy) * 10;
  const midx = (minX + maxX) / 2, midy = (minY + maxY) / 2;

  const superPts = [
    { x: midx - dmax, y: midy - dmax },
    { x: midx, y: midy + dmax },
    { x: midx + dmax, y: midy - dmax },
  ];
  const pts = points.concat(superPts);
  const superIdx = [n, n + 1, n + 2];

  let triangles = [[superIdx[0], superIdx[1], superIdx[2]]];

  function circumcircle(a, b, c) {
    const ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-10) return null;
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    const r2 = (ax - ux) ** 2 + (ay - uy) ** 2;
    return { x: ux, y: uy, r2 };
  }

  for (let pi = 0; pi < n; pi++) {
    const p = pts[pi];
    const bad = [];
    for (const tri of triangles) {
      const [i, j, k] = tri;
      const cc = circumcircle(pts[i], pts[j], pts[k]);
      if (!cc) continue;
      const dx2 = p.x - cc.x, dy2 = p.y - cc.y;
      if (dx2 * dx2 + dy2 * dy2 <= cc.r2 + 1e-7) bad.push(tri);
    }

    // polygon boundary of the bad triangles
    const edgeCount = new Map();
    const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
    for (const [i, j, k] of bad) {
      [[i, j], [j, k], [k, i]].forEach(([u, v]) => {
        const key = edgeKey(u, v);
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      });
    }
    const boundary = [];
    for (const [i, j, k] of bad) {
      [[i, j], [j, k], [k, i]].forEach(([u, v]) => {
        if (edgeCount.get(edgeKey(u, v)) === 1) boundary.push([u, v]);
      });
    }

    triangles = triangles.filter((t) => !bad.includes(t));
    for (const [u, v] of boundary) {
      triangles.push([u, v, pi]);
    }
  }

  return triangles.filter((tri) => tri.every((idx) => idx < n));
}

function recomputeTriangulation() {
  const mean = state.pointsA.map((p, i) => ({
    x: (p.x + state.pointsB[i].x) / 2,
    y: (p.y + state.pointsB[i].y) / 2,
  }));
  state.triangles = delaunayTriangulate(mean);
}

// ---------- Warping / morphing ----------
function affineMatrix(src, dst) {
  const [[x0, y0], [x1, y1], [x2, y2]] = src;
  const [[X0, Y0], [X1, Y1], [X2, Y2]] = dst;
  const denom = x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1);
  if (Math.abs(denom) < 1e-8) return null;
  const a = (X0 * (y1 - y2) + X1 * (y2 - y0) + X2 * (y0 - y1)) / denom;
  const b = (Y0 * (y1 - y2) + Y1 * (y2 - y0) + Y2 * (y0 - y1)) / denom;
  const c = (X0 * (x2 - x1) + X1 * (x0 - x2) + X2 * (x1 - x0)) / denom;
  const d = (Y0 * (x2 - x1) + Y1 * (x0 - x2) + Y2 * (x1 - x0)) / denom;
  const e = (X0 * (x1 * y2 - x2 * y1) + X1 * (x2 * y0 - x0 * y2) + X2 * (x0 * y1 - x1 * y0)) / denom;
  const f = (Y0 * (x1 * y2 - x2 * y1) + Y1 * (x2 * y0 - x0 * y2) + Y2 * (x0 * y1 - x1 * y0)) / denom;
  return [a, b, c, d, e, f];
}

// nudge each vertex slightly away from the triangle centroid so neighboring
// triangles overlap by ~1px and hide the antialiased seam between clip paths
function inflateTriangle(pts) {
  const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3;
  const cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
  return pts.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const pad = 0.6;
    return [x + (dx / len) * pad, y + (dy / len) * pad];
  });
}

function warpImageToPoints(ctx, img, srcPts, dstPts, triangles) {
  ctx.save();
  ctx.clearRect(0, 0, state.W, state.H);
  for (const [i, j, k] of triangles) {
    const s = [[srcPts[i].x, srcPts[i].y], [srcPts[j].x, srcPts[j].y], [srcPts[k].x, srcPts[k].y]];
    const d = [[dstPts[i].x, dstPts[i].y], [dstPts[j].x, dstPts[j].y], [dstPts[k].x, dstPts[k].y]];
    const m = affineMatrix(s, d);
    if (!m) continue;
    const dInflated = inflateTriangle(d);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dInflated[0][0], dInflated[0][1]);
    ctx.lineTo(dInflated[1][0], dInflated[1][1]);
    ctx.lineTo(dInflated[2][0], dInflated[2][1]);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function easeInOut(t) {
  // smoothstep sigmoid-like easing
  return t * t * (3 - 2 * t);
}

function lerpPoints(a, b, t) {
  return a.map((p, i) => ({ x: p.x + (b[i].x - p.x) * t, y: p.y + (b[i].y - p.y) * t }));
}

const workA = document.createElement("canvas");
const workB = document.createElement("canvas");
const workCtxA = workA.getContext("2d");
const workCtxB = workB.getContext("2d");
const baseA = document.createElement("canvas"); // imgA drawn at working res (cover fit)
const baseB = document.createElement("canvas");

function renderFrame(t, targetCtx) {
  const et = optEasing.checked ? easeInOut(t) : t;
  const interp = lerpPoints(state.pointsA, state.pointsB, et);

  warpImageToPoints(workCtxA, baseA, state.pointsA, interp, state.triangles);
  warpImageToPoints(workCtxB, baseB, state.pointsB, interp, state.triangles);

  targetCtx.clearRect(0, 0, state.W, state.H);
  targetCtx.globalAlpha = 1;
  targetCtx.drawImage(workA, 0, 0);
  targetCtx.globalAlpha = et;
  targetCtx.drawImage(workB, 0, 0);
  targetCtx.globalAlpha = 1;
}

// ---------- Settings UI ----------
optFrames.addEventListener("input", () => { optFramesVal.textContent = optFrames.value; });
optFps.addEventListener("input", () => { optFpsVal.textContent = optFps.value; });

btnGenerate.addEventListener("click", async () => {
  if (state.pointsA.length < 3) {
    alert("최소 3쌍 이상의 대응점이 필요해요.");
    return;
  }
  stopPlayback();
  btnGenerate.disabled = true;
  progressWrap.hidden = false;

  [workA, workB, baseA, baseB].forEach((c) => { c.width = state.W; c.height = state.H; });
  baseA.getContext("2d").clearRect(0, 0, state.W, state.H);
  baseB.getContext("2d").clearRect(0, 0, state.W, state.H);
  drawCover(baseA.getContext("2d"), state.imgA, state.W, state.H);
  drawCover(baseB.getContext("2d"), state.imgB, state.W, state.H);

  const n = parseInt(optFrames.value, 10);
  state.frames = [];

  await new Promise((resolve) => {
    let f = 0;
    function step() {
      const t = n === 1 ? 0 : f / (n - 1);
      renderFrame(t, ctxResult);
      state.frames.push(canvasResult.toDataURL("image/png"));
      f++;
      progressFill.style.width = `${Math.round((f / n) * 100)}%`;
      progressText.textContent = `${Math.round((f / n) * 100)}%`;
      if (f < n) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(step);
  });

  btnGenerate.disabled = false;
  progressWrap.hidden = true;
  panelPreview.hidden = false;
  scrub.max = state.frames.length - 1;
  scrub.value = 0;
  state.currentFrame = 0;
  showFrame(0);
  panelPreview.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---------- Playback ----------
function showFrame(idx) {
  state.currentFrame = idx;
  const img = new Image();
  img.onload = () => {
    ctxResult.clearRect(0, 0, state.W, state.H);
    ctxResult.drawImage(img, 0, 0);
  };
  img.src = state.frames[idx];
  scrub.value = idx;
  frameIndicator.textContent = `${idx + 1} / ${state.frames.length}`;
}

scrub.addEventListener("input", () => {
  stopPlayback();
  showFrame(parseInt(scrub.value, 10));
});

function stopPlayback() {
  state.playing = false;
  if (state.playTimer) clearInterval(state.playTimer);
  state.playTimer = null;
  btnPlay.textContent = "▶ 재생";
}

function startPlayback() {
  if (!state.frames.length) return;
  state.playing = true;
  btnPlay.textContent = "⏸ 일시정지";
  const fps = parseInt(optFps.value, 10);
  state.playTimer = setInterval(() => {
    let next = state.currentFrame + 1;
    if (next >= state.frames.length) next = 0;
    showFrame(next);
  }, 1000 / fps);
}

btnPlay.addEventListener("click", () => {
  if (state.playing) stopPlayback();
  else startPlayback();
});

// ---------- Export ----------
btnExportFrame.addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = state.frames[state.currentFrame];
  a.download = `morph_frame_${state.currentFrame + 1}.png`;
  a.click();
});

btnExportVideo.addEventListener("click", async () => {
  if (!state.frames.length) return;
  if (!canvasResult.captureStream || !window.MediaRecorder) {
    exportStatus.textContent = "이 브라우저는 동영상 내보내기를 지원하지 않아요 (Chrome/Edge 권장).";
    return;
  }
  stopPlayback();
  btnExportVideo.disabled = true;
  exportStatus.textContent = "녹화 중...";

  const fps = parseInt(optFps.value, 10);
  const stream = canvasResult.captureStream(fps);
  const mimeCandidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  const done = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.start();

  // play through all frames once, twice for a smoother loop-in/out feel
  let idx = 0;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      showFrame(idx);
      idx++;
      if (idx >= state.frames.length) {
        clearInterval(timer);
        resolve();
      }
    }, 1000 / fps);
  });

  recorder.stop();
  await done;

  const blob = new Blob(chunks, { type: "video/webm" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "morph.webm";
  a.click();
  URL.revokeObjectURL(url);

  btnExportVideo.disabled = false;
  exportStatus.textContent = "완료! morph.webm 다운로드됨";
});
