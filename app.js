'use strict';
/* Macro Tracker: a personal food and macro logger.
   Everything lives on the phone (IndexedDB). No account, no server. */

// ================= Storage =================
const DB_NAME = 'macro-tracker', STORE = 'kv';
const KG_PER_LB = 0.45359237;
const DEFAULT_STATE = () => ({
  version: 1,
  settings: { goals: { cal: 2200, p: 160, c: 220, f: 70 }, unit: 'lb', usdaKey: '', lastBackup: null },
  foods: {},     // saved foods: custom, label scans, and anything you've logged from search
  entries: [],   // food log: { id, date, ts, qty, unit, foodKey, food:{snapshot} }
  weights: {},   // { 'YYYY-MM-DD': kg }
});
let S = DEFAULT_STATE();

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function loadState() {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const q = db.transaction(STORE).objectStore(STORE).get('state');
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => rej(q.error);
    });
  } catch (e) {
    const s = localStorage.getItem('state');
    return s ? JSON.parse(s) : null;
  }
}
async function save() {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(S, 'state');
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) {
    localStorage.setItem('state', JSON.stringify(S));
  }
}
function mergeDefaults(s) {
  const d = DEFAULT_STATE();
  if (!s) return d;
  return {
    ...d, ...s,
    settings: { ...d.settings, ...(s.settings || {}), goals: { ...d.settings.goals, ...((s.settings || {}).goals || {}) } },
    foods: s.foods || {}, entries: s.entries || [], weights: s.weights || {},
  };
}

// ================= Small helpers =================
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayStr = () => ymd(new Date());
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : 0; };
const kcal = n => Math.round(n).toLocaleString();
const gr = n => (Math.abs(n) < 10 ? Math.round(n * 10) / 10 : Math.round(n));
const r1 = n => Math.round(n * 10) / 10;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function prettyDate(s) {
  const t = todayStr();
  if (s === t) return 'Today';
  if (s === addDays(t, -1)) return 'Yesterday';
  if (s === addDays(t, 1)) return 'Tomorrow';
  return parseYmd(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function titleCase(s) {
  s = String(s || '').trim();
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase());
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2000);
}
const SRC = { usda: 'USDA', off: 'Open Food Facts', custom: 'My food', label: 'Label scan' };

// ================= Nutrition math =================
function factor(entry) {
  if (entry.unit === 'g') return entry.food.grams ? entry.qty / entry.food.grams : 0;
  return entry.qty;
}
function entryMacros(e) {
  const k = factor(e), f = e.food;
  return { cal: f.cal * k, p: f.p * k, c: f.c * k, f: f.f * k };
}
function dayTotals(date) {
  const t = { cal: 0, p: 0, c: 0, f: 0, n: 0 };
  for (const e of S.entries) if (e.date === date) {
    const m = entryMacros(e);
    t.cal += m.cal; t.p += m.p; t.c += m.c; t.f += m.f; t.n++;
  }
  return t;
}
function amountText(e) {
  if (e.unit === 'g') return `${r1(e.qty)} g`;
  const q = r1(e.qty);
  return `${q} × ${e.food.serving || 'serving'}`;
}
const pcfLine = m => `<span class="p">P ${gr(m.p)}</span> · <span class="c">C ${gr(m.c)}</span> · <span class="f">F ${gr(m.f)}</span>`;

// ================= App state & rendering =================
let view = 'today';
let curDate = todayStr();
let trendRange = 7;
let weightRange = 90;
const TITLES = { today: 'Today', trends: 'Trends', weight: 'Bodyweight', settings: 'Settings' };

function render() {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  $('#title').textContent = TITLES[view];
  const main = $('#main');
  main.innerHTML = { today: renderToday, trends: renderTrends, weight: renderWeight, settings: renderSettings }[view]();
  if (view === 'settings') bindSettings();
}

// ---------- Today ----------
function renderToday() {
  const t = dayTotals(curDate), g = S.settings.goals;
  const entries = S.entries.filter(e => e.date === curDate).sort((a, b) => a.ts - b.ts);
  const left = g.cal - t.cal;
  const pct = g.cal ? Math.min(t.cal / g.cal, 1) : 0;
  const R = 52, C = 2 * Math.PI * R;
  const over = t.cal > g.cal;
  const macroBar = (key, name, color) => {
    const v = t[key], goal = g[key] || 0;
    const w = goal ? Math.min(v / goal, 1) * 100 : 0;
    return `<div class="macro"><div class="top"><b style="color:${color}">${name}</b><span>${gr(v)} / ${goal} g</span></div>
      <div class="bar"><i style="width:${w}%;background:${v > goal * 1.05 && goal ? 'var(--over)' : color}"></i></div></div>`;
  };
  return `
    <div class="datenav">
      <button data-action="day" data-n="-1" aria-label="Previous day">‹</button>
      <button class="label" data-action="day" data-n="0">${esc(prettyDate(curDate))}</button>
      <button data-action="day" data-n="1" aria-label="Next day">›</button>
    </div>
    <div class="card">
      <div class="summary">
        <div class="ring">
          <svg viewBox="0 0 128 128">
            <circle cx="64" cy="64" r="${R}" fill="none" stroke="var(--track)" stroke-width="12"/>
            <circle cx="64" cy="64" r="${R}" fill="none" stroke="${over ? 'var(--over)' : 'var(--accent)'}" stroke-width="12"
              stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/>
          </svg>
          <div class="center"><div class="big">${kcal(Math.abs(left))}</div><div class="small muted">${over ? 'kcal over' : 'kcal left'}</div></div>
        </div>
        <div class="macros">
          <div class="small muted">${kcal(t.cal)} of ${kcal(g.cal)} kcal eaten</div>
          ${macroBar('p', 'Protein', 'var(--protein)')}
          ${macroBar('c', 'Carbs', 'var(--carbs)')}
          ${macroBar('f', 'Fat', 'var(--fat)')}
        </div>
      </div>
    </div>
    <div class="card">
      <h2>Food log <span class="muted small">(${entries.length})</span></h2>
      ${entries.length ? `<ul class="list">${entries.map(e => {
        const m = entryMacros(e);
        return `<li><button class="item" data-action="edit-entry" data-id="${e.id}">
          <div class="grow"><div class="name">${esc(e.food.name)}</div>
          <div class="sub">${esc(amountText(e))}</div><div class="pcf">${pcfLine(m)}</div></div>
          <div class="cal">${kcal(m.cal)}<div class="small muted">kcal</div></div></button></li>`;
      }).join('')}</ul>` : `<div class="empty">Nothing logged yet.<br>Tap <b>+ Add food</b> to start.</div>`}
    </div>
    <button class="fab" data-action="open-add">+ Add food</button>`;
}

