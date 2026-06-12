/* NCL physical-observability demo.
   Renders a real simulated temperature field, computes the naive sparse-sensor
   baseline live, and turns each frame into an operator decision. No backend. */

(function () {
  "use strict";

  const data = window.NCL_DATA;
  if (!data) { console.error("demo_data.js failed to load"); return; }

  const NX = data.meta.nx, NY = data.meta.ny;
  const [TMIN, TMAX] = data.meta.tempRange;
  const NFRAMES = data.meta.nframes;
  const SENSORS = data.sensors;
  const CHANNEL_M = 22;                 // channel length used for "distance" readouts
  const M_PER_CELL = CHANNEL_M / NX;
  const PLAY_MS = 260;

  // ---- decode payloads -----------------------------------------------------
  function b64ToBytes(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const MASK = b64ToBytes(data.mask);                    // 255 inside pipe, 0 outside
  const GEO = data.geometry;
  const FRAME_GT = data.frames.map(f => b64ToBytes(f.gt));
  const LUT = new Uint8Array(256 * 3);
  data.colormap.forEach((c, i) => { LUT[i*3]=c[0]; LUT[i*3+1]=c[1]; LUT[i*3+2]=c[2]; });

  const tempFromU8 = v => TMIN + (v / 255) * (TMAX - TMIN);
  const u8FromTemp = t => Math.max(0, Math.min(255, Math.round((t - TMIN) / (TMAX - TMIN) * 255)));

  // ---- state ---------------------------------------------------------------
  const state = {
    frame: 0,
    view: "after",                       // "before" | "after"
    overlays: { sensors: true, confidence: false },
    playing: false,
    hover: null,                         // {gx, gy}
    planted: [],                         // [{gx, gy}, ...] click-planted virtual sensors
  };
  const idwCache = new Array(NFRAMES);   // before-NCL baseline, computed on demand

  // ---- DOM -----------------------------------------------------------------
  const $ = id => document.getElementById(id);
  const fieldWrap = $("fieldWrap");
  const fieldCanvas = $("fieldCanvas"), overlayCanvas = $("overlayCanvas");
  const fctx = fieldCanvas.getContext("2d"), octx = overlayCanvas.getContext("2d");
  const probeTip = $("probeTip"), anomalyCallout = $("anomalyCallout"), fieldHint = $("fieldHint");
  const timeline = $("timeline"), playBtn = $("playBtn");

  const off = document.createElement("canvas"); off.width = NX; off.height = NY;
  const offCtx = off.getContext("2d");
  const fieldImg = offCtx.createImageData(NX, NY);

  // ---- confidence / uncertainty (mirrors the 3D posterior-spread model) ----
  // A generative reconstruction is a posterior, not one field. We approximate
  // its per-pixel spread from three signals: observational support (how close,
  // how many sensors constrain a point), field structure (steep gradients admit
  // many fits) and novelty vs the ambient prior. Structure and novelty are gated
  // by lack of observation, then smoothed. Per frame, cached, time varying.
  const AMBIENT = data.meta.ambientC;
  const SIG2D = 10;                            // sensor influence radius (cells)
  const UOBS2D = new Float32Array(NX * NY);    // static observation-only term
  (function () {
    const inv2s2 = 1 / (2 * SIG2D * SIG2D);
    for (let i = 0; i < NX * NY; i++) {
      if (!MASK[i]) continue;
      const x = i % NX, y = (i / NX) | 0;
      let cov = 0;
      for (let k = 0; k < SENSORS.length; k++) {
        const dx = x - SENSORS[k].x, dy = y - SENSORS[k].y;
        cov += Math.exp(-(dx*dx + dy*dy) * inv2s2);
      }
      UOBS2D[i] = Math.exp(-cov * 2.2);        // on a sensor: ~0, far from all sensors: ~1
    }
  })();
  const nb2 = (f, x, y, fb) => (x < 0 || x >= NX || y < 0 || y >= NY) ? f[fb]
    : (MASK[y*NX + x] ? f[y*NX + x] : f[fb]);
  const uncCache2d = new Array(NFRAMES);
  function uncertainty2d(frame) {
    if (uncCache2d[frame]) return uncCache2d[frame];
    const f = FRAME_GT[frame], U = new Float32Array(NX * NY), GRADREF = 26;
    for (let i = 0; i < NX * NY; i++) {
      if (!MASK[i]) continue;
      const x = i % NX, y = (i / NX) | 0;
      const gxv = nb2(f, x+1, y, i) - nb2(f, x-1, y, i);
      const gyv = nb2(f, x, y+1, i) - nb2(f, x, y-1, i);
      const ugrad = Math.min(1, 0.5 * Math.sqrt(gxv*gxv + gyv*gyv) / GRADREF);
      const unov = Math.min(1, Math.max(0, (tempFromU8(f[i]) - (AMBIENT + 8)) / 45));
      const structural = Math.min(1, 0.85 * ugrad + 0.55 * unov);
      U[i] = UOBS2D[i] * (0.38 + 0.62 * structural);
    }
    for (let p = 0; p < 2; p++) {                // light smoothing -> continuous field
      const src = U.slice();
      for (let i = 0; i < NX * NY; i++) {
        if (!MASK[i]) continue;
        const x = i % NX;
        let sum = src[i], cnt = 1;
        if (x+1 < NX && MASK[i+1])      { sum += src[i+1];  cnt++; }
        if (x-1 >= 0 && MASK[i-1])      { sum += src[i-1];  cnt++; }
        if (i+NX < NX*NY && MASK[i+NX]) { sum += src[i+NX]; cnt++; }
        if (i-NX >= 0 && MASK[i-NX])    { sum += src[i-NX]; cnt++; }
        U[i] = sum / cnt;
      }
    }
    return (uncCache2d[frame] = U);
  }
  // green (sure) -> amber -> orange -> magenta (unsure); same ramp as the 3D view
  const CONF_STOPS2D = [[0.0,34,197,94],[0.45,250,204,66],[0.74,239,135,80],[1.0,192,78,210]];
  function confRGB2d(u) {
    let a = CONF_STOPS2D[0], b = CONF_STOPS2D[CONF_STOPS2D.length-1];
    for (let s = 0; s < CONF_STOPS2D.length-1; s++) { if (u >= CONF_STOPS2D[s][0] && u <= CONF_STOPS2D[s+1][0]) { a = CONF_STOPS2D[s]; b = CONF_STOPS2D[s+1]; break; } }
    const t = b[0] === a[0] ? 0 : (u - a[0]) / (b[0] - a[0]);
    return [a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t, a[3]+(b[3]-a[3])*t];
  }
  // colorbar gradients: temperature (inferno) vs confidence (green -> magenta)
  const TEMP_BAR = (() => { const s=[]; for (let i=0;i<=10;i++){ const c=data.colormap[Math.round(i/10*255)]; s.push(`rgb(${c[0]},${c[1]},${c[2]}) ${i*10}%`); } return `linear-gradient(90deg, ${s.join(",")})`; })();
  const CONF_BAR = (() => { const s=[]; for (let i=0;i<=10;i++){ const c=confRGB2d(i/10); s.push(`rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])}) ${i*10}%`); } return `linear-gradient(90deg, ${s.join(",")})`; })();
  function paintColorbar(confView) {
    $("cbTrack").style.background = confView ? CONF_BAR : TEMP_BAR;
    $("cbMin").textContent = confView ? "Confident" : Math.round(TMIN) + "°C";
    $("cbMax").textContent = confView ? "Uncertain" : Math.round(TMAX) + "°C";
  }

  let DPR = Math.min(window.devicePixelRatio || 1, 2);
  let fw = 0, fh = 0;

  // ---- baseline (before NCL): inverse-distance weighting from sensors ------
  function idwField(frameIdx) {
    if (idwCache[frameIdx]) return idwCache[frameIdx];
    const vals = data.frames[frameIdx].sensorVals;
    const out = new Uint8Array(NX * NY);
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        let num = 0, den = 0, exact = -1;
        for (let k = 0; k < SENSORS.length; k++) {
          const dx = x - SENSORS[k].x, dy = y - SENSORS[k].y;
          const d2 = dx*dx + dy*dy;
          if (d2 < 1) { exact = vals[k]; break; }
          const w = 1 / (d2 * d2);          // power-4 weight -> crisp near sensors
          num += w * vals[k]; den += w;
        }
        out[y*NX + x] = u8FromTemp(exact >= 0 ? exact : num / den);
      }
    }
    idwCache[frameIdx] = out;
    return out;
  }

  function currentFieldU8() {
    return state.view === "before" ? idwField(state.frame) : FRAME_GT[state.frame];
  }

  // ---- rendering: pipe asset (casing + equipment) --------------------------
  function drawCasing() {
    const loop = GEO.loop;
    fctx.lineJoin = "round"; fctx.lineCap = "round";
    fctx.beginPath();
    fctx.moveTo(gx2px(loop[0][0]), gy2px(loop[0][1]));
    for (let i = 1; i < loop.length; i++) fctx.lineTo(gx2px(loop[i][0]), gy2px(loop[i][1]));
    fctx.closePath();
    fctx.lineWidth = (GEO.pipeRadius * 2 + 9) * (fw / NX);
    fctx.strokeStyle = "#39435a"; fctx.stroke();        // steel casing (fluid sits inside)
  }
  // crisp, evenly-spaced gear teeth along the inner pipe wall (vector -> high-res)
  function drawTeeth() {
    const loop = GEO.loop, s = fw / NX;
    let cx = 0, cy = 0; for (const p of loop) { cx += p[0]; cy += p[1]; } cx /= loop.length; cy /= loop.length;
    const cpx = gx2px(cx), cpy = gy2px(cy);
    const rIn = GEO.pipeRadius * s - 1, toothLen = 6, toothW = 8, step = 14;
    fctx.fillStyle = "#48556f";
    let acc = step;
    for (let i = 0; i < loop.length; i++) {
      const a = [gx2px(loop[i][0]), gy2px(loop[i][1])];
      const nb = loop[(i + 1) % loop.length], b = [gx2px(nb[0]), gy2px(nb[1])];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 1e-3) continue;
      const tx = dx / len, ty = dy / len;
      let nx = -ty, ny = tx;
      if ((cpx - a[0]) * nx + (cpy - a[1]) * ny < 0) { nx = -nx; ny = -ny; }   // normal -> toward centre
      for (let d = 0; d < len; d++) {
        if (++acc < step) continue; acc = 0;
        const px = a[0] + tx * d, py = a[1] + ty * d, bx = px + nx * rIn, by = py + ny * rIn;
        fctx.beginPath();
        fctx.moveTo(bx + tx * toothW / 2, by + ty * toothW / 2);
        fctx.lineTo(bx - tx * toothW / 2, by - ty * toothW / 2);
        fctx.lineTo(bx + nx * toothLen, by + ny * toothLen);   // tip into the central hole
        fctx.closePath(); fctx.fill();
      }
    }
  }
  function assetLabel(px, py, text) {
    fctx.font = "600 11px Inter, system-ui, sans-serif";
    fctx.textAlign = "center";
    const w = fctx.measureText(text).width;
    fctx.fillStyle = "rgba(8,12,24,0.72)";
    fctx.fillRect(px - w / 2 - 4, py - 11, w + 8, 15);
    fctx.fillStyle = "#aab9d6"; fctx.fillText(text, px, py);
    fctx.textAlign = "left";
  }
  function drawEquipment() {
    const p = GEO.pump, e = GEO.exchanger, s = fw / NX;
    // pump: a housing on the pipe with an impeller triangle (not a crosshair)
    const ppx = gx2px(p.x), ppy = gy2px(p.y), pr = p.r * s * 0.82;
    fctx.beginPath(); fctx.arc(ppx, ppy, pr, 0, Math.PI*2);
    fctx.fillStyle = "#2b3447"; fctx.fill();
    fctx.lineWidth = 2; fctx.strokeStyle = "#5d6d88"; fctx.stroke();
    fctx.fillStyle = "#8aa0c4";
    fctx.beginPath();
    fctx.moveTo(ppx, ppy - pr*0.5);
    fctx.lineTo(ppx + pr*0.42, ppy + pr*0.34);
    fctx.lineTo(ppx - pr*0.42, ppy + pr*0.34);
    fctx.closePath(); fctx.fill();
    assetLabel(ppx - pr - 24, ppy, "Pump");              // label left of the pump, clear of T-01
    // heat exchanger
    const epx = gx2px(e.x), epy = gy2px(e.y), ew = e.w * s, eh = e.h * (fh / NY);
    fctx.fillStyle = "#2b3447"; fctx.fillRect(epx - ew/2, epy - eh/2, ew, eh);
    fctx.lineWidth = 2; fctx.strokeStyle = "#5d6d88"; fctx.strokeRect(epx - ew/2, epy - eh/2, ew, eh);
    fctx.strokeStyle = "#4c5b76"; fctx.lineWidth = 1.5;
    for (let i = 1; i < 6; i++) {
      const x = epx - ew/2 + i*ew/6;
      fctx.beginPath(); fctx.moveTo(x, epy - eh/2 + 3); fctx.lineTo(x, epy + eh/2 - 3); fctx.stroke();
    }
    assetLabel(epx, epy - eh/2 - 8, "Heat exchanger");
  }

  // ---- rendering: field ----------------------------------------------------
  function renderField() {
    const field = currentFieldU8();
    const confView = state.overlays.confidence && state.view === "after";
    const U = confView ? uncertainty2d(state.frame) : null;   // NCL output: After only
    const d = fieldImg.data;
    for (let i = 0; i < NX * NY; i++) {
      if (!MASK[i]) { d[i*4+3] = 0; continue; }          // outside the pipe -> transparent
      if (confView) {                                    // recolour the pipe as the confidence field
        const rgb = confRGB2d(U[i]);
        d[i*4] = rgb[0]; d[i*4+1] = rgb[1]; d[i*4+2] = rgb[2]; d[i*4+3] = 255;
      } else {
        const c = field[i] * 3;
        const w = Math.max(0, 1 - field[i] / 40);        // blend cool fluid into the casing grey
        d[i*4]   = LUT[c]   * (1 - w) + 57 * w;           // (hides the grid-resolution pipe edge;
        d[i*4+1] = LUT[c+1] * (1 - w) + 67 * w;           //  warm fluid stays pure inferno)
        d[i*4+2] = LUT[c+2] * (1 - w) + 90 * w;
        d[i*4+3] = 255;
      }
    }
    offCtx.putImageData(fieldImg, 0, 0);

    fctx.clearRect(0, 0, fw, fh);
    drawCasing();                                        // pipe body (under the fluid)
    fctx.imageSmoothingEnabled = true;
    fctx.drawImage(off, 0, 0, NX, NY, 0, 0, fw, fh);     // field, clipped to pipe
    paintColorbar(confView);                             // temperature scale, or confident -> uncertain
    drawTeeth();                                         // crisp ridged inner wall
    drawEquipment();                                     // pump + exchanger on top of the fluid
  }

  // ---- rendering: overlay (sensors / anomaly / probe) ----------------------
  const gx2px = gx => (gx + 0.5) / NX * fw;
  const gy2px = gy => (gy + 0.5) / NY * fh;

  // Tint a sensor by the signal it carries (delta above baseline): cool -> amber -> red.
  function sensorColor(delta) {
    const t = Math.max(0, Math.min(1, delta / 15));
    const stops = [[125, 211, 252], [251, 191, 36], [248, 113, 113]];
    const seg = t < 0.5 ? 0 : 1;
    const f = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const a = stops[seg], b = stops[seg + 1];
    return `rgb(${Math.round(a[0]+(b[0]-a[0])*f)},${Math.round(a[1]+(b[1]-a[1])*f)},${Math.round(a[2]+(b[2]-a[2])*f)})`;
  }

  // greedy non-overlapping label placement; returns [textX, baselineY] and records the rect
  function placeLabel(px, py, lw, placed, hit) {
    const cands = [
      [px + 11, py + 4], [px - 11 - lw, py + 4],
      [px + 11, py - 9], [px - 11 - lw, py - 9],
      [px + 11, py + 17], [px - 11 - lw, py + 17],
    ];
    let tx = cands[0][0], ty = cands[0][1];
    for (const c of cands) {
      const r = { x: c[0] - 4, y: c[1] - 12, w: lw + 8, h: 16 };
      if (r.x < 2 || r.x + r.w > fw - 2 || r.y < 2 || r.y + r.h > fh - 2) continue;
      if (hit(r)) continue;
      tx = c[0]; ty = c[1]; break;
    }
    placed.push({ x: tx - 4, y: ty - 12, w: lw + 8, h: 16 });
    return [tx, ty];
  }

  // a click-planted virtual sensor: dashed NCL-blue, clearly distinct from physical dots
  function drawVirtualMarker(px, py) {
    octx.save();
    octx.setLineDash([3, 3]);
    octx.lineWidth = 2; octx.strokeStyle = "#60a5fa";
    octx.beginPath(); octx.arc(px, py, 8, 0, Math.PI * 2); octx.stroke();
    octx.setLineDash([]);
    octx.beginPath(); octx.arc(px, py, 3, 0, Math.PI * 2);
    octx.fillStyle = "#3b82f6"; octx.fill();
    octx.lineWidth = 1.5; octx.strokeStyle = "#0c1322"; octx.stroke();
    octx.restore();
  }

  function renderOverlay(now) {
    octx.clearRect(0, 0, fw, fh);
    const fr = data.frames[state.frame];
    octx.font = "600 11px Inter, system-ui, sans-serif";
    const placed = [];
    const hit = r => placed.some(p =>
      !(r.x + r.w < p.x || r.x > p.x + p.w || r.y + r.h < p.y || r.y > p.y + p.h));

    if (state.overlays.sensors) {
      const items = [];
      for (let k = 0; k < SENSORS.length; k++) {
        const s = SENSORS[k];
        const px = gx2px(s.x), py = gy2px(s.y);
        const reading = fr.sensorVals[k];
        const delta = reading - data.meta.ambientC;
        const col = sensorColor(delta);
        octx.beginPath(); octx.arc(px, py, 6, 0, Math.PI*2);
        octx.fillStyle = col; octx.fill();
        octx.lineWidth = 2; octx.strokeStyle = "rgba(255,255,255,0.92)"; octx.stroke();
        const main = `${s.id}  ${reading.toFixed(1)}°C`;
        const dTxt = delta >= 1.5 ? `  +${delta.toFixed(0)}` : "";
        const mw = octx.measureText(main).width;
        items.push({ px, py, col, main, dTxt, mw, lw: mw + (dTxt ? octx.measureText(dTxt).width : 0) });
      }
      for (const it of items) {
        const [tx, ty] = placeLabel(it.px, it.py, it.lw, placed, hit);
        octx.fillStyle = "rgba(8,12,24,0.72)"; octx.fillRect(tx - 4, ty - 12, it.lw + 8, 16);
        octx.fillStyle = "#dce8fb"; octx.fillText(it.main, tx, ty);
        if (it.dTxt) { octx.fillStyle = it.col; octx.fillText(it.dTxt, tx + it.mw, ty); }
      }
    }

    // anomaly ring at the hidden hotspot (auto when warning/critical, after-view only)
    const crit = fr.status === "critical";
    const showAnomaly = state.view === "after" && (fr.status === "warning" || crit) && fr.hotspot;
    if (showAnomaly) {
      const px = gx2px(fr.hotspot.x), py = gy2px(fr.hotspot.y);
      const phase = (Math.sin((now || 0) / (crit ? 240 : 360)) + 1) / 2;
      const r = (crit ? 30 : 26) + phase * (crit ? 16 : 10);
      octx.lineWidth = crit ? 3 : 2.5;
      octx.strokeStyle = `rgba(248,90,90,${(crit ? 0.95 : 0.85) - phase*0.3})`;
      octx.beginPath(); octx.arc(px, py, r, 0, Math.PI*2); octx.stroke();
      octx.lineWidth = 2; octx.strokeStyle = crit ? "rgba(255,80,80,0.95)" : "rgba(251,111,111,0.9)";
      octx.beginPath(); octx.arc(px, py, 16, 0, Math.PI*2); octx.stroke();
    }
    positionAnomalyCallout(showAnomaly ? fr : null);

    // planted virtual sensors: each reads the current field at its point (updates with time/view)
    const field = currentFieldU8();
    for (const p of state.planted) {
      if (!MASK[p.gy * NX + p.gx]) continue;
      const px = gx2px(p.gx), py = gy2px(p.gy);
      drawVirtualMarker(px, py);
      const txt = `${tempFromU8(field[p.gy * NX + p.gx]).toFixed(0)}°C`;
      const lw = octx.measureText(txt).width;
      const [tx, ty] = placeLabel(px, py, lw, placed, hit);
      octx.fillStyle = "rgba(8,12,24,0.8)"; octx.fillRect(tx - 4, ty - 12, lw + 8, 16);
      octx.fillStyle = "#93c5fd"; octx.fillText(txt, tx, ty);
    }

    // hover preview crosshair (live, before you commit a plant)
    if (state.hover && MASK[state.hover.gy * NX + state.hover.gx]) drawProbeMarker(state.hover, false);
  }

  function drawProbeMarker(p, pinned) {
    const px = gx2px(p.gx), py = gy2px(p.gy);
    octx.save();
    octx.strokeStyle = pinned ? "#93c5fd" : "rgba(255,255,255,0.85)";
    octx.lineWidth = 1.5;
    octx.setLineDash([4, 4]);
    octx.beginPath(); octx.moveTo(px, 0); octx.lineTo(px, fh);
    octx.moveTo(0, py); octx.lineTo(fw, py); octx.stroke();
    octx.setLineDash([]);
    octx.beginPath(); octx.arc(px, py, 6, 0, Math.PI*2);
    octx.fillStyle = pinned ? "#3b82f6" : "#fff"; octx.fill();
    octx.lineWidth = 2; octx.strokeStyle = "#0c1322"; octx.stroke();
    octx.restore();
  }

  function positionAnomalyCallout(fr) {
    if (!fr) { anomalyCallout.hidden = true; return; }
    const px = gx2px(fr.hotspot.x), py = gy2px(fr.hotspot.y);
    anomalyCallout.hidden = false;
    anomalyCallout.innerHTML =
      `${fr.status === "critical" ? "Critical" : "Hidden"} hotspot · ${fr.hotspot.segment}` +
      `<small>${fr.peakC.toFixed(1)}°C reconstructed</small>`;
    const w = anomalyCallout.offsetWidth, h = anomalyCallout.offsetHeight;
    // sit below-left of the peak (sensor cluster + plume tail are above/right)
    let left = px - w - 8, top = py + 30;
    if (top + h > fh - 6) top = py - h - 30;          // flip above if no room below
    left = Math.max(6, Math.min(fw - 6 - w, left));
    anomalyCallout.style.left = left + "px";
    anomalyCallout.style.top = top + "px";
  }

  // ---- operator panel ------------------------------------------------------
  const STATUS = {
    normal:  { word: "Normal",  pill: "All nominal",
      line: "Existing sensors and the reconstructed field agree. Operating within bounds." },
    watch:   { word: "Watch",   pill: "Early signal",
      line: "The reconstruction shows heat rising in a zone with no nearby sensor, while the sensors still read normal." },
    warning: { word: "Warning", pill: "Action needed",
      line: "A hot region is developing in an unmonitored part of the loop. The sensors alone would not catch this yet." },
    critical: { word: "Critical", pill: "Immediate action",
      line: "Reconstructed temperature is far above the safe margin in an unmonitored zone. The existing sensors are still blind to it." },
  };
  function actionText(status, seg) {
    if (status === "critical") return `Isolate and inspect segment ${seg} immediately. Reconstructed temperature is critically high in a zone with no physical sensor.`;
    if (status === "warning") return `Inspect segment ${seg} now. Reconstructed temperature exceeds the safe margin in a zone with no physical sensor.`;
    if (status === "watch") return `Schedule a targeted inspection of segment ${seg}. Re-check the reconstruction next cycle.`;
    return "Continue normal monitoring. No intervention required.";
  }
  function explainerText() {
    if (state.view === "before")
      return "<strong>Before NCL:</strong> a few sensors run slightly warm, but interpolation can never read hotter than the sensors themselves, so the hidden peak is badly underestimated.";
    if (state.overlays.confidence)
      return "<strong>Confidence map:</strong> the spread across posterior reconstructions. Green where sensors pin the field and the pattern is regular; magenta where it is sparsely sensed, changing fast, or unlike normal operation, which is exactly where the fault hides.";
    return "<strong>After NCL:</strong> the faint, correlated signal across the sensors, plus the physics, reconstructs the full field and reveals a peak far hotter than any single sensor reads.";
  }
  function confLabel(pct) { return pct >= 70 ? "High" : pct >= 40 ? "Moderate" : "Low"; }

  const SENSOR_ALARM_C = 60;   // physical high-temp alarm (operators set these high to avoid trips)

  function updatePanel() {
    const fr = data.frames[state.frame];
    const hottest = Math.max.apply(null, fr.sensorVals);

    $("clock").textContent = fr.t;
    $("mTime").textContent = fr.t;
    $("sensorPeak").textContent = hottest.toFixed(1) + "°C";
    $("explainer").innerHTML = explainerText();

    // Before NCL: only raw sensors. No reconstruction, no confidence, no fault
    // call. Here the sensors never cross their alarm, so the asset reads Normal
    // even as the fault develops -> that is the whole point of the comparison.
    if (state.view === "before") {
      const tripped = hottest >= SENSOR_ALARM_C;
      $("liveDot").className = "live-dot" + (tripped ? " warning" : "");
      $("statusWord").textContent = tripped ? "Warning" : "Normal";
      $("statusPill").textContent = tripped ? "Sensor alarm" : "No alarm";
      $("statusLine").textContent = tripped
        ? "A physical sensor has crossed its alarm threshold."
        : "All sensors read within normal range. No anomaly detected.";
      $("statusCard").className = "status-card" + (tripped ? " warning" : "");
      $("gapCard").style.display = "none";
      $("mLocation").textContent = "None";
      $("mConfidence").textContent = "—";
      $("mDistance").textContent = "—";
      $("actionText").textContent = "Continue normal monitoring. No intervention indicated by the sensors.";
      $("actionCard").className = "action-card";
      return;
    }

    // After NCL: full assessment from the reconstructed field.
    const info = STATUS[fr.status];
    $("liveDot").className = "live-dot" + (fr.status === "normal" ? "" : " " + fr.status);
    $("statusWord").textContent = info.word;
    $("statusPill").textContent = info.pill;
    $("statusLine").textContent = info.line;
    $("statusCard").className = "status-card" + (fr.status === "normal" ? "" : " " + fr.status);

    $("gapCard").style.display = "";
    $("reconPeak").textContent = fr.peakC.toFixed(1) + "°C";
    const gap = Math.max(0, fr.peakC - hottest);
    $("gapHidden").textContent = "Hidden rise: +" + gap.toFixed(1) + "°C";
    $("gapCard").className = "gap-card" + (gap < 2 ? " calm" : "");

    if (fr.hotspot) {
      const U = uncertainty2d(state.frame);
      const pct = Math.round((1 - U[fr.hotspot.y * NX + fr.hotspot.x]) * 100);
      let dmin = Infinity;
      for (const s of SENSORS) {
        const d = Math.hypot(s.x - fr.hotspot.x, s.y - fr.hotspot.y);
        if (d < dmin) dmin = d;
      }
      $("mLocation").textContent = "Segment " + fr.hotspot.segment;
      $("mConfidence").textContent = confLabel(pct) + " · " + pct + "%";
      $("mDistance").textContent = (dmin * M_PER_CELL).toFixed(1) + " m away";
    } else {
      $("mLocation").textContent = "None";
      $("mConfidence").textContent = "High";
      $("mDistance").textContent = "in range";
    }

    $("actionText").textContent = actionText(fr.status, fr.hotspot ? fr.hotspot.segment : "");
    $("actionCard").className = "action-card" +
      ((fr.status === "warning" || fr.status === "critical") ? " " + fr.status : "");
  }

  // ---- virtual sensor readout ----------------------------------------------
  function updateProbeReadout() {
    const card = document.querySelector(".probe-card");
    const p = state.hover;
    if (p && MASK[p.gy * NX + p.gx]) {
      const idx = p.gy * NX + p.gx;
      const t = tempFromU8(currentFieldU8()[idx]);
      card.classList.add("active");
      if (state.view === "before") {
        $("probeReadout").innerHTML =
          `Interpolated estimate here: <b>${t.toFixed(1)}°C</b><br>classical interpolation between sensors, no confidence`;
      } else {
        const pct = Math.round((1 - uncertainty2d(state.frame)[idx]) * 100);
        $("probeReadout").innerHTML =
          `NCL reconstruction here: <b>${t.toFixed(1)}°C</b><br>Confidence: <b>${pct}%</b>`;
      }
      return;
    }
    if (state.planted.length) {
      card.classList.add("active");
      const n = state.planted.length;
      $("probeReadout").innerHTML =
        `<b>${n}</b> virtual sensor${n > 1 ? "s" : ""} planted. Click one to remove, or hover the pipe to read any point.`;
    } else {
      card.classList.remove("active");
      $("probeReadout").innerHTML =
        "Hover the pipe to read any point, or click to plant a virtual sensor where there is no physical one.";
    }
  }

  function updateProbeTip(clientX, clientY) {
    if (!state.hover || !MASK[state.hover.gy * NX + state.hover.gx]) { probeTip.hidden = true; return; }
    const idx = state.hover.gy * NX + state.hover.gx;
    const t = tempFromU8(currentFieldU8()[idx]);
    const rect = fieldWrap.getBoundingClientRect();
    probeTip.hidden = false;
    probeTip.style.left = (clientX - rect.left) + "px";
    probeTip.style.top = (clientY - rect.top) + "px";
    probeTip.innerHTML = `${t.toFixed(1)}°C<small>${state.view === "before" ? "interpolated" : "virtual sensor"}</small>`;
  }

  // ---- frame control -------------------------------------------------------
  function setFrame(i) {
    state.frame = Math.max(0, Math.min(NFRAMES - 1, i));
    timeline.value = state.frame;
    renderField();
    updatePanel();
    updateProbeReadout();
  }
  function play() {
    if (state.frame >= NFRAMES - 1) state.frame = 0;
    state.playing = true; playBtn.textContent = "❚❚"; playBtn.setAttribute("aria-label", "Pause");
    clearInterval(play._t);
    play._t = setInterval(() => {
      if (state.frame >= NFRAMES - 1) { pause(); return; }
      setFrame(state.frame + 1);
    }, PLAY_MS);
  }
  function pause() {
    state.playing = false; playBtn.textContent = "▶"; playBtn.setAttribute("aria-label", "Play");
    clearInterval(play._t);
  }

  // Confidence is an NCL deliverable: available only in the After view.
  const confPill = document.querySelector('.pill[data-overlay="confidence"]');
  function syncConfidenceAvailability() {
    if (state.view === "before") {
      state.overlays.confidence = false;
      confPill.classList.remove("is-active");
      confPill.classList.add("disabled");
      confPill.title = "Confidence is an NCL output, available After NCL";
    } else {
      confPill.classList.remove("disabled");
      confPill.title = "";
      confPill.classList.toggle("is-active", state.overlays.confidence);
    }
  }

  // ---- events --------------------------------------------------------------
  document.querySelectorAll(".seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.view = btn.dataset.view;
      document.querySelectorAll(".seg-btn").forEach(b => b.classList.toggle("is-active", b === btn));
      syncConfidenceAvailability();
      renderField(); updatePanel(); updateProbeReadout();
    });
  });
  document.querySelectorAll(".pill").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("disabled")) return;
      const key = btn.dataset.overlay;
      state.overlays[key] = !state.overlays[key];
      btn.classList.toggle("is-active", state.overlays[key]);
      renderField(); updatePanel();
    });
  });
  timeline.addEventListener("input", e => { pause(); setFrame(+e.target.value); });
  playBtn.addEventListener("click", () => state.playing ? pause() : play());

  function pointerToGrid(e) {
    const rect = fieldWrap.getBoundingClientRect();
    const gx = Math.floor((e.clientX - rect.left) / rect.width * NX);
    const gy = Math.floor((e.clientY - rect.top) / rect.height * NY);
    if (gx < 0 || gx >= NX || gy < 0 || gy >= NY) return null;
    return { gx, gy };
  }
  fieldWrap.addEventListener("pointermove", e => {
    const g = pointerToGrid(e);
    state.hover = g;
    fieldHint.style.opacity = "0";
    updateProbeTip(e.clientX, e.clientY);
    updateProbeReadout();
  });
  fieldWrap.addEventListener("pointerleave", () => {
    state.hover = null; probeTip.hidden = true; updateProbeReadout();
  });
  fieldWrap.addEventListener("pointerdown", e => {
    const g = pointerToGrid(e);
    if (!g || !MASK[g.gy * NX + g.gx]) return;            // only plant on the pipe
    const near = state.planted.findIndex(p => Math.hypot(p.gx - g.gx, p.gy - g.gy) < 6);
    if (near >= 0) state.planted.splice(near, 1);          // click a virtual sensor to remove it
    else if (state.planted.length < 8) state.planted.push(g);
    updateProbeReadout();
  });
  document.addEventListener("keydown", e => {
    if (e.key === " ") { e.preventDefault(); state.playing ? pause() : play(); }
    else if (e.key === "ArrowRight") { pause(); setFrame(state.frame + 1); }
    else if (e.key === "ArrowLeft") { pause(); setFrame(state.frame - 1); }
  });

  // ---- timeline ticks + colorbar ------------------------------------------
  function buildTicks() {
    const ticks = $("ticks");
    const marks = [{ f: 0, label: data.frames[0].t, cls: "" }];
    if (data.meta.watchFrame != null)
      marks.push({ f: data.meta.watchFrame, label: "Fault begins", cls: "watch" });
    if (data.meta.criticalFrame != null)
      marks.push({ f: data.meta.criticalFrame, label: "Critical", cls: "critical" });
    else if (data.meta.warningFrame != null)
      marks.push({ f: data.meta.warningFrame, label: "Warning", cls: "warning" });
    ticks.innerHTML = marks.map(m =>
      `<span class="${m.cls}" style="left:${m.f/(NFRAMES-1)*100}%"><b></b>${m.label}</span>`).join("");
  }
  function buildColorbar() {
    const stops = [];
    for (let i = 0; i <= 10; i++) {
      const c = data.colormap[Math.round(i/10*255)];
      stops.push(`rgb(${c[0]},${c[1]},${c[2]}) ${i*10}%`);
    }
    $("cbTrack").style.background = `linear-gradient(90deg, ${stops.join(",")})`;
    $("cbMin").textContent = Math.round(TMIN) + "°C";
    $("cbMax").textContent = Math.round(TMAX) + "°C";
  }

  // ---- resize + animation loop --------------------------------------------
  function resize() {
    const r = fieldWrap.getBoundingClientRect();
    fw = r.width; fh = r.height;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    for (const cv of [fieldCanvas, overlayCanvas]) {
      cv.width = Math.round(fw * DPR); cv.height = Math.round(fh * DPR);
    }
    fctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    octx.setTransform(DPR, 0, 0, DPR, 0, 0);
    renderField();
  }
  window.addEventListener("resize", resize);

  function loop(now) { renderOverlay(now); requestAnimationFrame(loop); }

  // ---- init ----------------------------------------------------------------
  timeline.max = NFRAMES - 1;
  buildTicks();
  buildColorbar();
  syncConfidenceAvailability();
  resize();
  setFrame(0);
  requestAnimationFrame(loop);
})();
