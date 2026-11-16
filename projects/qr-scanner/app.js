const $ = (id) => document.getElementById(id);

const videoEl = $("video");
const viewerEl = $("viewer");
const overlayEl = $("overlay");
const guideEl = $("guide");
const statusEl = $("status");
const hintEl = $("hint");
const continuousEl = $("continuous");
const resultEl = $("result");
const resultListEl = $("result-list");
const resumeEl = $("resume");
const previewEl = $("still-preview");
const historyEl = $("history");
const torchEl = $("torch");
const zoomWrapEl = $("zoom-wrap");
const zoomEl = $("zoom");
const cameraSelectEl = $("camera-select");

// 画面に出す枠の一辺（映像の短辺に対する割合）。枠の外側も少し含めて切り出す
const GUIDE_RATIO = 0.7;
const ROI_MARGIN = 1.3;

const FORMATS = ["QRCode", "MicroQRCode", "RMQRCode"];
const BASE_OPTIONS = { formats: FORMATS, tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true };

// カメラはフレームごとに読み方を切り替える。
// 枠内は縮小せずに切り出して小さいコードの画素を保ち、枠からはみ出す大きいコードは全体を縮小して拾う。
// 二値化の方式とノイズ除去は、照明のむらや印刷のかすれで得意不得意が分かれるので交互に使う
const CAMERA_PASSES = [
  { region: "roi", options: { binarizer: "LocalAverage" } },
  { region: "full", maxSide: 1280, options: { binarizer: "LocalAverage" } },
  { region: "roi", options: { binarizer: "GlobalHistogram" } },
  { region: "roi", options: { binarizer: "LocalAverage", tryDenoise: true } },
];

// 画像は見つかるまで順に試す。写真が大きすぎるとモジュールのにじみが広がるので、縮小した版も試す
const STILL_PASSES = [
  { maxSide: 2048, options: { binarizer: "LocalAverage" } },
  { maxSide: 2048, options: { binarizer: "GlobalHistogram" } },
  { maxSide: 2048, options: { binarizer: "LocalAverage", tryDenoise: true } },
  { maxSide: 1024, options: { binarizer: "LocalAverage" } },
  { maxSide: 640, options: { binarizer: "LocalAverage" } },
  { maxSide: 4096, options: { binarizer: "LocalAverage" } },
];

const FORMAT_LABEL = {
  QRCode: "QRコード",
  QRCodeModel2: "QRコード",
  QRCodeModel1: "QRコード（モデル1）",
  MicroQRCode: "マイクロQRコード",
  RMQRCode: "rMQRコード",
};
const LINK_PROTOCOLS = ["mailto:", "tel:", "sms:"];
const HISTORY_KEY = "qr-scanner:history";
const CAMERA_KEY = "qr-scanner:camera";
const HISTORY_LIMIT = 50;

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* 保存できない環境では覚えないだけ */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* 同上 */ }
  },
};

const state = {
  stream: null,
  track: null,
  token: 0,
  scanning: false,
  paused: false,
  torch: false,
  ignore: null,
  seen: new Set(),
  searchingSince: 0,
  lastMs: 0,
  resumeOnVisible: false,
  pausedOnHide: false,
};

// ---- 読み取りエンジン ----

class ZXingDecoder {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.ok = false;
    this.failed = false;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = (event) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(event.message || "worker error"));
    };
  }

  onMessage(message) {
    if (message.type === "ready") {
      this.ok = true;
      this.resolveReady();
      return;
    }
    if (message.type === "fatal") {
      this.fail(new Error(message.message));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message);
  }

  fail(error) {
    this.ok = false;
    this.failed = true;
    this.rejectReady(error);
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  decode(imageData, options) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(
        { id, width: imageData.width, height: imageData.height, data: imageData.data, options },
        [imageData.data.buffer],
      );
    });
  }
}

let zxing = null;
let detector = null;
let nativeFailures = 0;

function createCanvas() {
  const canvas = document.createElement("canvas");
  return { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }) };
}
const cameraWork = createCanvas();
const stillWork = createCanvas();