// ---------- Trends ----------
function renderTrends() {
  const g = S.settings.goals, end = todayStr();
  const days = [];
  for (let i = trendRange - 1; i >= 0; i--) {
    const d = addDays(end, -i);
    days.push({ d, ...dayTotals(d) });
  }
  const logged = days.filter(d => d.n > 0);
  const avg = k => (logged.length ? logged.reduce((s, d) => s + d[k], 0) / logged.length : 0);
  const a = { cal: avg('cal'), p: avg('p'), c: avg('c'), f: avg('f') };
  const onTarget = logged.filter(d => Math.abs(d.cal - g.cal) <= g.cal * 0.1).length;
  const macroCal = a.p * 4 + a.c * 4 + a.f * 9 || 1;
  const split = k => Math.round((a[k] * (k === 'f' ? 9 : 4)) / macroCal * 100);
  const seg = [7, 30, 90].map(n => `<button class="${trendRange === n ? 'on' : ''}" data-action="trend-range" data-n="${n}">${n} days</button>`).join('');

  return `
    <div class="seg">${seg}</div>
    <div class="card">
      <h2>Daily averages <span class="muted small">(days you logged)</span></h2>
      <div class="stats">
        <div><b>${kcal(a.cal)}</b><span>kcal / ${kcal(g.cal)}</span></div>
        <div><b>${logged.length}/${trendRange}</b><span>days logged</span></div>
        <div><b>${onTarget}</b><span>days within 10%</span></div>
      </div>
      <div class="stats" style="margin-top:8px">
        <div><b style="color:var(--protein)">${gr(a.p)} g</b><span>protein · ${logged.length ? split('p') : 0}%</span></div>
        <div><b style="color:var(--carbs)">${gr(a.c)} g</b><span>carbs · ${logged.length ? split('c') : 0}%</span></div>
        <div><b style="color:var(--fat)">${gr(a.f)} g</b><span>fat · ${logged.length ? split('f') : 0}%</span></div>
      </div>
    </div>
    <div class="card chart"><h2>Calories</h2>${barChart(days, 'cal', g.cal, 'var(--accent)')}</div>
    <div class="card chart"><h2>Protein (g)</h2>${barChart(days, 'p', g.p, 'var(--protein)')}</div>
    <div class="card chart"><h2>Carbs (g)</h2>${barChart(days, 'c', g.c, 'var(--carbs)')}</div>
    <div class="card chart"><h2>Fat (g)</h2>${barChart(days, 'f', g.f, 'var(--fat)')}</div>`;
}

function niceMax(v) {
  if (v <= 0) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function barChart(days, key, goal, color) {
  const W = 360, H = 170, L = 38, R = 8, T = 10, B = 22;
  const max = niceMax(Math.max(goal || 0, ...days.map(d => d[key])) * 1.08);
  const iw = W - L - R, ih = H - T - B;
  const y = v => T + ih - (v / max) * ih;
  const bw = iw / days.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let i = 0; i <= 3; i++) {
    const v = (max / 3) * i;
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`;
    s += `<text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${Math.round(v).toLocaleString()}</text>`;
  }
  days.forEach((d, i) => {
    const v = d[key];
    if (d.n > 0) {
      const h = Math.max(1, (v / max) * ih);
      const over = goal && v > goal * 1.1 && key === 'cal';
      s += `<rect x="${L + i * bw + bw * 0.15}" y="${T + ih - h}" width="${Math.max(1, bw * 0.7)}" height="${h}" rx="${Math.min(3, bw * 0.2)}" fill="${over ? 'var(--over)' : color}"/>`;
    }
  });
  if (goal) s += `<line x1="${L}" x2="${W - R}" y1="${y(goal)}" y2="${y(goal)}" stroke="var(--text)" stroke-width="1.2" stroke-dasharray="4 3" opacity=".6"/>`;
  const every = days.length <= 7 ? 1 : days.length <= 30 ? 7 : 15;
  days.forEach((d, i) => {
    if ((days.length - 1 - i) % every === 0) {
      const dt = parseYmd(d.d);
      const lab = days.length <= 7 ? dt.toLocaleDateString(undefined, { weekday: 'short' }) : `${dt.getMonth() + 1}/${dt.getDate()}`;
      s += `<text x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${lab}</text>`;
    }
  });
  return s + `</svg><div class="small muted">Dashed line = your goal${goal ? ` (${Math.round(goal).toLocaleString()})` : ''}</div>`;
}

// ---------- Weight ----------
const toUnit = kg => (S.settings.unit === 'lb' ? kg / KG_PER_LB : kg);
const fromUnit = v => (S.settings.unit === 'lb' ? v * KG_PER_LB : v);
function weightSeries() {
  const dates = Object.keys(S.weights).sort();
  return dates.map(d => {
    // 7-day trailing average: smooths out daily water-weight swings
    const win = dates.filter(x => x <= d && daysBetween(x, d) < 7);
    const avg = win.reduce((s, x) => s + S.weights[x], 0) / win.length;
    return { d, kg: S.weights[d], avg };
  });
}
function renderWeight() {
  const u = S.settings.unit;
  const all = weightSeries();
  const last = all[all.length - 1];
  const t = todayStr();
  const changeOver = n => {
    if (!last) return null;
    const target = addDays(last.d, -n);
    const prior = all.filter(p => p.d <= target).pop();
    return prior ? toUnit(last.avg) - toUnit(prior.avg) : null;
  };
  const fmtChange = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${r1(v)}`);
  const c7 = changeOver(7), c30 = changeOver(30);
  const rangeStart = weightRange === 0 ? (all[0] ? all[0].d : t) : addDays(t, -weightRange + 1);
  const pts = all.filter(p => p.d >= rangeStart);
  const from = pts.length ? (pts[0].d > rangeStart ? pts[0].d : rangeStart) : rangeStart;
  const seg = [[30, '30d'], [90, '90d'], [365, '1y'], [0, 'All']].map(([n, l]) =>
    `<button class="${weightRange === n ? 'on' : ''}" data-action="weight-range" data-n="${n}">${l}</button>`).join('');
  const recent = all.slice(-14).reverse();

  return `
    <div class="card">
      <h2>Log weight</h2>
      <div class="grid2">
        <label class="field"><span>Date</span><input id="wDate" type="date" value="${t}" max="${t}"></label>
        <label class="field"><span>Weight (${u})</span><input id="wVal" type="number" inputmode="decimal" step="0.1" placeholder="${last ? r1(toUnit(last.kg)) : ''}"></label>
      </div>
      <button class="btn primary block" data-action="save-weight">Save weight</button>
    </div>
    <div class="card">
      <div class="stats">
        <div><b>${last ? r1(toUnit(last.avg)) : '–'}</b><span>7-day avg (${u})</span></div>
        <div><b>${fmtChange(c7)}</b><span>vs 1 week ago</span></div>
        <div><b>${fmtChange(c30)}</b><span>vs 30 days ago</span></div>
      </div>
    </div>
    <div class="seg">${seg}</div>
    <div class="card chart"><h2>Trend</h2>${pts.length >= 2 ? weightChart(pts, from, t) : '<div class="empty">Log at least two weigh-ins to see a trend.</div>'}</div>
    <div class="card"><h2>Recent weigh-ins</h2>
      ${recent.length ? `<ul class="list">${recent.map(p => `<li><div class="item"><div class="grow"><div class="name">${r1(toUnit(p.kg))} ${u}</div><div class="sub">${esc(prettyDate(p.d))}</div></div>
        <button class="btn danger" data-action="delete-weight" data-d="${p.d}">Delete</button></div></li>`).join('')}</ul>` : '<div class="empty">No weigh-ins yet.</div>'}
    </div>`;
}
function weightChart(pts, from, to) {
  const W = 360, H = 190, L = 40, R = 10, T = 10, B = 22;
  const span = Math.max(1, daysBetween(from, to));
  const vals = pts.flatMap(p => [toUnit(p.kg), toUnit(p.avg)]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const padv = Math.max(1, (hi - lo) * 0.15); lo -= padv; hi += padv;
  const x = d => L + (daysBetween(from, d) / span) * (W - L - R);
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) / 3) * i;
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/>`;
    s += `<text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${r1(v)}</text>`;
  }
  pts.forEach(p => { s += `<circle cx="${x(p.d)}" cy="${y(toUnit(p.kg))}" r="2.6" fill="var(--muted)" opacity=".7"/>`; });
  s += `<polyline fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" points="${pts.map(p => `${x(p.d)},${y(toUnit(p.avg))}`).join(' ')}"/>`;
  [from, to].forEach((d, i) => {
    const dt = parseYmd(d);
    s += `<text x="${i ? W - R : L}" y="${H - 6}" text-anchor="${i ? 'end' : 'start'}">${dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</text>`;
  });
  return s + `</svg><div class="small muted">Dots = weigh-ins · green line = 7-day average</div>`;
}

