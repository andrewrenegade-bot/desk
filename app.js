// app.js - the desk app, STEP 10 full text (plan B: static GitHub Pages + encrypted data files).
// Tabs: Home · Bots · Activity · Account; pushed views: Coin, Audit. Polls every 15 s (plan B).
// Never a made-up number: missing = "—". Error = 1 red row, last good numbers stay.
// Controls (Sell now, pause, settings, PAPER/LIVE) act only through the desk API with a confirmation sheet,
// and only when account.api_base is set; plan B has no route to the desk, so they say "use Telegram".
import { parseFragment, makeKeys, openBlob, coinFile, FILES } from './crypto.js';
const POLL_S = 15, STALE_S = 300, LS = 'desk.d', LIVE_S = 5;
const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
let keys = null, failN = 0, range = 'LIVE', view = 'home', stack = [], coinNow = null;
const D = { state: null, chart: null, activity: null, bots: null, audit: null, account: null };

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (v) => v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const big$ = (v) => v == null ? '—' : v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? '$' + (v / 1e3).toFixed(1) + 'K' : usd(v);
const price$ = (v) => v == null ? '—' : v >= 1 ? usd(v) : '$' + Number(v).toPrecision(4);
const pct = (v, d = 2) => v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`;
const tm = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'never';
const tms = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'never';
const unsk = (...ids) => ids.forEach((i) => $(i) && $(i).classList.remove('sk'));
const ext = (href, text, cls = 'fomo') => href ? `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : '';
const apiBase = () => (D.account && D.account.controls && D.account.controls.api_base) || null;
let ctl = null, ctlTs = 0;                                    // last /api/ping answer
const apiOn = () => !!(apiBase() && ctl && ctl.ok);            // the desk answered with our key
const actOn = () => apiOn() && !!ctl.actions_enabled;           // mutating actions (flag: 6:30 AM CST Nov 27)
async function apiGet(path) {
  const r = await fetch(apiBase() + path, { headers: { authorization: 'Bearer ' + keys.apiToken, 'ngrok-skip-browser-warning': '1' }, cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status)); return r.json();
}
async function pingDesk(force) {
  if (!apiBase()) { ctl = null; return; }
  if (!force && Date.now() - ctlTs < 60000) return;
  ctlTs = Date.now();
  try { ctl = await apiGet('/api/ping'); } catch (e) { ctl = { ok: false, err: e.message }; }
  renderAccount();
}

async function load(name) {
  const r = await fetch(`d/${keys.path}/${FILES[name]}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(name + ' ' + r.status);
  const b = await openBlob(keys, name, await r.arrayBuffer());
  return name.endsWith('.jpg') ? b : JSON.parse(new TextDecoder().decode(b));
}
async function loadCoin(mint) {
  const f = await coinFile(keys, mint);
  const r = await fetch(`d/${keys.path}/coin/${f}.bin?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) return null;
  return JSON.parse(new TextDecoder().decode(await openBlob(keys, `coin/${mint}.json`, await r.arrayBuffer())));
}

// ---------- odometer: changed digits roll 600 ms ease-out, 30 ms stagger; reduced motion = swap
function odometer(el, text) {
  if (el.dataset.v === text) return;
  const old = el.dataset.v || ''; el.dataset.v = text;
  if (RM || !old || old.length !== text.length) { el.textContent = text; return; }
  el.innerHTML = [...text].map((ch, i) => (!/\d/.test(ch) || ch === old[i]) ? `<span>${esc(ch)}</span>`
    : `<span class="dg"><span>${esc(old[i])}<br>${esc(ch)}</span></span>`).join('');
  let k = 0;
  el.querySelectorAll('.dg>span').forEach((s) => { const d = 30 * k++; setTimeout(() => { s.style.transform = 'translateY(-50%)'; }, 20 + d); });
}

