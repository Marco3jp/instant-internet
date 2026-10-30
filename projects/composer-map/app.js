const ERAS = window.ERAS;
const REGIONS = window.REGIONS;
const COMPOSERS = window.COMPOSERS.slice().sort((a, b) => a.b - b.b);
const byId = new Map(COMPOSERS.map(c => [c.id, c]));

const YEAR_MIN = 1440;
const YEAR_MAX = 2000;

const state = {
  year: 1830,
  win: "0", // "0" | "10" | "25" | "all"
  eras: new Set(Object.keys(ERAS)),
  selected: null,
  playing: null,
};

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const enc = encodeURIComponent;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ───────── 居所の計算 ─────────

// その年にいた拠点。拠点データの開始年より前なら null
function placeAt(c, year) {
  let found = null;
  for (const p of c.pl) {
    if (p[3] <= year) found = p;
    else break;
  }
  return found;
}

// 最も長く過ごした拠点（同じ都市への複数回の滞在は合算）
function mainPlace(c) {
  const total = new Map();
  c.pl.forEach((p, i) => {
    const end = i + 1 < c.pl.length ? c.pl[i + 1][3] : c.d;
    const key = p[0].replace(/（.*）/, "");
    total.set(key, (total.get(key) || 0) + Math.max(end - p[3], 0));
  });
  let best = c.pl[0];
  let bestLen = -1;
  for (const p of c.pl) {
    const len = total.get(p[0].replace(/（.*）/, ""));
    if (len > bestLen) { best = p; bestLen = len; }
  }
  return best;
}

function windowYears() {
  return state.win === "all" ? Infinity : Number(state.win);
}

function isVisible(c) {
  if (!state.eras.has(c.era)) return false;
  if (state.win === "all") return true;
  const w = windowYears();
  return c.b <= state.year + w && c.d >= state.year - w;
}

function placeFor(c) {
  if (state.win === "all") return mainPlace(c);
  const w = windowYears();
  const y = clamp(state.year, c.b, c.d);
  const p = placeAt(c, y);
  if (p) return p;
  // 幼少期など拠点データがない期間は、窓の範囲内に最初の拠点があればそこに置く
  return c.pl[0][3] <= state.year + w ? c.pl[0] : null;
}

function isAlive(c, y = state.year) {
  return c.b <= y && y <= c.d;
}

function ageText(c) {
  const y = state.year;
  if (y < c.b) return `${c.b - y}年後に誕生`;
  if (y > c.d) return `没後${y - c.d}年`;
  return `${y - c.b}歳`;
}

// 同じ都市に重なるピンを高ズーム時に見分けられるよう、IDから決まる小さなずれを足す
function jitter(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const angle = (Math.abs(h) % 360) * Math.PI / 180;
  const r = 0.006 + (Math.abs(h >> 8) % 10) * 0.0012;
  return [Math.sin(angle) * r, Math.cos(angle) * r];
}

// ───────── 地図 ─────────

const map = L.map("map", { zoomControl: true, worldCopyJump: true, minZoom: 2 }).fitBounds(REGIONS[1].bounds);

// OpenStreetMap 公式タイル（APIキー不要）。ダークモードは CSS のフィルターで暗くする
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

const cluster = L.markerClusterGroup({
  maxClusterRadius: 38,
  showCoverageOnHover: false,
  spiderfyDistanceMultiplier: 1.6,
  iconCreateFunction(cl) {
    const children = cl.getAllChildMarkers();
    const counts = {};
    for (const m of children) counts[m.options.era] = (counts[m.options.era] || 0) + 1;
    let acc = 0;
    const stops = [];
    for (const key of Object.keys(ERAS)) {
      if (!counts[key]) continue;
      const from = acc / children.length * 360;
      acc += counts[key];
      const to = acc / children.length * 360;
      stops.push(`${ERAS[key].color} ${from}deg ${to}deg`);
    }
    return L.divIcon({
      html: `<div class="cm-cluster" style="background:conic-gradient(${stops.join(",")})"><span>${children.length}</span></div>`,
      className: "",
      iconSize: [36, 36],
    });
  },
});
map.addLayer(cluster);