// ---------- Settings ----------
function renderSettings() {
  const g = S.settings.goals;
  const nFoods = Object.keys(S.foods).length;
  const row = (k, name, color) => `
    <div class="goalrow">
      <b style="color:${color}">${name}</b>
      <label class="field"><span>grams</span><input id="g${k.toUpperCase()}" data-m="${k}" class="gGrams" type="number" inputmode="numeric" value="${g[k]}"></label>
      <label class="field"><span>% of kcal</span><input id="pct${k.toUpperCase()}" data-m="${k}" class="gPct" type="number" inputmode="numeric" value="${macroPct(g[k], k, g.cal)}"></label>
    </div>`;
  return `
    <div class="card">
      <h2>Daily goals</h2>
      <label class="field"><span>Calories (kcal)</span><input id="gCal" type="number" inputmode="numeric" value="${g.cal}"></label>
      ${row('p', 'Protein', 'var(--protein)')}
      ${row('c', 'Carbs', 'var(--carbs)')}
      ${row('f', 'Fat', 'var(--fat)')}
      <p class="small muted" style="margin:0 0 8px">Edit grams or %, whichever you think in. The other updates to match.</p>
      <div class="notice small" id="macroHint">${macroHintHtml(g)}</div>
    </div>
    <div class="card">
      <h2>Weight unit</h2>
      <div class="seg" style="margin:0">
        <button class="${S.settings.unit === 'lb' ? 'on' : ''}" data-action="unit" data-u="lb">Pounds (lb)</button>
        <button class="${S.settings.unit === 'kg' ? 'on' : ''}" data-action="unit" data-u="kg">Kilograms (kg)</button>
      </div>
    </div>
    <div class="card">
      <h2>USDA food search key <span class="muted small">(optional)</span></h2>
      <p class="small muted" style="margin-top:0">Search works without this, but the shared demo key is limited to about 30 searches per hour. A free personal key from
        <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener">fdc.nal.usda.gov/api-key-signup</a> raises that to 1,000.</p>
      <input id="usdaKey" type="text" autocomplete="off" spellcheck="false" placeholder="Paste key here" value="${esc(S.settings.usdaKey)}">
    </div>
    <div class="card">
      <h2>Backup</h2>
      <p class="small muted" style="margin-top:0">Your data lives only on this phone. Export a backup now and then (save it to Google Drive) so a phone reset never wipes your history.
        ${S.settings.lastBackup ? `Last backup: ${esc(prettyDate(S.settings.lastBackup))}.` : 'No backup yet.'}</p>
      <div class="btnrow">
        <button class="btn primary" data-action="export">Export backup</button>
        <button class="btn" data-action="import">Restore backup</button>
      </div>
      <p class="small muted">${S.entries.length.toLocaleString()} log entries · ${nFoods} saved foods · ${Object.keys(S.weights).length} weigh-ins</p>
    </div>`;
}
// Macro % = that macro's calories as a share of the calorie goal (protein & carbs 4 kcal/g, fat 9 kcal/g)
const KCAL_PER_G = { p: 4, c: 4, f: 9 };
const macroPct = (grams, k, cal) => (cal > 0 ? Math.round((grams * KCAL_PER_G[k]) / cal * 100) : 0);
const gramsFromPct = (pct, k, cal) => Math.max(0, Math.round((pct / 100) * cal / KCAL_PER_G[k]));
function macroHintHtml(g) {
  const fromMacros = Math.round(g.p * 4 + g.c * 4 + g.f * 9);
  const total = macroPct(g.p, 'p', g.cal) + macroPct(g.c, 'c', g.cal) + macroPct(g.f, 'f', g.cal);
  const off = Math.abs(total - 100) > 2;
  return `Split: <b style="color:var(--protein)">${macroPct(g.p, 'p', g.cal)}% P</b> · <b style="color:var(--carbs)">${macroPct(g.c, 'c', g.cal)}% C</b> · <b style="color:var(--fat)">${macroPct(g.f, 'f', g.cal)}% F</b>
    = <b style="color:${off ? 'var(--over)' : 'inherit'}">${total}%</b> of your calorie goal.<br>
    Macros add up to <b>${fromMacros.toLocaleString()} kcal</b>${off ? ` vs your ${Number(g.cal).toLocaleString()} kcal goal.` : '.'}
    ${off ? `<button class="chip" data-action="cal-from-macros" style="margin-top:6px">Set calorie goal to ${fromMacros.toLocaleString()}</button>` : ''}`;
}
function bindSettings() {
  // Read the form, keep grams and % in sync, update the summary line
  const readGoals = () => ({ cal: Math.max(0, Math.round(num($('#gCal').value))), p: Math.max(0, Math.round(num($('#gP').value))), c: Math.max(0, Math.round(num($('#gC').value))), f: Math.max(0, Math.round(num($('#gF').value))) });
  const syncPcts = () => { const g = readGoals(); for (const k of ['p', 'c', 'f']) { const el = $('#pct' + k.toUpperCase()); if (el !== document.activeElement) el.value = macroPct(g[k], k, g.cal); } $('#macroHint').innerHTML = macroHintHtml(g); };
  const commit = () => { S.settings.goals = readGoals(); save(); toast('Goals saved'); };
  $('#gCal').addEventListener('input', syncPcts);
  document.querySelectorAll('.gGrams').forEach(el => el.addEventListener('input', syncPcts));
  document.querySelectorAll('.gPct').forEach(el => el.addEventListener('input', () => {
    const k = el.dataset.m, cal = num($('#gCal').value);
    if (el.value.trim() === '') return;
    $('#g' + k.toUpperCase()).value = gramsFromPct(num(el.value), k, cal);
    $('#macroHint').innerHTML = macroHintHtml(readGoals());
  }));
  document.querySelectorAll('#gCal, .gGrams, .gPct').forEach(el => el.addEventListener('change', () => { commit(); syncPcts(); }));
  $('#usdaKey').addEventListener('change', e => { S.settings.usdaKey = e.target.value.trim(); save(); toast('Key saved'); });
}

