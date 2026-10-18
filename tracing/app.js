'use strict';
// FlUni contact-tracing demo. Data: tracing/out/<run>/tracing.json (built by tracing/build.py).
const qs = new URLSearchParams(location.search);
const RUN = qs.get('run') || 'influenza_none_n1000_d4_s42_73b8452c';
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TYPE_NAMES = { dorm: 'dorm', dining: 'dining hall', library: 'library', classroom: 'classrooms', lecture_hall: 'lecture hall', gym: 'gym' };

const state = { rule: 'dose', thr: 0.02, truth: qs.get('truth') === '1', caseId: qs.get('case'), sel: null };
let D, map, layers = {};

const $ = (id) => document.getElementById(id);
const pct = (p) => (p >= 0.1 ? Math.round(p * 100) : p >= 0.01 ? (p * 100).toFixed(1) : (p * 100).toFixed(2)) + '%';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function when(t) {
  const d = new Date(new Date(D.start).getTime() + t * D.step_min * 60000);
  return `${DAY[d.getDay()]} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
const bname = (loc) => (D.buildings[loc] ? D.buildings[loc].name : loc === 'outdoors' ? 'Outdoors' : loc === 'OFF_CAMPUS' ? 'off campus' : loc);

// One row per person the case met (their pair-days merged): notified if any day meets the rule.
function people(c) {
  const by = new Map();
  for (const x of c.contacts) {
    let p = by.get(x.other);
    if (!p) by.set(x.other, (p = { other: x.other, days: [], minutes: 0, max6: 0, closest: 99, noLam: 1, t0: x.t0, where: x.where, room: x.room, topLam: -1 }));
    p.days.push(x);
    p.minutes += x.minutes;
    p.max6 = Math.max(p.max6, x.minutes6ft);
    p.closest = Math.min(p.closest, x.closest_m);
    p.noLam *= 1 - x.lambda;
    p.t0 = Math.min(p.t0, x.t0);
    if (x.lambda > p.topLam) Object.assign(p, { topLam: x.lambda, where: x.where, room: x.room, topT: x.t0 });
  }
  const tr = D.truth;
  return [...by.values()].map((p) => {
    p.lambda = 1 - p.noLam;
    p.cdc = p.max6 >= 15;
    p.dose = p.lambda >= state.thr;
    p.infected = tr[p.other] && tr[p.other].by === c.id;
    p.app = !!D.has_app[p.other];
    return p;
  }).sort((a, b) => b.lambda - a.lambda);
}
const notified = (p, rule = state.rule) => (rule === 'cdc' ? p.cdc : p.dose);

// Everyone each case infected while they could have been traced (lookback through the day after reporting).
function secondaries(c) {
  const hi = c.t_report + 24 * 60 / D.step_min;
  return Object.entries(D.truth).filter(([, v]) => v.by === c.id && v.t <= hi).map(([k]) => k);
}

function score(rule) {
  let n = 0, hit = 0, sec = 0, noContact = 0;
  for (const c of D.cases) {
    const ps = people(c), s = new Set(secondaries(c));
    sec += s.size;
    const seen = new Set(ps.map((p) => p.other));
    for (const k of s) if (!seen.has(k)) noContact++;
    for (const p of ps) if (notified(p, rule)) { n++; if (s.has(p.other)) hit++; }
  }
  return { n, hit, sec, noContact };
}

function renderScore() {
  const me = score(state.rule), other = score(state.rule === 'cdc' ? 'dose' : 'cdc');
  const otherName = state.rule === 'cdc' ? `FlUni dose ≥ ${pct(state.thr)}` : 'the CDC 15-min rule';
  $('score').innerHTML = `
    <h2>Across all ${D.cases.length} reported cases</h2>
    <div class="big">
      <div><b>${me.n}</b><span>people notified</span></div>
      <div><b>${me.hit}/${me.sec}</b><span>infections caught</span></div>
      <div><b>${me.n ? Math.round(me.n / Math.max(me.hit, 1)) : 0}</b><span>alerts per catch</span></div>
    </div>
    <p class="vs">vs ${otherName}: <b>${other.n}</b> notified, <b>${other.hit}/${other.sec}</b> caught.
    ${me.noContact ? `${me.noContact} infection${me.noContact > 1 ? 's' : ''} came from shared air with no close contact logged.` : ''}</p>`;
}

function renderCases() {
  $('casecount').textContent = `· ${D.cases.length} · sorted by report time`;
  $('cases').innerHTML = D.cases.map((c) => {
    const ps = people(c), n = ps.filter((p) => notified(p)).length;
    const how = c.t_positive != null && c.t_positive <= c.t_report ? 'positive test' : 'self-reported sick';
    return `<li data-id="${c.id}" class="${c.id === state.caseId ? 'on' : ''}">
      <span class="who">Case ${esc(c.id)}</span><span class="n">${n} notified</span>
      <span class="when">${when(c.t_report)} · ${how}</span></li>`;
  }).join('');
  for (const li of $('cases').children) li.onclick = () => selectCase(li.dataset.id === state.caseId ? null : li.dataset.id);
}

function renderDetail() {
  const c = D.cases.find((x) => x.id === state.caseId);
  if (!c) {
    $('detailhead').innerHTML = `<h3>Pick a case</h3><span class="hint">Each case is a student who told FlUni they're sick. We look back ${D.lookback_days} days at who they were near, estimate each person's chance of catching it, and decide who gets an alert.</span>`;
    $('contacts').innerHTML = '';
    return;
  }
  const ps = people(c), sec = new Set(secondaries(c));
  const nN = ps.filter((p) => notified(p)).length;
  const caught = ps.filter((p) => notified(p) && sec.has(p.other)).length;
  $('detailhead').innerHTML = `<h3>Case ${esc(c.id)} · reported ${when(c.t_report)}</h3>
    <span class="hint">${esc(c.archetype)}${c.dorm && c.dorm !== 'OFF_CAMPUS' ? ' · lives in ' + esc(bname(c.dorm)) : ' · lives off campus'} · ${c.visits.length} places in the ${D.lookback_days} days before ·
    ${ps.length} people nearby · <b>${nN} notified</b>${state.truth ? ` · infected ${sec.size}, caught ${caught}` : ''}</span>`;
  const shown = ps.filter((p) => p.lambda >= 0.001 || p.cdc || p.infected).slice(0, 300);
  const maxLam = Math.max(...shown.map((p) => p.lambda), 0.01);
  $('contacts').innerHTML = `<thead><tr><th>Person</th><th>First met</th><th>Where (most risky)</th>
    <th class="num">Minutes near</th><th class="num">Within 6 ft (max/day)</th><th class="num">Closest</th>
    <th>Chance they caught it</th><th>Alert?</th>${state.truth ? '<th>Sim truth</th>' : ''}</tr></thead><tbody>` +
    shown.map((p) => `<tr class="row ${notified(p) ? '' : 'dim'} ${state.sel === p.other ? 'sel' : ''}" data-o="${p.other}">
      <td>${anon(p.other)}${p.app ? '' : ' <span class="hint">(no app)</span>'}</td>
      <td>${when(p.t0)}</td><td>${esc(bname(p.where))}</td>
      <td class="num">${p.minutes}</td><td class="num">${p.max6}</td><td class="num">${p.closest < 0.3 ? '&lt;0.3' : p.closest} m</td>
      <td><span class="bar" style="width:${Math.max(2, 70 * p.lambda / maxLam)}px"></span>${pct(p.lambda)}</td>
      <td>${notified(p) ? `<span class="pill notify">${p.app ? 'Notify' : 'Vaden call'}</span>` : '<span class="pill skip">no</span>'}</td>
      ${state.truth ? `<td>${p.infected ? `<span class="pill ${notified(p) ? 'inf' : 'miss'}">${notified(p) ? 'infected · caught' : 'infected · missed'}</span>` : ''}</td>` : ''}
    </tr>`).join('') + '</tbody>' +
    (ps.length > shown.length ? `<tfoot><tr><td colspan="9" class="hint">${ps.length - shown.length} more brief, distant contacts (&lt;0.1%) not shown.</td></tr></tfoot>` : '');
  for (const tr of $('contacts').querySelectorAll('tr.row')) tr.onclick = () => selectPerson(c, ps.find((p) => p.other === tr.dataset.o));
}

// Contacts are shown as anonymous handles; the app never tells you who the case was either.
const anon = (id) => 'Contact #' + (parseInt(id.replace(/\D/g, ''), 10) * 7919 % 9973).toString().padStart(4, '0');

function advice(p) {
  if (p.lambda >= 0.1) return ['High', ['Get a flu test at Vaden (free, same day).', 'Wear a mask indoors for the next 3 days.', 'If you feel sick, stay home and report it in FlUni so your contacts hear too.']];
  if (p.lambda >= 0.03) return ['Moderate', ['Watch for fever, cough or aches over the next 3 days.', 'Mask in lectures and dining halls until then.', 'Ask Vaden about antivirals if you get symptoms in the next 48 h.']];
  return ['Low', ['No need to change plans.', 'Watch for symptoms for 3 days and report if you get them.']];
}

function selectPerson(c, p) {
  state.sel = p.other;
  renderDetail();
  drawCase(c, p);
  if (!notified(p)) { $('phone').hidden = true; return; }
  const [level, todo] = advice(p);
  const room = p.room ? ` (${esc(p.room.split('_').slice(-2).join(' '))})` : '';
  $('phonebody').innerHTML = `<div class="app">FlUni · now</div>
    <h4>You were near someone who reported flu</h4>
    <div>${when(p.topT)} at <b>${esc(bname(p.where))}</b>${room}, about ${p.days.find((d) => d.lambda === p.topLam).minutes} min.</div>
    <div style="margin-top:10px">Your chance of catching it from them</div>
    <div class="risk">${pct(p.lambda)} <span class="hint">${level}</span></div>
    <b>What to do</b><ul>${todo.map((t) => `<li>${t}</li>`).join('')}</ul>
    <div class="fine">We never share who reported or where you go. Estimate uses distance, time, room size, ventilation and humidity (FlUni exposure model).</div>`;
  $('phone').hidden = !p.app;
}

function selectCase(id) {
  state.caseId = id; state.sel = null;
  $('phone').hidden = true;
  const u = new URL(location); id ? u.searchParams.set('case', id) : u.searchParams.delete('case'); history.replaceState(null, '', u);
  renderCases(); renderDetail();
  const c = D.cases.find((x) => x.id === id);
  c ? drawCase(c) : drawOverview();
}

// --- map ---
function color(lam) { return lam >= 0.1 ? '#8e3a28' : lam >= 0.03 ? '#db6c59' : lam >= 0.01 ? '#e99569' : lam >= 0.003 ? '#ebd187' : '#acbc8b'; }
const ll = (loc) => (D.buildings[loc] ? [D.buildings[loc].lat, D.buildings[loc].lon] : null);

function clearDyn() { if (layers.dyn) layers.dyn.remove(); layers.dyn = L.layerGroup().addTo(map); return layers.dyn; }

function drawOverview() {
  const g = clearDyn(), count = {};
  for (const c of D.cases) for (const loc of new Set(c.visits.map((v) => v.loc))) count[loc] = (count[loc] || 0) + 1;
  for (const [loc, n] of Object.entries(count)) {
    const p = ll(loc); if (!p) continue;
    L.circleMarker(p, { radius: 5 + 3 * Math.sqrt(n), color: '#8e3a28', weight: 1, fillColor: '#db6c59', fillOpacity: .45 })
      .bindTooltip(`<b>${esc(bname(loc))}</b><br>${n} case${n > 1 ? 's' : ''} spent time here while contagious`).addTo(g);
  }
  setLegend('overview');
}

function drawCase(c, focus) {
  const g = clearDyn();
  const stops = c.visits.filter((v) => ll(v.loc));
  const line = stops.map((v) => ll(v.loc));
  if (line.length > 1) L.polyline(line, { color: '#33241c', weight: 2, opacity: .5, dashArray: '4 5' }).addTo(g);
  // Contact clusters per building: size = people nearby, color = highest risk there.
  const at = {};
  for (const p of people(c)) {
    const k = p.where; if (!ll(k)) continue;
    const a = (at[k] ||= { n: 0, notified: 0, max: 0, inf: 0 });
    a.n++; if (notified(p)) a.notified++; a.max = Math.max(a.max, p.lambda); if (p.infected) a.inf++;
  }
  for (const [loc, a] of Object.entries(at)) {
    L.circleMarker(ll(loc), { radius: 6 + 2.2 * Math.sqrt(a.n), color: '#fff', weight: 1.5, fillColor: color(a.max), fillOpacity: .85 })
      .bindTooltip(`<b>${esc(bname(loc))}</b><br>${a.n} people nearby · ${a.notified} notified<br>highest risk ${pct(a.max)}` +
        (state.truth ? `<br>${a.inf} actually infected` : '')).addTo(g);
  }
  const seen = new Map();
  stops.forEach((v, i) => {
    const prev = seen.get(v.loc); if (prev) { prev.push(i + 1); return; }
    seen.set(v.loc, [i + 1]);
  });
  for (const [loc, nums] of seen) {
    const vs = stops.filter((v) => v.loc === loc);
    const label = nums.length > 2 ? `${nums[0]}…` : nums.join(',');
    L.marker(ll(loc), { icon: L.divIcon({ className: '', html: `<div class="stop-label" style="width:${label.length > 2 ? 30 : 20}px;border-radius:10px">${label}</div>`, iconSize: [label.length > 2 ? 30 : 20, 20] }) })
      .bindTooltip(`<b>${esc(bname(loc))}</b><br>` + vs.map((v) => `${when(v.t0)}–${when(v.t1).split(' ')[1]} · ${esc(v.act)}`).join('<br>')).addTo(g);
  }
  if (focus && ll(focus.where)) {
    L.circleMarker(ll(focus.where), { radius: 22, color: '#8e3a28', weight: 3, fill: false }).addTo(g);
    map.panTo(ll(focus.where));
  } else if (line.length) map.fitBounds(L.latLngBounds(line).pad(0.25), { maxZoom: 17 });
  setLegend('case');
}

function setLegend(mode) {
  $('legend').innerHTML = mode === 'overview'
    ? '<div><i style="background:#db6c59"></i>places cases visited while contagious</div><div class="hint">pick a case to trace it</div>'
    : `<div><span class="stop-label" style="display:inline-block;width:20px">1</span> where the case went, in order</div>
       <div><b>Contacts</b>&nbsp;by highest chance of infection:</div>
       ${[[0.1, '≥10%'], [0.03, '3–10%'], [0.01, '1–3%'], [0.003, '0.3–1%'], [0, '<0.3%']].map(([v, t]) => `<div><i style="background:${color(v)}"></i>${t}</div>`).join('')}`;
}

async function init() {
  const [data, bounds] = await Promise.all([
    fetch(`out/${RUN}/tracing.json`).then((r) => { if (!r.ok) throw new Error(`No tracing data for ${RUN}. Run: python3 tracing/build.py sim/runs/${RUN}`); return r.json(); }),
    fetch('../heatmap/assets/trace/campus_trace_bounds.json').then((r) => r.json()),
  ]);
  D = data;
  const b = [[bounds.south, bounds.west], [bounds.north, bounds.east]];
  map = L.map('map', { zoomSnap: 0.25, maxBounds: L.latLngBounds(b).pad(0.2), attributionControl: true }).fitBounds(b);
  L.imageOverlay('../heatmap/assets/trace/campus_trace.webp', b, { attribution: 'FlUni campus map · OSM' }).addTo(map);
  for (const [loc, x] of Object.entries(D.buildings)) {
    if (!x.ring) continue;
    L.polygon(x.ring, { color: '#6a5244', weight: .6, fillOpacity: .08, interactive: true })
      .bindTooltip(`<b>${esc(x.name)}</b><br>${TYPE_NAMES[x.type] || x.type}`, { sticky: true }).addTo(map);
  }
  const start = new Date(D.start);
  $('runline').textContent = `Stanford · ${D.n_agents.toLocaleString()} simulated students · ${D.days} days from ${start.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const sync = () => {
    $('thrlabel').textContent = pct(state.thr);
    $('thr').disabled = state.rule !== 'dose';
    renderScore(); renderCases(); renderDetail();
    const c = D.cases.find((x) => x.id === state.caseId);
    const p = c && state.sel && people(c).find((x) => x.other === state.sel);
    c ? (p ? selectPerson(c, p) : drawCase(c)) : drawOverview();
  };
  for (const r of document.querySelectorAll('input[name=rule]')) r.onchange = () => { state.rule = r.value; sync(); };
  if (qs.get('rule') === 'cdc') { state.rule = 'cdc'; document.querySelector('input[value=cdc]').checked = true; }
  if (qs.get('thr')) state.thr = Number(qs.get('thr')) / 100;
  $('thr').value = state.thr * 100;
  $('thr').oninput = () => { state.thr = Number($('thr').value) / 100; sync(); };
  $('truth').checked = state.truth;
  $('truth').onchange = () => { state.truth = $('truth').checked; sync(); };
  $('phoneclose').onclick = () => { $('phone').hidden = true; };
  sync();
}

init().catch((e) => { document.body.innerHTML = `<p style="padding:24px">${esc(e.message)}</p>`; console.error(e); });