async function initEngines() {
  try {
    zxing = new ZXingDecoder();
    zxing.ready.then(updateEngineLabel, updateEngineLabel);
  } catch {
    zxing = null;
  }
  if ("BarcodeDetector" in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    } catch {
      detector = null;
    }
  }
  updateEngineLabel();
}

function updateEngineLabel() {
  const names = [];
  if (zxing?.ok) names.push("ZXing（WebAssembly）");
  if (detector) names.push("ブラウザ内蔵のバーコード検出");
  $("engine-label").textContent = names.length ? `読み取りには${names.join("と")}を使っています。` : "";
}

function noEngine() {
  return (!zxing || zxing.failed) && !detector;
}

function corners(position) {
  return [position.topLeft, position.topRight, position.bottomRight, position.bottomLeft];
}

function parseExtra(extra) {
  if (!extra) return {};
  try { return JSON.parse(extra); } catch { return {}; }
}

// source の rect の範囲を最大 maxSide に縮めて ZXing で読み、座標を source 側に戻して返す
async function zxingRegion(source, rect, maxSide, options, work) {
  if (!zxing?.ok) return [];
  const scale = maxSide ? Math.min(1, maxSide / Math.max(rect.w, rect.h)) : 1;
  const w = Math.max(1, Math.round(rect.w * scale));
  const h = Math.max(1, Math.round(rect.h * scale));
  if (work.canvas.width !== w) work.canvas.width = w;
  if (work.canvas.height !== h) work.canvas.height = h;
  work.ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  const imageData = work.ctx.getImageData(0, 0, w, h);
  let response;
  try {
    response = await zxing.decode(imageData, { ...BASE_OPTIONS, ...options });
  } catch {
    return [];
  }
  state.lastMs = response.ms;
  const sx = rect.w / w;
  const sy = rect.h / h;
  return response.results.map((r) => ({
    engine: "zxing",
    format: r.format,
    text: r.text,
    extra: parseExtra(r.extra),
    isMirrored: r.isMirrored,
    isInverted: r.isInverted,
    points: corners(r.position).map((p) => ({ x: rect.x + p.x * sx, y: rect.y + p.y * sy })),
  }));
}

async function nativeDetect(source) {
  if (!detector) return [];
  try {
    const found = await detector.detect(source);
    nativeFailures = 0;
    return found
      .filter((b) => b.rawValue)
      .map((b) => ({
        engine: "native",
        format: "QRCode",
        text: b.rawValue,
        extra: {},
        isMirrored: false,
        isInverted: false,
        points: b.cornerPoints?.length === 4 ? b.cornerPoints : rectPoints(b.boundingBox),
      }));
  } catch {
    // 端末によっては検出が毎回失敗するので、続くようなら使うのをやめる
    if (++nativeFailures >= 5) {
      detector = null;
      updateEngineLabel();
    }
    return [];
  }
}

function rectPoints(r) {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
}