// ================= Bottom sheet (pop-up panel) =================
let sheetOpen = false;
function openSheet(html) {
  const sh = $('#sheet');
  sh.innerHTML = `<div class="grab"></div>${html}`;
  sh.hidden = false; $('#backdrop').hidden = false;
  sh.scrollTop = 0;
  if (!sheetOpen) { history.pushState({ sheet: 1 }, ''); sheetOpen = true; }
}
function hideSheet() {
  stopCamera();
  $('#sheet').hidden = true; $('#backdrop').hidden = true; $('#sheet').innerHTML = '';
}
function closeSheet() { if (sheetOpen) history.back(); else hideSheet(); }
window.addEventListener('popstate', () => { if (sheetOpen) { sheetOpen = false; hideSheet(); } });
const sheetHead = (title, sub = '') =>
  `<div class="head"><div class="grow"><h2>${esc(title)}</h2>${sub ? `<div class="small muted">${sub}</div>` : ''}</div>
   <button class="close" data-action="close-sheet" aria-label="Close">✕</button></div>`;

// ================= Add food: search =================
const results = new Map(); // key -> food (from search results, for tap handling)
function openAddSheet() {
  openSheet(`${sheetHead('Add food', `Logging to ${esc(prettyDate(curDate))}`)}
    <form class="searchrow" id="searchForm">
      <input id="q" type="search" placeholder="Search foods (e.g. greek yogurt)" autocomplete="off" enterkeyhint="search">
      <button class="btn primary" type="submit">Search</button>
    </form>
    <div class="actions3">
      <button class="btn" data-action="scan"><span>▦</span>Barcode</button>
      <button class="btn" data-action="photo"><span>📷</span>Label photo</button>
      <button class="btn" data-action="new-food"><span>✎</span>Custom food</button>
    </div>
    <p class="small muted" style="margin:-4px 0 8px;text-align:center">Label already in your photos? <a href="#" data-action="photo-gallery">Pick from gallery</a></p>
    <div id="localResults"></div>
    <div id="onlineResults"></div>`);
  const q = $('#q');
  q.addEventListener('input', () => { renderLocal(q.value); $('#onlineResults').innerHTML = ''; });
  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); q.blur(); searchOnline(q.value.trim()); });
  renderLocal('');
}
function foodRow(f) {
  results.set(f.key, f);
  const m = { p: f.p, c: f.c, f: f.f };
  return `<li><button class="item" data-action="pick" data-key="${esc(f.key)}">
    <div class="grow"><div class="name">${esc(f.name)}</div>
    <div class="sub">${f.brand ? esc(f.brand) + ' · ' : ''}${esc(f.serving)}<span class="tag">${SRC[f.source] || ''}</span></div>
    <div class="pcf">${pcfLine(m)}</div></div>
    <div class="cal">${kcal(f.cal)}<div class="small muted">kcal</div></div></button></li>`;
}
function renderLocal(q) {
  const ql = q.toLowerCase().trim();
  let foods = Object.values(S.foods);
  if (ql) foods = foods.filter(f => `${f.name} ${f.brand}`.toLowerCase().includes(ql));
  foods.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  foods = foods.slice(0, ql ? 50 : 25);
  $('#localResults').innerHTML = foods.length
    ? `<div class="section-title">${ql ? 'My foods' : 'Recent & my foods'}</div><ul class="list">${foods.map(foodRow).join('')}</ul>`
    : (ql ? '' : `<div class="notice small">Search the food databases above, scan a barcode, or snap a label. Foods you log show up here for one-tap re-logging.</div>`);
}
async function searchOnline(q) {
  if (!q) return;
  const box = $('#onlineResults');
  box.innerHTML = `<div class="section-title">Online results</div><div class="notice"><span class="spinner"></span>Searching USDA and Open Food Facts…</div>`;
  const [usda, off] = await Promise.allSettled([searchUSDA(q), searchOFF(q)]);
  if (!$('#onlineResults')) return; // sheet closed meanwhile
  const list = [];
  const notes = [];
  if (usda.status === 'fulfilled') list.push(...usda.value.filter(f => f.kind !== 'Branded'));
  if (off.status === 'fulfilled') list.push(...off.value);
  if (usda.status === 'fulfilled') list.push(...usda.value.filter(f => f.kind === 'Branded'));
  if (usda.status === 'rejected') notes.push(usda.reason && usda.reason.message === 'limit'
    ? 'USDA search limit reached for now. Add a free personal key in Settings to raise it.'
    : 'USDA search failed (check your connection).');
  if (off.status === 'rejected') notes.push('Open Food Facts search failed or is busy; try again in a minute.');
  box.innerHTML = `<div class="section-title">Online results</div>
    ${notes.map(n => `<div class="notice warn small">${esc(n)}</div>`).join('')}
    ${list.length ? `<ul class="list">${list.map(foodRow).join('')}</ul>` : '<div class="empty">No matches. Try fewer words, or add it as a custom food.</div>'}`;
}