// ---------- canvas charts, devicePixelRatio aware
function setup(cv) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h); return [g, w, h];
}
function emptyText(g, w, h, t) { g.fillStyle = 'rgba(235,235,245,.3)'; g.font = '13px -apple-system,system-ui'; g.textAlign = 'center'; g.fillText(t, w / 2, h / 2); }
let lastPtTs = 0, slideRAF = 0;
function drawLine(cv, pts, opt = {}, frac = 1) {
  const [g, w, h] = setup(cv);
  if (!pts || pts.length < 2) return emptyText(g, w, h, opt.emptyText || 'No points yet');
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
  let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  if (opt.start != null) { lo = Math.min(lo, opt.start); hi = Math.max(hi, opt.start); }
  if (hi === lo) { hi += Math.abs(hi) * 0.01 || 1; lo -= Math.abs(lo) * 0.01 || 1; }
  const top = opt.marks ? 76 : 12, bot = 10;
  const X = (t) => ((t - t0) / Math.max(t1 - t0, 1)) * (w - 8) + 4, Y = (v) => top + (1 - (v - lo) / (hi - lo)) * (h - top - bot);
  // the newest point slides in over 250 ms: the last segment grows from the previous point
  const n = pts.length, P = pts.map((p) => [X(p[0]), Y(p[1])]);
  if (frac < 1) { const a = P[n - 2], b = P[n - 1]; P[n - 1] = [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac]; }
  const col = '#00d35a', gr = g.createLinearGradient(0, top, 0, h); gr.addColorStop(0, col + '55'); gr.addColorStop(1, col + '00');
  g.beginPath(); P.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
  g.lineTo(P[n - 1][0], h); g.lineTo(P[0][0], h); g.closePath(); g.fillStyle = gr; g.fill();
  g.beginPath(); P.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
  g.strokeStyle = col; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
  const sv = opt.start ?? pts[0][1];                                     // dashed start line
  g.setLineDash([4, 4]); g.strokeStyle = 'rgba(235,235,245,.3)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, Y(sv)); g.lineTo(w, Y(sv)); g.stroke(); g.setLineDash([]);
  if (opt.marks) {                                                       // marks above the line; a later one moves up a row
    const rows = []; g.font = '600 11px -apple-system,system-ui';
    for (const m of opt.marks.filter((m) => m.ts >= t0 && m.ts <= t1)) {
      const tw = g.measureText(m.text).width + 10, x = Math.min(Math.max(X(m.ts), tw / 2 + 2), w - tw / 2 - 2);
      let r = 0; while ((rows[r] || []).some(([a, b]) => x - tw / 2 < b && x + tw / 2 > a)) r++;
      (rows[r] = rows[r] || []).push([x - tw / 2, x + tw / 2]);
      const y = top - 14 - r * 16; if (y < 2) continue;
      g.fillStyle = m.color; g.beginPath(); g.roundRect ? g.roundRect(x - tw / 2, y - 6, tw, 14, 7) : g.rect(x - tw / 2, y - 6, tw, 14); g.fill();
      g.fillStyle = '#000'; g.textAlign = 'center'; g.fillText(m.text, x, y + 5);
    }
  }
}
function drawCandles(cv, cs, exitLine) {
  const [g, w, h] = setup(cv);
  if (!cs || !cs.length) return emptyText(g, w, h, 'No 1-minute candles in the last 6 h');
  let lo = Math.min(...cs.map((c) => c[3])), hi = Math.max(...cs.map((c) => c[2]));
  if (exitLine != null) { lo = Math.min(lo, exitLine); hi = Math.max(hi, exitLine); }
  if (hi === lo) { hi *= 1.01; lo *= 0.99; }
  const Y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (h - 16), cw = Math.max(2, Math.min(9, (w - 8) / cs.length - 2));
  cs.forEach((c, i) => {
    const x = 4 + (i + 0.5) * ((w - 8) / cs.length), up = c[4] >= c[1];
    g.strokeStyle = g.fillStyle = up ? '#00d35a' : '#ff453a';
    g.beginPath(); g.moveTo(x, Y(c[2])); g.lineTo(x, Y(c[3])); g.lineWidth = 1; g.stroke();
    const y1 = Y(Math.max(c[1], c[4])), y2 = Y(Math.min(c[1], c[4])); g.fillRect(x - cw / 2, y1, cw, Math.max(1, y2 - y1));
  });
  if (exitLine != null) {                                                // orange dashed exit line
    g.setLineDash([5, 4]); g.strokeStyle = '#ff9f0a'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(0, Y(exitLine)); g.lineTo(w, Y(exitLine)); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#ff9f0a'; g.font = '600 11px -apple-system,system-ui'; g.textAlign = 'right'; g.fillText('exit ' + price$(exitLine), w - 4, Y(exitLine) - 4);
  }
}
const RANGES = { LIVE: 3600, '1H': 3600, '4H': 4 * 3600, '1D': 86400, '1W': 7 * 86400, ALL: Infinity };
function marksFrom(rows) {
  return (rows || []).filter((r) => ['bought', 'sold', 'stopped'].includes(r.kind)).map((r) => {
    const sym = (r.title || '').split(' ').slice(1).join(' ');
    if (r.kind === 'bought') return { ts: r.ts, color: '#0a84ff', text: `Bought ${sym}` };
    if (r.kind === 'sold') return { ts: r.ts, color: '#00d35a', text: (r.value || '').split(' · ')[0] };
    const m = /([-+]\d+)%/.exec(r.subtitle || ''); return { ts: r.ts, color: '#ff453a', text: `${m ? m[1] + '%' : ''} · ${r.value || ''}` };
  }).reverse();
}
function renderChart() {
  const all = (D.chart && D.chart.points) || [], now = Date.now() / 1000, span = RANGES[range];
  const pts = all.filter((p) => p[0] >= now - span), cv = $('chart');
  cv.classList.remove('sk');
  const opt = { marks: marksFrom(D.activity && D.activity.rows), start: D.chart && D.chart.night_start_balance, emptyText: 'No balance points in this range' };
  const newest = pts.length ? pts[pts.length - 1][0] : 0;
  cancelAnimationFrame(slideRAF);
  if (!RM && lastPtTs && newest > lastPtTs && pts.length > 1) {
    const t0 = performance.now();
    const step = (t) => { const f = Math.min(1, (t - t0) / 250); drawLine(cv, pts, opt, 1 - (1 - f) ** 2); if (f < 1) slideRAF = requestAnimationFrame(step); };
    slideRAF = requestAnimationFrame(step);
  } else drawLine(cv, pts, opt);
  lastPtTs = newest;
}

// ---------- Home
function renderHome() {
  const s = D.state; if (!s) return;
  unsk('balance', 'sub');
  odometer($('balance'), usd(s.balance));
  $('badge').hidden = s.mode !== 'PAPER';
  $('sub').innerHTML = s.pct_today == null ? 'today —' : `<span class="${s.pct_today >= 0 ? 'up' : 'down'}">${pct(s.pct_today)}</span> today`;
  const mult = s.pct_today == null ? null : 1 + s.pct_today / 100;        // balance / night start
  $('mult').hidden = mult == null; if (mult != null) $('mult').textContent = mult.toFixed(2) + '×';
  $('empty').hidden = (s.trades_total || 0) > 0;
  $('upd').textContent = `Updated ${tm(s.ts)}` + (s.fixture ? ' · FIXTURE DATA' : '');
  renderLive();
}

