/* My Ski Days — local viewer for Carv data (exported by export_carv.py). No network needed. */
"use strict";

const CARV = (() => {
  let INDEX = null;
  const cache = {};
  const waiting = {};
  const state = { season: null, sort: { key: "start", dir: -1 }, outdoorOnly: false, trend: "ski_iq", iqType: null, impType: null, impPeriod: "d30", lr: false };

  // ---------- labels (named after Carv's metric names) ----------
  // Names as in the Carv app where known (edge build, turn float, parallel portion, snowplough size: own names).
  const METRICS = {
    parallel_skis: "Parallel skis",
    turn_shape_25_short_carving: "Turn shape",
    turn_closure: "Turn closure",
    rotation_rate: "Rotation rate",
    early_edging: "Early edging",
    edging_smoothness: "Edging smoothness",
    edging_similarity: "Edging similarity",
    edge_angle: "Edge angle",
    weight_release: "Weight release",
    g_force: "G-force",
    slope_pitch: "Slope pitch",
    snow_difficulty: "Snow surface",
    edge_build: "Edge build",
    turn_float: "Turn float",
    turn_portion_parallel: "Parallel portion",
    snowplough_size: "Snowplough size",
  };
  // Metrics and order per turn type exactly as the Carv app shows them.
  const APP_ORDER = {
    carving: ["parallel_skis", "turn_shape_25_short_carving", "turn_closure", "early_edging", "edging_smoothness",
      "edging_similarity", "edge_angle", "weight_release", "g_force", "slope_pitch"],
    short: ["parallel_skis", "turn_shape_25_short_carving", "rotation_rate", "early_edging", "edging_similarity",
      "edge_angle", "weight_release", "g_force", "slope_pitch", "snow_difficulty"],
  };
  const RAW_METRICS = { tempo: ["Tempo", ""], turn_speed: ["Turn Speed", " m/s"] };
  // Units per metric. Carv stores angles in radians, G-force in g, speeds in m/s and most
  // other metrics as a 0–1 score. conv = to display unit, max = full bar.
  const DEG = 180 / Math.PI;
  const UNITS = {
    g_force: { conv: (v) => v, fmt: (x) => nf(x, 1) + " g", max: 2 },
    edge_angle: { conv: (v) => v * DEG, fmt: (x) => nf(x) + "°", max: 70 },
    slope_pitch: { conv: (v) => v * DEG, fmt: (x) => nf(x) + "°", max: 35 },
    rotation_rate: { conv: (v) => v * DEG, fmt: (x) => nf(x) + "°/s", max: 120 },
    tempo: { conv: (v) => v, fmt: (x) => nf(x) + " /min", max: 80 },
    turn_speed: { conv: (v) => v * 3.6, fmt: (x) => nf(x) + " km/h", max: 50 },
  };
  // Scores are shown 0–100% like the Carv app; Carv's stored value can go slightly above 1, the app caps it.
  const PCT = { conv: (v) => Math.max(0, Math.min(1, v)) * 100, fmt: (x) => nf(x) + "%", max: 100, cap: 1 };
  const unitOf = (k) => UNITS[k] || PCT;
  // Mid-turn balance as a rating. Checked against the Carv app: 0.533 and 0.962 are both "Good"
  // (14 Nov 2026, runs 1 and 2). The Ok/Good and Good/Great limits are still estimates around that.
  // Checked against the Carv app (14 Nov 2026): descents 1–6 (0.40–0.53) are "Good", descents 7–10
  // (0.96–1.00) are "Great". So Good/Great lies between 0.53 and 0.96 and Ok/Good below 0.40;
  // the exact limits are still estimates within those ranges.
  const BALANCE_LIMITS = { good: 0.35, great: 0.75 };
  const balanceLabel = (v) => (v == null ? "–" : v >= BALANCE_LIMITS.great ? "Great" : v >= BALANCE_LIMITS.good ? "Good" : "Ok");
  const balancePill = (v) => (v == null ? "–" : `<span class="pill bal-${balanceLabel(v).toLowerCase()}" title="mid-turn balance ${nf(v * 100)}%">${balanceLabel(v)}</span>`);
  const metricNum = (k, v) => (v == null ? null : unitOf(k).conv(v));
  const metricText = (k, v) => (v == null ? "–" : unitOf(k).fmt(metricNum(k, v)));
  const metricFrac = (k, v) => (v == null ? 0 : Math.max(0, Math.min(1, metricNum(k, v) / unitOf(k).max)));
  // Metrics that only appear in the Ski:IQ breakdown.
  const IMPACT_ONLY = { turn_shape_23_other: "Turn Shape (other)", tempo: "Tempo" };
  const ADDITIONAL = {
    turn_portion_carving: "Carving Portion",
    early_forward_movement: "Early Forward Movement",
    mid_turn_balance: "Mid-Turn Balance",
  };
  const IQ_TYPES = { carving: "Carved turns", short: "Short turns", mogul: "Moguls", powder: "Powder", parallel: "Parallel", snowplough: "Snowplough" };
  const TURN_TYPES = {
    GroomedParallel: "Parallel (groomed)", GroomedShort: "Short Turns", GroomedCarving: "Carving", Carving: "Carving",
    UnevenParallel: "Parallel (uneven)", Snowplough: "Snowplough", Moguls: "Moguls", Powder: "Powder", Ungroomed: "Ungroomed",
  };
  // Which detected turn types count towards each Ski:IQ type. Carv scores every turn with all six
  // models, so a type you did not ski still gets a (hypothetical) score; we only show skied types.
  const IQ_TYPE_TURNS = {
    carving: ["GroomedCarving", "Carving"], short: ["GroomedShort"], mogul: ["Moguls"],
    powder: ["Powder"], parallel: ["GroomedParallel", "UnevenParallel"], snowplough: ["Snowplough"],
  };
  const turnsOfIqType = (types, k) => (IQ_TYPE_TURNS[k] || []).reduce((a, t) => a + ((types && types[t]) || 0), 0);
  const iqTypeOf = (turnType) => Object.keys(IQ_TYPE_TURNS).find((k) => IQ_TYPE_TURNS[k].includes(turnType));
  // Carv's Ski:IQ per turn type = best scored stretch (sub-segment of ~8 turns) of that type.
  function bestOfSubs(subs) {
    const best = {};
    for (const [tt, v, start, , , impact] of subs || []) {
      const k = iqTypeOf(tt);
      if (k && v != null && (!best[k] || v > best[k].iq)) best[k] = { iq: v, start, impact };
    }
    return best;
  }
  // Averages of Ski:IQ only count scores from this value up: lower scores are mostly descents spent teaching.
  const MIN_AVG_IQ = 125;
  // "Best 8": average Turn IQ of the 8 best turns of a descent (not necessarily consecutive).
  const best8 = (rows) => { const v = (rows || []).map((x) => x[0]).filter((x) => typeof x === "number").sort((a, b) => b - a).slice(0, 8); return v.length === 8 ? v.reduce((a, b) => a + b, 0) / 8 : null; };
  const BEST8_INFO = "Best 8 = average Turn IQ of the 8 best turns of a descent (they do not have to follow each other); per day the best descent.";
  const DIFF_COLOR ={ Novice: "#2fb34a", Beginner: "#2fb34a", Easy: "#2e7bf0", Intermediate: "#e5383b", Advanced: "#8fa5c4", Expert: "#8fa5c4" };
  const LOCALE = "en-GB";

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = (x, d = 0) => (x == null || isNaN(x) ? "–" : Number(x).toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const tt = (t) => TURN_TYPES[t] || t;
  const dur = (s) => { if (s == null) return "–"; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`; };
  const dateFmt = (d) => d ? new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "–";
  const iq = (x) => (x && x.overall != null ? Math.round(x.overall) : null);
  const isOutdoor = (s) => (s.descent_m || 0) > 50 || (s.lifts || 0) > 0;
  const place = (s) => (s.lifts_used && s.lifts_used[0]) || (s.routes && s.routes[0]) || (isOutdoor(s) ? "Unknown" : "Indoor / training");
  let tip;
  function showTip(e, html) { tip.innerHTML = html; tip.style.display = "block"; tip.style.left = e.clientX + 12 + "px"; tip.style.top = e.clientY + 12 + "px"; }
  function hideTip() { tip.style.display = "none"; }

  // Locally every session has its own file (data/s/<id>.js). The online version bundles sessions
  // into a few larger files; data/bundles.js then says which file holds which session.
  let BUNDLES = null;
  const loadingFile = {};
  function loadSession(id) {
    if (cache[id]) return Promise.resolve(cache[id]);
    return new Promise((res, rej) => {
      (waiting[id] = waiting[id] || []).push(res);
      const file = BUNDLES && BUNDLES[id] ? `data/${BUNDLES[id]}` : `data/s/${id}.js`;
      if (loadingFile[file]) return;
      loadingFile[file] = true;
      loadScript(file).catch(() => { delete loadingFile[file]; rej(new Error("Session file not found: " + id)); });
    });
  }

  // ---------- data files: plain locally, encrypted on the internet ----------
  // The internet version (window.CARV_SECURE) only has encrypted data (data/*.bin, AES-256-GCM,
  // key from your password via PBKDF2). The password is asked once per device; the derived key
  // (not the password) is kept in this browser's storage.
  let KEY = null, KEYB64 = null;
  const b64 = { enc: (b) => btoa(String.fromCharCode(...new Uint8Array(b))), dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };
  function addScript(src) {
    return new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = src; sc.onload = () => res(); sc.onerror = () => rej(new Error("File not found: " + src));
      document.body.appendChild(sc);
    });
  }
  async function decryptFile(file) {
    const r = await fetch(file, { cache: "no-cache" });
    if (!r.ok) throw new Error("File not found: " + file);
    const buf = new Uint8Array(await r.arrayBuffer());
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, KEY, buf.slice(12));
  }
  async function loadScript(file) {
    if (!window.CARV_SECURE) return addScript(file);
    const plain = await decryptFile(file.replace(/\.js$/, ".bin"));
    const url = URL.createObjectURL(new Blob([plain], { type: "text/javascript" }));
    try { await addScript(url); } finally { URL.revokeObjectURL(url); }
  }
  const keyName = (meta) => "carv-key-" + meta.salt;
  async function keyWorks() {
    try { return new TextDecoder().decode(await decryptFile("data/check.bin")) === "ok"; } catch { return false; }
  }
  async function deriveKey(password, meta) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64.dec(meta.salt), iterations: meta.iterations, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
  }
  async function startSecure() {
    await loadScript("data/bundles.js");
    await loadScript("data/index.js");
  }
  async function secureBoot() {
    let meta;
    try { meta = await (await fetch("data/meta.json", { cache: "no-cache" })).json(); }
    catch { $("#app").innerHTML = `<div class="card"><h2>No data online yet</h2></div>`; return; }
    let saved = null;
    try { saved = localStorage.getItem(keyName(meta)); } catch {}
    if (saved) {
      KEYB64 = saved;
      KEY = await crypto.subtle.importKey("raw", b64.dec(saved), "AES-GCM", false, ["decrypt"]);
      if (await keyWorks()) return startSecure();
      try { localStorage.removeItem(keyName(meta)); } catch {}
    }
    $("#app").innerHTML = `<div class="card lock"><h2>My Ski Days is locked</h2>
      <p class="muted small">Enter your password once. This device then remembers it.</p>
      <form id="unlock"><input id="pw" type="password" autocomplete="current-password" placeholder="Password" required>
      <button type="submit" id="unlock-btn">Unlock</button></form><p id="unlock-msg" class="small"></p></div>`;
    $("#pw").focus();
    $("#unlock").onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("#unlock-btn"), msg = $("#unlock-msg");
      btn.disabled = true; msg.className = "small muted"; msg.textContent = "Checking…";
      KEY = await deriveKey($("#pw").value, meta);
      if (!(await keyWorks())) { btn.disabled = false; msg.className = "small bad"; msg.textContent = "Wrong password. Try again."; return; }
      KEYB64 = b64.enc(await crypto.subtle.exportKey("raw", KEY));
      try { localStorage.setItem(keyName(meta), KEYB64); } catch {}
      $("#app").innerHTML = `<p class="muted">Loading…</p>`;
      startSecure();
    };
  }
  function forgetKey() {
    try { Object.keys(localStorage).filter((k) => k.startsWith("carv-key-")).forEach((k) => localStorage.removeItem(k)); } catch {}
    location.reload();
  }

  // ---------- charts (pure SVG) ----------
  // Chart drawing width: narrower on small screens, so charts stay tall enough to read there.
  const chartW = () => Math.round(Math.min(760, Math.max(380, (window.innerWidth || 760) - 40)));
  // Line charts with clear axes ("nice" round tick values, gridlines both ways, axis lines) and zoom:
  // + / − / All buttons, pinch (phone), Ctrl+scroll or trackpad pinch (laptop), drag to move, double-tap = all.
  // When zoomed in, the y-axis fits the visible part, so details become readable.
  function lineChart({ points, w, h = 220, color = "var(--accent)", dots = true, onClick, fmtX = (x) => x, fmtY = (y) => nf(y), area = false }) {
    return zoomChart({ series: [{ color, points, dots, area }], w, h, onClick, fmtX, fmtY, yZero: true });
  }
  const charts = new Map();
  function niceStep(range, n) {
    const raw = range / Math.max(1, n), p = 10 ** Math.floor(Math.log10(raw || 1)), f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }
  function zoomChart(cfg) {
    const all = cfg.series.flatMap((s) => s.points.filter((p) => p.y != null && !isNaN(p.y)));
    if (!all.length) return `<p class="muted small">No data.</p>`;
    const xs = all.map((p) => p.x);
    const full = [Math.min(...xs), Math.max(...xs)];
    if (full[0] === full[1]) { full[0] -= 1; full[1] += 1; }
    const id = "z" + Math.random().toString(36).slice(2);
    const st = { id, cfg, full, view: [...full], flat: [] };
    charts.set(id, st);
    setTimeout(() => bindZoom(st));
    const canZoom = new Set(xs).size > 12;
    const touch = matchMedia("(pointer: coarse)").matches;
    const legend = cfg.legend ? `<div class="legend">${cfg.series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
    return `<div class="zc" id="${id}">${canZoom ? `<div class="zc-bar"><button type="button" data-z="in" aria-label="Zoom in">+</button><button type="button" data-z="out" aria-label="Zoom out">−</button><button type="button" data-z="all">All</button><span class="zc-hint">${touch ? "Pinch to zoom · drag to move" : "Ctrl+scroll to zoom · drag to move"}</span></div>` : ""}<div class="zc-svg">${drawChart(st)}</div>${legend}</div>`;
  }
  function drawChart(st) {
    const { cfg, view: [v0, v1] } = st;
    const w = cfg.w || chartW(), h = cfg.h || 220;
    const pad = { l: 50, r: 14, t: 12, b: 30 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const span = v1 - v0;
    // Visible points, plus one just outside each edge so lines run to the border.
    const visible = (pts) => {
      const ok = pts.filter((p) => p.y != null && !isNaN(p.y));
      const i0 = Math.max(0, ok.findIndex((p) => p.x >= v0) - 1);
      let i1 = ok.length - 1;
      for (let i = ok.length - 1; i >= 0; i--) if (ok[i].x <= v1) { i1 = Math.min(ok.length - 1, i + 1); break; }
      return ok.slice(i0, i1 + 1);
    };
    const vis = cfg.series.map((s) => visible(s.points));
    const inView = vis.flat().filter((p) => p.x >= v0 && p.x <= v1);
    const ys = (inView.length ? inView : vis.flat()).map((p) => p.y);
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    const yStep = niceStep(y1 - y0, h < 200 ? 4 : 5);
    y0 = Math.floor(y0 / yStep) * yStep; y1 = Math.ceil(y1 / yStep) * yStep;
    if (cfg.yZero && y0 < 0 && Math.min(...ys) >= 0) y0 = 0;
    const X = (x) => pad.l + ((x - v0) / span) * pw;
    const Y = (y) => pad.t + ph - ((y - y0) / (y1 - y0)) * ph;
    const dec = yStep < 1 ? (yStep < 0.1 ? 2 : 1) : 0;
    const fy = (v) => cfg.fmtY(Number(v.toFixed(dec)));
    let g = "";
    for (let v = y0; v <= y1 + yStep / 2; v += yStep) {
      const yy = Y(v).toFixed(1);
      g += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${yy}" y2="${yy}" stroke="var(--line)"/><text class="ax" x="${pad.l - 7}" y="${+yy + 4}" text-anchor="end">${esc(fy(v))}</text>`;
    }
    const xStep = Math.max(1, Math.round(niceStep(span, Math.max(2, Math.floor(pw / 95)))));
    const labels = [];
    for (let v = Math.ceil(v0 / xStep) * xStep; v <= v1; v += xStep) labels.push(v);
    const anyX = labels.some((v) => cfg.fmtX(v) !== "");
    for (const v of labels) {
      const xx = X(v).toFixed(1);
      g += `<line x1="${xx}" x2="${xx}" y1="${pad.t}" y2="${pad.t + ph}" stroke="var(--line)" stroke-dasharray="2 3"/>`;
      if (anyX) g += `<text class="ax" x="${xx}" y="${h - 9}" text-anchor="middle">${esc(cfg.fmtX(v))}</text>`;
    }
    g += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${pad.t + ph}" y2="${pad.t + ph}" class="axis"/><line x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${pad.t + ph}" class="axis"/>`;
    const clip = st.id + "c";
    let body = "";
    st.flat = [];
    const density = inView.length;
    cfg.series.forEach((s, si) => {
      const pts = vis[si];
      if (!pts.length) return;
      const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
      if (s.area) body += `<path d="${d}L${X(pts[pts.length - 1].x).toFixed(1)},${pad.t + ph}L${X(pts[0].x).toFixed(1)},${pad.t + ph}Z" fill="${s.color}" opacity=".15"/>`;
      body += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
      if (s.dots !== false && density < 450) {
        const r = density < 60 ? 4 : density < 160 ? 3 : 2;
        body += pts.filter((p) => p.x >= v0 && p.x <= v1).map((p) => { st.flat.push(p); return `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${r}" fill="${s.color}" data-i="${st.flat.length - 1}"${cfg.onClick ? ' style="cursor:pointer"' : ""}/>`; }).join("");
      }
    });
    return `<svg viewBox="0 0 ${w} ${h}" width="100%"><defs><clipPath id="${clip}"><rect x="${pad.l}" y="${pad.t - 6}" width="${pw}" height="${ph + 12}"/></clipPath></defs>${g}<g clip-path="url(#${clip})">${body}</g></svg>`;
  }
  function bindZoom(st) {
    const el = document.getElementById(st.id); if (!el) { charts.delete(st.id); return; }
    const box = el.querySelector(".zc-svg");
    const { cfg, full } = st;
    const minSpan = Math.max(4, (full[1] - full[0]) / 300);
    let moved = false;
    const bindPoints = () => box.querySelectorAll("circle").forEach((c) => {
      const p = st.flat[+c.dataset.i]; if (!p) return;
      c.addEventListener("mousemove", (e) => showTip(e, p.tip || `${cfg.fmtX(p.x)}: ${cfg.fmtY(p.y)}`));
      c.addEventListener("mouseleave", hideTip);
      c.addEventListener("click", (e) => {
        if (moved) return;
        if (cfg.onClick) { hideTip(); cfg.onClick(p); } else showTip(e, p.tip || `${cfg.fmtX(p.x)}: ${cfg.fmtY(p.y)}`);
      });
    });
    const redraw = () => { box.innerHTML = drawChart(st); bindPoints(); el.classList.toggle("zoomed", st.view[0] > full[0] || st.view[1] < full[1]); };
    const setView = (a, b) => {
      let span = Math.max(minSpan, Math.min(full[1] - full[0], b - a));
      a = Math.max(full[0], Math.min(a, full[1] - span));
      st.view = [a, a + span]; redraw();
    };
    const zoomAt = (factor, frac = 0.5) => {
      const [a, b] = st.view, c = a + frac * (b - a), span = (b - a) * factor;
      setView(c - frac * span, c - frac * span + span);
    };
    const plotFrac = (clientX) => {
      const r = box.getBoundingClientRect(), w = cfg.w || chartW();
      return Math.max(0, Math.min(1, ((clientX - r.left) / r.width * w - 50) / (w - 64)));
    };
    el.querySelectorAll("[data-z]").forEach((b) => (b.onclick = () => {
      if (b.dataset.z === "in") zoomAt(0.5); else if (b.dataset.z === "out") zoomAt(2); else setView(full[0], full[1]);
    }));
    box.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomAt(e.deltaY > 0 ? 1.25 : 0.8, plotFrac(e.clientX));
    }, { passive: false });
    box.addEventListener("dblclick", () => setView(full[0], full[1]));
    const ptrs = new Map();
    let start = null;
    box.addEventListener("pointerdown", (e) => {
      ptrs.set(e.pointerId, e.clientX); moved = false;
      start = { view: [...st.view], xs: [...ptrs.values()] };
    });
    box.addEventListener("pointermove", (e) => {
      if (!ptrs.has(e.pointerId) || !start) return;
      ptrs.set(e.pointerId, e.clientX);
      const now = [...ptrs.values()], r = box.getBoundingClientRect();
      const [a, b] = start.view, span = b - a;
      if (now.length >= 2 && start.xs.length >= 2) {
        const d0 = Math.abs(start.xs[1] - start.xs[0]) || 1, d1 = Math.abs(now[1] - now[0]) || 1;
        const frac = plotFrac((start.xs[0] + start.xs[1]) / 2), c = a + frac * span, ns = span * d0 / d1;
        setView(c - frac * ns, c - frac * ns + ns); moved = true;
      } else if (now.length === 1 && start.xs.length === 1) {
        const dx = now[0] - start.xs[0];
        if (Math.abs(dx) > 6 && (a > full[0] || b < full[1])) { moved = true; const shift = -dx / r.width * span * 1.08; setView(a + shift, b + shift); }
      }
    });
    const end = (e) => { ptrs.delete(e.pointerId); start = ptrs.size ? { view: [...st.view], xs: [...ptrs.values()] } : null; };
    box.addEventListener("pointerup", end); box.addEventListener("pointercancel", end); box.addEventListener("pointerleave", end);
    bindPoints();
  }

  function bars(obj, labels, { max = 1, pct = true, sort = false } = {}) {
    let keys = Object.keys(labels).filter((k) => obj && obj[k] != null);
    if (sort) keys.sort((a, b) => obj[b] - obj[a]);
    if (!keys.length) return `<p class="muted small">No data.</p>`;
    return keys.map((k) => {
      const v = obj[k], w = Math.max(0, Math.min(1, v / max)) * 100;
      return `<div class="bar"><span>${esc(labels[k])}</span><div class="track"><div class="fill" style="width:${w}%"></div></div><span class="v">${pct ? nf(v * 100) + "%" : nf(v)}</span></div>`;
    }).join("");
  }

  function speedColor(v, vmax) {
    const t = Math.max(0, Math.min(1, (v || 0) / Math.max(vmax, 1)));
    const hue = 210 - 210 * t; // blue -> red
    return `hsl(${hue},80%,48%)`;
  }

  function mapSvg(day, selRun) {
    const all = [];
    day.runs.forEach((r) => r.path.forEach((p) => all.push(p)));
    day.lifts.forEach((l) => l.path.forEach((p) => all.push(p)));
    if (all.length < 2) return `<p class="muted small">No GPS track in this session (e.g. indoor).</p>`;
    const lats = all.map((p) => p[0]), lons = all.map((p) => p[1]);
    const la0 = Math.min(...lats), la1 = Math.max(...lats), lo0 = Math.min(...lons), lo1 = Math.max(...lons);
    const k = Math.cos(((la0 + la1) / 2) * Math.PI / 180);
    const wDeg = Math.max((lo1 - lo0) * k, 1e-5), hDeg = Math.max(la1 - la0, 1e-5);
    const W = 760, H = Math.max(260, Math.min(620, (W * hDeg) / wDeg)), pad = 14;
    const s = Math.min((W - 2 * pad) / wDeg, (H - 2 * pad) / hDeg);
    const ox = (W - wDeg * s) / 2, oy = (H - hDeg * s) / 2;
    const P = (p) => [(ox + (p[1] - lo0) * k * s).toFixed(1), (oy + (la1 - p[0]) * s).toFixed(1)];
    let g = "";
    day.lifts.forEach((l) => { if (l.path.length > 1) g += `<polyline points="${l.path.map((p) => P(p).join(",")).join(" ")}" fill="none" stroke="var(--lift)" stroke-width="1.5" stroke-dasharray="4 4"><title>${esc(l.name || "Lift")}</title></polyline>`; });
    const vmax = Math.max(...day.runs.map((r) => r.max_speed_kmh || 0), 1);
    day.runs.forEach((r, i) => {
      const dim = selRun != null && selRun !== i;
      for (let j = 1; j < r.path.length; j++) {
        const [ax, ay] = P(r.path[j - 1]), [bx, by] = P(r.path[j]);
        g += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${speedColor(r.path[j][3], vmax)}" stroke-width="${selRun === i ? 4 : 2.5}" stroke-linecap="round" opacity="${dim ? 0.15 : 1}"/>`;
      }
      if (r.path.length) { const [cx, cy] = P(r.path[0]); g += `<circle cx="${cx}" cy="${cy}" r="${selRun === i ? 5 : 3}" fill="var(--card)" stroke="var(--ink)" opacity="${dim ? 0.2 : 1}" data-run="${i}" style="cursor:pointer"><title>Descent ${r.num || i + 1}${r.route ? " – " + esc(r.route) : ""}</title></circle>`; }
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="background:var(--bg);border-radius:8px">${g}</svg>
      <div class="legend"><span><i style="background:linear-gradient(90deg,hsl(210,80%,48%),hsl(105,80%,48%),hsl(0,80%,48%))"></i>speed (low → ${nf(vmax)} km/h)</span><span><i style="background:var(--lift)"></i>lift</span><span>○ start of run (click to select)</span></div>`;
  }

  // ---------- views ----------
  function seasons() { return [...new Set(INDEX.sessions.map((s) => s.season).filter(Boolean))].sort(); }
  function seasonChips(short) {
    const ss = seasons();
    if (state.season === null) state.season = ss[ss.length - 1] || "all";
    return `<div class="chips">${["all", ...ss].map((x) => `<button class="chip ${x === state.season ? "on" : ""}" data-season="${x}">${x === "all" ? "All seasons" : "Season " + x}</button>`).join("")}
      <button class="chip ${state.outdoorOnly ? "on" : ""}" data-outdoor>${short ? "Outdoor only" : "Outdoor only (lifts / vertical)"}</button></div>`;
  }
  function bindChips(view) {
    document.querySelectorAll("[data-season]").forEach((b) => (b.onclick = () => { state.season = b.dataset.season; view(); }));
    $("[data-outdoor]").onclick = () => { state.outdoorOnly = !state.outdoorOnly; view(); };
  }
  function filtered() {
    let list = INDEX.sessions.filter((s) => state.season === "all" || s.season === state.season);
    if (state.outdoorOnly) list = list.filter(isOutdoor);
    return list;
  }

  // ---------- days (as in the Carv app: a day has runs = recording sessions, each with descents) ----------
  function dayGroups(list) {
    const by = {};
    for (const s of list) (by[s.date] = by[s.date] || []).push(s);
    return Object.entries(by).map(([date, ss]) => {
      ss.sort((a, b) => (a.start > b.start ? 1 : -1));
      const sum = (f) => ss.reduce((a, s) => a + (s[f] || 0), 0);
      const max = (f) => Math.max(...ss.map((s) => s[f] || 0));
      const bestIq = ss.reduce((b, s) => (iq(s.ski_iq) ?? -1) > (iq(b?.ski_iq) ?? -1) ? s : b, null);
      return {
        date, sessions: ss, start: ss[0].start, end: ss[ss.length - 1].end, season: ss[0].season,
        runs: ss.length, descents: sum("runs"), turns: sum("turns"), skiing_distance_km: sum("skiing_distance_km"),
        descent_m: sum("descent_m"), skiing_duration_min: sum("skiing_duration_min"), max_speed_kmh: max("max_speed_kmh"),
        max_altitude_m: max("max_altitude_m"), ski_iq: bestIq?.ski_iq,
        best8: ss.some((s) => s.best8 != null) ? Math.max(...ss.filter((s) => s.best8 != null).map((s) => s.best8)) : null, place: place(ss.find(isOutdoor) || ss[0]),
        outdoor: ss.some(isOutdoor),
      };
    }).sort((a, b) => (a.start > b.start ? 1 : -1));
  }

  async function loadDay(date) {
    const ss = INDEX.sessions.filter((s) => s.date === date).sort((a, b) => (a.start > b.start ? 1 : -1));
    const datas = await Promise.all(ss.map((s) => loadSession(s.id)));
    let n = 0;
    const runs = [], lifts = [], subs = [], types = {}, agg = {};
    datas.forEach((d, k) => {
      d.runs.forEach((r) => runs.push({ ...r, num: ++n, session: k }));
      lifts.push(...d.lifts);
      subs.push(...(d.subsegments || []));
      for (const [t, c] of Object.entries(d.turn_types || {})) types[t] = (types[t] || 0) + c;
    });
    for (const r of runs) {
      const w = r.turns || 0;
      for (const [k, v] of Object.entries(r.display || {})) if (typeof v === "number" && w) (agg[k] = agg[k] || []).push([v, w]);
    }
    const display = Object.fromEntries(Object.entries(agg).map(([k, xs]) => [k, xs.reduce((a, [v, w]) => a + v * w, 0) / xs.reduce((a, [, w]) => a + w, 0)]));
    const g = dayGroups(ss)[0];
    const lifts_used = [...new Set(datas.flatMap((d) => d.summary.lifts_used || []))];
    return {
      date, sessions: ss, datas, runs, lifts, subsegments: subs, turn_types: types, display,
      airtimes: datas.reduce((a, d) => a + (d.airtimes || 0), 0),
      summary: { ...g, lifts_used, duration_h: datas.reduce((a, d) => a + (d.summary.duration_h || 0), 0) },
    };
  }

  function viewHome() {
    const chips = seasonChips(false);
    const list = filtered();
    const days = dayGroups(list);
    const sum = (f) => days.reduce((a, s) => a + (s[f] || 0), 0);
    const best = days.reduce((b, s) => (iq(s.ski_iq) > (iq(b?.ski_iq) ?? -1) ? s : b), null);
    const fastest = days.reduce((b, s) => ((s.max_speed_kmh || 0) > (b?.max_speed_kmh || 0) ? s : b), null);

    const { key, dir } = state.sort;
    const val = (s) => (key === "ski_iq" ? iq(s.ski_iq) ?? -1 : s[key] ?? -1);
    const sorted = [...days].sort((a, b) => (val(a) > val(b) ? dir : val(a) < val(b) ? -dir : 0));
    const th = (k, label, num) => `<th class="${num ? "num" : ""}" data-sort="${k}">${label}${key === k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`;
    const iqPts = days.map((s, i) => ({ x: i, y: iq(s.ski_iq), date: s.date, tip: `${dateFmt(s.date)} · ${esc(s.place)}<br>Ski:IQ ${iq(s.ski_iq) ?? "–"}` }));

    $("#app").innerHTML = `
      <h1>Overview</h1>
      ${chips}
      <div class="stats stats9">
        <div class="stat"><b>${nf(days.length)}</b><span>ski days</span></div>
        <div class="stat"><b>${nf(sum("runs"))}</b><span>runs</span></div>
        <div class="stat"><b>${nf(sum("descents"))}</b><span>descents</span></div>
        <div class="stat"><b>${nf(sum("turns"))}</b><span>turns</span></div>
        <div class="stat"><b>${nf(sum("skiing_distance_km"), 0)} km</b><span>ski distance</span></div>
        <div class="stat"><b>${nf(sum("descent_m") / 1000, 1)} km</b><span>vertical descent</span></div>
        <div class="stat"><b>${nf(sum("skiing_duration_min") / 60, 1)} h</b><span>time skiing</span></div>
        <div class="stat"><b>${best ? iq(best.ski_iq) : "–"}</b><span>best Ski:IQ${best ? "<br>" + new Date(best.date + "T12:00:00").toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" }) : ""}</span></div>
        <div class="stat"><b>${fastest ? nf(fastest.max_speed_kmh) : "–"}</b><span>top speed km/h</span></div>
      </div>
      <div class="card"><h2>Ski:IQ per day</h2>${multiLineChart({
        series: [["carving", "Carved turns", "#4da3ff"], ["short", "Short turns", "#ff8a00"]].map(([k, name, color]) => ({
          name, color, points: days.map((d, i) => {
            const v = Math.max(...d.sessions.map((s) => s.best_iq?.[k]?.iq ?? -1));
            return { x: i, y: v > 0 ? v : null, date: d.date, tip: `${dateFmt(d.date)} · ${esc(d.place)}<br>${name}: ${nf(v)}` };
          }),
        })),
        fmtX: (x) => { const s = days[Math.round(x)]; return s ? axisDate(s.date) : ""; },
        onClick: (p) => (location.hash = "#/d/" + p.date),
      })}
        <p class="muted small">Best Ski:IQ per day for carved turns and short turns, as in the Carv app. Days without that turn type have no point. Click a point to open that day.</p></div>
      <div class="card"><h2>Ski days</h2><div class="scroll"><table>
        <thead><tr>${th("start", "Date")}<th>Place</th>${th("ski_iq", "Ski:IQ", 1)}${th("best8", `<span title="${esc(BEST8_INFO)}">Best 8</span>`, 1)}${th("runs", "Runs", 1)}${th("descents", "Descents", 1)}${th("turns", "Turns", 1)}${th("skiing_distance_km", "km", 1)}${th("descent_m", "Vertical ↓", 1)}${th("max_speed_kmh", "Max km/h", 1)}</tr></thead>
        <tbody>${sorted.map((s) => `<tr class="click" data-date="${s.date}">
          <td>${dateFmt(s.date)}</td><td>${esc(s.place)}</td><td class="num">${iq(s.ski_iq) ?? "–"}</td><td class="num">${nf(s.best8, 1)}</td><td class="num">${nf(s.runs)}</td><td class="num">${nf(s.descents)}</td><td class="num">${nf(s.turns)}</td>
          <td class="num">${nf(s.skiing_distance_km, 1)}</td><td class="num">${nf(s.descent_m)}</td><td class="num">${s.max_speed_kmh ? nf(s.max_speed_kmh) : "–"}</td></tr>`).join("")}</tbody>
      </table></div><p class="muted small">Ski:IQ is Carv's official score. ${esc(BEST8_INFO)}</p></div>`;
    bindChips(viewHome);
    document.querySelectorAll("th[data-sort]").forEach((t) => (t.onclick = () => {
      const k = t.dataset.sort; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : -1 }; viewHome();
    }));
    document.querySelectorAll("tr[data-date]").forEach((r) => (r.onclick = () => (location.hash = "#/d/" + r.dataset.date)));
  }

  // scope: null = whole day, "r<k>" = run k (a recording session), number = descent index in the day.
  async function viewDay(date, scopeArg) {
    $("#app").innerHTML = `<p class="muted">Loading day…</p>`;
    let D;
    try { D = await loadDay(date); } catch (e) { $("#app").innerHTML = `<p>${esc(e.message)}</p>`; return; }
    if (!D.sessions.length) { $("#app").innerHTML = `<p>No data for ${esc(date)}.</p>`; return; }
    const sm = D.summary;
    const allDays = [...new Set(INDEX.sessions.map((s) => s.date))].sort();
    const di = allDays.indexOf(date), prev = allDays[di - 1], next = allDays[di + 1];

    let runK = null, sel = null;
    if (typeof scopeArg === "string" && scopeArg.startsWith("r")) runK = +scopeArg.slice(1);
    else if (scopeArg != null && scopeArg !== "" && D.runs[+scopeArg]) sel = +scopeArg;
    if (runK != null && !D.datas[runK]) runK = null;
    const run = sel != null ? D.runs[sel] : null;
    if (run) runK = run.session;

    // The part of the day we show: whole day, one run, or (for the map/charts) all of the day with one descent highlighted.
    const inScope = (r) => (sel != null ? r === run : runK != null ? r.session === runK : true);
    const scopeRuns = D.runs.filter(inScope);
    const edgingHtml = edgingCard(scopeRuns, run ? `descent ${run.num}` : runK != null ? `run ${runK + 1}` : "this day");
    const span = (r) => [r.start, r.end];
    const inRuns = (ts) => ts && scopeRuns.some((r) => r.start && r.end && ts >= r.start && ts <= r.end);
    const scopeLabel = run ? `(descent ${run.num})` : runK != null ? `(run ${runK + 1})` : "(this day)";

    const altPts = [], spdPts = [];
    let t = 0;
    scopeRuns.forEach((r) => r.path.forEach((p) => { altPts.push({ x: t, y: p[2], tip: `Descent ${r.num}: ${nf(p[2])} m · ${nf(p[3])} km/h` }); spdPts.push({ x: t, y: p[3] }); t++; }));

    const turnRows = scopeRuns.flatMap((r) => r.turn_rows);
    // Best Ski:IQ of one descent (any turn type); used to leave teaching descents out of averages.
    const descentIq = (r) => { const b = Object.values(bestOfSubs((D.subsegments || []).filter((y) => y[2] && r.start && r.end && y[2] >= r.start && y[2] <= r.end))); return b.length ? Math.max(...b.map((x) => x.iq)) : null; };
    const avgRuns = scopeRuns.filter((r) => (descentIq(r) ?? -1) >= MIN_AVG_IQ);
    const avgRows = avgRuns.flatMap((r) => r.turn_rows);
    const turnPts = turnRows.map((tr, k) => ({ x: k + 1, y: tr[0], tip: `Turn ${k + 1} (${tr[4] === "L" ? "left" : "right"}) · ${esc(tt(tr[1]))}<br>Turn IQ ${nf(tr[0])} · radius ${nf(tr[2], 1)} m · ${nf(tr[3])} km/h` }));
    const leftIq = avgRows.filter((x) => x[4] === "L" && x[0] != null), rightIq = avgRows.filter((x) => x[4] === "R" && x[0] != null);
    const avg = (xs, j) => (xs.length ? xs.reduce((a, x) => a + x[j], 0) / xs.length : null);

    const disp = run ? run.display : runK != null ? D.datas[runK].display : D.display;
    const types = run ? run.turn_types : runK != null ? D.datas[runK].turn_types : D.turn_types;
    const typeTotal = Object.values(types || {}).reduce((a, b) => a + b, 0) || 1;
    // Ski:IQ per turn type as the Carv app shows it: the best scored stretch of that type in the scope.
    const best = bestOfSubs((D.subsegments || []).filter((x) => inRuns(x[2])));
    const skiedIq = Object.keys(IQ_TYPES).filter((k) => best[k]);
    const notSkied = Object.keys(IQ_TYPES).filter((k) => !best[k]);
    const iqBy = Object.fromEntries(skiedIq.map((k) => [k, best[k].iq]));
    const descentAt = (ts) => D.runs.find((r) => r.start && r.end && ts >= r.start && ts <= r.end);
    const iqLabels = Object.fromEntries(skiedIq.map((k) => { const r = descentAt(best[k].start); return [k, `${IQ_TYPES[k]}${r && !run ? ` · descent ${r.num}` : ""}`]; }));
    const byIq = [...skiedIq].sort((a, b) => best[b].iq - best[a].iq);
    const bt = byIq.includes(state.iqType) ? state.iqType : byIq[0];
    const imp = (bt && best[bt].impact) || {};
    const impSum = Object.values(imp).reduce((a, b) => a + b, 0);
    const appList = APP_ORDER[bt];
    const extraImp = appList ? Object.keys(imp).filter((k) => !appList.includes(k) && imp[k]) : [];
    const techRows = () => {
      let keys;
      if (appList) keys = appList;
      else {
        keys = [...new Set([...Object.keys(METRICS).filter((k) => disp && disp[k] != null), ...Object.keys(imp)])]
          .filter((k) => METRICS[k] || IMPACT_ONLY[k] || RAW_METRICS[k]);
        keys.sort((a, b) => (imp[b] ?? -99) - (imp[a] ?? -99));
      }
      return keys.map((k) => {
        const label = METRICS[k] || IMPACT_ONLY[k] || RAW_METRICS[k][0];
        const v = disp?.[k];
        const weight = imp[k] != null && impSum ? nf((imp[k] / impSum) * 100) + "%" : "–";
        const hov = k === "edge_angle" && !!edgingHtml;
        const hovS = !hov && SHAPE_METRICS[k] && scopeRuns.some((r) => r.shape?.path?.length);
        return `<div class="bar bar4${hov ? " hov-edge" : ""}${hovS ? " hov-shape" : ""}"${hovS ? ` data-metric="${k}"` : ""}><span>${esc(label)}${hov || hovS ? ` <span class="hov-hint">ⓘ</span>` : ""}</span>
          ${v != null ? `<div class="track"><div class="fill" style="width:${metricFrac(k, v) * 100}%"></div></div>` : "<span></span>"}
          <span class="v">${metricText(k, v)}</span><span class="v pts">${weight}</span></div>`;
      }).join("");
    };

    // Stats for the header: whole day, or the selected run (session).
    const hs = runK != null && !run ? D.datas[runK].summary : sm;
    const hsRuns = runK != null && !run ? D.runs.filter((r) => r.session === runK).length : D.runs.length;
    const hs8 = D.runs.filter((r) => runK == null || run || r.session === runK).map((r) => best8(r.turn_rows)).filter((v) => v != null);
    const hsBest8 = hs8.length ? Math.max(...hs8) : null;
    const mapDay = { runs: D.runs, lifts: runK != null ? D.datas[runK].lifts : D.lifts };
    const mapRuns = runK != null ? { runs: D.runs.filter((r) => r.session === runK), lifts: mapDay.lifts } : mapDay;
    const mapSel = run ? mapRuns.runs.indexOf(run) : null;
    const url = (x) => `#/d/${date}${x === undefined || x === null ? "" : "/" + x}`;

    $("#app").innerHTML = `
      <p class="small"><a href="#/">← Overview</a>${prev ? ` · <a href="${"#/d/" + prev}">← previous day</a>` : ""}${next ? ` · <a href="${"#/d/" + next}">next day →</a>` : ""}</p>
      <h1>${dateFmt(date)} · ${esc(sm.place)}</h1>
      <p class="muted">${(sm.start || "").slice(11, 16)}–${(sm.end || "").slice(11, 16)}${sm.lifts_used?.length ? " · Lifts: " + sm.lifts_used.slice(0, 8).map(esc).join(", ") : ""}</p>
      <div class="stats">
        <div class="stat"><b>${iq(hs.ski_iq) ?? "–"}</b><span>Ski:IQ</span></div>
        <div class="stat"><b>${nf(hsBest8, 1)}</b><span>best 8 turns</span></div>
        ${runK == null || run ? `<div class="stat"><b>${nf(D.sessions.length)}</b><span>runs</span></div>` : ""}
        <div class="stat"><b>${nf(hsRuns)}</b><span>descents</span></div>
        <div class="stat"><b>${nf(hs.turns)}</b><span>turns</span></div>
        ${hs.skiing_distance_km ? `<div class="stat"><b>${nf(hs.skiing_distance_km, 1)} km</b><span>ski distance</span></div>` : ""}
        ${hs.descent_m ? `<div class="stat"><b>${nf(hs.descent_m)} m</b><span>vertical ↓</span></div>` : ""}
        ${hs.max_speed_kmh ? `<div class="stat"><b>${nf(hs.max_speed_kmh)}</b><span>max km/h</span></div>` : ""}
        <div class="stat"><b>${dur((hs.duration_h || 0) * 3600)}</b><span>total time</span></div>
        ${hs.max_altitude_m ? `<div class="stat"><b>${nf(hs.max_altitude_m)} m</b><span>max altitude</span></div>` : ""}
        ${D.airtimes && runK == null ? `<div class="stat"><b>${D.airtimes}</b><span>jumps</span></div>` : ""}
      </div>
      <div class="chips"><button class="chip ${runK == null && !run ? "on" : ""}" data-go="">Whole day</button>
        ${D.sessions.map((s, k) => `<button class="chip ${runK === k && !run ? "on" : ""}" data-go="r${k}">Run ${k + 1} · ${(s.start || "").slice(11, 16)} · ${D.runs.filter((r) => r.session === k).length} descents</button>`).join("")}</div>
      <div class="chips">${D.runs.filter((r) => runK == null || r.session === runK).map((r) => `<button class="chip ${r === run ? "on" : ""}" data-go="${r.num - 1}">${r.num} · ${(r.start || "").slice(11, 16)}</button>`).join("")}</div>
      ${run ? `<div class="card" style="border-color:var(--accent)"><h2>Descent ${run.num} <span class="muted small">run ${run.session + 1}</span>${run.route ? " – " + esc(run.route) : ""}${run.piste_difficulty ? ` <span class="pill">${esc(run.piste_difficulty)}</span>` : ""}</h2>
        <div class="stats" style="margin-bottom:6px">
          <div class="stat"><b>${nf(best8(run.turn_rows), 1)}</b><span>best 8 turns</span></div>
          <div class="stat"><b>${nf(run.tempo)}</b><span>tempo (turns/min)</span></div>
          <div class="stat"><b>${nf(run.corridor_m, 1)} m</b><span>corridor</span></div>
          <div class="stat"><b>${nf(run.radius_m, 1)} m</b><span>radius</span></div>
          <div class="stat"><b>${balancePill(run.balance)}</b><span>balance</span></div>
          <div class="stat"><b>${nf(run.turns)}</b><span>turns</span></div>
          <div class="stat"><b>${dur(run.duration_s)}</b><span>duration</span></div>
          ${run.distance_m ? `<div class="stat"><b>${nf(run.distance_m)} m</b><span>distance</span></div>` : ""}
          ${run.descent_m ? `<div class="stat"><b>${nf(run.descent_m)} m</b><span>vertical ↓</span></div>` : ""}
          ${run.max_speed_kmh ? `<div class="stat"><b>${nf(run.max_speed_kmh)}</b><span>max km/h</span></div>` : ""}
        </div>
        <p class="small"><a href="${url("r" + run.session)}">← run ${run.session + 1}</a> · <a href="${url()}">whole day</a></p></div>` : ""}
      <div class="grid g2">
        <div class="card"><h2>Route</h2>${mapSvg(mapRuns, mapSel)}</div>
        <div class="card"><h2>Ski:IQ by turn type ${scopeLabel}</h2>${bars(iqBy, iqLabels, { max: 160, pct: false, sort: true })}
          <p class="muted small">Best Ski:IQ per turn type, as in the Carv app: Carv scores stretches of about 8 turns of one type.${notSkied.length ? ` Not skied: ${notSkied.map((k) => IQ_TYPES[k]).join(", ")}.` : ""}</p>
          <h2 style="margin-top:18px">Turn types</h2>${bars(Object.fromEntries(Object.entries(types || {}).map(([k2, v]) => [k2, v / typeTotal])), Object.fromEntries(Object.keys(types || {}).map((k2) => [k2, tt(k2)])), { sort: true })}</div>
      </div>
      <div class="card"><h2>Altitude and speed ${scopeLabel}</h2>
        ${lineChart({ points: altPts, h: 180, dots: false, area: true, fmtX: () => "", fmtY: (y) => nf(y) + " m" })}
        ${lineChart({ points: spdPts, h: 150, dots: false, color: "var(--warn)", fmtX: () => "", fmtY: (y) => nf(y) + " km/h" })}</div>
      <div class="grid g2">
        <div class="card"><h2>Technique ${scopeLabel}</h2>
          ${bt ? `<div class="chips" style="margin:0 0 8px">${byIq.map((k) => `<button class="chip ${k === bt ? "on" : ""}" data-iqtype="${k}">${IQ_TYPES[k]} ${nf(best[k].iq)}</button>`).join("")}</div>` : ""}
          <div class="bar bar4 head"><span>Metric</span><span></span><span class="v">Your score</span><span class="v">Weight</span></div>
          ${techRows()}
          ${extraImp.length ? `<p class="muted small">Also counted in this Ski:IQ but not listed in the app: ${extraImp.map((k) => `${esc(METRICS[k] || IMPACT_ONLY[k] || k)} ${nf((imp[k] / impSum) * 100)}%`).join(", ")}.</p>` : ""}
          <p class="muted small">"Your score" is your average ${scopeLabel.replace(/[()]/g, "")} (angles in degrees, G-force in g). "Weight" is each metric's share of the Ski:IQ points in the best stretch of the chosen turn type (together 100%).</p></div>
        <div class="card"><h2>Turn IQ per turn ${scopeLabel}</h2>
          ${lineChart({ points: turnPts, h: 200, dots: turnPts.length < 400, fmtX: (x) => nf(x), fmtY: (y) => nf(y) })}
          <p class="small">Left average <b>${nf(avg(leftIq, 0))}</b> (${leftIq.length} turns) · right average <b>${nf(avg(rightIq, 0))}</b> (${rightIq.length} turns)</p>
          <p class="muted small">Averages only count descents with a Ski:IQ of ${MIN_AVG_IQ}+ (${avgRuns.length} of ${scopeRuns.length} descents); lower ones are mostly teaching.</p></div>
      </div>
      <div class="card"><h2>Descents and lifts ${runK != null && !run ? `(run ${runK + 1})` : ""}</h2><div class="scroll"><table>
        <thead><tr><th>#</th><th>Run</th><th>Start</th><th>Piste</th><th class="num">Duration</th><th class="num">Distance</th><th class="num">↓ m</th><th class="num">Max km/h</th><th class="num">Turns</th><th class="num">Tempo</th><th class="num">Corridor</th><th class="num">Radius</th><th>Balance</th><th class="num">Best Ski:IQ</th><th class="num" title="${esc(BEST8_INFO)}">Best 8</th></tr></thead>
        <tbody>${timeline({ runs: D.runs.filter((r) => runK == null || run || r.session === runK), lifts: runK != null && !run ? D.datas[runK].lifts : D.lifts }).map((x) => x.kind === "run" ? `<tr class="click ${x.r === run ? "sel" : ""}" data-go="${x.r.num - 1}">
            <td>${x.r.num}</td><td>${x.r.session + 1}</td><td>${(x.r.start || "").slice(11, 16)}</td>
            <td>${x.r.piste_difficulty ? `<span style="color:${DIFF_COLOR[x.r.piste_difficulty] || "inherit"}" title="${esc(x.r.piste_difficulty)}">●</span> ` : ""}${esc(x.r.route || "–")}</td>
            <td class="num">${dur(x.r.duration_s)}</td><td class="num">${x.r.distance_m ? nf(x.r.distance_m) + " m" : "–"}</td><td class="num">${x.r.descent_m ? nf(x.r.descent_m) : "–"}</td>
            <td class="num">${x.r.max_speed_kmh ? nf(x.r.max_speed_kmh) : "–"}</td><td class="num">${nf(x.r.turns)}</td>
            <td class="num">${nf(x.r.tempo)}</td><td class="num">${nf(x.r.corridor_m, 1)} m</td><td class="num">${nf(x.r.radius_m, 1)} m</td><td>${balancePill(x.r.balance)}</td><td class="num">${(() => {
              const b = bestOfSubs((D.subsegments || []).filter((y) => y[2] && x.r.start && x.r.end && y[2] >= x.r.start && y[2] <= x.r.end));
              const top = Object.entries(b).sort((p, q) => q[1].iq - p[1].iq)[0];
              return top ? `${nf(top[1].iq)} <span class="muted small">${IQ_TYPES[top[0]]}</span>` : "–";
            })()}</td><td class="num">${nf(best8(x.r.turn_rows), 1)}</td></tr>`
          : `<tr class="muted"><td></td><td></td><td>${(x.l.start || "").slice(11, 16)}</td><td>🚡 ${esc(x.l.name || "Lift")}</td><td class="num">${dur(x.l.duration_s)}</td><td></td><td class="num">↑ ${nf(x.l.ascent_m)}</td><td colspan="8"></td></tr>`).join("")}</tbody>
      </table></div><p class="muted small">Click a descent to see it on its own. ${esc(BEST8_INFO)}</p></div>`;
    document.querySelectorAll("[data-iqtype]").forEach((b) => (b.onclick = () => { state.iqType = b.dataset.iqtype; const y = window.scrollY; viewDay(date, scopeArg).then(() => window.scrollTo(0, y)); }));
    document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => { location.hash = url(b.dataset.go || null); }));
    document.querySelectorAll(".hov-edge").forEach((el) => {
      el.addEventListener("mouseenter", (e) => showHoverCard(e, edgingHtml));
      el.addEventListener("mousemove", (e) => moveHoverCard(e));
      el.addEventListener("mouseleave", hideHoverCard);
    });
    const shapeScope = run ? `descent ${run.num}` : runK != null ? `run ${runK + 1}` : "this day";
    document.querySelectorAll(".hov-shape").forEach((el) => {
      el.addEventListener("mouseenter", (e) => showHoverCard(e, shapeCard(scopeRuns, el.dataset.metric, shapeScope) || `<div class="muted small">No turn-shape data here.</div>`));
      el.addEventListener("mousemove", (e) => moveHoverCard(e));
      el.addEventListener("mouseleave", hideHoverCard);
    });
    document.querySelectorAll("circle[data-run]").forEach((c) => (c.onclick = () => { const r = mapRuns.runs[+c.dataset.run]; if (r) location.hash = url(r.num - 1); }));
  }

  // ---------- where to gain points ----------
  // Per turn type and metric, Carv's Ski:IQ points are (almost) a straight line of your score on that
  // metric. We fit that line over all your scored stretches and use it to estimate the gain of
  // lifting your usual level to your own top-10% level.
  let STRETCHES = null;
  const stretchWaiters = [];
  function loadStretches() {
    if (STRETCHES) return Promise.resolve(STRETCHES);
    return new Promise((res, rej) => {
      stretchWaiters.push(res);
      if (stretchWaiters.length > 1) return;
      loadScript("data/stretches.js").catch(() => { stretchWaiters.length = 0; rej(new Error("data/stretches.js not found — run bijwerken.ps1")); });
    });
  }
  // One "step" of improvement per unit, in Carv's stored unit.
  const STEP = { g_force: [0.1, "+0.1 g"], edge_angle: [5 / DEG, "+5°"], slope_pitch: [2 / DEG, "+2°"], rotation_rate: [10 / DEG, "+10°/s"], tempo: [5, "+5 /min"] };
  const stepOf = (k) => STEP[k] || [0.1, "+10%"];
  function fit(xs, ys) {
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    const b = sxx ? sxy / sxx : 0;
    return { a: my - b * mx, b, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0 };
  }
  const quant = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  async function viewImprove() {
    $("#app").innerHTML = `<p class="muted">Loading…</p>`;
    let all;
    try { all = await loadStretches(); } catch (e) { $("#app").innerHTML = `<p>${esc(e.message)}</p>`; return; }
    const typeOf = (tt) => iqTypeOf(tt);
    const counts = {};
    for (const s of all) { const k = typeOf(s[1]); if (k) counts[k] = (counts[k] || 0) + 1; }
    const types = Object.keys(IQ_TYPES).filter((k) => (counts[k] || 0) >= 20);
    const T = types.includes(state.impType) ? state.impType : types.includes("short") ? "short" : types[0];
    const lastDate = all.reduce((m, s) => (s[0] > m ? s[0] : m), "");
    const daysBack = (n) => { const d = new Date(lastDate + "T12:00:00"); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
    const PERIODS = { d30: ["Last 30 days", daysBack(30)], d90: ["Last 90 days", daysBack(90)], all: ["All time", "0000"] };
    const P = PERIODS[state.impPeriod] ? state.impPeriod : "d30";
    const ofType = all.filter((s) => typeOf(s[1]) === T);
    const recent = ofType.filter((s) => s[0] >= PERIODS[P][1]);

    // Everything is based on your best Ski:IQ for this turn type (the best scored stretch in the period,
    // which is the score the Carv app shows): per metric, how much better that stretch needed to be for +1.
    const keys = [...new Set([...(APP_ORDER[T] || []), ...ofType.flatMap((s) => Object.keys(s[4] || {}))])]
      .filter((k) => ofType.some((s) => s[4]?.[k] != null && s[5]?.[k] != null));
    // Highest level we may recommend per turn type, in Carv's stored units (fractions, radians).
    // Metrics not listed have no maximum.
    const MAX_REC = {
      carving: { parallel_skis: 1, turn_shape_25_short_carving: 1, turn_closure: 0.75, early_edging: 1, edging_smoothness: 1,
        edging_similarity: 1, edge_angle: 85 / DEG, weight_release: 1 },
      short: { parallel_skis: 1, turn_shape_25_short_carving: 1, rotation_rate: 100 / DEG, early_edging: 1,
        edging_similarity: 1, edge_angle: 60 / DEG, weight_release: 1 },
    }[T] || {};
    const bestS =recent.reduce((b, s) => (!b || s[2] > b[2] ? s : b), null);
    const rows = !bestS ? [] : keys.map((k) => {
      const pairs = ofType.filter((s) => s[4]?.[k] != null && s[5]?.[k] != null);
      const f = fit(pairs.map((s) => s[5][k]), pairs.map((s) => s[4][k]));
      const capV = unitOf(k).cap;
      const cap = (v) => (capV != null ? Math.min(capV, v) : v);
      const v = bestS[5]?.[k] != null ? cap(bestS[5][k]) : null;
      const p = bestS[4]?.[k];
      const bestEver = Math.max(...pairs.map((s) => cap(s[5][k])));
      const delta = f.b > 0 ? 1 / f.b : null;
      const target = delta != null && v != null ? v + delta : null;
      const maxV = MAX_REC[k] ?? capV;
      const maxText = maxV != null ? metricText(k, maxV) : "";
      const NO_TIP = { slope_pitch: "no tips: depends on the slope", snow_difficulty: "no tips: depends on the snow" };
      const why = NO_TIP[k] ? NO_TIP[k]
        : v == null ? "not scored in this stretch"
        : f.r2 < 0.5 || f.b <= 0 ? "points hardly depend on it"
        : maxV != null && v >= maxV - 0.005 ? `already at the maximum (${maxText})`
        : maxV != null && target > maxV ? `the maximum (${maxText}) is reached before a full point`
        : null;
      const done = target != null && target <= bestEver;
      // Easiest first: targets you have reached before, then the smallest step compared with your own range.
      const effort = delta != null && bestEver > v ? delta / (bestEver - v) : Infinity;
      return { k, f, v, p, bestEver, delta, target, why, done, effort, maxV, inApp: (APP_ORDER[T] || []).includes(k) };
    }).filter((r) => r.v != null || r.why);
    rows.sort((a, b) => (!!a.why - !!b.why) || (b.done - a.done) || a.effort - b.effort);
    const tips = rows.filter((r) => !r.why);
    const name = (k) => esc(METRICS[k] || IMPACT_ONLY[k] || k);
    const deltaText = (r) => `+${unitOf(r.k).fmt(unitOf(r.k).conv(r.delta))}`;
    const bestDescent = bestS ? `${dateFmt(bestS[0])} ${(bestS[3] || "").slice(11, 16)}` : "";

    // Optional: split each tip over left and right turns. The stretch score is (about) the average of
    // both sides, so +Δ on the average = +2Δ on one side, or the weaker side catches up first and then
    // both sides improve together.
    const lrOf = (r) => {
      const lr = bestS?.[7]?.[r.k];
      if (!lr || lr[0] == null || lr[1] == null) return null;
      const cap = (x) => (r.maxV != null ? Math.min(r.maxV, x) : x);
      const L = cap(lr[0]), R = cap(lr[1]), d = r.delta;
      const weaker = L < R ? "left" : R < L ? "right" : null;
      const w = Math.min(L, R), s = Math.max(L, R), g = s - w;
      let toL = L, toR = R;
      if (2 * d <= g) { if (L < R) toL = L + 2 * d; else toR = R + 2 * d; }
      else { const e = d - g / 2; toL = cap(s + e); toR = cap(s + e); }
      const both = toL !== L && toR !== R;
      return { L, R, toL, toR, weaker, both, nL: lr[2], nR: lr[3] };
    };
    const lrLine = (r) => {
      const x = lrOf(r);
      if (!x) return `<div class="lr muted small">No left/right data for this stretch.</div>`;
      const t = (v) => metricText(r.k, v);
      const plus = (from, to) => `+${unitOf(r.k).fmt(unitOf(r.k).conv(to - from))}`;
      const side = (lbl, from, to, weak) => `<span class="lr-side ${weak ? "lr-weak" : ""}">${lbl} <b>${to - from > 1e-6 ? plus(from, to) : "keep"}</b> <span class="small">(${t(from)}${to - from > 1e-6 ? ` → ${t(to)}` : ""})</span></span>`;
      const advice = x.both ? "both legs" : x.weaker === "left" ? "left turns" : x.weaker === "right" ? "right turns" : "both legs";
      const short = ((x.toL - x.L) + (x.toR - x.R)) / 2 < r.delta * 0.95;
      return `<div class="lr">Improve <b>${advice}</b>: ${side("Left", x.L, x.toL, x.weaker === "left")} ${side("Right", x.R, x.toR, x.weaker === "right")}
        <span class="muted small">(${x.nL} left, ${x.nR} right turns${short ? "; your turns are already close to the maximum, so this split gives a little less than the full point" : ""})</span></div>`;
    };
    const lrTally = { left: 0, right: 0 };
    if (state.lr) for (const r of tips) { const x = lrOf(r); if (x?.weaker) lrTally[x.weaker]++; }

    $("#app").innerHTML = `<h1>Where to gain points</h1>
      <div class="chips">${types.map((k) => `<button class="chip ${k === T ? "on" : ""}" data-imptype="${k}">${IQ_TYPES[k]}</button>`).join("")}</div>
      <div class="chips">${Object.entries(PERIODS).map(([k, [l]]) => `<button class="chip ${k === P ? "on" : ""}" data-impperiod="${k}">${l}</button>`).join("")}</div>
      <label class="lr-toggle"><input type="checkbox" id="lrToggle" ${state.lr ? "checked" : ""}> Split tips by left and right turns</label>
      ${!bestS ? `<div class="card"><p>No ${IQ_TYPES[T].toLowerCase()} in this period. Choose a longer period.</p></div>` : `
      <div class="stats">
        <div class="stat"><b>${nf(bestS[2])}</b><span>your best Ski:IQ ${IQ_TYPES[T].toLowerCase()} · ${bestDescent}</span></div>
        <div class="stat"><b>+${tips.length}</b><span>points possible (+1 per metric)</span></div>
        <div class="stat"><b>${nf(bestS[2] + tips.length)}</b><span>Ski:IQ if you get them all</span></div>
      </div>
      <div class="card"><h2>+1 on your best Ski:IQ, per metric</h2>
        ${tips.length ? tips.map((r, i) => `<p style="margin:7px 0"><b>${i + 1}. ${name(r.k)}</b> — from ${metricText(r.k, r.v)} to <b>${metricText(r.k, r.target)}</b> (${deltaText(r)}) = <b>+1 Ski:IQ</b>
          ${r.done ? `<span class="pill bal-great">you have reached this before</span>` : `<span class="pill bal-ok">beyond your best so far</span>`}</p>
          ${state.lr ? lrLine(r) : ""}`).join("")
          : `<p>No metric left where you can gain a full point: you are at 100% or the points hardly depend on it.</p>`}
        ${state.lr && tips.length ? `<p style="margin-top:12px"><b>Weaker side:</b> ${lrTally.right > lrTally.left ? "right turns" : lrTally.left > lrTally.right ? "left turns" : "neither"} — left turns are the weaker side on ${lrTally.left} and right turns on ${lrTally.right} of the ${tips.length} tips.</p>
          <p class="muted small">Your stretch score is about the average of your left and right turns. To raise it, the weaker side catches up first; only when that is not enough, both legs improve. Together this gives the same +1 Ski:IQ per tip. The left/right levels are the averages of your individual turns in that stretch, so they can differ a little from Carv's stretch score above; the improvement (+…) is what counts.</p>` : ""}
        <p class="muted small">"From" is your score on that metric in your best ${IQ_TYPES[T].toLowerCase()} stretch (${bestDescent}, Ski:IQ ${nf(bestS[2])}). Easiest first: targets you have already reached on some stretch come first.</p></div>
      <div class="card"><h2>All metrics in your best stretch</h2><div class="scroll"><table>
        <thead><tr><th>Metric</th><th class="num">Score</th><th class="num">Points</th><th class="num">For +1 point</th><th class="num">Your best ever</th><th class="num">Fit</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.why ? "muted" : ""}">
          <td>${name(r.k)}${r.inApp ? "" : ` <span class="small">(not shown in app)</span>`}${r.why ? ` <span class="small">— ${esc(r.why)}</span>` : ""}</td>
          <td class="num">${metricText(r.k, r.v)}</td><td class="num">${r.p != null ? Math.round(r.p) : "–"}</td>
          <td class="num">${r.why ? "–" : `<b>${metricText(r.k, r.target)}</b> <span class="small">(${deltaText(r)})</span>`}</td>
          <td class="num">${metricText(r.k, r.bestEver)}</td>
          <td class="num ${r.f.r2 < 0.5 ? "muted" : ""}" title="how well a straight line describes the points (R²)">${nf(r.f.r2 * 100)}%</td></tr>`).join("")}</tbody>
      </table></div>
      <p class="muted small">How this works: Carv's Ski:IQ for ${IQ_TYPES[T].toLowerCase()} = a fixed base + points per metric. For each metric the points follow your score on that metric almost in a straight line, fitted on all ${nf(ofType.length)} of your scored stretches ("Fit": 100% = perfect). From that line follows how much better your best stretch needed to be on a metric for exactly one extra point. Each metric has a highest level that may be recommended (for example 100%, or edge angle ${T === "short" ? "60°" : "85°"}); if that maximum comes before a full point, the metric gets no tip.</p></div>`}`;
    document.querySelectorAll("[data-imptype]").forEach((b) => (b.onclick = () => { state.impType = b.dataset.imptype; viewImprove(); }));
    document.querySelectorAll("[data-impperiod]").forEach((b) => (b.onclick = () => { state.impPeriod = b.dataset.impperiod; viewImprove(); }));
    const lrT = document.getElementById("lrToggle");
    if (lrT) lrT.onchange = () => { state.lr = lrT.checked; viewImprove(); };
  }

  // ---------- records: your 10 best descents per turn type ----------
  async function viewRecords() {
    $("#app").innerHTML = `<p class="muted">Loading…</p>`;
    let all;
    try { all = await loadStretches(); } catch (e) { $("#app").innerHTML = `<p>${esc(e.message)}</p>`; return; }
    const section = (T) => {
      // A descent's Ski:IQ for a turn type = its best scored stretch of that type (as in the Carv app).
      const byDescent = {};
      for (const s of all) {
        if (iqTypeOf(s[1]) !== T || s[6] == null) continue;
        const key = s[0] + "|" + s[6];
        if (!byDescent[key] || s[2] > byDescent[key][2]) byDescent[key] = s;
      }
      const top = Object.values(byDescent).sort((a, b) => b[2] - a[2]).slice(0, 10);
      if (!top.length) return `<div class="card"><h2>${IQ_TYPES[T]}</h2><p class="muted">No scored ${IQ_TYPES[T].toLowerCase()} yet.</p></div>`;
      const keys = APP_ORDER[T] || [];
      // Highest value per metric among these ten, to highlight it.
      // Compare the values as shown (rounded), so equal-looking values are treated as equal.
      const shown = (k, v) => (v == null ? null : parseFloat(metricText(k, v).replace(/,/g, "")));
      const colMax = Object.fromEntries(keys.map((k) => [k, Math.max(...top.map((s) => shown(k, s[5]?.[k]) ?? -Infinity))]));
      const colMin = Object.fromEntries(keys.map((k) => [k, Math.min(...top.map((s) => shown(k, s[5]?.[k]) ?? Infinity))]));
      // Best in the column: green badge. Lowest: amber. Others: green shade (darker = closer to the best),
      // a small bar for the position between lowest and best, and the gap to the best.
      const gapText = (k, d) => { const t = unitOf(k).fmt(d); return d > 0 ? `−${t}` : t; };
      const cell = (k, s) => {
        // Edge angle cells show the outside/inside ski card for that descent on hover.
        // data-label: the metric name, shown inside the cell when the table stacks into cards on a phone.
        const hk = k === "edge_angle" ? " hov-edge" : SHAPE_METRICS[k] ? " hov-shape" : "";
        const td = (cls, style, inner) => `<td class="num rec-cell${cls}${hk}" data-label="${esc(METRICS[k] || k)}"${hk ? ` data-edate="${s[0]}" data-edesc="${s[6]}" data-metric="${k}"` : ""}${style ? ` style="${style}"` : ""}>${inner}</td>`;
        const n = shown(k, s[5]?.[k]);
        if (n == null) return td("", "", "–");
        const v = metricText(k, s[5][k]);
        if (colMax[k] === colMin[k]) return td("", "", `<span class="rec-same">${v}</span><div class="rec-gap">all equal</div>`);
        const t = (n - colMin[k]) / (colMax[k] - colMin[k]);
        const bar = `<div class="rec-bar"><i style="width:${(6 + t * 94).toFixed(0)}%"></i></div>`;
        if (n === colMax[k]) return td(" rec-top", "", `<span class="rec-best">★ ${v}</span><div class="rec-gap">best</div>${bar}`);
        const gap = `<div class="rec-gap">${gapText(k, colMax[k] - n)}</div>`;
        if (n === colMin[k]) return td(" rec-low", "", `${v}${gap}${bar}`);
        return td("", `background:rgba(60,207,110,${(0.05 + t * 0.25).toFixed(2)})`, `${v}${gap}${bar}`);
      };
      const shortDate = (d) => new Date(d + "T12:00:00").toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "2-digit" });
      return `<div class="card"><h2>${IQ_TYPES[T]} — top ${top.length} descents</h2><table class="rec-table">
        <thead><tr><th>#</th><th class="num">Ski:IQ</th><th>Date · descent</th>${keys.map((k) => `<th class="num">${esc(METRICS[k] || k)}${k === "edge_angle" || SHAPE_METRICS[k] ? ` <span class="hov-hint">ⓘ</span>` : ""}</th>`).join("")}</tr></thead>
        <tbody>${top.map((s, i) => `<tr class="click" data-go="#/d/${s[0]}/${s[6] - 1}">
          <td class="rec-rank">${i + 1}</td><td class="num rec-iq" data-label="#${i + 1} · Ski:IQ"><b>${nf(s[2])}</b></td><td class="rec-when" data-label="Date · descent">${shortDate(s[0])} · ${s[6]}<br><span class="muted small">${(s[3] || "").slice(11, 16)}</span></td>
          ${keys.map((k) => cell(k, s)).join("")}</tr>`).join("")}</tbody>
      </table></div>`;
    };
    $("#app").innerHTML = `<h1>Records</h1>
      <p class="muted">Your 10 best descents per turn type over all your data. A descent's Ski:IQ is its best scored stretch of that turn type, as in the Carv app; the metrics are from that stretch. Per metric: <span class="rec-best">★</span> = the best of these ten, <span class="rec-legend-low">amber</span> = the lowest, the darker the green the closer to the best. Under each value: how far it is from the best, and a bar from lowest to best. Grey = all ten are equal. Click a row to open the descent.</p>
      ${section("carving")}${section("short")}`;
    document.querySelectorAll("tr[data-go]").forEach((r) => (r.onclick = () => (location.hash = r.dataset.go)));
    // Hover on an edge angle cell: load that day (cached after the first time) and show the descent's card.
    document.querySelectorAll("td.hov-edge, td.hov-shape").forEach((el) => {
      let over = false;
      el.addEventListener("mouseenter", async (e) => {
        over = true;
        showHoverCard(e, `<div class="muted small">Loading…</div>`);
        const D = await loadDay(el.dataset.edate).catch(() => null);
        const r = D?.runs.find((x) => x.num === +el.dataset.edesc);
        const scope = `${dateFmt(el.dataset.edate)}, descent ${el.dataset.edesc}`;
        const html = el.classList.contains("hov-edge") ? edgingCard(r ? [r] : [], scope) : shapeCard(r ? [r] : [], el.dataset.metric, scope);
        if (over) showHoverCard(e, html || `<div class="muted small">No per-ski data for this descent.</div>`);
      });
      el.addEventListener("mousemove", moveHoverCard);
      el.addEventListener("mouseleave", () => { over = false; hideHoverCard(); });
    });
  }

  // Several lines in one chart: series = [{ name, color, points: [{x, y, tip}] }].
  function multiLineChart({ series, w, h = 260, fmtX = (x) => x, fmtY = (y) => nf(y), onClick }) {
    return zoomChart({ series, w, h, fmtX, fmtY, onClick, legend: true });
  }
  // Short date for chart axes, e.g. "2 Jul 26".
  const axisDate = (d) => d ? new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "2-digit" }) : "";

  // ---------- the average turn as an S (hover card on other technique metrics) ----------
  // Carv's median ski path: first half = right turn, second half = left turn. Along the path the colour
  // shows where in the turn a metric is measured more (darker) or less (lighter).
  const SHAPE_METRICS = {
    parallel_skis: { what: "Angle between the skis", more: "skis less parallel", src: "par", unit: "°" },
    g_force: { what: "Load on the skis", more: "more load", src: "acc", unit: " g" },
    weight_release: { what: "Unloading of the skis", more: "more weight released", src: "rel" },
    rotation_rate: { what: "Turning speed of the skis", more: "faster turning", src: "rot" },
    turn_shape_25_short_carving: { what: "How sharply the path curves", more: "sharper curve", src: "curve" },
    turn_closure: { what: "How sharply the path curves", more: "sharper curve (closing the turn)", src: "curve" },
    early_edging: { what: "How fast the edge angle builds up", more: "edging up faster", src: "edgeup" },
    edging_smoothness: { what: "Sudden changes in edging", more: "less smooth edging", src: "jerk" },
    edging_similarity: { what: "Edge angle difference between the skis", more: "skis edged more differently", src: "simdiff", unit: "°" },
  };
  function shapeCard(runs, k, scopeText) {
    const meta = SHAPE_METRICS[k];
    const rs = runs.filter((r) => r.shape?.path?.length);
    if (!meta || !rs.length) return "";
    const wt = (r) => r.turns || 1, W = rs.reduce((a, r) => a + wt(r), 0);
    const n = rs[0].shape.path.length;
    const path = Array.from({ length: n }, (_, i) => [0, 1].map((j) => rs.reduce((a, r) => a + (r.shape.path[i]?.[j] ?? 0) * wt(r), 0) / W));
    // Average a per-turn curve over the descents that have it.
    const avgCurve = (get) => {
      const got = rs.map((r) => [get(r), wt(r)]).filter(([c]) => c?.length);
      if (!got.length) return null;
      const m = Math.min(...got.map(([c]) => c.length)), w = got.reduce((a, [, x]) => a + x, 0);
      return Array.from({ length: m }, (_, i) => got.reduce((a, [c, x]) => a + c[i] * x, 0) / w);
    };
    const resample = (c, m) => c && Array.from({ length: m }, (_, i) => c[Math.round((i * (c.length - 1)) / Math.max(1, m - 1))]);
    const half = Math.floor(n / 2);
    const curveOf = (side) => {
      const S = side === "R" ? "R" : "L", e1 = side === "R" ? "ro" : "lo", e2 = side === "R" ? "ri" : "li";
      const roll = () => { const a = avgCurve((r) => r.edging?.[e1]), b = avgCurve((r) => r.edging?.[e2]); return a && b ? a.map((v, i) => (v + b[i]) / 2) : null; };
      switch (meta.src) {
        case "par": case "acc": case "rot": return avgCurve((r) => r.shape[S]?.[meta.src]);
        case "rel": { const a = avgCurve((r) => r.shape[S]?.acc); if (!a) return null; const mx = Math.max(...a); return a.map((v) => mx - v); }
        case "simdiff": { const a = avgCurve((r) => r.edging?.[e1]), b = avgCurve((r) => r.edging?.[e2]); return a && b ? a.map((v, i) => Math.abs(v - b[i])) : null; }
        case "edgeup": { const a = roll(); return a && a.map((v, i) => Math.max(0, (a[Math.min(i + 1, a.length - 1)] - a[Math.max(i - 1, 0)]) / 2)); }
        case "jerk": { const a = roll(); return a && a.map((v, i) => Math.abs((a[Math.min(i + 1, a.length - 1)] ?? v) - 2 * v + (a[Math.max(i - 1, 0)] ?? v))); }
        case "curve": {
          const seg = side === "R" ? path.slice(0, half + 1) : path.slice(half);
          const hd = seg.slice(1).map((p, i) => Math.atan2(p[0] - seg[i][0], p[1] - seg[i][1]));
          return seg.map((_, i) => { const a = hd[Math.max(0, i - 1)], b = hd[Math.min(hd.length - 1, i)]; let d = Math.abs(b - a); if (d > Math.PI) d = 2 * Math.PI - d; return (d * 180) / Math.PI; });
        }
      }
      return null;
    };
    const cR = resample(curveOf("R"), half + 1), cL = resample(curveOf("L"), n - half);
    if (!cR && !cL) return "";
    const vals = [...(cR || []), ...(cL || [])];
    const lo = Math.min(...vals), hi = Math.max(...vals), norm = (v) => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
    // Light to dark blue.
    const col = (t) => { const a = [214, 236, 250], b = [8, 70, 125]; return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(",")})`; };
    const xs = path.map((p) => p[0]), ys = path.map((p) => p[1]);
    const W2 = 250, H2 = 330, pad = 26;
    const sx = (W2 - 2 * pad) / Math.max(1e-6, Math.max(...xs) - Math.min(...xs)), sy = (H2 - 2 * pad) / Math.max(1e-6, Math.max(...ys) - Math.min(...ys));
    // Widened sideways (like the Carv app), otherwise the S is a thin line.
    const sX = Math.min(sx * 0.62, sy * 4), cx = W2 / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * sX, y0 = Math.min(...ys);
    const P = (p) => [cx + p[0] * sX, pad + (p[1] - y0) * sy];
    let segs = "";
    for (let i = 0; i < n - 1; i++) {
      const v = i < half ? cR?.[i] : cL?.[i - half];
      const [x1, y1] = P(path[i]), [x2, y2] = P(path[i + 1]);
      segs += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${v == null ? "#c9d3df" : col(norm(v))}" stroke-width="9" stroke-linecap="round"/>`;
    }
    const apex = (a, b) => { let best = a; for (let i = a; i < b; i++) if (Math.abs(path[i][0]) > Math.abs(path[best][0])) best = i; return best; };
    const aR = apex(0, half), aL = apex(half, n);
    const lab = (i, text) => { const [x, y] = P(path[i]); const right = path[i][0] > 0; return `<text x="${(x + (right ? -16 : 16)).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${right ? "end" : "start"}" style="fill:var(--ink);font-size:12px;font-weight:700">${text}</text>`; };
    const [tx, ty] = P(path[0]);
    // Where in each turn the metric peaks (as % of the turn).
    const peak = (c) => { if (!c) return null; let b = 0; c.forEach((v, i) => { if (v > c[b]) b = i; }); return Math.round((b / Math.max(1, c.length - 1)) * 100); };
    const pR = peak(cR), pL = peak(cL);
    const fmtV = (v) => (meta.unit ? nf(v, meta.unit === " g" ? 2 : 1) + meta.unit : "");
    const ends = meta.unit ? `<span>${fmtV(lo)}</span><span>${fmtV(hi)}</span>` : `<span>less</span><span>more</span>`;
    return `<div class="hc-title">${esc(METRICS[k] || k)} through the turn <span class="muted small">(${esc(scopeText)})</span></div>
      <div class="shape-wrap"><svg viewBox="0 0 ${W2} ${H2}" width="${W2}" class="shape-svg" role="img" aria-label="Average turn shape">
        <text x="${tx.toFixed(1)}" y="12" text-anchor="middle" class="ax">start ↓ downhill</text>${segs}${lab(aR, "Right turn")}${lab(aL, "Left turn")}</svg>
      <div class="shape-side"><p class="small" style="margin:0 0 8px"><b>${esc(meta.what)}</b> along your average turn: darker = ${esc(meta.more)}.</p>
        <div class="shape-legend"><i style="background:linear-gradient(90deg,${col(0)},${col(1)})"></i><div class="shape-ends">${ends}</div></div>
        <p class="small" style="margin:10px 0 0">Highest at about ${pR != null ? `<b>${pR}%</b> of the right turn` : "–"}${pL != null ? ` and <b>${pL}%</b> of the left turn` : ""} (0% = start, 100% = end of the turn).</p>
        <p class="muted small" style="margin:8px 0 0">Shape and values are Carv's average over the turns${rs.length > 1 ? `, weighted by turns over ${rs.length} descents` : ""}. Lighter and darker are relative within this picture.</p></div></div>`;
  }

  // ---------- outside vs inside ski edge angle (hover card on "Edge angle") ----------
  // Average the per-descent curves (weighted by turns). Positive = edged into the turn, in degrees.
  function edgingCard(runs, scopeText) {
    const keys = ["lo", "li", "ro", "ri"];
    const avg = {};
    for (const k of keys) {
      const rs = runs.filter((r) => r.edging?.[k]?.length);
      if (!rs.length) return "";
      const n = Math.min(...rs.map((r) => r.edging[k].length));
      const w = rs.reduce((a, r) => a + (r.turns || 1), 0);
      avg[k] = Array.from({ length: n }, (_, i) => rs.reduce((a, r) => a + r.edging[k][i] * (r.turns || 1), 0) / w);
    }
    // Per curve: peak, where in the turn it is reached, average, and when 80% of the peak is first reached.
    const pctAt = (i, n) => Math.round((i / (n - 1)) * 100);
    const info = Object.fromEntries(keys.map((k) => {
      const a = avg[k], p = Math.max(...a), pi = a.indexOf(p);
      return [k, { peak: p, peakAt: pctAt(pi, a.length), mean: a.reduce((x, y) => x + y, 0) / a.length,
        mid: a[Math.round((a.length - 1) / 2)], build: pctAt(a.findIndex((v) => v >= 0.8 * p), a.length), pi }];
    }));
    const peak = Object.fromEntries(keys.map((k) => [k, info[k].peak]));
    // A ski "lags" when its peak is at least 5° below the other ski in that turn direction.
    const behind = { lo: peak.lo < peak.li - 5, li: peak.li < peak.lo - 5, ro: peak.ro < peak.ri - 5, ri: peak.ri < peak.ro - 5 };
    const gaps = [["left turns", "outside", peak.lo - peak.li], ["left turns", "inside", peak.li - peak.lo], ["right turns", "outside", peak.ro - peak.ri], ["right turns", "inside", peak.ri - peak.ro]];
    const worst = gaps.reduce((a, g) => (g[2] < a[2] ? g : a));
    const deg = (x) => `${Math.round(x)}°`;
    const sdeg = (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(Math.round(x))}°`;
    const all = keys.flatMap((k) => avg[k]);
    const y0 = Math.min(0, Math.floor(Math.min(...all) / 10) * 10), y1 = Math.max(10, Math.ceil(Math.max(...all) / 10) * 10);
    const chart = (title, ko, ki) => {
      const out = avg[ko], inn = avg[ki], outBehind = behind[ko], inBehind = behind[ki];
      const W = 330, H = 210, L = 32, R = 8, B = 22, T = 20;
      const X = (i, n) => L + (i / (n - 1)) * (W - L - R), Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
      const XP = (p) => L + (p / 100) * (W - L - R);
      const path = (a) => a.map((v, i) => `${i ? "L" : "M"}${X(i, a.length).toFixed(1)},${Y(v).toFixed(1)}`).join("");
      const blue = "var(--accent)", amber = "#f0b429";
      let grid = "";
      for (let v = y0; v <= y1; v += 10) grid += `<line x1="${L}" y1="${Y(v)}" x2="${W - R}" y2="${Y(v)}" stroke="var(--line)" ${v === 0 ? "" : 'stroke-dasharray="2 3"'}/><text x="${L - 4}" y="${Y(v) + 4}" text-anchor="end">${v}°</text>`;
      for (const p of [0, 25, 50, 75, 100]) grid += `<line x1="${XP(p)}" y1="${T}" x2="${XP(p)}" y2="${H - B}" stroke="var(--line)" ${p === 50 ? "" : 'stroke-dasharray="2 3"'}/><text x="${XP(p)}" y="${H - 6}" text-anchor="${p === 0 ? "start" : p === 100 ? "end" : "middle"}">${p === 50 ? "mid-turn" : p + "%"}</text>`;
      // Shaded band between the two skis: shows where in the turn they differ most.
      const band = `${path(out)}${inn.slice().reverse().map((v, j) => `L${X(inn.length - 1 - j, inn.length).toFixed(1)},${Y(v).toFixed(1)}`).join("")}Z`;
      const mark = (k, col, below) => {
        const c = info[k], a = avg[k], x = X(c.pi, a.length), y = Y(c.peak);
        return `<circle cx="${x}" cy="${y}" r="3.5" fill="${col}"/><text x="${Math.min(W - R - 2, Math.max(L + 14, x))}" y="${below ? y + 14 : y - 6}" text-anchor="middle" style="fill:${col};font-weight:600">${deg(c.peak)}</text>`;
      };
      const outBelow = info[ko].peak < info[ki].peak;
      return `<svg viewBox="0 0 ${W} ${H}" width="100%"><text x="0" y="12" style="fill:var(--ink);font-size:12px;font-weight:600">${title}</text>
        ${grid}
        <path d="${band}" fill="${outBehind || inBehind ? amber : blue}" fill-opacity=".12" stroke="none"/>
        <path d="${path(inn)}" fill="none" stroke="${inBehind ? amber : blue}" stroke-width="2" stroke-dasharray="5 4"/>
        <path d="${path(out)}" fill="none" stroke="${outBehind ? amber : blue}" stroke-width="2.5"/>
        ${mark(ki, inBehind ? amber : blue, !outBelow)}${mark(ko, outBehind ? amber : blue, outBelow)}</svg>`;
    };
    // Detail table: outside, inside and the difference (outside − inside) per turn direction.
    const row = (label, f, fmt, diffFmt, warnDiff) => {
      const side = (ko, ki) => {
        const d = f(info[ko]) - f(info[ki]);
        return `<td class="num">${fmt(f(info[ko]))}</td><td class="num">${fmt(f(info[ki]))}</td><td class="num${warnDiff && warnDiff(d) ? " warn" : ""}">${diffFmt(d)}</td>`;
      };
      return `<tr><td>${label}</td>${side("lo", "li")}${side("ro", "ri")}</tr>`;
    };
    const pct = (x) => `${x}%`, spct = (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x)}%`;
    const table = `<table class="hc-table"><thead>
        <tr><th></th><th colspan="3" class="grp">Left turns</th><th colspan="3" class="grp">Right turns</th></tr>
        <tr><th></th><th class="num">Outside</th><th class="num">Inside</th><th class="num">Diff.</th><th class="num">Outside</th><th class="num">Inside</th><th class="num">Diff.</th></tr></thead><tbody>
        ${row("Peak edge angle", (c) => c.peak, deg, sdeg, (d) => Math.abs(d) >= 5)}
        ${row("Edge at mid-turn", (c) => c.mid, deg, sdeg, (d) => Math.abs(d) >= 5)}
        ${row("Average through turn", (c) => c.mean, deg, sdeg, (d) => Math.abs(d) >= 5)}
        ${row("Peak reached at", (c) => c.peakAt, pct, spct)}
        ${row("80% of peak reached at", (c) => c.build, pct, spct)}
      </tbody></table>`;
    const nTurns = runs.reduce((a, r) => a + (r.turns || 0), 0);
    return `<div class="hc-title">Outside vs inside ski <span class="muted small">(${esc(scopeText)}${nTurns ? ` · ${nf(nTurns)} turns${runs.length > 1 ? `, ${runs.length} descents` : ""}` : ""})</span></div>
      <div class="hc-stats">
        <div><span>Left turns · peak edge</span><b>${deg(peak.lo)} <small>out</small> · ${deg(peak.li)} <small>in</small></b></div>
        <div><span>Right turns · peak edge</span><b>${deg(peak.ro)} <small>out</small> · ${deg(peak.ri)} <small>in</small></b></div>
        <div class="${worst[2] <= -5 ? "hc-warn" : ""}"><span>Biggest gap</span><b>${worst[2] <= -5 ? `${worst[0]}, ${worst[1]} ski ${deg(worst[2])}` : "none (within 5°)"}</b></div>
      </div>
      <div class="hc-charts">${chart("Left turns", "lo", "li")}${chart("Right turns", "ro", "ri")}</div>
      <div class="legend"><span><i style="background:var(--accent)"></i>outside ski</span><span><i style="background:repeating-linear-gradient(90deg,var(--accent) 0 5px,transparent 5px 9px)"></i>inside ski</span><span><i style="background:rgba(77,163,255,.3)"></i>difference between the skis</span><span><i style="background:#f0b429"></i>at least 5° behind the other ski</span></div>
      ${table}
      <p class="muted small" style="margin:4px 0 0">Average edge angle per ski from the start (0%) to the end (100%) of the turn, at full resolution. "80% of peak reached at" shows how early each ski builds its edge. More edge on the outside ski usually goes with more weight on it, but Carv does not measure weight.</p>`;
  }
  let hoverCard;
  function showHoverCard(e, html) {
    if (!html) return;
    if (!hoverCard) { hoverCard = document.createElement("div"); hoverCard.className = "hovercard"; document.body.appendChild(hoverCard); }
    hoverCard.innerHTML = html; hoverCard.style.display = "block"; moveHoverCard(e);
  }
  function moveHoverCard(e) {
    if (!hoverCard || hoverCard.style.display !== "block") return;
    const w = hoverCard.offsetWidth, h = hoverCard.offsetHeight;
    let x = e.clientX + 16, y = e.clientY + 16;
    if (x + w > window.innerWidth - 8) x = Math.max(8, e.clientX - w - 16);
    if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
    hoverCard.style.left = x + "px"; hoverCard.style.top = y + "px";
  }
  function hideHoverCard() { if (hoverCard) hoverCard.style.display = "none"; }

  function timeline(day) {
    const items = day.runs.map((r, i) => ({ kind: "run", i, r, t: r.start || "" })).concat(day.lifts.map((l) => ({ kind: "lift", l, t: l.start || "" })));
    return items.sort((a, b) => (a.t > b.t ? 1 : a.t < b.t ? -1 : 0));
  }

  function viewTrends() {
    const opts = { ski_iq: "Ski:IQ", ...METRICS, tempo: "Tempo", turn_speed: "Turn speed",
      max_speed_kmh: "Max speed (km/h)", skiing_distance_km: "Ski distance (km)", descent_m: "Vertical ↓ (m)", turns: "Turns" };
    for (const [k, v] of Object.entries(IQ_TYPES)) opts["iq_" + k] = "Ski:IQ " + v;
    const chips = seasonChips(true);
    const list = [...filtered()].sort((a, b) => (a.start > b.start ? 1 : -1));
    const m = state.trend;
    const get = (s) => m === "ski_iq" ? iq(s.ski_iq) : m.startsWith("iq_") ? s.best_iq?.[m.slice(3)]?.iq ?? null : m in METRICS || m in RAW_METRICS ? metricNum(m, s.display?.[m]) : s[m];
    const pts = list.map((s, i) => ({ x: i, y: get(s), id: s.id, tip: `${dateFmt(s.date)} · ${esc(place(s))}<br>${esc(opts[m])}: ${nf(get(s), 1)}` }));
    const isIq = m === "ski_iq" || m.startsWith("iq_");
    const allVals = pts.map((p) => p.y).filter((y) => y != null);
    const vals = isIq ? allVals.filter((y) => y >= MIN_AVG_IQ) : allVals;
    const half = Math.floor(vals.length / 2);
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    $("#app").innerHTML = `<h1>Trends</h1>
      ${chips}
      <div class="card"><label>Metric: <select id="metric">${Object.entries(opts).map(([k, v]) => `<option value="${k}" ${k === m ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
        <div style="margin-top:12px">${lineChart({ points: pts, h: 280, fmtX: (x) => { const s = list[Math.round(x)]; return s ? axisDate(s.date) : ""; }, fmtY: (y) => nf(y, Math.abs(y) < 10 && y % 1 ? 1 : 0), onClick: (p) => (location.hash = "#/s/" + p.id) })}</div>
        <p class="small">${vals.length} sessions${isIq && vals.length < allVals.length ? ` with ${MIN_AVG_IQ}+ (of ${allVals.length})` : ""} · average <b>${nf(mean(vals), 1)}</b> · first half ${nf(mean(vals.slice(0, half)), 1)} → second half <b>${nf(mean(vals.slice(half)), 1)}</b> · highest ${vals.length ? nf(Math.max(...vals), 1) : "–"}</p>
        <p class="muted small">Technique values averaged per session (weighted by number of turns), in the same units as on the session page.${m.startsWith("iq_") ? " Ski:IQ per turn type = best scored stretch of that type in the session (as in the Carv app)." : ""}${isIq ? ` Averages only count scores of ${MIN_AVG_IQ}+; lower scores are mostly teaching. The chart shows all sessions.` : ""}</p></div>`;
    $("#metric").onchange = (e) => { state.trend = e.target.value; viewTrends(); };
    bindChips(viewTrends);
  }

  // ---------- router ----------
  function route() {
    if (!INDEX) return;
    const h = location.hash.replace(/^#\/?/, "").split("/");
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === (h[0] === "" || h[0] === "s" || h[0] === "d" ? "home" : h[0])));
    hideTip();
    if (h[0] === "s" && h[1]) {
      // Old session links (e.g. from Trends) open the day, scoped to that run.
      const s = INDEX.sessions.find((x) => x.id === h[1]);
      const k = s ? INDEX.sessions.filter((x) => x.date === s.date).sort((a, b) => (a.start > b.start ? 1 : -1)).indexOf(s) : -1;
      location.replace(s ? `#/d/${s.date}/r${k}` : "#/");
      return;
    }
    if (h[0] === "d" && h[1]) viewDay(h[1], h[2] !== undefined && h[2] !== "" ? h[2] : null);
    else if (h[0] === "trends") viewTrends();
    else if (h[0] === "improve") viewImprove();
    else if (h[0] === "records") viewRecords();
    else viewHome();
    window.scrollTo(0, 0);
  }

  // A hover card must not stay behind when a click on that row opens another page.
  window.addEventListener("hashchange", () => { hideHoverCard(); route(); });

  // Refresh button: load the newest data the laptop has put online (a home-screen app has no reload button).
  // Fetching from Carv itself happens on the laptop (bijwerken.ps1 / the scheduled task).
  // Online, it first asks the cloud job to fetch new sessions from Carv and waits until that is done.
  const refreshBtn = document.getElementById("refresh");
  const refreshLabel = refreshBtn && refreshBtn.querySelector("span");
  const setLabel = (t) => { if (refreshLabel) refreshLabel.textContent = t; };
  function alertBox(text) {
    document.getElementById("refresh-msg")?.remove();
    const d = document.createElement("div");
    d.id = "refresh-msg"; d.className = "card refresh-msg"; d.setAttribute("role", "status");
    d.innerHTML = `<p class="small" style="margin:0">${esc(text)}</p><button type="button" class="chip" style="margin-top:10px">OK</button>`;
    d.querySelector("button").onclick = () => d.remove();
    $("#app").prepend(d);
    window.scrollTo(0, 0);
  }
  async function refreshProof() {
    const bytes = new TextEncoder().encode("my-ski-days-refresh|" + KEYB64);
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function fetchFromCarv() {
    const headers = { "x-refresh-proof": await refreshProof() };
    const start = Date.now();
    const r = await fetch("api/refresh", { method: "POST", headers });
    if (r.status === 404) return "no-cloud";
    const first = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(first.error || `HTTP ${r.status}`);
    setLabel("Fetching…");
    // Wait for the job: first for it to appear, then for it to finish (max. ~15 minutes).
    for (let i = 0; i < 180; i++) {
      await new Promise((res) => setTimeout(res, 5000));
      const s = await (await fetch("api/status", { headers, cache: "no-store" })).json().catch(() => ({}));
      const run = s.run;
      if (!run) continue;
      const fresh = first.started ? Date.parse(run.created) >= start - 20000 : true;
      if (!fresh) continue;
      if (run.status === "completed") {
        if (run.conclusion === "success") return "done";
        throw new Error("carv");
      }
    }
    throw new Error("timeout");
  }
  if (refreshBtn) refreshBtn.onclick = async () => {
    refreshBtn.classList.add("busy"); refreshBtn.disabled = true;
    if (window.CARV_SECURE && KEYB64) {
      let cloudErr = null;
      try { await fetchFromCarv(); }
      catch (e) { cloudErr = e; }
      // Cloud job not available (switched off or not set up): just load the newest data, no message.
      if (cloudErr && cloudErr.message !== "carv" && cloudErr.message !== "timeout") cloudErr = null;
      if (cloudErr) {
        const e = cloudErr;
        refreshBtn.classList.remove("busy"); refreshBtn.disabled = false; setLabel("Refresh");
        alertBox(e.message === "carv"
          ? "Fetching from Carv failed. The Carv login has probably expired: on the laptop, log in to Carv again and run cloud\\carv-login-vernieuwen.ps1. The data you see is from the last successful update."
          : e.message === "timeout" ? "Fetching from Carv takes longer than usual. Try Refresh again in a few minutes."
          : `Could not reach the update service (${e.message}). The data you see is from the last update.`);
        return;
      }
      setLabel("Loading…");
    }
    const data = window.CARV_SECURE ? ["index.bin", "bundles.bin", "stretches.bin"] : ["index.js", "stretches.js"];
    const files = data.map((f) => `data/${f}`).concat(["app.js", "app.css", "theme-carv.css"]);
    await Promise.all(files.map((f) => fetch(f, { cache: "reload" }).catch(() => null)));
    location.reload();
  };

  // Sharp charts at every screen size: the SVGs scale with their card, which made text and lines
  // tiny and blurry on a phone (and oversized on a big screen). Draw text, dots and lines at their
  // real pixel size instead; only the positions scale.
  function crispCharts() {
    document.querySelectorAll("svg[viewBox]").forEach((svg) => {
      const vb = svg.viewBox.baseVal, w = svg.getBoundingClientRect().width;
      if (!vb || !vb.width || !w) return;
      const s = w / vb.width;
      if (svg.dataset.s && Math.abs(+svg.dataset.s - s) < 0.01) return;
      svg.dataset.s = s;
      svg.style.overflow = "visible";
      svg.querySelectorAll("text").forEach((t) => {
        if (!t.dataset.fs) t.dataset.fs = parseFloat(getComputedStyle(t).fontSize) || 11;
        t.style.fontSize = `${t.dataset.fs / s}px`;
      });
      svg.querySelectorAll("circle").forEach((c) => {
        if (!c.dataset.r) c.dataset.r = c.getAttribute("r");
        c.setAttribute("r", Math.min(+c.dataset.r / s, +c.dataset.r * 2.2));
      });
    });
  }
  let crispQueued = false;
  const queueCrisp = () => { if (!crispQueued) { crispQueued = true; requestAnimationFrame(() => { crispQueued = false; crispCharts(); }); } };
  new MutationObserver(queueCrisp).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", queueCrisp);
  // Redraw the page when the chart width changes a lot (e.g. turning the phone), keeping the scroll position.
  let drawnW = chartW(), redrawT = null;
  window.addEventListener("resize", () => {
    clearTimeout(redrawT);
    redrawT = setTimeout(() => {
      const w = chartW();
      if (Math.abs(w - drawnW) / drawnW < 0.15 || !INDEX) return;
      drawnW = w;
      const y = window.scrollY;
      Promise.resolve(route()).then(() => window.scrollTo(0, y));
    }, 250);
  });
  function ensureTip() { if (!tip) { tip = document.createElement("div"); tip.className = "tip"; document.body.appendChild(tip); } }
  document.addEventListener("DOMContentLoaded", ensureTip);

  return {
    index(data) {
      INDEX = data;
      INDEX.sessions.sort((a, b) => (a.start > b.start ? 1 : -1));
      if (window.CARV_SECURE) {
        $("#foot").innerHTML = `${INDEX.sessions.length} sessions · data updated ${esc(INDEX.generated)} · <a href="#" id="forget">Lock on this device</a>`;
        $("#forget").onclick = (e) => { e.preventDefault(); forgetKey(); };
      } else {
        $("#foot").textContent = `${INDEX.sessions.length} sessions · data updated ${INDEX.generated} · run bijwerken.ps1 to fetch new ski days`;
      }
      ensureTip();
      route();
    },
    bundles(map) { BUNDLES = map; },
    secureBoot,
    loaded(id, data) { cache[id] = data; (waiting[id] || []).forEach((f) => f(data)); delete waiting[id]; },
    stretches(data) { STRETCHES = data; stretchWaiters.splice(0).forEach((f) => f(data)); },
    missing() { $("#app").innerHTML = `<div class="card"><h2>No data yet</h2><p>Run <code>bijwerken.ps1</code> in this folder first.</p></div>`; },
  };
})();