// --- USDA FoodData Central (values are per 100 g; branded foods also list a serving) ---
async function searchUSDA(q) {
  const key = S.settings.usdaKey || 'DEMO_KEY';
  // Generic/whole foods only; branded packaged foods come from Open Food Facts
  const types = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'].map(t => '&dataType=' + encodeURIComponent(t)).join('');
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}`
    + `&pageSize=20${types}`;
  const r = await fetch(url);
  if (r.status === 429 || r.status === 403) throw new Error('limit');
  if (!r.ok) throw new Error('USDA ' + r.status);
  const j = await r.json();
  return (j.foods || []).map(normUSDA).filter(Boolean);
}
function normUSDA(f) {
  const v = id => { const n = (f.foodNutrients || []).find(n => n.nutrientId === id); return n && n.value != null ? n.value : null; };
  let cal = v(1008) ?? v(2047) ?? v(2048);
  if (cal == null && v(1062) != null) cal = v(1062) / 4.184;
  const p = v(1003) ?? 0, c = v(1005) ?? 0, fat = v(1004) ?? 0;
  if (cal == null) { if (p || c || fat) cal = p * 4 + c * 4 + fat * 9; else return null; }
  let base = { cal, p, c, f: fat }, serving = '100 g', grams = 100;
  const unit = String(f.servingSizeUnit || '').toLowerCase();
  if (f.dataType === 'Branded' && f.servingSize && ['g', 'grm', 'ml', 'mlt'].includes(unit)) {
    const k = f.servingSize / 100, isMl = unit.startsWith('m');
    base = { cal: cal * k, p: p * k, c: c * k, f: fat * k };
    serving = `${f.householdServingFullText ? f.householdServingFullText + ' ' : ''}(${r1(f.servingSize)} ${isMl ? 'ml' : 'g'})`;
    grams = isMl ? null : f.servingSize;
  }
  return {
    key: 'usda:' + f.fdcId, name: titleCase(f.description), brand: titleCase(f.brandName || f.brandOwner || ''),
    serving, grams, ...base, source: 'usda', barcode: f.gtinUpc || '', kind: f.dataType,
  };
}

// --- Open Food Facts (great for packaged/branded foods and barcodes) ---
const OFF_FIELDS = 'code,product_name,product_name_en,brands,nutriments,serving_size,serving_quantity';
async function searchOFF(q) {
  const url = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}&page_size=25&langs=en&fields=${OFF_FIELDS}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('OFF ' + r.status);
  const j = await r.json();
  return (j.hits || []).map(normOFF).filter(Boolean);
}
async function lookupOFFBarcode(code) {
  const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('OFF ' + r.status);
  const j = await r.json();
  if (j.status !== 1 || !j.product) return null;
  j.product.code = j.product.code || code;
  return normOFF(j.product);
}
function normOFF(p) {
  const n = p.nutriments || {};
  const name = String(p.product_name || p.product_name_en || '').trim();
  if (!name) return null;
  const kc = sfx => n['energy-kcal' + sfx] ?? (n['energy' + sfx] != null ? n['energy' + sfx] / 4.184 : null);
  let food;
  const sCal = kc('_serving'), c100 = kc('_100g'), sq = Number(p.serving_quantity) || null;
  if (sCal != null && p.serving_size) {
    food = { cal: sCal, p: n.proteins_serving ?? 0, c: n.carbohydrates_serving ?? 0, f: n.fat_serving ?? 0, serving: p.serving_size, grams: sq };
  } else if (c100 != null && sq && p.serving_size) {
    const k = sq / 100; // scale per-100 g values to the package's serving
    food = { cal: c100 * k, p: (n.proteins_100g ?? 0) * k, c: (n.carbohydrates_100g ?? 0) * k, f: (n.fat_100g ?? 0) * k, serving: p.serving_size, grams: sq };
  } else if (c100 != null) {
    food = { cal: c100, p: n.proteins_100g ?? 0, c: n.carbohydrates_100g ?? 0, f: n.fat_100g ?? 0, serving: '100 g', grams: 100 };
  } else return null;
  const b = Array.isArray(p.brands) ? p.brands[0] : String(p.brands || '').split(',')[0];
  const brand = String(b || '').replace(/^[a-z]{2}:/, '').trim();
  return { key: 'off:' + p.code, name, brand: brand ? brand[0].toUpperCase() + brand.slice(1) : '', ...food, source: 'off', barcode: p.code };
}

// ================= Log / edit an entry =================
let sheetFood = null, sheetEntry = null;
function openFoodSheet(food, entry = null) {
  sheetFood = food; sheetEntry = entry;
  const per100 = food.grams === 100 && /^100\s*g$/i.test(food.serving);
  const qty = entry ? entry.qty : per100 ? 100 : 1;
  const unit = entry ? entry.unit : per100 ? 'g' : 'serving';
  const saved = !!S.foods[food.key];
  openSheet(`${sheetHead(food.name, `${food.brand ? esc(food.brand) + ' · ' : ''}1 serving = ${esc(food.serving)}`)}
    <div class="grid2">
      <label class="field"><span>Amount</span><input id="amt" type="number" inputmode="decimal" step="any" value="${qty}"></label>
      <label class="field"><span>Unit</span><select id="unit">
        <option value="serving" ${unit === 'serving' ? 'selected' : ''}>serving(s)</option>
        ${food.grams ? `<option value="g" ${unit === 'g' ? 'selected' : ''}>grams</option>` : ''}
      </select></label>
    </div>
    <div class="chips" id="chips"></div>
    <div class="preview" id="preview"></div>
    <div class="btnrow">
      ${entry ? `<button class="btn danger" data-action="delete-entry">Delete</button>` : ''}
      <button class="btn primary" data-action="log">${entry ? 'Save' : `Log to ${esc(prettyDate(curDate))}`}</button>
    </div>
    ${saved ? `<p class="small" style="text-align:center"><a href="#" data-action="edit-food">Edit this food's nutrition info</a></p>` : ''}
    <p class="small muted" style="text-align:center">Source: ${SRC[food.source] || 'Saved'}</p>`);
  const upd = () => {
    const u = $('#unit').value;
    const chips = u === 'g' ? [50, 100, 150, 200] : [0.5, 1, 1.5, 2];
    $('#chips').innerHTML = chips.map(c => `<button class="chip" data-action="chip" data-v="${c}">${c}${u === 'g' ? ' g' : '×'}</button>`).join('');
    const m = entryMacros({ qty: num($('#amt').value), unit: u, food });
    $('#preview').innerHTML = `<div><b>${kcal(m.cal)}</b><span class="small muted">kcal</span></div>
      <div class="p"><b>${gr(m.p)}</b><span class="small muted">protein</span></div>
      <div class="c"><b>${gr(m.c)}</b><span class="small muted">carbs</span></div>
      <div class="f"><b>${gr(m.f)}</b><span class="small muted">fat</span></div>`;
  };
  $('#amt').addEventListener('input', upd);
  $('#unit').addEventListener('change', () => {
    // Convert the number when switching units so the total stays the same
    const a = num($('#amt').value);
    if (food.grams) $('#amt').value = $('#unit').value === 'g' ? r1(a * food.grams) : r1(a / food.grams * 100) / 100;
    upd();
  });
  upd();
}
function snapshot(f) {
  return { name: f.name, brand: f.brand || '', serving: f.serving, grams: f.grams || null, cal: f.cal, p: f.p, c: f.c, f: f.f };
}
function rememberFood(f) {
  const prev = S.foods[f.key] || {};
  const { kind, ...clean } = f;
  S.foods[f.key] = { ...clean, uses: (prev.uses || 0) + 1, lastUsed: Date.now() };
}
function doLog() {
  const qty = num($('#amt').value), unit = $('#unit').value;
  if (qty <= 0) { toast('Enter an amount'); return; }
  if (sheetEntry) {
    Object.assign(sheetEntry, { qty, unit });
    toast('Updated');
  } else {
    S.entries.push({ id: uid(), date: curDate, ts: Date.now(), qty, unit, foodKey: sheetFood.key, food: snapshot(sheetFood) });
    rememberFood(sheetFood);
    toast('Logged');
  }
  save(); closeSheet(); view = 'today'; render();
}

// ================= Custom food / label review form =================
function openFoodForm(pre = {}, opts = {}) {
  const f = { name: '', brand: '', serving: '1 serving', grams: '', cal: '', p: '', c: '', f: '', ...pre };
  const v = x => (x === '' || x == null ? '' : r1(x));
  const title = opts.mode === 'edit' ? 'Edit food' : opts.mode === 'label' ? 'Check label values' : 'Custom food';
  openSheet(`${sheetHead(title, opts.mode === 'label' ? 'The scan can misread numbers. Compare with the label and fix anything off.' : 'Nutrition for ONE serving')}
    ${opts.img ? `<img class="labelthumb" src="${opts.img}" alt="Label photo">` : ''}
    ${opts.mode === 'label' && opts.found < 4 ? `<div class="notice warn small">Only found ${opts.found} of 4 values. Fill in the rest from the label, or retake the photo straight-on with good light.</div>` : ''}
    <label class="field"><span>Food name *</span><input id="fName" type="text" value="${esc(f.name)}" placeholder="e.g. Protein bar"></label>
    <label class="field"><span>Brand (optional)</span><input id="fBrand" type="text" value="${esc(f.brand)}"></label>
    <div class="grid2">
      <label class="field"><span>Serving size</span><input id="fServing" type="text" value="${esc(f.serving)}" placeholder="e.g. 1 bar"></label>
      <label class="field"><span>Serving weight (g, optional)</span><input id="fGrams" type="number" inputmode="decimal" step="any" value="${v(f.grams)}"></label>
    </div>
    <div class="grid4">
      <label class="field"><span>Calories</span><input id="fCal" type="number" inputmode="decimal" step="any" value="${v(f.cal)}"></label>
      <label class="field"><span>Protein g</span><input id="fP" type="number" inputmode="decimal" step="any" value="${v(f.p)}"></label>
      <label class="field"><span>Carbs g</span><input id="fC" type="number" inputmode="decimal" step="any" value="${v(f.c)}"></label>
      <label class="field"><span>Fat g</span><input id="fF" type="number" inputmode="decimal" step="any" value="${v(f.f)}"></label>
    </div>
    <p class="small muted" style="margin-top:0">Leave calories blank to calculate from macros.</p>
    ${opts.rawText ? `<details><summary>Text the scanner read</summary><pre>${esc(opts.rawText)}</pre></details>` : ''}
    <div class="btnrow">
      ${opts.mode === 'edit' ? `<button class="btn danger" data-action="delete-food">Delete food</button>` : ''}
      <button class="btn primary" data-action="save-food">${opts.mode === 'edit' ? 'Save changes' : 'Save & log'}</button>
    </div>`);
  formCtx = { key: pre.key || null, source: pre.source || (opts.mode === 'label' ? 'label' : 'custom'), barcode: pre.barcode || opts.barcode || '', mode: opts.mode || 'new' };
}
let formCtx = null;
function saveFoodForm() {
  const name = $('#fName').value.trim();
  if (!name) { toast('Give it a name'); $('#fName').focus(); return; }
  const p = num($('#fP').value), c = num($('#fC').value), fat = num($('#fF').value);
  let cal = $('#fCal').value.trim() === '' ? p * 4 + c * 4 + fat * 9 : num($('#fCal').value);
  const food = {
    key: formCtx.key || `${formCtx.source}:${uid()}`, name, brand: $('#fBrand').value.trim(),
    serving: $('#fServing').value.trim() || '1 serving', grams: num($('#fGrams').value) || null,
    cal, p, c, f: fat, source: formCtx.source, barcode: formCtx.barcode,
  };
  const prev = S.foods[food.key] || {};
  S.foods[food.key] = { ...prev, ...food, lastUsed: prev.lastUsed || Date.now(), uses: prev.uses || 0 };
  save();
  if (formCtx.mode === 'edit') { toast('Food updated (past logs unchanged)'); closeSheet(); }
  else openFoodSheet(S.foods[food.key]);
}

// ================= Barcode scanning =================
let camStream = null, scanTimer = null;
function stopCamera() {
  clearTimeout(scanTimer); scanTimer = null;
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
}
async function openScanner() {
  const supported = 'BarcodeDetector' in window;
  openSheet(`${sheetHead('Scan barcode', 'Hold the barcode across the red line')}
    ${supported ? `<div class="scanwrap"><video class="scanner" id="video" playsinline muted></video></div>` :
      `<div class="notice warn small">This browser can't scan barcodes with the camera. Type the number under the barcode instead.</div>`}
    <div id="scanStatus" class="small muted" style="margin:8px 0"></div>
    <form class="searchrow" id="manualForm">
      <input id="manualCode" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="Or type the barcode number">
      <button class="btn" type="submit">Look up</button>
    </form>`);
  $('#manualForm').addEventListener('submit', e => { e.preventDefault(); const c = $('#manualCode').value.replace(/\D/g, ''); if (c) handleBarcode(c); });
  if (!supported) return;
  try {
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    const video = $('#video');
    if (!video) { stopCamera(); return; }
    video.srcObject = camStream;
    await video.play();
    $('#scanStatus').textContent = 'Looking for a barcode…';
    const tick = async () => {
      if (!camStream) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) { const c = codes[0].rawValue; stopCamera(); if (navigator.vibrate) navigator.vibrate(60); handleBarcode(c); return; }
      } catch (e) { /* frame not ready */ }
      scanTimer = setTimeout(tick, 200);
    };
    tick();
  } catch (e) {
    const st = $('#scanStatus');
    if (st) st.textContent = 'Camera unavailable (permission denied?). You can type the number instead.';
  }
}
async function handleBarcode(code) {
  // 1) Already saved on this phone?  2) Open Food Facts.  3) Offer a label photo.
  const norm = c => c.replace(/^0+/, '');
  const local = Object.values(S.foods).find(f => f.barcode && norm(f.barcode) === norm(code));
  if (local) { openFoodSheet(local); return; }
  openSheet(`${sheetHead('Looking up ' + code)}<div class="notice"><span class="spinner"></span>Checking Open Food Facts…</div>`);
  let food = null, failed = false;
  try { food = await lookupOFFBarcode(code); } catch (e) { failed = true; }
  if (!sheetOpen) return;
  if (food) { openFoodSheet(food); return; }
  pendingBarcode = code;
  openSheet(`${sheetHead('Not found', `Barcode ${esc(code)}`)}
    <div class="notice small">${failed ? "Couldn't reach Open Food Facts (check your connection)." : "This product isn't in the database yet."}
      Snap the nutrition label and it'll be saved with this barcode, so next scan finds it instantly.</div>
    <div class="btnrow" style="margin-top:12px">
      <button class="btn primary" data-action="photo">📷 Label photo</button>
      <button class="btn" data-action="new-food">✎ Type it in</button>
    </div>`);
}
let pendingBarcode = '';

// ================= Nutrition label photo (on-device text scan) =================
const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let tessWorker = null, ocrProgress = () => {};
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); });
}
async function getOCR() {
  if (!window.Tesseract) await loadScript(TESS_URL);
  if (!tessWorker) tessWorker = await Tesseract.createWorker('eng', 1, { logger: m => { if (m.status === 'recognizing text') ocrProgress(m.progress); } });
  return tessWorker;
}
async function prepImage(file) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const s = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.naturalWidth * s); cv.height = Math.round(img.naturalHeight * s);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  // Grayscale + contrast stretch: makes label text crisper for the scanner
  const d = ctx.getImageData(0, 0, cv.width, cv.height), px = d.data;
  const hist = new Array(256).fill(0), gray = new Uint8ClampedArray(px.length / 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) { const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0; gray[j] = g; hist[g]++; }
  const total = gray.length; let acc = 0, lo = 0, hi = 255;
  for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc > total * 0.02) { lo = k; break; } }
  acc = 0; for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc > total * 0.02) { hi = k; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) { const v = Math.max(0, Math.min(255, ((gray[j] - lo) * 255) / range)); px[i] = px[i + 1] = px[i + 2] = v; }
  ctx.putImageData(d, 0, 0);
  return { canvas: cv, url };
}
async function handlePhoto(file) {
  if (!file) return;
  openSheet(`${sheetHead('Reading label…')}
    <div class="notice small" id="ocrMsg"><span class="spinner"></span>Preparing photo…</div>
    <div class="progress"><i id="ocrBar"></i></div>
    <p class="small muted">The first scan downloads the text reader (about 10 MB). After that it's quicker.</p>`);
  const code = pendingBarcode; pendingBarcode = '';
  try {
    const { canvas, url } = await prepImage(file);
    if ($('#ocrMsg')) $('#ocrMsg').innerHTML = '<span class="spinner"></span>Loading text reader…';
    ocrProgress = p => { const b = $('#ocrBar'); if (b) b.style.width = Math.round(p * 100) + '%'; const m = $('#ocrMsg'); if (m) m.innerHTML = '<span class="spinner"></span>Reading text…'; };
    const w = await getOCR();
    const { data } = await w.recognize(canvas);
    if (!sheetOpen) return;
    const parsed = parseLabel(data.text || '');
    openFoodForm({ ...parsed.values, barcode: code }, { mode: 'label', img: url, rawText: data.text, found: parsed.found, barcode: code });
  } catch (e) {
    console.error(e);
    openSheet(`${sheetHead('Scan failed')}<div class="notice warn small">Couldn't read the photo${navigator.onLine ? '' : ' (the text reader needs internet the first time)'}. You can type the values in instead.</div>
      <button class="btn primary block" data-action="new-food">✎ Enter manually</button>`);
    pendingBarcode = code;
  }
}