// LIVE SCREEN card: 16:9, radius 22, double buffered (load into the hidden <img>, swap on load: never flashes)
let front = 'shotA', shotTs = 0, shotUrl = { shotA: null, shotB: null };
const chk3 = (c) => ['screen', 'api', 'chain'].map((k) => `<span class="ck ${c[k] == null ? 'na' : c[k] ? 'ok' : 'no'}" title="${k}">${c[k] == null ? '–' : c[k] ? '✓' : '✗'}<i>${k}</i></span>`).join('');
async function renderLive() {
  const s = D.state, sc = $('screen'), msg = $('screenmsg'), st = s.screen_status || {};
  sc.classList.remove('sk');
  const fts = st.frame_ts || st.ts, age = fts ? Date.now() / 1000 - fts : null;
  $('livetag').innerHTML = age != null && age < LIVE_S ? '<i class="ld red"></i>Live · Bot\'s computer' : `<i class="ld grey"></i>Last frame ${fts ? tms(fts) : '—'}`;
  const ln = s.lane || {};
  $('lanetag').innerHTML = ln.holder ? `<span style="color:${esc(ln.color)}">${esc(ln.holder)} · ${esc(ln.state)}</span>` : 'Idle';
  if (st.paused === 'private') { $(front).hidden = true; msg.hidden = false; msg.textContent = 'Paused · private screen'; }
  else if (!s.screen) { $(front).hidden = true; msg.hidden = false; msg.textContent = 'No frame yet'; }
  else if (Date.now() - shotTs > POLL_S * 1000 - 1000) {
    shotTs = Date.now();
    try {
      const b = await load('screen.jpg'), u = URL.createObjectURL(new Blob([b], { type: 'image/jpeg' }));
      const backId = front === 'shotA' ? 'shotB' : 'shotA', back = $(backId);
      back.onload = () => { back.hidden = false; $(front).hidden = true; if (shotUrl[front]) URL.revokeObjectURL(shotUrl[front]); front = backId; msg.hidden = true; };
      shotUrl[backId] = u; back.src = u;
    } catch (e) { /* keep the last frame */ }
  }
  const o = s.last_order;
  $('liveline').innerHTML = o ? `<span class="lo">${esc(o.title)}</span><span class="cks">${chk3(o.checks || {})}</span>` : '<span class="s">No order yet</span>';
}
function openFull() {
  const img = $(front); if (!img || img.hidden || !img.src) return;
  $('fullimg').src = img.src; $('full').hidden = false; zoom = { s: 1, x: 0, y: 0 }; applyZoom();
  const l = D.state && D.state.screen_status && D.state.screen_status.coin_link;
  $('ffomo').hidden = !l; if (l) $('ffomo').href = l;
}
let zoom = { s: 1, x: 0, y: 0 }, pinch = null;
const applyZoom = () => { $('fullimg').style.transform = `translate(${zoom.x}px,${zoom.y}px) scale(${zoom.s})`; };
const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
$('fz').addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) pinch = { d: dist(e.touches), s: zoom.s };
  else if (e.touches.length === 1) pinch = { px: e.touches[0].clientX - zoom.x, py: e.touches[0].clientY - zoom.y };
}, { passive: true });
$('fz').addEventListener('touchmove', (e) => {
  if (!pinch) return; e.preventDefault();
  if (e.touches.length === 2 && pinch.d) zoom.s = Math.min(5, Math.max(1, pinch.s * dist(e.touches) / pinch.d));
  else if (e.touches.length === 1 && pinch.px != null && zoom.s > 1) { zoom.x = e.touches[0].clientX - pinch.px; zoom.y = e.touches[0].clientY - pinch.py; }
  applyZoom();
}, { passive: false });
$('fz').addEventListener('touchend', () => { pinch = null; if (zoom.s <= 1) { zoom = { s: 1, x: 0, y: 0 }; applyZoom(); } });
$('fz').addEventListener('dblclick', () => { zoom = zoom.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 }; applyZoom(); });

// ---------- bot cards (Home carousel = compact, Bots tab = full width)
function ring(score) {
  const v = score == null ? 0 : Math.max(0, Math.min(100, score)), c = 2 * Math.PI * 17, col = score == null ? 'rgba(235,235,245,.3)' : v >= 70 ? '#00d35a' : '#ff453a';
  return `<svg class="ring" viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" class="rt"/><circle cx="20" cy="20" r="17" stroke="${col}" stroke-dasharray="${c * v / 100} ${c}" transform="rotate(-90 20 20)"/>
    <text x="20" y="24" text-anchor="middle">${score == null ? '—' : Math.round(v)}</text></svg>`;
}
function cardBody(b) {
  if (b.key === 'scanner') return `<div class="feed">${(b.feed || []).slice(0, 4).map((f) => f.passed
    ? `<div class="fi"><span>${esc(f.symbol)}</span><span class="up">→ Analyst</span></div>`
    : `<div class="fi kill"><span><s>${esc(f.symbol)}</s></span><span class="rs">${esc(f.reason || 'killed')}</span></div>`).join('') || '<div class="s">No pools yet</div>'}</div>`;
  if (b.key === 'analyst') return `<div class="an"><div class="strips">${Array.from({ length: 8 }, (_, i) => { const v = (b.strips || [])[i];
    return `<i class="${v == null ? 'na' : v ? 'ok' : 'no'}"></i>`; }).join('')}</div>${ring(b.score)}</div>
    <div class="s">${b.symbol ? esc(b.symbol) + ' · ' : ''}${!b.social_on ? 'Social: off' : b.social_pts == null ? 'Social —' : 'Social ' + (b.social_pts >= 0 ? '+' : '') + b.social_pts}</div>`;
  if (b.key === 'brain') return b.last ? `<div class="bigv">${usd(b.last.usd)} · ${b.last.pct ?? '—'}% of cash</div><div class="s">${esc(b.last.rule)}</div>`
    : `<div class="bigv">—</div><div class="s">${esc(b.rules.join(' / '))}</div>`;
  if (b.key === 'executor') return `<div class="bar ${b.bar && b.bar.startsWith('✓') ? 'done' : ''}">${esc(b.bar || 'No order yet')}</div>`;
  if (b.key === 'risk') return `<div class="pills">${b.pills.map((p) => `<span class="pill th ${p.tone}">${esc(p.text)}</span>`).join('')}</div>
    <div class="s">${b.open ? b.open + ' open' : 'No open position'}</div>`;
  return '';
}
const dotOf = (b) => `<i class="sd ${b.status === 'running' ? 'on' : b.status === 'paused' ? 'pz' : 'off'}"></i>`;
const cardHead = (b) => `<div class="bh"><i class="cd" style="background:${esc(b.color)}"></i><span class="bn">${esc(b.name)}</span>${dotOf(b)}</div>
  <div class="hl" style="color:${esc(b.color)}">${esc(b.headline)}</div>`;