const pathLayer = L.layerGroup().addTo(map);
const markers = new Map(); // id -> marker

function pinIcon(c) {
  const sel = state.selected === c.id ? " sel" : "";
  return L.divIcon({
    html: `<div class="cm-pin${sel}" style="--c:${ERAS[c.era].color}"><span class="dot"></span><span class="lbl">${esc(c.s)}</span></div>`,
    className: "",
    iconSize: null,
  });
}

function latLngFor(c, place) {
  const [dy, dx] = jitter(c.id);
  return L.latLng(place[1] + dy, place[2] + dx);
}

function updateMarkers(visibleList) {
  const seen = new Set();
  const toAdd = [];
  for (const { c, place } of visibleList) {
    seen.add(c.id);
    const ll = latLngFor(c, place);
    let m = markers.get(c.id);
    if (!m) {
      m = L.marker(ll, { icon: pinIcon(c), era: c.era, riseOnHover: true });
      m.bindTooltip(() => `<b>${esc(c.s)}</b>（${c.b}–${c.d}）<br>${esc(m.options.city)}`, { direction: "top", offset: [0, -8] });
      m.on("click", () => select(c.id, { fly: false, tab: true }));
      markers.set(c.id, m);
      m.options.city = place[0];
      toAdd.push(m);
    } else {
      m.options.city = place[0];
      if (!m.getLatLng().equals(ll)) {
        if (cluster.hasLayer(m)) cluster.removeLayer(m);
        m.setLatLng(ll);
      }
      if (!cluster.hasLayer(m)) toAdd.push(m);
    }
  }
  const toRemove = [];
  for (const [id, m] of markers) {
    if (!seen.has(id) && cluster.hasLayer(m)) toRemove.push(m);
  }
  if (toRemove.length) cluster.removeLayers(toRemove);
  if (toAdd.length) cluster.addLayers(toAdd);
}

function refreshPinIcons() {
  for (const [id, m] of markers) m.setIcon(pinIcon(byId.get(id)));
}

function drawPath() {
  pathLayer.clearLayers();
  const c = byId.get(state.selected);
  if (!c) return;
  const color = ERAS[c.era].color;
  const current = placeAt(c, clamp(state.year, c.b, c.d));
  // 同じ都市が連続していない限り、拠点を順に結ぶ
  const pts = c.pl.map(p => [p[1], p[2]]);
  if (pts.length > 1) {
    L.polyline(pts, { color, weight: 2.5, opacity: .8, dashArray: "6 6" }).addTo(pathLayer);
  }
  const labelled = new Map();
  for (const p of c.pl) {
    const key = `${p[1]},${p[2]}`;
    if (!labelled.has(key)) labelled.set(key, { p, years: [] });
    labelled.get(key).years.push(p[3]);
  }
  for (const { p, years } of labelled.values()) {
    const isNow = current && current[1] === p[1] && current[2] === p[2];
    L.circleMarker([p[1], p[2]], {
      radius: isNow ? 7 : 5, color, weight: 2, fillColor: isNow ? color : "#fff", fillOpacity: 1,
    })
      .bindTooltip(`${years.join(", ")}〜 ${esc(p[0])}`, { permanent: true, direction: "right", className: "path-label", offset: [6, 0] })
      .addTo(pathLayer);
  }
}

map.on("zoomend", () => {
  map.getContainer().classList.toggle("show-labels", map.getZoom() >= 6);
});

// ───────── 地域ズーム ─────────