/* Pulls calories, fat, carbs, protein and serving size out of scanned label text.
   OCR often confuses O/0, l/1, and reads "5g" as "59", so we clean those up. */
function parseLabel(raw) {
  const text = raw.replace(/\r/g, '').replace(/[|]/g, ' ');
  const flat = text.replace(/\n+/g, ' \n ');
  const cleanNum = s => {
    let t = s.replace(/[oO]/g, '0').replace(/[lI]/g, '1').replace(',', '.');
    return parseFloat(t);
  };
  // value followed by an optional unit; "59" with no unit is probably "5g"
  const grab = re => {
    const m = flat.match(re);
    if (!m) return null;
    let token = m[1], unit = m[2];
    let v = cleanNum(token);
    if (!isFinite(v)) return null;
    if (!unit && /9$/.test(token) && token.replace(/\D/g, '').length >= 2) v = cleanNum(token.slice(0, -1));
    return v;
  };
  const NUM = '([0-9oOlI]+(?:[.,][0-9]+)?)\\s*(m?g\\b)?';
  const values = {};
  const cal = (() => {
    const m = flat.match(/calories(?!\s*from)[^0-9\n]{0,12}\n?[^0-9]{0,6}([0-9oOlI]{1,4})/i);
    return m ? cleanNum(m[1]) : null;
  })();
  const fat = grab(new RegExp('total\\s*fat[^0-9oOlI]{0,8}' + NUM, 'i'))
    ?? grab(new RegExp('(?<!(?:sat\\w*|trans|poly\\w*|mono\\w*)\\s*)\\bfat[^0-9oOlI]{0,8}' + NUM, 'i'));
  const carbs = grab(new RegExp('(?:total\\s*)?carb\\w*\\.?[^0-9oOlI]{0,8}' + NUM, 'i'));
  const protein = grab(new RegExp('prote\\w*[^0-9oOlI]{0,8}' + NUM, 'i'));
  const sm = text.match(/serving\s*size[:\s]*([^\n]+)/i);
  if (sm) {
    // "(559)" is almost always "(55g)" misread
    const s = sm[1].trim().replace(/\s{2,}/g, ' ').replace(/\((\d+)9\)/, '($1g)');
    values.serving = s.slice(0, 40);
    const gm = s.match(/\(?\s*(\d+(?:\.\d+)?)\s*g\b/i);
    if (gm) values.grams = parseFloat(gm[1]);
  }
  let found = 0;
  if (cal != null && cal < 3000) { values.cal = cal; found++; }
  if (fat != null && fat < 300) { values.f = fat; found++; }
  if (carbs != null && carbs < 500) { values.c = carbs; found++; }
  if (protein != null && protein < 300) { values.p = protein; found++; }
  return { values, found };
}

// ================= Weight actions =================
function saveWeight() {
  const d = $('#wDate').value || todayStr();
  const v = num($('#wVal').value);
  if (v <= 0) { toast('Enter your weight'); return; }
  S.weights[d] = fromUnit(v);
  save(); render(); toast('Weight saved');
}

// ================= Backup =================
function exportBackup() {
  S.settings.lastBackup = todayStr();
  save();
  const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `macro-tracker-backup-${todayStr()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  render();
}
async function importBackup(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.entries) || typeof data.foods !== 'object') throw new Error('bad');
    if (!confirm(`Restore this backup? It has ${data.entries.length} log entries and will REPLACE what's on this phone.`)) return;
    S = mergeDefaults(data); await save(); render(); toast('Backup restored');
  } catch (e) { alert("That file doesn't look like a Macro Tracker backup."); }
}