function renderBots() {
  const b = D.bots; if (!b || !b.cards) return;
  $('botshead').textContent = `Bots · ${b.running} running`;
  $('carousel').innerHTML = b.cards.map((x) => `<a class="bc" data-tab="bots">${cardHead(x)}${cardBody(x)}</a>`).join('');
  $('botsince').textContent = `Since night start ${new Date(b.since * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
  $('botfull').innerHTML = b.cards.map((x) => `<div class="card bot">
    <div class="bh"><i class="cd" style="background:${esc(x.color)}"></i><span class="bn">${esc(x.name)}</span>${dotOf(x)}
      <span class="cnt">${x.count} today</span>
      <button class="sw ${x.paused ? '' : 'on'} ${x.pause_locked ? 'locked' : ''}" data-pause="${esc(x.key)}" role="switch" aria-checked="${!x.paused}"
        aria-label="${esc(x.name)} running" ${x.pause_locked ? 'aria-disabled="true"' : ''}></button></div>
    ${x.pause_locked ? '<div class="note">Locked while a position is open</div>' : ''}
    <div class="hl" style="color:${esc(x.color)}">${esc(x.headline)}</div>${cardBody(x)}
    <details class="dec"><summary>Last ${Math.min(20, x.decisions.length)} decisions</summary>${x.decisions.slice(0, 20).map((d) => `<div class="r sm">
      <span class="l"><span class="${d.ok ? '' : 'dim'}">${esc(d.symbol)}</span><span class="s">${tm(d.ts)} · ${esc(d.text)}</span></span>${ext(d.link, 'FOMO')}</div>`).join('') || '<div class="note">None since night start</div>'}</details>
    <button class="r link" data-settings="${esc(x.key)}"><span class="l">Settings</span><span class="v chev">›</span></button></div>`).join('');
}

// ---------- Activity
function actRow(x) {
  const go = x.mint ? (x.open === 'audit' ? `data-audit="${esc(x.mint)}"` : `data-coin="${esc(x.mint)}"`) : '';
  const vcls = /^\+/.test(x.value || '') ? 'up' : /^-/.test(x.value || '') ? 'down' : x.kind === 'rejected' ? 'dim' : '';
  return `<div class="r act"><a class="l" ${go}>${esc(x.title)}<span class="s">${esc(x.subtitle)}</span></a>
    <span class="v"><span class="${vcls}">${esc(x.value)}</span>${x.link ? '<br>' + ext(x.link, 'Open on FOMO') : ''}</span></div>`;
}
function renderActivity() {
  const a = D.activity; if (!a) return;
  const rows = (a.rows || []).slice(0, 100);
  $('actempty').hidden = rows.length > 0; $('actrows').hidden = !rows.length;
  $('actrows').innerHTML = rows.map(actRow).join('');
  $('homeact').innerHTML = rows.slice(0, 5).map(actRow).join('') || '<div class="r"><span class="l s">Nothing yet tonight</span></div>';
  $('dot').hidden = !rows.some((x) => /unverified|logged out/i.test(x.title || '') && Date.now() / 1000 - x.ts < 86400);
}

// ---------- Audit: 8 discs, a cyan beam reads each layer, then green check or red
let beamDone = new Set();
function renderAudit(focus) {
  const a = D.audit; if (!a) return;
  $('auditempty').hidden = a.rows.length > 0;
  $('auditrows').innerHTML = a.rows.map((r) => {
    const L = Array.from({ length: 8 }, (_, i) => r.layers.find((l) => Number(l.layer) === i + 1) || null);
    const anim = !RM && view === 'audit' && !beamDone.has(r.mint + r.ts);
    return `<div class="card aud" id="au-${esc(r.mint)}"><a class="r" data-coin="${esc(r.mint)}"><span class="l"><b>${esc(r.symbol || r.mint.slice(0, 6))}</b>
      <span class="s">${tm(r.ts)} · ${esc(r.reason || '')}</span></span><span class="v">${ring(r.score)}</span></a>
      <div class="discs ${anim ? 'scan' : ''}">${L.map((l, i) => `<span class="disc ${l == null ? 'na' : l.pass ? 'ok' : 'no'}" style="--i:${i}">${l == null ? i + 1 : l.pass ? '✓' : '✗'}</span>`).join('')}<i class="beam"></i></div>
      ${L.map((l, i) => l ? `<div class="layer"><span class="n ${l.pass ? 'g' : 'rd'}">${i + 1}</span><span class="txt">${esc(l.name)}<span class="s">${esc(l.value_text ?? 'no data')}</span></span>
        <span class="v ${l.pass ? 'up' : 'down'}">${l.pass ? '✓' : '✗'}</span></div>` : '').join('') || '<div class="note">Refused before the layers</div>'}
      <div class="layer soc"><span class="txt">${esc(r.social_row || 'Social: off')}</span></div>
      ${ext(r.link, 'Open on FOMO', 'btn sec')}</div>`;
  }).join('');
  if (view === 'audit') a.rows.forEach((r) => beamDone.add(r.mint + r.ts));   // the beam reads each coin once, on screen
  if (focus) { const e = document.getElementById('au-' + focus); if (e) e.scrollIntoView({ block: 'start' }); }
}

// ---------- Coin
async function openCoin(mint) {
  push('coin'); coinNow = mint;
  $('cname').textContent = 'Coin'; $('cname').classList.add('sk'); $('cchart').classList.add('sk');
  $('cbody').innerHTML = '<div class="card sk tall"></div>'; $('csub').textContent = ''; $('cshield').hidden = true; $('cprice').textContent = '—'; $('centry').textContent = '';
  let c = null; try { c = await loadCoin(mint); } catch (e) { c = null; }
  if (coinNow !== mint) return;
  unsk('cname', 'cchart');
  const fromAudit = (D.audit && D.audit.rows.find((r) => r.mint === mint)) || {};
  const sym = (c && c.symbol) || fromAudit.symbol || mint.slice(0, 6);
  $('cname').textContent = (c && c.name) || sym;
  $('csub').textContent = `${sym} · Solana · ${c && c.age_h != null ? (c.age_h < 1 ? Math.round(c.age_h * 60) + 'm' : Math.round(c.age_h) + 'h') + ' old' : 'age —'}`;
  if (c && c.shield && c.shield.read) { $('cshield').hidden = false; $('cshield').textContent = `${c.shield.pass}/${c.shield.of}`; $('cshield').className = 'shield ' + (c.shield.pass === 8 ? 'ok' : 'no'); }
  $('cbadge').hidden = !(D.state && D.state.mode === 'PAPER');
  $('cprice').textContent = price$(c && c.price);
  $('centry').innerHTML = c && c.since_entry_pct != null ? `<span class="${c.since_entry_pct >= 0 ? 'up' : 'down'}">${c.since_entry_pct >= 0 ? '▲' : '▼'} ${Math.abs(c.since_entry_pct).toFixed(1)}% since entry</span>` : '';
  drawCandles($('cchart'), c && c.candles, c && c.exit_line);
  const link = (c && c.link) || fromAudit.link;
  if (!c) { $('cbody').innerHTML = '<div class="empty">This coin isn\'t in the last 24 h of data</div>' + ext(link, 'Open on FOMO', 'btn'); return; }
  const p = c.position, open = p && p.open;
  $('cbody').innerHTML = `<div class="stats3"><div><span>Market cap</span><b>${big$(c.market_cap)}</b></div><div><span>Liquidity</span><b>${big$(c.liquidity)}</b></div>
      <div><span>Holders</span><b>${c.holders == null ? '—' : Number(c.holders).toLocaleString()}</b></div></div>
    ${p ? `<div class="card"><div class="r"><span class="l">Your position<span class="s">${usd(p.size_usd)} in · ${esc(p.bot)}${open ? '' : ' · closed'}</span></span></div></div>` : ''}
    <div class="btns">${ext(link, 'Open on FOMO', 'btn')}${open ? `<button class="btn red" data-sell="${esc(mint)}" data-sym="${esc(sym)}">Sell now</button>` : ''}</div>
    ${c.social_row ? `<div class="note">${esc(c.social_row)}</div>` : ''}`;
}

// ---------- sheets (confirmation), toast
function sheet(html) { $('sheet').innerHTML = `<div class="grab"></div>${html}`; $('sheet').hidden = false; $('scrim').hidden = false; }
function closeSheet() { $('sheet').hidden = true; $('scrim').hidden = true; }
function toast(t) { const e = $('toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { e.hidden = true; }, 2200); }
const offNote = (cmd) => actOn() ? '' : apiOn()
  ? '<p class="note">Desk connected. Actions open at 6:30 AM CST, after the PAPER night.</p>'
  : `<p class="note">The app can't reach the desk right now. Send <b>${esc(cmd)}</b> to the desk bot in Telegram.</p>`;
async function api(path, body, retry = true) {
  let r;
  try { r = await fetch(apiBase() + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + keys.apiToken, 'ngrok-skip-browser-warning': '1' }, body: JSON.stringify(body) }); }
  catch (e) {                                                   // the tunnel URL may have changed: re-read the pointer once
    const was = apiBase(); try { D.account = await load('account.json'); } catch (e2) { /* keep */ }
    if (retry && apiBase() && apiBase() !== was) return api(path, body, false);
    throw new Error('desk not reachable');
  }
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.detail || r.status); return j;
}
function sellSheet(mint, sym) {
  let p = 50;
  const draw = () => sheet(`<h3>Sell ${esc(sym)}</h3><div class="seg big3">${[25, 50, 100].map((v) => `<button data-pct="${v}" class="${v === p ? 'on' : ''}">${v}%</button>`).join('')}</div>
    <button class="btn red" id="confirmsell" ${actOn() ? '' : 'disabled'}>Confirm sell</button>${offNote(`sell ${sym} ${p}`)}<button class="btn sec wide" data-close>Cancel</button>`);
  draw();
  $('sheet').onclick = async (e) => {
    const b = e.target.closest('[data-pct],#confirmsell,[data-close]'); if (!b) return;
    if (b.dataset.pct) { p = Number(b.dataset.pct); draw(); }
    else if (b.hasAttribute('data-close')) closeSheet();
    else if (actOn()) { try { const j = await api('/api/sell', { mint, pct: p, confirm: true }); toast(j.reply || 'Sent'); } catch (err) { toast('Desk said no: ' + err.message); } closeSheet(); }
  };
}
function confirmSheet(title, body, cmd, payload) {
  sheet(`<h3>${esc(title)}</h3><p class="s">${esc(body)}</p><button class="btn" id="cfm" ${actOn() ? '' : 'disabled'}>Confirm</button>${offNote(cmd)}<button class="btn sec wide" data-close>Cancel</button>`);
  $('sheet').onclick = async (e) => {
    const b = e.target.closest('#cfm,[data-close]'); if (!b) return;
    if (b.id === 'cfm' && actOn()) { try { const j = await api('/api/cmd', { text: cmd, confirm: true, ...payload }); toast(j.reply || 'Done'); } catch (err) { toast('Desk said no: ' + err.message); } }
    closeSheet();
  };
}