function buildRegions() {
  const wrap = $("regions");
  for (const r of REGIONS) {
    const b = document.createElement("button");
    b.textContent = r.name;
    b.addEventListener("click", () => {
      map.flyToBounds(r.bounds, { duration: 0.8 });
      wrap.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
    });
    wrap.appendChild(b);
  }
  const fit = document.createElement("button");
  fit.textContent = "表示中に合わせる";
  fit.title = "いま地図に出ている作曲家がすべて入るようにズーム";
  fit.addEventListener("click", () => {
    const pts = currentVisible().map(v => [v.place[1], v.place[2]]);
    if (pts.length) map.flyToBounds(L.latLngBounds(pts).pad(0.15), { duration: 0.8, maxZoom: 9 });
    wrap.querySelectorAll("button").forEach(x => x.classList.remove("active"));
  });
  wrap.appendChild(fit);
}

// ───────── 時代フィルター ─────────

function buildEraChips() {
  const wrap = $("eras");
  for (const [key, e] of Object.entries(ERAS)) {
    const b = document.createElement("button");
    b.className = "era-chip";
    b.style.setProperty("--c", e.color);
    b.innerHTML = `<i></i>${esc(e.name)}`;
    b.title = `${e.name}（おおよそ${e.from}–${e.to}年）の表示を切り替え`;
    b.addEventListener("click", () => {
      if (state.eras.has(key)) state.eras.delete(key);
      else state.eras.add(key);
      b.classList.toggle("off", !state.eras.has(key));
      render();
    });
    wrap.appendChild(b);
  }
}

// ───────── タイムライン ─────────

function aliveCount(y) {
  let n = 0;
  for (const c of COMPOSERS) if (c.b <= y && y <= c.d) n++;
  return n;
}

function drawTimeline() {
  const svg = $("tl-svg");
  const W = svg.clientWidth;
  const H = svg.clientHeight;
  if (!W) return;
  const x = y => 1.5 + (y - YEAR_MIN) / (YEAR_MAX - YEAR_MIN) * (W - 3);
  const baseY = H - 8;
  const maxH = H - 22;
  const counts = [];
  let maxCount = 1;
  for (let y = YEAR_MIN; y <= YEAR_MAX; y++) {
    const n = aliveCount(y);
    counts.push(n);
    if (n > maxCount) maxCount = n;
  }
  let d = `M${x(YEAR_MIN)},${baseY}`;
  counts.forEach((n, i) => { d += ` L${x(YEAR_MIN + i).toFixed(1)},${(baseY - n / maxCount * maxH).toFixed(1)}`; });
  d += ` L${x(YEAR_MAX)},${baseY} Z`;

  const muted = getComputedStyle(document.body).getPropertyValue("--muted");
  const accent = getComputedStyle(document.body).getPropertyValue("--accent");
  let out = "";
  const sel = byId.get(state.selected);
  if (sel) {
    out += `<rect x="${x(sel.b)}" y="0" width="${x(sel.d) - x(sel.b)}" height="${H}" fill="${accent}" opacity=".12"/>`;
  }
  out += `<path d="${d}" fill="${muted}" opacity=".28"/>`;
  for (const e of Object.values(ERAS)) {
    out += `<rect x="${x(Math.max(e.from, YEAR_MIN))}" y="${baseY + 2}" width="${x(e.to) - x(Math.max(e.from, YEAR_MIN))}" height="5" fill="${e.color}" opacity=".85"><title>${e.name}</title></rect>`;
  }
  const step = W < 500 ? 100 : 50;
  for (let y = Math.ceil(YEAR_MIN / step) * step; y <= YEAR_MAX; y += step) {
    const anchor = x(y) < 16 ? "start" : x(y) > W - 16 ? "end" : "middle";
    out += `<line x1="${x(y)}" x2="${x(y)}" y1="12" y2="${baseY}" stroke="${muted}" stroke-opacity=".25"/>`;
    out += `<text x="${x(y)}" y="10" font-size="10" fill="${muted}" text-anchor="${anchor}">${y}</text>`;
  }
  svg.innerHTML = out;
}