function boundsOf(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function expandRect(r, ratio, maxW, maxH) {
  const side = Math.max(r.w, r.h) * (1 + ratio * 2);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return clampRect({ x: cx - side / 2, y: cy - side / 2, w: side, h: side }, maxW, maxH);
}

function clampRect(r, maxW, maxH) {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return { x, y, w: Math.max(1, Math.min(maxW, r.x + r.w) - x), h: Math.max(1, Math.min(maxH, r.y + r.h) - y) };
}

function sameSpot(a, b) {
  const box = boundsOf(b.points);
  const center = boundsOf(a.points);
  const cx = center.x + center.w / 2;
  const cy = center.y + center.h / 2;
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
}

// ブラウザ内蔵の検出は版の種類を区別しないので、同じコードかどうかは中身だけで見る
function keyOf(hit) {
  return hit.text;
}

function uniqueHits(hits) {
  const seen = new Set();
  return hits.filter((h) => {
    const key = keyOf(h);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ZXing の結果を優先し、ブラウザ内蔵の検出だけが拾ったコードを足す。
// 同じ位置のコードは ZXing 側を残す（Shift_JIS などの文字コードを判定でき、版や誤り訂正の情報も取れるため）
function mergeHits(zxingHits, nativeHits) {
  const merged = [...zxingHits];
  for (const n of nativeHits) {
    if (merged.some((z) => z.text === n.text || sameSpot(n, z))) continue;
    merged.push(n);
  }
  return uniqueHits(merged);
}

// ---- カメラ ----

function displayMapping() {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const ew = videoEl.clientWidth;
  const eh = videoEl.clientHeight;
  const scale = Math.max(ew / vw, eh / vh);
  return { vw, vh, ew, eh, scale, dx: (ew - vw * scale) / 2, dy: (eh - vh * scale) / 2 };
}

function layoutGuide() {
  const ew = viewerEl.clientWidth;
  const eh = viewerEl.clientHeight;
  const side = Math.min(ew, eh) * GUIDE_RATIO;
  Object.assign(guideEl.style, {
    width: `${side}px`,
    height: `${side}px`,
    left: `${(ew - side) / 2}px`,
    top: `${(eh - side) / 2}px`,
  });
  const dpr = window.devicePixelRatio || 1;
  overlayEl.width = Math.round(ew * dpr);
  overlayEl.height = Math.round(eh * dpr);
}

function roiRect() {
  const m = displayMapping();
  const side = (Math.min(m.ew, m.eh) * GUIDE_RATIO * ROI_MARGIN) / m.scale;
  const cx = (m.ew / 2 - m.dx) / m.scale;
  const cy = (m.eh / 2 - m.dy) / m.scale;
  return clampRect({ x: cx - side / 2, y: cy - side / 2, w: side, h: side }, m.vw, m.vh);
}

function drawOutlines(hits) {
  const ctx = overlayEl.getContext("2d");
  ctx.clearRect(0, 0, overlayEl.width, overlayEl.height);
  viewerEl.classList.toggle("hit", hits.length > 0);
  if (!hits.length || !videoEl.videoWidth) return;
  const m = displayMapping();
  const dpr = overlayEl.width / Math.max(1, m.ew);
  ctx.lineWidth = 4 * dpr;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#4cc797";
  ctx.fillStyle = "rgba(76, 199, 151, .22)";
  for (const hit of hits) {
    ctx.beginPath();
    hit.points.forEach((p, i) => {
      const x = (p.x * m.scale + m.dx) * dpr;
      const y = (p.y * m.scale + m.dy) * dpr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

function cameraErrorMessage(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "カメラの使用が許可されていません。ブラウザのサイト設定でカメラを許可してから、もう一度起動してください";
    case "NotFoundError":
    case "OverconstrainedError":
      return "使えるカメラが見つかりませんでした。画像から読むこともできます";
    case "NotReadableError":
    case "AbortError":
      return "カメラを開けませんでした。ほかのアプリがカメラを使っていないか確かめてください";
    default:
      return `カメラを起動できませんでした（${error?.name || error}）`;
  }
}

async function startCamera({ keepPaused = false } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus(window.isSecureContext ? "このブラウザはカメラに対応していません。画像から読むこともできます" : "カメラは https のページでしか使えません", true);
    return;
  }
  stopCamera();
  $("start-panel").hidden = true;
  setStatus("カメラを起動しています…");

  const savedId = storage.get(CAMERA_KEY);
  const video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  if (savedId) video.deviceId = { exact: savedId };
  else video.facingMode = { ideal: "environment" };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (error) {
    if (savedId && (error.name === "OverconstrainedError" || error.name === "NotFoundError")) {
      storage.remove(CAMERA_KEY);
      return startCamera({ keepPaused });
    }
    $("start-panel").hidden = false;
    setStatus(cameraErrorMessage(error), true);
    return;
  }

  const token = ++state.token;
  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  videoEl.srcObject = stream;
  try {
    await videoEl.play();
  } catch {
    // 自動再生が止められても、映像のフレームは届くので読み取りは続けられる
  }
  if (token !== state.token) return;

  const settings = state.track.getSettings?.() || {};
  viewerEl.classList.toggle("mirrored", settings.facingMode === "user");
  guideEl.hidden = false;
  layoutGuide();
  await setupTrackControls(state.track, settings);
  populateCameras(settings.deviceId);

  state.scanning = true;
  state.paused = keepPaused;
  if (keepPaused) videoEl.pause();
  state.searchingSince = performance.now();
  scanLoop(token);
}

function stopCamera() {
  state.scanning = false;
  state.token++;
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.track = null;
  state.torch = false;
  videoEl.srcObject = null;
  $("cam-controls").hidden = true;
  guideEl.hidden = true;
  hintEl.hidden = true;
  drawOutlines([]);
}

async function setupTrackControls(track, settings) {
  const caps = track.getCapabilities?.() || {};
  if (caps.focusMode?.includes("continuous")) {
    await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
  }
  torchEl.hidden = !caps.torch;
  torchEl.setAttribute("aria-pressed", "false");

  const zoom = caps.zoom;
  if (zoom && zoom.max > zoom.min) {
    zoomEl.min = zoom.min;
    zoomEl.max = zoom.max;
    zoomEl.step = zoom.step || 0.1;
    zoomEl.value = settings.zoom ?? zoom.min;
    zoomWrapEl.hidden = false;
  } else {
    zoomWrapEl.hidden = true;
  }
  $("cam-controls").hidden = false;
}

async function populateCameras(currentId) {
  let cameras = [];
  try {
    cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  } catch {
    cameras = [];
  }
  cameraSelectEl.replaceChildren(
    ...cameras.map((c, i) => {
      const option = document.createElement("option");
      option.value = c.deviceId;
      option.textContent = c.label || `カメラ ${i + 1}`;
      option.selected = c.deviceId === currentId;
      return option;
    }),
  );
  cameraSelectEl.hidden = cameras.length < 2;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function scanLoop(token) {
  const alive = () => state.scanning && token === state.token;
  let i = 0;
  while (alive()) {
    await nextFrame();
    if (!alive()) break;
    if (state.paused || videoEl.readyState < 2 || !videoEl.videoWidth) continue;

    const pass = CAMERA_PASSES[i++ % CAMERA_PASSES.length];
    const hits = await scanFrame(pass);
    if (!alive() || state.paused) continue;

    drawOutlines(hits);
    if (hits.length) handleCameraHits(hits);
    else updateSearchingStatus();
  }
}

async function scanFrame(pass) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const rect = pass.region === "roi" ? roiRect() : { x: 0, y: 0, w: vw, h: vh };
  const [zxingHits, nativeHits] = await Promise.all([
    zxingRegion(videoEl, rect, pass.maxSide, pass.options, cameraWork),
    nativeDetect(videoEl),
  ]);
  if (zxingHits.length || !nativeHits.length) return mergeHits(zxingHits, nativeHits);

  // ブラウザ内蔵の検出だけが拾えたときは、その位置を縮小せずに切り出して ZXing でも読み直す
  const refined = [];
  for (const n of nativeHits) {
    const around = expandRect(boundsOf(n.points), 0.25, vw, vh);
    const again = await zxingRegion(videoEl, around, null, { binarizer: "LocalAverage" }, cameraWork);
    refined.push(again.find((a) => a.text === n.text) || (again.length === 1 ? again[0] : n));
  }
  return uniqueHits(refined);
}

function handleCameraHits(hits) {
  const now = Date.now();
  const fresh = hits.filter((h) => !(state.ignore && now < state.ignore.until && state.ignore.keys.has(keyOf(h))));
  if (!fresh.length) return;

  if (continuousEl.checked) {
    const news = fresh.filter((h) => !state.seen.has(keyOf(h)));
    if (!news.length) return;
    news.forEach((h) => {
      state.seen.add(keyOf(h));
      addHistory(h);
    });
    vibrate();
    toast(`読み取りました：${news[0].text}`);
    showResults(news, { title: "最後に読み取ったコード" });
    state.searchingSince = performance.now();
    return;
  }

  state.paused = true;
  videoEl.pause();
  vibrate();
  fresh.forEach(addHistory);
  showResults(fresh, { resumable: true });
  setStatus(fresh.length > 1 ? `${fresh.length}個のコードを読み取りました` : "読み取りました");
  hintEl.hidden = true;
}

function resumeScanning() {
  state.ignore = { keys: new Set(currentHits.map(keyOf)), until: Date.now() + 1500 };
  resumeEl.hidden = true;
  previewEl.hidden = true;
  drawOutlines([]);
  if (!state.stream) {
    startCamera();
    return;
  }
  state.paused = false;
  state.searchingSince = performance.now();
  videoEl.play().catch(() => {});
  setStatus("読み取り中");
}

function updateSearchingStatus() {
  if (noEngine()) {
    setStatus("読み取りエンジンを読み込めませんでした。通信状況を確かめてページを再読み込みしてください", true);
    return;
  }
  if (!zxing?.ok && !detector) {
    setStatus("読み取りエンジンを準備しています…");
    return;
  }
  const parts = ["読み取り中"];
  if (state.lastMs) parts.push(`1回の解析 ${Math.round(state.lastMs)}ms`);
  setStatus(parts.join(" ・ "));
  hintEl.hidden = performance.now() - state.searchingSince < 8000;
}

function vibrate() {
  try { navigator.vibrate?.(60); } catch { /* 振動できない端末では何もしない */ }
}

torchEl.addEventListener("click", async () => {
  if (!state.track) return;
  const next = !state.torch;
  try {
    await state.track.applyConstraints({ advanced: [{ torch: next }] });
    state.torch = next;
    torchEl.setAttribute("aria-pressed", String(next));
  } catch {
    toast("ライトを切り替えられませんでした");
  }
});

zoomEl.addEventListener("input", () => {
  state.track?.applyConstraints({ advanced: [{ zoom: Number(zoomEl.value) }] }).catch(() => {});
});

cameraSelectEl.addEventListener("change", () => {
  storage.set(CAMERA_KEY, cameraSelectEl.value);
  startCamera({ keepPaused: state.paused });
});

$("start").addEventListener("click", () => startCamera());
resumeEl.addEventListener("click", resumeScanning);
continuousEl.addEventListener("change", () => {
  state.seen.clear();
  if (state.paused && state.stream && !resumeEl.hidden && continuousEl.checked) resumeScanning();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (state.stream) {
      state.resumeOnVisible = true;
      state.pausedOnHide = state.paused;
      stopCamera();
    }
  } else if (state.resumeOnVisible) {
    state.resumeOnVisible = false;
    startCamera({ keepPaused: state.pausedOnHide });
  }
});

new ResizeObserver(layoutGuide).observe(viewerEl);

// ---- 画像から読む ----

async function loadBitmap(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    return await createImageBitmap(blob);
  }
}

async function scanStill(blob) {
  if (!blob) return;
  const cameraWasLive = state.scanning && !state.paused;
  state.paused = true;
  setStatus("画像を解析しています…");
  hintEl.hidden = true;

  let bitmap;
  try {
    bitmap = await loadBitmap(blob);
  } catch {
    setStatus("画像を開けませんでした。別の形式（JPEG や PNG）で試してください", true);
    if (cameraWasLive) state.paused = false;
    return;
  }

  if (zxing && !zxing.ok) await zxing.ready.catch(() => {});
  const nativePromise = nativeDetect(bitmap);
  const full = { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  const tried = new Set();
  let zxingHits = [];
  for (const pass of STILL_PASSES) {
    const scale = Math.min(1, pass.maxSide / Math.max(bitmap.width, bitmap.height));
    const key = `${Math.round(bitmap.width * scale)}:${JSON.stringify(pass.options)}`;
    if (tried.has(key)) continue;
    tried.add(key);
    zxingHits = await zxingRegion(bitmap, full, pass.maxSide, pass.options, stillWork);
    if (zxingHits.length) break;
  }
  const hits = mergeHits(zxingHits, await nativePromise);

  drawStillPreview(bitmap, hits);
  bitmap.close?.();

  if (!hits.length) {
    showResults([], { title: "画像の読み取り結果", resumable: cameraWasLive, preview: true });
    setStatus("コードが見つかりませんでした。コード全体が写っていて、ピントの合った画像で試してください", true);
    return;
  }
  if (cameraWasLive) videoEl.pause();
  hits.forEach(addHistory);
  vibrate();
  showResults(hits, { title: "画像の読み取り結果", resumable: Boolean(state.stream), preview: true });
  setStatus(hits.length > 1 ? `画像から${hits.length}個のコードを読み取りました` : "画像から読み取りました");
}

function drawStillPreview(bitmap, hits) {
  const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
  previewEl.width = Math.round(bitmap.width * scale);
  previewEl.height = Math.round(bitmap.height * scale);
  const ctx = previewEl.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, previewEl.width, previewEl.height);
  ctx.lineWidth = Math.max(3, previewEl.width / 200);
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#4cc797";
  ctx.fillStyle = "rgba(76, 199, 151, .25)";
  for (const hit of hits) {
    ctx.beginPath();
    hit.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * scale, p.y * scale) : ctx.lineTo(p.x * scale, p.y * scale)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  previewEl.hidden = false;
}

$("file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  scanStill(file);
});

document.addEventListener("paste", (event) => {
  const item = [...(event.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (!item) return;
  event.preventDefault();
  scanStill(item.getAsFile());
});

let dragDepth = 0;
document.addEventListener("dragenter", (event) => {
  if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
  dragDepth++;
  $("drop-mask").hidden = false;
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("drop-mask").hidden = true;
});
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  $("drop-mask").hidden = true;
  const file = [...(event.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) scanStill(file);
});

// ---- 結果の表示 ----

let currentHits = [];

function parseWifi(text) {
  const fields = {};
  let key = "";
  let value = "";
  let inKey = true;
  let escaped = false;
  for (const ch of text.slice(5)) {
    if (escaped) {
      if (inKey) key += ch;
      else value += ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (inKey && ch === ":") {
      inKey = false;
    } else if (ch === ";") {
      if (key) fields[key.toUpperCase()] = value;
      key = "";
      value = "";
      inKey = true;
    } else if (inKey) {
      key += ch;
    } else {
      value += ch;
    }
  }
  if (key && !inKey) fields[key.toUpperCase()] = value;
  if (!("S" in fields)) return null;
  return { ssid: fields.S, password: fields.P ?? "", security: fields.T || "", hidden: fields.H === "true" };
}

function classify(text) {
  const trimmed = text.trim();
  if (/^WIFI:/i.test(trimmed)) {
    const wifi = parseWifi(trimmed);
    if (wifi) return { kind: "wifi", wifi };
  }
  let url = null;
  try { url = new URL(trimmed); } catch { url = null; }
  if (url && (url.protocol === "http:" || url.protocol === "https:") && !/\s/.test(trimmed)) return { kind: "url", url };
  if (url && LINK_PROTOCOLS.includes(url.protocol)) return { kind: "link", url };
  return { kind: "text" };
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function copyButton(value, label = "コピー") {
  const button = el("button", { type: "button", className: "button small", textContent: label });
  button.addEventListener("click", async () => {
    const ok = await copyText(value);
    button.textContent = ok ? "コピーしました" : "コピーできませんでした";
    setTimeout(() => { button.textContent = label; }, 1500);
  });
  return button;
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const area = el("textarea", { value });
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

function metaLine(hit) {
  const items = [FORMAT_LABEL[hit.format] || hit.format];
  const extra = hit.extra || {};
  if (extra.Version) items.push(`バージョン ${extra.Version}`);
  if (extra.ECLevel) items.push(`誤り訂正レベル ${extra.ECLevel}`);
  const uec = Number.parseFloat(extra.UEC);
  if (Number.isFinite(uec)) items.push(`誤り訂正の余力 ${Math.round(uec * 100)}%`);
  if (hit.isInverted) items.push("白黒反転");
  if (hit.isMirrored) items.push("鏡像");
  if (hit.engine === "native") items.push("ブラウザ内蔵の検出で読み取り");
  const line = el("div", { className: "meta" }, items.map((t) => el("span", { textContent: t })));
  if (Number.isFinite(uec)) line.title = "誤り訂正の余力：汚れや欠けを補える量のうち、今回の読み取りで使わずに残った割合";
  return line;
}

function resultCard(hit) {
  const card = el("article", { className: "card" }, [metaLine(hit)]);
  const info = classify(hit.text);
  const actions = el("div", { className: "actions" });

  if (info.kind === "url" || info.kind === "link") {
    const target = info.kind === "url" ? info.url.host : info.url.href.replace(/^[a-z]+:/i, "");
    card.append(el("p", { className: "dest" }, [`${info.kind === "url" ? "開く先：" : "宛先："}`, el("strong", { textContent: target })]));
    actions.append(el("a", {
      className: "button primary small",
      href: info.url.href,
      target: "_blank",
      rel: "noopener noreferrer",
      textContent: "開く",
    }));
  }

  if (info.kind === "wifi") {
    const { ssid, password, security, hidden } = info.wifi;
    const rows = [["ネットワーク名", ssid], ["パスワード", password || "（なし）"], ["暗号化", security || "（指定なし）"]];
    if (hidden) rows.push(["ステルス", "あり"]);
    const fields = el("dl", { className: "fields" });
    for (const [label, value] of rows) {
      const canCopy = (label === "ネットワーク名" && value) || (label === "パスワード" && password);
      fields.append(el("dt", { textContent: label }), el("dd", { textContent: value }), canCopy ? copyButton(label === "パスワード" ? password : ssid) : el("span"));
    }
    card.append(fields);
  }

  card.append(el("pre", { className: "text", textContent: hit.text }));
  actions.append(copyButton(hit.text));
  card.append(actions);
  return card;
}

function showResults(hits, { title = "読み取り結果", resumable = false, preview = false } = {}) {
  currentHits = hits;
  $("result-title").textContent = title;
  resultListEl.replaceChildren(...hits.map(resultCard));
  if (!hits.length) {
    resultListEl.append(el("p", { className: "sub", textContent: "コードは見つかりませんでした" }));
  }
  previewEl.hidden = !preview;
  resumeEl.hidden = !resumable;
  resultEl.hidden = false;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

let toastTimer = 0;
function toast(text) {
  const node = $("toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2200);
}

// ---- 履歴 ----

function loadHistory() {
  try {
    const list = JSON.parse(storage.get(HISTORY_KEY) || "[]");
    return Array.isArray(list) ? list.filter((h) => typeof h?.text === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  storage.set(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
}

let historyItems = loadHistory();

function addHistory(hit) {
  const entry = { text: hit.text, format: hit.format, at: Date.now() };
  historyItems = [entry, ...historyItems.filter((h) => h.text !== hit.text)].slice(0, HISTORY_LIMIT);
  saveHistory(historyItems);
  renderHistory();
}

function formatWhen(at) {
  const d = new Date(at);
  const now = new Date();
  const time = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })} ${time}`;
}

function renderHistory() {
  historyEl.replaceChildren(
    ...historyItems.map((entry) => {
      const open = el("button", { type: "button", className: "open" }, [
        el("span", { className: "when", textContent: `${formatWhen(entry.at)}　${FORMAT_LABEL[entry.format] || entry.format}` }),
        el("span", { className: "what", textContent: entry.text }),
      ]);
      open.addEventListener("click", () => {
        showResults([{ ...entry, extra: {}, points: [] }], { title: "履歴から表示", resumable: state.paused && Boolean(state.stream) });
        resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      const remove = el("button", { type: "button", className: "button small", textContent: "削除" });
      remove.addEventListener("click", () => {
        historyItems = historyItems.filter((h) => h !== entry);
        saveHistory(historyItems);
        renderHistory();
      });
      return el("li", {}, [open, copyButton(entry.text), remove]);
    }),
  );
  $("history-empty").hidden = historyItems.length > 0;
  $("clear-history").hidden = historyItems.length === 0;
}

$("clear-history").addEventListener("click", () => {
  if (!confirm("履歴をすべて消しますか？")) return;
  historyItems = [];
  saveHistory(historyItems);
  renderHistory();
});

// ---- 起動 ----

async function autoStartIfAllowed() {
  try {
    const permission = await navigator.permissions.query({ name: "camera" });
    if (permission.state === "granted") {
      startCamera();
      return;
    }
  } catch {
    // camera の権限を問い合わせられないブラウザでは、ボタンを押してもらってから起動する
  }
  setStatus("「カメラを起動」を押すか、画像を選んでください");
}

renderHistory();
initEngines();
autoStartIfAllowed();