// ================= Event wiring =================
const actions = {
  nav: el => { view = el.dataset.view; if (view === 'today') curDate = curDate || todayStr(); render(); window.scrollTo(0, 0); },
  day: el => { const n = +el.dataset.n; curDate = n === 0 ? todayStr() : addDays(curDate, n); render(); },
  'open-add': openAddSheet,
  'close-sheet': closeSheet,
  pick: el => { const f = results.get(el.dataset.key) || S.foods[el.dataset.key]; if (f) openFoodSheet(f); },
  chip: el => { $('#amt').value = el.dataset.v; $('#amt').dispatchEvent(new Event('input')); },
  log: doLog,
  'edit-entry': el => {
    const e = S.entries.find(x => x.id === el.dataset.id);
    if (e) openFoodSheet({ ...e.food, key: e.foodKey, source: (S.foods[e.foodKey] || {}).source }, e);
  },
  'delete-entry': () => { S.entries = S.entries.filter(x => x !== sheetEntry); save(); closeSheet(); render(); toast('Deleted'); },
  'edit-food': (el, ev) => { ev.preventDefault(); const f = S.foods[sheetFood.key]; if (f) openFoodForm(f, { mode: 'edit' }); },
  'delete-food': () => {
    if (!confirm('Delete this saved food? Past log entries stay as they are.')) return;
    delete S.foods[formCtx.key]; save(); closeSheet(); toast('Food deleted');
  },
  'new-food': () => openFoodForm({ barcode: pendingBarcode }, { barcode: pendingBarcode }),
  'save-food': saveFoodForm,
  scan: openScanner,
  photo: () => $('#photoCamera').click(),
  'photo-gallery': (el, ev) => { ev.preventDefault(); $('#photoGallery').click(); },
  'trend-range': el => { trendRange = +el.dataset.n; render(); },
  'weight-range': el => { weightRange = +el.dataset.n; render(); },
  'save-weight': saveWeight,
  'delete-weight': el => { if (confirm('Delete this weigh-in?')) { delete S.weights[el.dataset.d]; save(); render(); } },
  unit: el => { S.settings.unit = el.dataset.u; save(); render(); },
  'cal-from-macros': () => { const g = S.settings.goals; g.cal = Math.round(g.p * 4 + g.c * 4 + g.f * 9); save(); render(); toast('Calorie goal updated'); },
  export: exportBackup,
  import: () => $('#importFile').click(),
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el, e);
});
$('#backdrop').addEventListener('click', closeSheet);
$('#photoCamera').addEventListener('change', e => { handlePhoto(e.target.files[0]); e.target.value = ''; });
$('#photoGallery').addEventListener('change', e => { handlePhoto(e.target.files[0]); e.target.value = ''; });
$('#importFile').addEventListener('change', e => { importBackup(e.target.files[0]); e.target.value = ''; });

// When the app comes back to the foreground on a new day, jump to today
let lastSeenDay = todayStr();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && todayStr() !== lastSeenDay) {
    if (curDate === lastSeenDay) curDate = todayStr();
    lastSeenDay = todayStr(); render();
  }
});

// ================= Start up =================
(async function init() {
  S = mergeDefaults(await loadState());
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// Exposed for testing in the browser console
window.__mt = { parseLabel, normOFF, normUSDA, get state() { return S; } };