function setYear(y, { push = true } = {}) {
  state.year = clamp(Math.round(y), YEAR_MIN, YEAR_MAX);
  $("year").value = state.year;
  render();
  if (push) saveHash();
}

function togglePlay() {
  if (state.playing) {
    clearInterval(state.playing);
    state.playing = null;
    $("play").textContent = "▶";
    saveHash();
    return;
  }
  if (state.year >= YEAR_MAX) state.year = YEAR_MIN;
  $("play").textContent = "❚❚";
  const tick = () => {
    if (state.year >= YEAR_MAX) { togglePlay(); return; }
    setYear(state.year + 1, { push: false });
  };
  state.playing = setInterval(tick, Number($("speed").value));
}

// ───────── 一覧 ─────────

function currentVisible() {
  const list = [];
  for (const c of COMPOSERS) {
    if (!isVisible(c)) continue;
    const place = placeFor(c);
    if (place) list.push({ c, place });
  }
  return list;
}

function renderList(visibleList) {
  const pane = $("pane-list");
  if (!visibleList.length) {
    pane.innerHTML = `<div class="empty">${state.year}年に存命の作曲家はこのデータにはいないみたい。<br>表示の幅を広げるか、年を動かしてみて。</div>`;
    return;
  }
  const head = state.win === "all"
    ? `全${visibleList.length}人（主な拠点に表示）`
    : `${state.year}年${state.win === "0" ? "" : `±${state.win}年`}：${visibleList.length}人`;
  pane.innerHTML = `<div class="list-head">${head}</div>` + visibleList.map(({ c, place }) => `
    <div class="list-item${state.selected === c.id ? " sel" : ""}" data-id="${c.id}" style="--c:${ERAS[c.era].color}">
      <i></i>
      <div><div class="nm">${esc(c.s)}</div><div class="meta">${esc(place[0])} · ${c.b}–${c.d}</div></div>
      <div class="age">${state.win === "all" ? ERAS[c.era].name : ageText(c)}</div>
    </div>`).join("");
}

$("pane-list").addEventListener("click", e => {
  const item = e.target.closest(".list-item");
  if (item) select(item.dataset.id, { fly: true, tab: true });
});

// ───────── 詳細 ─────────

const searchLinks = q => `
  <a href="https://www.youtube.com/results?search_query=${enc(q)}" target="_blank" rel="noopener">YouTube</a>
  <a href="https://open.spotify.com/search/${enc(q)}" target="_blank" rel="noopener">Spotify</a>
  <a href="https://music.apple.com/jp/search?term=${enc(q)}" target="_blank" rel="noopener">Apple Music</a>`;