// ---------- Account
const BOTGROUP = { scanner: 'Scanner', analyst: 'Analyst', social: 'Analyst · Social', brain: 'Brain', executor: 'Executor', risk: 'Risk', desk: 'Desk' };
function setRow(i) {
  if (i.min == null) return `<div class="r"><span class="l">${esc(i.name)}</span><span class="v">${esc(i.value === '' ? 'not set' : i.value)}</span></div>`;
  const stp = Number.isInteger(i.min) && Number.isInteger(i.max) && Number.isInteger(i.value) ? 1 : (i.max - i.min) / 100;
  return `<div class="set1"><div class="sh2"><span>${esc(i.name)}</span><b class="num" id="n-${esc(i.key)}">${esc(i.value)}</b></div>
    <input type="range" min="${i.min}" max="${i.max}" step="${stp}" value="${i.value}" data-set="${esc(i.key)}" data-was="${i.value}" aria-label="${esc(i.key)}">
    <div class="mm"><span>${esc(i.min)}</span><span>${esc(i.max)}</span></div></div>`;
}
function renderAccount() {
  const a = D.account; if (!a) return;
  const picks = a.picks || { lists: [] }, last = picks.lists[0], sch = a.copy_schedule || { every: 'off', at: null }, n = a.notifications || {};
  const pickCard = (p) => `<div class="card pick"><div class="h"><b>${esc(p.handle)}</b>${ext(p.profile, 'Profile', 'btn sec')}</div>
    <div class="nums"><span class="up">7d ${p.pnl7d == null ? '—' : '+' + usd(p.pnl7d)}</span><span class="up">30d ${p.pnl30d == null ? '—' : '+' + usd(p.pnl30d)}</span></div>
    <div class="s">${p.trades ?? '—'} trades · last trade ${esc(p.last_trade_cst || '—')}</div>
    ${p.why ? `<div class="s why">${esc(p.why)}</div>` : ''}
    ${p.last_buy && (p.last_buy.link || p.last_buy_text) ? (p.last_buy.link ? `<a class="r" href="${esc(p.last_buy.link)}" target="_blank" rel="noopener noreferrer"><span class="l">Last buy<span class="s">${esc(p.last_buy_text || '')}</span></span><span class="v chev">›</span></a>` : `<div class="r"><span class="l">Last buy<span class="s">${esc(p.last_buy_text || '')}</span></span></div>`) : ''}
    <div class="r copyrow"><span class="l">Copy on desk<span class="s">off by default · max 2</span></span>
      <button class="sw ${p.copy_on_desk ? 'on' : ''}" data-copy="${esc(p.handle)}" role="switch" aria-checked="${p.copy_on_desk ? 'true' : 'false'}" aria-label="Copy on desk ${esc(p.handle)}"></button></div></div>`;
  const prevList = (lst) => `<div class="card prev-list"><div class="s">${esc(lst.as_of || '')}</div>
    <div class="handles">${(lst.picks || []).map((x) => esc(x.handle)).join(' · ') || '—'}</div></div>`;
  const ctlRow = !apiBase() ? '<div class="r"><span class="l">Desk controls<span class="s">no tunnel to the desk: use the desk bot in Telegram</span></span><span class="v down">Off</span></div>'
    : !ctl ? '<div class="r"><span class="l">Desk controls<span class="s">checking…</span></span></div>'
    : !ctl.ok ? `<div class="r"><span class="l">Desk controls<span class="s">desk not reachable (${esc(ctl.err)}) · retrying</span></span><span class="v down">Offline</span></div>`
    : `<div class="r"><span class="l">Desk controls<span class="s">${ctl.actions_enabled ? 'actions on · every change asks first' : 'read-only until 6:30 AM CST (after the PAPER night)'}</span></span><span class="v up">Connected</span></div>
       <button class="r link" id="deskstatus"><span class="l">Desk status now<span class="s">asks the desk directly</span></span><span class="v chev">›</span></button>`;
  const ctlCard = `<div class="card">${ctlRow}</div>`;
  $('acct').innerHTML =
    `<div class="card"><div class="seg two" id="mode"><button data-mode="PAPER" class="${a.mode === 'PAPER' ? 'on' : ''}">PAPER</button><button data-mode="LIVE" class="${a.mode === 'LIVE' ? 'on' : ''}">LIVE</button></div>
      <p class="note">${esc(a.live_rule)}</p>
      <label class="r"><span class="l">Cash<span class="s">PAPER start cash</span></span><input class="cash" id="cash" inputmode="decimal" value="${esc(a.cash ?? '')}" data-was="${esc(a.cash ?? '')}" aria-label="cash"></label>
      ${a.profile ? `<a class="r" href="${esc(a.profile)}" target="_blank" rel="noopener noreferrer"><span class="l">Your FOMO profile<span class="s">@${esc(a.handle)}</span></span><span class="v chev">›</span></a>` : '<div class="r"><span class="l">Your FOMO profile<span class="s">handle not set</span></span></div>'}
      <button class="r link" id="invite"><span class="l">Invite a friend<span class="s">your FOMO invite link</span></span><span class="v chev">›</span></button></div>
    ${ctlCard}
    <div class="list"><h2>Copy picks</h2><div class="card"><div class="seg four" id="every">${['off', '24h', '12h', '6h'].map((v) => `<button data-every="${v}" class="${sch.every === v ? 'on' : ''}">${v === 'off' ? 'Off' : 'Every ' + v}</button>`).join('')}</div>
      <label class="r"><span class="l">Time<span class="s">first list of the day, CST</span></span><input type="time" id="picktime" value="${esc(sch.at || '09:00')}" ${sch.every === 'off' ? 'disabled' : ''}></label></div>
      ${last ? `<p class="since">${esc(last.as_of || '')} · newest on top</p>${last.picks.map(pickCard).join('')}` : '<div class="empty">No copy picks yet</div>'}
      ${(picks.lists || []).slice(1, 8).length ? `<h2>Last 7 lists</h2>${picks.lists.slice(1, 8).map(prevList).join('')}` : ''}</div>
    <div class="list"><h2>Pushes</h2><div class="card">
      <div class="r"><span class="l">Telegram<span class="s">${esc(n.row || '')}</span></span><span class="v ${n.telegram_on ? 'up' : 'down'}">${n.telegram_on ? 'Connected' : 'Not connected'}</span></div>
      <button class="r link" id="testpush"><span class="l">Send test push</span><span class="v chev">›</span></button>
      ${a.watch_url ? `<a class="r" href="${esc(a.watch_url)}" target="_blank" rel="noopener noreferrer"><span class="l">Watch in Grok Bot<span class="s">the bot's own computer</span></span><span class="v chev">›</span></a>`
        : '<div class="r"><span class="l">Watch in Grok Bot<span class="s">open the bot\'s computer preview from the Grok Bot app</span></span></div>'}</div></div>
    <div class="list"><h2>Settings</h2>${a.settings.map((g) => `<details class="card set" id="sg-${esc(g.group)}"><summary class="r"><span class="l">${esc(BOTGROUP[g.group] || g.group)}<span class="s">${g.items.length} settings</span></span><span class="v chev">›</span></summary>
      ${g.items.map(setRow).join('')}</details>`).join('')}</div>
    <div class="list"><h2>Recent changes</h2><div class="card">${(a.changes || []).map((c) => `<div class="r"><span class="l">${esc(c.key)}<span class="s">${esc(c.who)} · ${new Date(c.ts * 1000).toLocaleDateString()}</span></span><span class="v">${esc(c.old)} → ${esc(c.new)}</span></div>`).join('') || '<div class="note">None</div>'}</div></div>`;
}
async function invite() {
  const u = D.account && D.account.signup; if (!u) return;
  if (navigator.share) { try { await navigator.share({ title: 'FOMO', url: u }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(u); toast('Link copied'); } catch (e) { toast(u); }
}

// ---------- navigation and events
function show(v) {
  document.querySelectorAll('.view').forEach((e) => { e.hidden = e.id !== 'v-' + v; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === (['coin', 'audit'].includes(v) ? stack[0] || 'home' : v)));
  view = v; scrollTo(0, 0); if (v === 'home') renderChart();
}
function push(v) { stack.push(view); show(v); }
function back() { show(stack.pop() || 'home'); }
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab],[data-coin],[data-audit],[data-back],#toaudit,#avatar,#who,#bell,[data-range],#screen,#fclose,#scrim,[data-sell],[data-pause],[data-settings],[data-mode],[data-every],[data-copy],#invite,#testpush,#deskstatus');
  if (!t || t.closest('#sheet')) return;
  if (t.dataset.tab) { stack = []; show(t.dataset.tab); }
  else if (t.dataset.coin) { e.preventDefault(); $('results').hidden = true; openCoin(t.dataset.coin); }
  else if (t.dataset.audit) { e.preventDefault(); push('audit'); renderAudit(t.dataset.audit); }
  else if (t.hasAttribute('data-back')) back();
  else if (t.id === 'toaudit') { push('audit'); renderAudit(); }
  else if (t.id === 'avatar' || t.id === 'who') { stack = []; show('account'); }
  else if (t.id === 'bell') { stack = []; show('activity'); }
  else if (t.id === 'screen') openFull();
  else if (t.id === 'fclose') $('full').hidden = true;
  else if (t.id === 'scrim') closeSheet();
  else if (t.dataset.sell) sellSheet(t.dataset.sell, t.dataset.sym);
  else if (t.dataset.pause) {
    const b = D.bots.cards.find((x) => x.key === t.dataset.pause);
    if (b.pause_locked) { toast('Risk stays on while a position is open'); return; }
    confirmSheet(`${b.paused ? 'Resume' : 'Pause'} ${b.name}?`, b.paused ? `${b.name} starts working again.` : `${b.name} stops taking new work. Open positions stay guarded by Risk.`,
      `pause ${b.key}${b.paused ? ' off' : ''}`, {});
  }
  else if (t.dataset.settings) { stack = []; show('account'); const g = $('sg-' + (t.dataset.settings === 'analyst' ? 'analyst' : t.dataset.settings)); if (g) { g.open = true; g.scrollIntoView({ block: 'start' }); } }
  else if (t.dataset.mode) {
    if (t.dataset.mode === (D.account && D.account.mode)) return;
    if (t.dataset.mode === 'LIVE') sheet(`<h3>Switch to LIVE?</h3><p class="s">${esc(D.account.live_rule)}. Type LIVE to go on.</p><input id="typelive" class="typelive" autocapitalize="characters" placeholder="LIVE">
      <button class="btn red" id="golive" disabled>Switch to LIVE</button>${offNote('live')}<button class="btn sec wide" data-close>Cancel</button>`), wireLive();
    else confirmSheet('Switch to PAPER?', 'New orders are paper fills from now on.', 'paper', {});
  }
  else if (t.dataset.every) confirmSheet(`Copy picks ${t.dataset.every === 'off' ? 'off' : 'every ' + t.dataset.every}?`, 'The picks list is posted on this schedule.', `picks every ${t.dataset.every}`, {});
  else if (t.dataset.copy) {
    const on = !!(D.account && (D.account.picks || {}).lists && D.account.picks.lists[0] && D.account.picks.lists[0].picks.find((x) => x.handle === t.dataset.copy && x.copy_on_desk));
    confirmSheet(`${on ? 'Turn off' : 'Turn on'} Copy on desk for ${t.dataset.copy}?`,
      on ? 'The desk will stop copying their new trades. Open copy positions stay under Risk.'
         : 'Existing swaps are marked seen (no old trades). New buys are copied in PAPER: half size, 30s delay, -25% stop. Max 2 traders.',
      `copy ${on ? 'off' : 'on'} ${t.dataset.copy}`, {});
  }
  else if (t.id === 'invite') invite();
  else if (t.id === 'deskstatus') api('/api/cmd', { text: 'status' }).then((j) => sheet(`<h3>Desk status</h3><pre class="rep">${esc(j.reply)}</pre>
      ${(j.buttons || []).map(([l, u]) => ext(u, l, 'btn sec')).join('')}<button class="btn sec wide" data-close>Close</button>`)).catch((e) => toast('Desk: ' + e.message));
  else if (t.id === 'testpush') confirmSheet('Send a test push?', 'The desk bot sends "PAPER · Test push" to Telegram.', 'test push', {});
  else if (t.dataset.range) { range = t.dataset.range; document.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('on', b === t)); lastPtTs = 0; renderChart(); }
});
function wireLive() {
  $('sheet').onclick = async (e) => {
    const b = e.target.closest('#golive,[data-close]'); if (!b) return;
    if (b.id === 'golive' && actOn()) { try { const j = await api('/api/cmd', { text: 'live', typed: $('typelive').value, confirm: true }); toast(j.reply || 'Done'); } catch (err) { toast('Desk said no: ' + err.message); } }
    closeSheet();
  };
  $('typelive').oninput = () => { $('golive').disabled = !(actOn() && $('typelive').value === 'LIVE'); };
}
document.addEventListener('input', (e) => { const t = e.target; if (t.dataset && t.dataset.set) $('n-' + t.dataset.set).textContent = t.value; });
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.set) confirmSheet(`Set ${t.dataset.set} to ${t.value}?`, `Now ${t.dataset.was}. The change goes to change_log.`, `set ${t.dataset.set} to ${t.value}`, {});
  else if (t.id === 'cash') confirmSheet(`Set cash to $${t.value}?`, `Now $${t.dataset.was}.`, `set desk.paper_start_cash to ${t.value}`, {});
  else if (t.id === 'picktime') confirmSheet(`Copy picks at ${t.value}?`, 'Time is CST.', `picks at ${t.value}`, {});
});
$('scrim').addEventListener('click', closeSheet);
$('sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
$('ranges').innerHTML = Object.keys(RANGES).map((r) => `<button data-range="${r}" class="${r === range ? 'on' : ''}">${r}</button>`).join('');
$('q').addEventListener('input', () => {
  const q = $('q').value.trim().toLowerCase(), box = $('results');
  if (!q) { box.hidden = true; return; }
  const seen = new Map();
  for (const p of (D.state && D.state.open) || []) seen.set(p.mint, p.symbol);
  for (const r of (D.audit && D.audit.rows) || []) seen.set(r.mint, r.symbol || r.name);
  for (const r of (D.activity && D.activity.rows) || []) if (r.mint && !seen.has(r.mint)) seen.set(r.mint, (r.title || '').split(' ').slice(1).join(' '));
  const hit = [...seen].filter(([m, s]) => m.toLowerCase().startsWith(q) || (s || '').toLowerCase().includes(q)).slice(0, 8);
  box.hidden = false;
  box.innerHTML = hit.length ? hit.map(([m, s]) => `<a class="r" data-coin="${esc(m)}"><span class="l">${esc(s || m.slice(0, 6))}<span class="s">${esc(m.slice(0, 6))}…${esc(m.slice(-4))}</span></span><span class="v chev">›</span></a>`).join('')
    : '<div class="r"><span class="l s">No coin in tonight\'s data. Paste the mint in chat.</span></div>';
});
addEventListener('resize', () => { if (view === 'home') { lastPtTs = 0; renderChart(); } });

function showError(n) {
  const e = $('err'); e.hidden = false;
  e.textContent = `Desk offline · retrying in ${n}s · last update ${tm(D.state && D.state.ts)}`;
}
async function tick() {
  let next = POLL_S;
  try {
    D.state = await load('state.json');
    renderHome(); failN = 0;
    if (Date.now() / 1000 - D.state.ts > Math.max(STALE_S, 2 * (D.state.push_every_s || 0) + 180)) showError(next); else $('err').hidden = true;
    for (const [k, f, r] of [['activity', 'activity.json', renderActivity], ['chart', 'chart.json', () => {}], ['bots', 'bots.json', renderBots],
                             ['audit', 'audit.json', () => { if (view !== 'audit') renderAudit(); }], ['account', 'account.json', () => { renderAccount(); pingDesk(); }]]) {
      try { D[k] = await load(f); r(); } catch (e) { /* keep the last good one */ }
    }
    if (view === 'home') renderChart();
  } catch (e) {
    failN++; next = Math.min(POLL_S * 2 ** Math.min(failN - 1, 3), 120);
    showError(next);
  }
  setTimeout(tick, next * 1000);
}
async function start() {
  let frag = parseFragment(location.hash);
  if (frag) { localStorage.setItem(LS, location.hash.slice(1)); history.replaceState(null, '', location.pathname); }
  else frag = parseFragment('#' + (localStorage.getItem(LS) || ''));
  if (!frag) { $('nokey').hidden = false; unsk('balance', 'sub', 'chart', 'screen'); $('balance').textContent = '—'; $('sub').textContent = ''; return; }
  keys = await makeKeys(frag.path, frag.secret);
  tick();
}
window.addEventListener('hashchange', () => { if (parseFragment(location.hash)) location.reload(); });
start();
