import { STOPS, DAYS, FARE_NOTE } from "./data.js"

const $ = id => document.getElementById(id)

const state = {
  mode: null,      // "go" | "ret"
  from: "fast",    // "fast" or 乗り場id
  dayKey: null,
}

const toMin = t => {
  const [h, m] = t.split(":").map(Number)
  return h * 60 + m
}

function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function nowMin() {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

const dayKeys = Object.keys(DAYS).sort()
const todayKey = localDateKey(new Date())

// 今日が学園祭当日ならその日、そうでなければ次の開催日（過ぎていれば最終日）を初期表示にする
function defaultDayKey() {
  if (DAYS[todayKey]) return todayKey
  return dayKeys.find(k => k > todayKey) || dayKeys[dayKeys.length - 1]
}

// 選んだ乗り場（または全乗り場）の、今以降の便を発車順に返す
// 当日以外を見ている時に今の時刻以降の便がなければ、その日の始発から返す（前日の夜に翌日を確かめる用）
function upcoming() {
  const day = DAYS[state.dayKey][state.mode]
  const stopIds = state.from === "fast" ? STOPS[state.mode].map(s => s.id) : [state.from]
  const all = stopIds
    .flatMap(id => day[id].map(trip => ({ ...trip, stopId: id })))
    .sort((a, b) => toMin(a.t) - toMin(b.t))
  const now = nowMin()
  // 発車時刻ちょうどの便は「今から向かう」には間に合わないので除く
  const later = all.filter(trip => toMin(trip.t) > now)
  if (later.length === 0 && state.dayKey !== todayKey) {
    return { list: all, fromFirst: true }
  }
  return { list: later, fromFirst: false }
}

const stopOf = id => STOPS[state.mode].find(s => s.id === id)

function renderDayChips() {
  const wrap = $("days")
  wrap.innerHTML = ""
  for (const key of dayKeys) {
    const b = document.createElement("button")
    b.type = "button"
    b.textContent = DAYS[key].label + (key === todayKey ? " 今日" : "")
    b.setAttribute("aria-pressed", String(key === state.dayKey))
    b.addEventListener("click", () => {
      state.dayKey = key
      render()
    })
    wrap.appendChild(b)
  }
  const preview = state.dayKey !== todayKey
  $("preview").hidden = !preview
  $("preview").textContent = preview
    ? `${DAYS[state.dayKey].label}のダイヤを、いまの時刻にあてはめて表示しています`
    : ""
}

function renderResult() {
  const { list, fromFirst } = upcoming()
  const next = list[0]
  if (fromFirst) $("preview").textContent = `${DAYS[state.dayKey].label}のダイヤを始発から表示しています`
  const now = nowMin()

  $("mode").textContent = state.mode === "go" ? "行き（大学へ）" : "帰り（本厚木へ）"
  const prefix = state.from === "fast" ? "" : `${stopOf(state.from).short}発 `
  $("title").textContent = fromFirst ? `${prefix}始発` : (state.from === "fast" ? "最速バス" : `${prefix}最速`)

  const fromBtn = $("from")
  fromBtn.dataset.step = state.from === "fast" ? "0" : String(STOPS[state.mode].findIndex(s => s.id === state.from) + 1)
  fromBtn.querySelector(".current").textContent = state.from === "fast" ? "すべての乗り場" : stopOf(state.from).short

  const core = $("core")
  if (!next) {
    core.classList.add("over")
    $("time").textContent = "バス終わり"
    $("inmin").textContent = ""
    $("badge").hidden = true
    $("stop").textContent = state.from === "fast" ? "" : `乗り場: ${stopOf(state.from).short}`
    $("dest").textContent = ""
  } else {
    core.classList.remove("over")
    $("time").textContent = next.t
    const diff = toMin(next.t) - now
    $("inmin").textContent = fromFirst
      ? DAYS[state.dayKey].label
      : diff >= 60 ? `約${Math.floor(diff / 60)}時間${diff % 60}分後` : `約${diff}分後`
    $("badge").hidden = !next.extra
    $("stop").textContent = `乗り場: ${stopOf(next.stopId).short}`
    $("dest").textContent = `${next.kind}・${next.dest}`
  }

  // このあとの便
  const later = $("later")
  later.innerHTML = ""
  for (const trip of list.slice(1, 6)) {
    const li = document.createElement("li")
    li.innerHTML = `<span class="t"></span><span class="s"></span><span class="k"></span>`
    li.querySelector(".t").textContent = trip.t
    li.querySelector(".s").textContent = stopOf(trip.stopId).short
    li.querySelector(".k").textContent = trip.kind + (trip.extra ? "・臨時" : "")
    later.appendChild(li)
  }
  $("laterWrap").hidden = list.length <= 1

  // 乗り場の説明
  const notes = $("stopNotes")
  notes.innerHTML = ""
  for (const s of STOPS[state.mode]) {
    const dt = document.createElement("dt")
    dt.textContent = `${s.short}：${s.name}`
    const dd = document.createElement("dd")
    dd.textContent = s.note
    notes.append(dt, dd)
  }
}

function render() {
  renderDayChips()
  if (state.mode) renderResult()
}

function choose(mode) {
  state.mode = mode
  state.from = "fast"
  $("first").hidden = true
  $("last").hidden = false
  history.pushState({ mode }, "")
  render()
}

function back() {
  state.mode = null
  $("first").hidden = false
  $("last").hidden = true
  render()
}

$("go").addEventListener("click", () => choose("go"))
$("return").addEventListener("click", () => choose("ret"))
$("back").addEventListener("click", () => history.back())
window.addEventListener("popstate", () => back())

// 乗り場変更: すべて → 乗り場1 → 乗り場2 → すべて … と巡回する（旧版と同じ操作感）
$("from").addEventListener("click", () => {
  const ids = ["fast", ...STOPS[state.mode].map(s => s.id)]
  state.from = ids[(ids.indexOf(state.from) + 1) % ids.length]
  render()
})

$("fare").textContent = FARE_NOTE
state.dayKey = defaultDayKey()
render()

// 表示中の「あと何分」を最新に保つ
setInterval(render, 15 * 1000)
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) render()
})