function renderDetail() {
  const pane = $("pane-detail");
  const c = byId.get(state.selected);
  if (!c) return;
  const era = ERAS[c.era];
  const current = placeAt(c, clamp(state.year, c.b, c.d));
  const lifespan = c.d - c.b;
  const places = c.pl.map((p, i) => {
    const next = c.pl[i + 1];
    const until = next ? next[3] : c.d;
    const isNow = isAlive(c) && current === p;
    return `<li class="${isNow ? "now" : ""}" data-year="${p[3]}" style="--c:${era.color}"><span class="yr">${p[3]}</span>${esc(p[0])}<span class="meta" style="color:var(--muted);font-size:11px"> 〜${until}</span></li>`;
  }).join("");
  const hasScore = c.d < 1972;
  const works = c.w.map((w, i) => {
    const workQuery = `${c.q} ${w.o}`;
    const recs = w.r.map(r => `
      <div class="rec">
        <div class="who">${esc(r[0])}</div>
        <div class="when">${[r[1], r[2]].filter(Boolean).map(esc).join(" · ")}</div>
        <div class="links">${searchLinks(`${workQuery} ${r[3]}`)}</div>
      </div>`).join("");
    return `
      <details class="work"${i === 0 ? " open" : ""}>
        <summary><span>${esc(w.t)}</span><span class="y">${esc(w.y)}</span></summary>
        <div class="body">
          <div class="wo">${esc(w.o)}</div>
          <div>${esc(w.d)}</div>
          ${recs ? `<div class="rec-label">定評のある録音</div>${recs}` : ""}
          <div class="rec-label">この曲を探す</div>
          <div class="links">
            ${searchLinks(workQuery)}
            ${hasScore ? `<a href="https://imslp.org/index.php?search=${enc(workQuery)}" target="_blank" rel="noopener">楽譜（IMSLP）</a>` : ""}
          </div>
        </div>
      </details>`;
  }).join("");

  pane.innerHTML = `
    <div class="detail">
      <h2>${esc(c.n)}</h2>
      <div class="orig">${esc(c.o)}</div>
      <div class="dates">
        <span class="tag" style="--c:${era.color}">${esc(era.name)}</span>
        <span>${c.b}–${c.d}（${lifespan}歳没）</span>
        <span style="color:var(--muted)">${state.year}年：${ageText(c)}</span>
      </div>
      <div class="dates" style="color:var(--muted)">出身：${esc(c.bp)}</div>
      <p class="bio">${esc(c.bio)}</p>
      <div class="links">
        <a href="https://ja.wikipedia.org/w/index.php?search=${enc(c.n)}" target="_blank" rel="noopener">Wikipedia（日本語）</a>
        <a href="https://en.wikipedia.org/w/index.php?search=${enc(c.o)}" target="_blank" rel="noopener">Wikipedia（English）</a>
        ${hasScore ? `<a href="https://imslp.org/index.php?search=${enc(c.o)}" target="_blank" rel="noopener">IMSLP</a>` : ""}
      </div>
      <h3>拠点の変遷 <span style="font-weight:400">（クリックでその年へ）</span></h3>
      <ol class="places">${places}</ol>
      <div class="links" style="margin-top:8px">
        <a href="#" data-jump="${c.b}">誕生の年へ</a>
        <a href="#" data-jump="${c.d}">没年へ</a>
      </div>
      <h3>代表作と録音</h3>
      ${works}
      <p class="note">拠点は主要な活動地を年単位で概略化したもので、演奏旅行や短期滞在は省いてるわ。録音は広く定評のあるものを挙げていて、リンク先は各サービスの検索結果よ。地図上の国境は現代のもの。</p>
    </div>`;
}

$("pane-detail").addEventListener("click", e => {
  const li = e.target.closest("li[data-year]");
  if (li) { setYear(Number(li.dataset.year)); return; }
  const jump = e.target.closest("[data-jump]");
  if (jump) { e.preventDefault(); setYear(Number(jump.dataset.jump)); }
});

function showTab(tab) {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("pane-list").classList.toggle("active", tab === "list");
  $("pane-detail").classList.toggle("active", tab === "detail");
}
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));

function select(id, { fly = true, tab = true } = {}) {
  const c = byId.get(id);
  if (!c) return;
  state.selected = id;
  // 生きていない年を表示しているなら、人生の中ほどの年へ移動する
  if (state.win !== "all" && !isAlive(c)) {
    state.year = c.b + Math.round((c.d - c.b) / 2);
    $("year").value = state.year;
  }
  if (!state.eras.has(c.era)) {
    state.eras.add(c.era);
    document.querySelectorAll(".era-chip").forEach((b, i) => b.classList.toggle("off", !state.eras.has(Object.keys(ERAS)[i])));
  }
  render();
  refreshPinIcons();
  if (tab) showTab("detail");
  if (fly) {
    const place = placeFor(c) || c.pl[0];
    map.flyTo([place[1], place[2]], Math.max(map.getZoom(), 6), { duration: 0.8 });
  }
  saveHash();
}

// ───────── 検索 ─────────

function searchComposers(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const c of COMPOSERS) {
    const names = [c.n, c.s, c.o].join(" ").toLowerCase();
    if (names.includes(q)) { results.push({ c, hit: null }); continue; }
    const w = c.w.find(w => (w.t + " " + w.o).toLowerCase().includes(q));
    if (w) results.push({ c, hit: w.t });
  }
  return results.slice(0, 30);
}

let searchIndex = -1;
function renderSearch() {
  const box = $("search-results");
  const results = searchComposers($("search").value);
  if (!results.length) {
    box.classList.toggle("show", !!$("search").value.trim());
    box.innerHTML = `<div style="color:var(--muted);cursor:default">見つからないわね</div>`;
    return;
  }
  searchIndex = clamp(searchIndex, 0, results.length - 1);
  box.innerHTML = results.map(({ c, hit }, i) => `
    <div data-id="${c.id}" class="${i === searchIndex ? "active" : ""}">
      ${esc(c.n)}<small>${c.b}–${c.d} · ${esc(ERAS[c.era].name)}${hit ? ` · 『${esc(hit)}』` : ""}</small>
    </div>`).join("");
  box.classList.add("show");
}

function pickSearch(id) {
  $("search").value = "";
  $("search-results").classList.remove("show");
  $("search").blur();
  select(id, { fly: true, tab: true });
}

$("search").addEventListener("input", () => { searchIndex = 0; renderSearch(); });
$("search").addEventListener("keydown", e => {
  const items = $("search-results").querySelectorAll("[data-id]");
  if (e.key === "ArrowDown") { searchIndex++; renderSearch(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { searchIndex--; renderSearch(); e.preventDefault(); }
  else if (e.key === "Enter" && items[searchIndex]) pickSearch(items[searchIndex].dataset.id);
  else if (e.key === "Escape") { $("search").value = ""; $("search-results").classList.remove("show"); }
});
$("search-results").addEventListener("mousedown", e => {
  const item = e.target.closest("[data-id]");
  if (item) { e.preventDefault(); pickSearch(item.dataset.id); }
});
$("search").addEventListener("blur", () => $("search-results").classList.remove("show"));

// ───────── URL ─────────

function saveHash() {
  const p = new URLSearchParams();
  p.set("y", state.year);
  if (state.win !== "0") p.set("w", state.win);
  if (state.selected) p.set("c", state.selected);
  history.replaceState(null, "", "#" + p.toString());
}

function loadHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const y = Number(p.get("y"));
  if (y) state.year = clamp(y, YEAR_MIN, YEAR_MAX);
  const w = p.get("w");
  if (w && ["0", "10", "25", "all"].includes(w)) state.win = w;
  const c = p.get("c");
  if (c && byId.has(c)) state.selected = c;
  $("year").value = state.year;
  $("window").value = state.win;
}

// ───────── 描画 ─────────

function render() {
  const visibleList = currentVisible();
  updateMarkers(visibleList);
  renderList(visibleList);
  if (state.selected) renderDetail();
  drawPath();
  drawTimeline();
  $("year-big").textContent = state.year;
  $("year-count").textContent = `${visibleList.length}人`;
}

$("year").addEventListener("input", e => setYear(Number(e.target.value)));
$("window").addEventListener("change", e => { state.win = e.target.value; render(); saveHash(); });
$("play").addEventListener("click", togglePlay);
$("speed").addEventListener("change", () => { if (state.playing) { togglePlay(); togglePlay(); } });
$("prev").addEventListener("click", () => setYear(state.year - 10));
$("next").addEventListener("click", () => setYear(state.year + 10));

document.addEventListener("keydown", e => {
  if (e.target.closest("input, select, textarea")) return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowLeft") { setYear(state.year - (e.shiftKey ? 10 : 1)); }
  else if (e.key === "ArrowRight") { setYear(state.year + (e.shiftKey ? 10 : 1)); }
});

window.addEventListener("resize", drawTimeline);

buildEraChips();
buildRegions();
loadHash();
render();
if (state.selected) select(state.selected, { fly: true, tab: true });
