/* NCL row demo: a liquid-cooled rack row (two Redmond bays) fed by a 2 MW Deschutes-class CDU,
   drawn as a dimensioned wireframe from the OCP specification. Branch flow, return temperature
   and health in the After view are the output of the trained ensemble (ncl_demo_row_ml), with
   its standard deviation driving the confidence layer; row_data.js keeps the simulator truth beside them.
   row_data.js is written by ncl_demo_row_ml/export_demo.py. If it comes from generate_row_data.py instead
   (simulation state only, no model fields), the page says so and keeps working.
   Three.js r128 + OrbitControls, vendored, offline. */
(function () {
  "use strict";
  const data = window.NCL_ROW, THREE = window.THREE;
  if (!data || !THREE) { console.error("row_data.js or three.js missing"); return; }
  const G = data.geometry, M = data.meta, FR = data.frames, RACKS = G.racks, N = RACKS.length, NF = M.nframes;
  const [TMIN, TMAX] = M.tempRange, [CMIN, CMAX] = M.chipRange;
  const PLAY_MS = +(new URLSearchParams(location.search).get("play")) || 240;   // ?play=600 slows playback (recordings)
  const $ = id => document.getElementById(id);
  const opt = id => document.getElementById(id) || { textContent: "", innerHTML: "", hidden: true };   // an element a cached, older index.html may lack

  // ---- data source: trained model output, or the simulation state as a labelled stand-in ----------
  const MODEL = !!(M.model && FR[0].branches[0].qSd !== undefined);
  if (!MODEL) FR.forEach(fr => {
    fr.branches.forEach(b => { b.qSd = 0; b.tRetSd = 0; b.truth = null; });
    fr.hidden.deficitSdPct = 0; fr.hidden.pRestricted = fr.status === "normal" ? 0 : 1;
  });
  const throttleFrame = M.throttleFrame != null ? M.throttleFrame
    : (() => { const i = FR.findIndex(fr => fr.branches.some(b => b.throttle)); return i < 0 ? null : i; })();
  // minutes between the first flag in the After view and the first server alarm (the first sign in the Before view)
  const leadMin = (MODEL && M.watchFrame != null && throttleFrame != null && throttleFrame > M.watchFrame) ? (throttleFrame - M.watchFrame) * M.frameSeconds / 60 : null;
  const fmtMin = m => (Math.abs(m - Math.round(m)) < 0.05 ? String(Math.round(m)) : m.toFixed(1)) + " min";

  const state = { frame: 0, view: "after", layers: { structure: true, rdhx: true, labels: true, confidence: false }, playing: false, hover: null };

  // ---- colour maps -----------------------------------------------------------
  // coolant ramp: cool supply reads blue, warm return teal to amber, a starved branch orange to white-hot
  const COOL_STOPS = [[0.0, 37, 99, 235], [0.3, 34, 193, 195], [0.52, 251, 191, 36], [0.78, 249, 115, 22], [1.0, 255, 241, 193]];
  function rampColor(stops, u) {
    u = Math.max(0, Math.min(1, u));
    let a = stops[0], b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) if (u >= stops[s][0] && u <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break; }
    const t = b[0] === a[0] ? 0 : (u - a[0]) / (b[0] - a[0]);
    return new THREE.Color((a[1] + (b[1] - a[1]) * t) / 255, (a[2] + (b[2] - a[2]) * t) / 255, (a[3] + (b[3] - a[3]) * t) / 255);
  }
  function tempColor(t) { return rampColor(COOL_STOPS, (t - TMIN) / (TMAX - TMIN)); }
  // chip temperature: steel blue while normal, amber from about 85 C, red at the throttling point
  const CHIP_STOPS = [[0.0, 70, 100, 150], [0.55, 80, 120, 180], [0.72, 251, 191, 36], [1.0, 239, 68, 68]];
  function chipColor(t) { return rampColor(CHIP_STOPS, (t - CMIN) / (CMAX - CMIN)); }
  const CONF_STOPS = [[0.0, 52, 211, 153], [0.45, 250, 204, 66], [0.74, 239, 135, 80], [1.0, 192, 78, 210]];
  function confColor(u) {                       // u = uncertainty 0 (sure) .. 1 (unsure)
    let a = CONF_STOPS[0], b = CONF_STOPS[CONF_STOPS.length - 1];
    for (let s = 0; s < CONF_STOPS.length - 1; s++) if (u >= CONF_STOPS[s][0] && u <= CONF_STOPS[s + 1][0]) { a = CONF_STOPS[s]; b = CONF_STOPS[s + 1]; break; }
    const t = b[0] === a[0] ? 0 : (u - a[0]) / (b[0] - a[0]);
    return new THREE.Color((a[1] + (b[1] - a[1]) * t) / 255, (a[2] + (b[2] - a[2]) * t) / 255, (a[3] + (b[3] - a[3]) * t) / 255);
  }
  const NEUTRAL = new THREE.Color(0x3a4a68);

  // ---- three setup -------------------------------------------------------------
  const stage = $("stage");
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1120);
  scene.fog = new THREE.Fog(0x0a1120, 22, 44);
  const camera = new THREE.PerspectiveCamera(42, Math.max(1e-3, stage.clientWidth / Math.max(1, stage.clientHeight)), 0.05, 200);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(Math.max(1, stage.clientWidth), Math.max(1, stage.clientHeight));
  stage.insertBefore(renderer.domElement, stage.firstChild);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.1; controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 0.8; controls.maxDistance = 40;

  // ---- primitives --------------------------------------------------------------
  const matEdge = new THREE.LineBasicMaterial({ color: 0x4a5f88, transparent: true, opacity: 0.95 });
  const matEdgeSoft = new THREE.LineBasicMaterial({ color: 0x2b3a58, transparent: true, opacity: 0.9 });
  const matEdgeRdhx = new THREE.LineBasicMaterial({ color: 0x3d6a8a, transparent: true, opacity: 0.9 });
  const matEdgeCdu = new THREE.LineBasicMaterial({ color: 0x6f9bff, transparent: true, opacity: 0.95 });
  const matFaceBase = { transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide };
  const groups = { structure: new THREE.Group(), rdhx: new THREE.Group(), racks: new THREE.Group(), cdu: new THREE.Group(), pipes: new THREE.Group(), marks: new THREE.Group() };
  Object.values(groups).forEach(g => scene.add(g));

  function wireBox(w, h, d, pos, edgeMat, faceColor, faceOpacity, parent) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const face = new THREE.Mesh(geo, new THREE.MeshBasicMaterial(Object.assign({}, matFaceBase, { color: faceColor || 0x1a2a48, opacity: faceOpacity == null ? 0.07 : faceOpacity })));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat || matEdge);
    const grp = new THREE.Group(); grp.add(face); grp.add(edges); grp.position.set(pos[0], pos[1], pos[2]);
    (parent || scene).add(grp);
    return { group: grp, face: face, edges: edges };
  }
  function cylinderBetween(a, b, r, color, parent, segments) {
    const A = new THREE.Vector3(a[0], a[1], a[2]), B = new THREE.Vector3(b[0], b[1], b[2]);
    const len = A.distanceTo(B); if (len < 1e-4) return null;
    const geo = new THREE.CylinderGeometry(r, r, len, segments || 10, 1, false);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: color || NEUTRAL }));
    mesh.position.copy(A).add(B).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    (parent || scene).add(mesh);
    return mesh;
  }
  function wireCylinder(r, h, pos, axis, edgeMat, parent) {
    const geo = new THREE.CylinderGeometry(r, r, h, 14, 1, false);
    const face = new THREE.Mesh(geo, new THREE.MeshBasicMaterial(Object.assign({}, matFaceBase, { color: 0x1a2a48 })));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), edgeMat || matEdge);
    const grp = new THREE.Group(); grp.add(face); grp.add(edges); grp.position.set(pos[0], pos[1], pos[2]);
    if (axis === "z") grp.rotation.x = Math.PI / 2; else if (axis === "x") grp.rotation.z = Math.PI / 2;
    (parent || scene).add(grp); return grp;
  }
  function polyline(points, mat, parent) {
    const geo = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(p[0], p[1], p[2])));
    const line = new THREE.Line(geo, mat || matEdgeSoft); (parent || scene).add(line); return line;
  }

  // ---- floor + structure -----------------------------------------------------
  const rowLen = G.rowLength, R = G.rack, RD = G.rdhx, LV = G.levels, CDU = G.cdu;
  const rearZ = Math.abs(RACKS[0].zRear), frontZ = Math.abs(RACKS[0].zFront), wmfZ = G.wmfZ;
  const grid = new THREE.GridHelper(30, 60, 0x1b2944, 0x121c31); grid.position.set(rowLen / 2 + 0.8, 0.001, 0); scene.add(grid);
  (function structure() {
    const g = groups.structure, postZ = 1.0, H = G.structureH, p = G.post;
    for (let b = 0; b <= G.nBays; b++) {
      const x = b * G.bayPitch;
      for (const s of [1, -1]) {
        wireBox(p, H, p, [x, H / 2, s * postZ], matEdgeSoft, 0x1a2a48, 0.05, g);
        // base plate 12 x 8.5 in
        wireBox(12 * 0.0254, 0.02, 8.5 * 0.0254, [x, 0.01, s * postZ], matEdgeSoft, 0x1a2a48, 0.08, g);
      }
      polyline([[x, H, -postZ], [x, H, postZ]], matEdgeSoft, g);                         // cross beam over the aisle
    }
    for (const s of [1, -1]) {
      polyline([[0, H, s * postZ], [rowLen, H, s * postZ]], matEdgeSoft, g);           // longitudinal top beams
      // cable baskets, 24 in wide, on the cold aisle side at three elevations (Deschutes 18.4)
      for (const k of ["cable1", "cable2", "cable3"]) {
        const y = LV[k], hw = 0.61 / 2;
        polyline([[-0.3, y, s * (wmfZ - hw)], [rowLen + 0.3, y, s * (wmfZ - hw)], [rowLen + 0.3, y, s * (wmfZ + hw)], [-0.3, y, s * (wmfZ + hw)], [-0.3, y, s * (wmfZ - hw)]], matEdgeSoft, g);
        for (let x = 0; x <= rowLen + 0.3; x += 0.75) polyline([[x, y, s * (wmfZ - hw)], [x, y, s * (wmfZ + hw)]], matEdgeSoft, g);
      }
      // supports from the top beam down to the cable level on the cold aisle side
      for (let b = 0; b <= G.nBays; b++) polyline([[b * G.bayPitch, H, s * postZ], [b * G.bayPitch, H, s * (wmfZ + 0.31)], [b * G.bayPitch, LV.wmf - 0.15, s * (wmfZ + 0.31)]], matEdgeSoft, g);
    }
    // hot aisle containment top panel at the RDHx height
    const top = new THREE.Mesh(new THREE.PlaneGeometry(rowLen, RD.faceZ * 2), new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }));
    top.rotation.x = -Math.PI / 2; top.position.set(rowLen / 2, RD.h, 0); g.add(top);
    polyline([[0, RD.h, -RD.faceZ], [rowLen, RD.h, -RD.faceZ], [rowLen, RD.h, RD.faceZ], [0, RD.h, RD.faceZ], [0, RD.h, -RD.faceZ]], matEdgeSoft, g);
  })();

  // ---- racks + rear door heat exchangers ------------------------------------------
  const rackObjs = RACKS.map((rk, i) => {
    const zc = (rk.zRear + rk.zFront) / 2;
    const o = wireBox(R.w, R.h, R.d, [rk.x, R.h / 2, zc], matEdge, 0x1a2a48, 0.10, groups.racks);
    o.face.userData = { kind: "rack", index: i };
    // a few horizontal lines on the front face read as server trays
    for (let k = 1; k < 6; k++) polyline([[rk.x - R.w / 2, R.h * k / 6, rk.zFront], [rk.x + R.w / 2, R.h * k / 6, rk.zFront]], matEdgeSoft, groups.racks);
    // rear door heat exchanger: between the rack rear face and the aisle (Deschutes 18.10)
    const zr = rk.sgn * (RD.faceZ + RD.d / 2);
    const door = wireBox(RD.w, RD.h, RD.d, [rk.x, RD.h / 2, zr], matEdgeRdhx, 0x163a4a, 0.09, groups.rdhx);
    for (let k = 1; k < 4; k++) polyline([[rk.x - RD.w / 2 + 0.05, RD.h * k / 4, rk.sgn * RD.faceZ], [rk.x + RD.w / 2 - 0.05, RD.h * k / 4, rk.sgn * RD.faceZ]], matEdgeRdhx, groups.rdhx);
    return { rack: rk, box: o, door: door };
  });

  // ---- CDU: box + internals (Deschutes 3.3, 6.1 to 6.3) -------------------------------
  const cduX = CDU.x, cduTop = CDU.h;
  const cduBox = wireBox(CDU.w, CDU.h, CDU.d, [cduX, CDU.h / 2, 0], matEdgeCdu, 0x15264a, 0.08, groups.cdu);
  cduBox.face.userData = { kind: "cdu" };
  (function internals() {
    const g = groups.cdu, lx = dx => cduX + dx;
    wireCylinder(0.17, 0.55, [lx(-0.42), 0.36, 0.12], "z", matEdge, g);   // pump 1 (sealless, N+1)
    wireCylinder(0.17, 0.55, [lx(0.42), 0.36, 0.12], "z", matEdge, g);    // pump 2
    for (const dx of [-0.5, 0, 0.5]) wireBox(0.3, 1.1, 0.55, [lx(dx), 1.25, -0.2], matEdge, 0x1a2a48, 0.08, g);   // 3 x Alfa Laval CB210 in parallel
    for (const dx of [-0.45, -0.15, 0.15, 0.45]) wireCylinder(0.07, 0.45, [lx(dx), 1.78, 0.36], "y", matEdge, g);   // 4 secondary filters
    polyline([[lx(-0.6), 1.56, 0.36], [lx(0.6), 1.56, 0.36]], matEdge, g);                                             // 4.5 in filter manifold
    wireCylinder(0.14, 0.6, [lx(0.66), 1.3, 0.3], "y", matEdge, g);       // flow-through expansion tank
    wireBox(0.42, 0.62, 0.18, [lx(-0.56), 1.85, 0.44], matEdge, 0x1a2a48, 0.1, g);   // control enclosure (PLC + HMI)
    wireBox(0.3, 0.42, 0.16, [lx(-0.6), 0.95, 0.45], matEdge, 0x1a2a48, 0.1, g);     // HV electronics 1
    wireBox(0.3, 0.42, 0.16, [lx(-0.6), 1.42, 0.45], matEdge, 0x1a2a48, 0.1, g);     // HV electronics 2
    wireCylinder(0.09, 0.3, [lx(0.2), 2.0, -0.3], "y", matEdge, g);       // primary control valve (Belimo B6500)
    wireCylinder(0.09, 0.28, [lx(-0.3), 2.05, 0.3], "y", matEdge, g);     // secondary flow meter
    // casters
    for (const dx of [-0.7, 0.7]) for (const dz of [-0.4, 0.4]) wireCylinder(0.06, 0.05, [lx(dx), 0.03, dz], "x", matEdgeSoft, g);
  })();

  // ---- piping ---------------------------------------------------------------------------
  // Secondary (technology) loop: CDU -> riser -> cross header -> wall manifold pipes on each cold-aisle side -> drops to each rack.
  const OD = G.pipeOD / 2, HOSE = 0.02, yS = LV.wmf, yR = LV.wmf + 0.3;       // supply at the WMF elevation, return 0.3 m above it
  const zS = wmfZ - 0.15, zR = wmfZ + 0.15, xH = rowLen + 0.25;             // header x where the loop turns toward the CDU
  const fieldElems = [];   // { mesh, kind: "supply"|"return"|"hoseS"|"hoseR", side, upto (rack index list), rack }
  function pipe(a, b, r, kind, extra) {
    const m = cylinderBetween(a, b, r, NEUTRAL, groups.pipes, 12); if (!m) return null;
    m.userData = Object.assign({ kind: kind }, extra || {});
    fieldElems.push(m); return m;
  }
  // risers from the CDU top to the two header elevations
  const sx = cduX - 0.3, rx = cduX - 0.55;
  pipe([sx, cduTop, 0.3], [sx, yS, 0.3], OD, "supply", { label: "riser" });
  pipe([rx, cduTop, 0.3], [rx, yR, 0.3], OD, "return", { label: "riser", mix: "all" });
  pipe([sx, yS, 0.3], [xH, yS, 0.3], OD, "supply"); pipe([rx, yR, 0.3], [xH, yR, 0.3], OD, "return", { mix: "all" });
  for (const s of [1, -1]) {
    pipe([xH, yS, s * 0.3 * (s > 0 ? 1 : -1) * 0 + 0.3 * s], [xH, yS, s * zS], OD, "supply");          // cross header (supply)
    pipe([xH, yR, 0.3 * s], [xH, yR, s * zR], OD, "return", { mix: "side", side: s });                      // cross header (return, that side's mix)
    pipe([xH, yS, s * zS], [-0.3, yS, s * zS], OD, "supply", { side: s, label: "wall manifold" });        // supply manifold along the row
    // return manifold in segments: each carries the racks already merged (flow runs toward the CDU, x increasing)
    const side = RACKS.map((r, i) => ({ r: r, i: i })).filter(o => o.r.sgn === s).sort((a, b) => a.r.x - b.r.x);
    let xPrev = -0.3, merged = [];
    for (const o of side) {
      pipe([xPrev, yR, s * zR], [o.r.x, yR, s * zR], OD, "return", { mix: "list", list: merged.slice(), side: s });
      merged.push(o.i); xPrev = o.r.x;
    }
    pipe([xPrev, yR, s * zR], [xH, yR, s * zR], OD, "return", { mix: "list", list: merged.slice(), side: s });
  }
  // drops: supply and return hose per rack, from the manifolds down to the rack top on the cold-aisle side
  const hoseS = [], hoseR = [], hosePick = [], HOSE_EMPH = 2.6;      // the located branch is drawn HOSE_EMPH times thicker
  const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  RACKS.forEach((rk, i) => {
    const s = rk.sgn, zt = rk.zFront - s * 0.12, zt2 = rk.zFront - s * 0.28;
    const a = pipe([rk.x, yS, s * zS], [rk.x, R.h + 0.02, zt], HOSE, "hoseS", { rack: i });
    const b = pipe([rk.x, yR, s * zR], [rk.x, R.h + 0.02, zt2], HOSE, "hoseR", { rack: i });
    hoseS.push(a); hoseR.push(b);
    // a hose is 4 cm wide: an invisible sleeve around it makes it easy to hover
    for (const [p0, p1, kind] of [[[rk.x, yS, s * zS], [rk.x, R.h + 0.02, zt], "hoseS"], [[rk.x, yR, s * zR], [rk.x, R.h + 0.02, zt2], "hoseR"]]) {
      const pm = cylinderBetween(p0, p1, 0.075, 0x000000, groups.pipes, 6);
      pm.material = pickMat; pm.userData = { kind: kind, rack: i }; hosePick.push(pm);
    }
    // quick disconnects at the rack top
    wireCylinder(0.035, 0.08, [rk.x, R.h + 0.05, zt], "y", matEdgeSoft, groups.pipes);
    wireCylinder(0.035, 0.08, [rk.x, R.h + 0.05, zt2], "y", matEdgeSoft, groups.pipes);
  });
  // Primary (facility) loop: from the structure top down into the CDU (Deschutes 18.13: facility piping from above)
  const yF = G.structureH - 0.35;
  for (const [dx, dz, lab] of [[0.3, -0.25, "PCW supply"], [0.55, -0.45, "PCW return"]]) {
    cylinderBetween([cduX + dx, cduTop, dz], [cduX + dx, yF, dz], OD, 0x2f4a7a, groups.pipes);
    cylinderBetween([cduX + dx, yF, dz], [-0.3, yF, dz], OD, 0x2f4a7a, groups.pipes);
  }

  // ---- fault marker ------------------------------------------------------------------------
  function branchPos(rk) { return new THREE.Vector3(rk.x, (yS + R.h) / 2, rk.sgn * (zS + (frontZ - 0.12)) / 2); }
  const faultRack = RACKS[M.faultRack];
  const faultPos = branchPos(faultRack);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.012, 8, 40), new THREE.MeshBasicMaterial({ color: 0xff5a5a, transparent: true, opacity: 0.9 }));
  ring.position.copy(faultPos); ring.visible = false; groups.marks.add(ring);
  const ring2 = ring.clone(); ring2.rotation.y = Math.PI / 2; groups.marks.add(ring2);

  // ---- HTML labels -------------------------------------------------------------------------
  const labels = [];
  function addLabel(text, pos, cls, prio) {
    const el = document.createElement("div"); el.className = "lbl " + (cls || ""); el.innerHTML = text;
    stage.appendChild(el);
    const L = { el: el, pos: new THREE.Vector3(pos[0], pos[1], pos[2]), base: cls || "", prio: prio || 50, dirty: true, off: false, w: 0, h: 0 };
    labels.push(L); return L;
  }
  function setLabel(L, html, cls) {                    // touch the DOM only on a change; a changed label is measured again
    if (L.html !== html) { L.el.innerHTML = html; L.html = html; L.dirty = true; }
    if (cls != null && L.cls !== cls) { L.el.className = "lbl " + cls; L.cls = cls; L.dirty = true; }
  }
  const rackLabels = RACKS.map(rk => addLabel(rk.id, [rk.x, R.h + 0.5, rk.zFront - rk.sgn * 0.2], "", 50));
  const lblCdu = addLabel("CDU-A1 · 2 MW", [cduX + CDU.w / 2 + 0.3, 1.7, 0], "title cdu", 90);
  const lblSup = addLabel("", [xH + 0.4, yS - 0.12, 0.3], "cdu", 70);
  const lblRet = addLabel("", [xH - 0.9, yR + 0.35, 0.3], "cdu", 70);
  const lblFlow = addLabel("", [cduX - 0.3, 1.5, 0.8], "cdu", 72);
  const lblValve = addLabel("", [cduX + 0.5, yF + 0.25, -0.35], "cdu", 60);
  const lblBay = [addLabel("Bay 1", [G.bayPitch / 2, G.structureH + 0.3, 0], "title faint", 20), addLabel("Bay 2", [G.bayPitch * 1.5, G.structureH + 0.3, 0], "title faint", 20)];
  const lblAisle = addLabel("Hot aisle · 1.74 m", [rowLen / 2, 0.3, 0], "faint", 10);
  const lblWmf = addLabel("Wall manifold · 2.55 m", [-0.3, yS + 0.15, zS], "faint", 10);
  const lblPcw = addLabel("Facility water", [-0.3, yF + 0.15, -0.35], "faint", 10);
  const lblEst = addLabel("", [0, 0, 0], "est", 100); lblEst.off = true;   // the model's reading of the located branch, pinned to its hose
  const _v = new THREE.Vector3();
  // Labels never overlap each other or sit under a HUD panel: the more important one stays, then the nearer one.
  let blockers = [];
  function measureBlockers() {
    const s = stage.getBoundingClientRect();
    blockers = [".hud-controls", ".explainer-wrap", ".timeline-wrap"].map(q => document.querySelector(q))
      .filter(e => e && e.offsetParent !== null)
      .map(e => { const r = e.getBoundingClientRect(); return { x0: r.left - s.left, y0: r.top - s.top, x1: r.right - s.left, y1: r.bottom - s.top }; });
  }
  const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  function placeLabels() {
    const w = stage.clientWidth, h = stage.clientHeight, show = state.layers.labels, cand = [];
    for (const L of labels) {
      if (!show || L.off) { L.el.style.display = "none"; continue; }
      _v.copy(L.pos).project(camera);
      let x = (_v.x + 1) / 2 * w; const y = (1 - _v.y) / 2 * h;
      if (_v.z > 1 || _v.z < -1 || x < -40 || x > w + 40 || y < -20 || y > h + 20) { L.el.style.display = "none"; continue; }
      if (L.dirty || !L.w) { L.el.style.display = ""; L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; L.dirty = false; }
      if (L.prio >= 85 && L.w < w - 12) x = Math.max(L.w / 2 + 6, Math.min(w - L.w / 2 - 6, x));
      cand.push({ L: L, x: x, y: y, z: _v.z, box: { x0: x - L.w / 2 - 2, y0: y - L.h - 2, x1: x + L.w / 2 + 2, y1: y + 2 } });   // .lbl is anchored at its bottom centre
    }
    cand.sort((a, b) => (b.L.prio - a.L.prio) || (a.z - b.z));
    const placed = blockers.slice();
    for (const c of cand) {
      if (placed.some(p => overlaps(c.box, p))) { c.L.el.style.display = "none"; continue; }
      placed.push(c.box);
      c.L.el.style.display = ""; c.L.el.style.left = c.x + "px"; c.L.el.style.top = c.y + "px";
    }
  }

  // ---- field update -------------------------------------------------------------------------
  function mixTemp(fr, list) {
    let q = 0, qt = 0; for (const i of list) { const b = fr.branches[i]; q += b.q; qt += b.q * b.tRet; }
    return q > 0 ? qt / q : null;
  }
  function elemTemp(m, fr) {
    const u = m.userData, tsup = fr.cdu.SEC_SupplyTemperatureCelsius;
    if (u.kind === "supply" || u.kind === "hoseS") return tsup;
    if (u.kind === "hoseR") return fr.branches[u.rack].tRet;
    if (u.mix === "all") return fr.cdu.SEC_ReturnTemperatureCelsius;
    if (u.mix === "side") return mixTemp(fr, RACKS.map((r, i) => i).filter(i => RACKS[i].sgn === u.side));
    if (u.mix === "list") return u.list.length ? mixTemp(fr, u.list) : null;
    return null;
  }
  // model uncertainty of a branch estimate: 0 where a sensor pins the state, 1 at a spread of 20 percent
  // (relative to the estimate itself, so a hot, starved branch is judged like a healthy one: a spread of 20 percent
  //  of the branch's own flow, or of its own temperature rise, reads fully uncertain)
  function uRet(b, tsup) { return Math.min(1, b.tRetSd / Math.max(5, b.tRet - tsup) / 0.2); }
  function uFlow(b) { return Math.min(1, b.qSd / Math.max(1e-6, b.q) / 0.2); }
  function uBranch(b, tsup) { return Math.max(uRet(b, tsup), uFlow(b)); }
  function elemUncertainty(m, fr) {
    const u = m.userData;
    if (u.label === "riser" || u.mix === "all") return 0.03;            // metered at the CDU
    if (u.kind === "supply") return 0.03;                                // supply temperature is uniform and metered
    const tsup = fr.cdu.SEC_SupplyTemperatureCelsius;
    if (u.kind === "hoseS") return uFlow(fr.branches[u.rack]);
    if (u.kind === "hoseR") return uRet(fr.branches[u.rack], tsup);
    const list = u.mix === "side" ? RACKS.map((r, i) => i).filter(i => RACKS[i].sgn === u.side) : (u.list || []);
    if (!list.length) return 0.03;
    let q = 0, qt = 0, v = 0; for (const i of list) { const b = fr.branches[i]; q += b.q; qt += b.q * b.tRet; v += (b.q * b.tRetSd) ** 2; }
    return Math.min(1, (Math.sqrt(v) / q) / Math.max(5, qt / q - tsup) / 0.2);        // spread of the mixed return against its own rise
  }
  function renderField() {
    const fr = FR[state.frame], after = state.view === "after", conf = after && state.layers.confidence;
    for (const m of fieldElems) {
      if (conf) { m.material.color.copy(confColor(elemUncertainty(m, fr))); continue; }
      if (!after) { m.material.color.copy(NEUTRAL); continue; }
      const t = elemTemp(m, fr);
      m.material.color.copy(t == null ? NEUTRAL : tempColor(t));
    }
    rackObjs.forEach((o, i) => {                  // chip temperature is measured by the servers: visible in both views
      const b = fr.branches[i];
      const uc = Math.max(0, Math.min(1, (b.tChip - CMIN) / (CMAX - CMIN)));
      o.box.face.material.color.copy(chipColor(b.tChip)); o.box.face.material.opacity = 0.05 + 0.3 * uc * uc * uc;
      const L = rackLabels[i];
      setLabel(L, RACKS[i].id + "<small>" + b.tChip.toFixed(0) + "°C" + (b.throttle ? " · throttling" : "") + "</small>", b.throttle ? "hot" : b.tChip >= 80 ? "warm" : "");
      L.prio = b.throttle ? 85 : b.tChip >= 80 ? 60 : 50;
    });
    const c = fr.cdu;
    setLabel(lblSup, "Secondary supply <small>" + c.SEC_SupplyTemperatureCelsius.toFixed(1) + "°C · " + c.SEC_SupplyPressurekPa.toFixed(0) + " kPa</small>");
    setLabel(lblRet, "Secondary return <small>" + c.SEC_ReturnTemperatureCelsius.toFixed(1) + "°C · " + c.SEC_ReturnPressurekPa.toFixed(0) + " kPa</small>");
    setLabel(lblFlow, "Flow meter <small>" + c.SEC_FlowLitersPerMinute.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " L/min</small>");
    setLabel(lblValve, "Primary valve <small>" + c.PRI_ValvePositionPercent.toFixed(0) + "% · approach " + (c.SEC_SupplyTemperatureCelsius - c.PRI_SupplyTemperatureCelsius).toFixed(1) + "°C</small>");
    // the branch the After view locates: thicker hoses and a callout from the first flag, the ring from Warning
    const loc = after && fr.status !== "normal" ? fr.hidden.rack : -1;
    hoseS.forEach((m, i) => { const k = i === loc ? HOSE_EMPH : 1; m.scale.set(k, 1, k); });
    hoseR.forEach((m, i) => { const k = i === loc ? HOSE_EMPH : 1; m.scale.set(k, 1, k); });
    if (loc >= 0) {
      const rk = RACKS[loc], b = fr.branches[loc];
      lblEst.pos.set(rk.x, yR + 0.75, rk.sgn * zR);
      setLabel(lblEst, (MODEL ? "NCL estimate" : "Simulation") + " · " + rk.id + " branch <small>" + (b.q * 60).toFixed(0) + (MODEL ? " ± " + (b.qSd * 60).toFixed(0) : "") + " L/min · return " + b.tRet.toFixed(0) + "°C</small>");
      const p = branchPos(rk); ring.position.copy(p); ring2.position.copy(p);
    }
    lblEst.off = loc < 0;
    ring.visible = ring2.visible = loc >= 0 && (fr.status === "warning" || fr.status === "critical");
    document.querySelector(".colorbar").style.display = after ? "" : "none";     // nothing is coloured in the Before view
    paintColorbar(conf);
  }
  const TEMP_BAR = (() => { const s = []; for (let i = 0; i <= 10; i++) { const c = rampColor(COOL_STOPS, i / 10); s.push(`rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}) ${i * 10}%`); } return `linear-gradient(90deg, ${s.join(",")})`; })();
  const CONF_BAR = (() => { const s = []; for (let i = 0; i <= 10; i++) { const c = confColor(i / 10); s.push(`rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}) ${i * 10}%`); } return `linear-gradient(90deg, ${s.join(",")})`; })();
  function paintColorbar(conf) {
    $("cbTrack").style.background = conf ? CONF_BAR : TEMP_BAR;
    $("cbMin").textContent = conf ? "Confident" : Math.round(TMIN) + "°C";
    $("cbMax").textContent = conf ? "Uncertain" : Math.round(TMAX) + "°C";
  }

  // ---- operator panel ------------------------------------------------------------------------
  const STATUS = {
    normal: { word: "Normal", pill: "All nominal", line: "CDU telemetry and the reconstructed loop agree. Every branch draws its share of flow." },
    watch: { word: "Watch", pill: "Early signal", line: "One rack branch is drawing less coolant than the others. The CDU flow meter still reads within band." },
    warning: { word: "Warning", pill: "Action needed", line: "A branch restriction is developing. That rack's coolant return runs hot while CDU-A1 sees a change of a fraction of a degree." },
    critical: { word: "Critical", pill: "Immediate action", line: "The starved rack is at its throttling point. The CDU sensors alone would report a normal loop." },
  };
  function fmtPipeDistance(rk) {              // metres of pipe between the fault hose and the CDU flow meter
    const along = (xH - rk.x) + (zR - 0.3) + (cduX - 0.55 - xH) + (yR - cduTop);
    return along.toFixed(1) + " m of pipe";
  }
  function actionText(status, id, side, bay) {
    const where = `${id} supply branch (bay ${bay}, ${side} side)`;
    if (status === "critical") return `Open the bypass and inspect the ${where} now: quick-disconnect, rack manifold filter and hose. Move ${id} workload if the restriction cannot be cleared within minutes.`;
    if (status === "warning") return `Inspect the ${where} this shift. Check the quick-disconnect and the rack manifold filter for fouling or a partial closure.`;
    if (status === "watch") return `Schedule a check of the ${where}. Re-check the branch estimate next cycle.`;
    return "Continue normal monitoring. No intervention required.";
  }
  function explainerText(fr) {
    if (state.view === "before") return "<strong>Before NCL:</strong> the operator sees the CDU telemetry and the servers' own temperatures. Nothing measures the flow of a single rack branch, so a starving branch stays invisible until its chips throttle.";
    if (state.layers.confidence) return "<strong>Confidence map:</strong> the spread of the model's estimate, relative to the estimate. Green where a sensor pins the state, amber to magenta where the estimate is loose. A branch turns uncertain while its restriction develops and settles as the evidence builds.";
    if (fr.status === "normal") return "<strong>After NCL:</strong> " + (MODEL ? "a trained model estimates" : "a network simulation stands in for the NCL model and gives") + " the flow and return temperature of all " + N + " rack branches from the CDU channels, each rack's metered power and its servers' temperatures. No sensor measures branch flow.";
    const h = fr.hidden, b = fr.branches[h.rack];
    return "<strong>After NCL:</strong> the " + (MODEL ? "model" : "simulation") + " reads a restriction on the " + RACKS[h.rack].id + " branch: " + (b.q * 60).toFixed(0) + (MODEL ? " ± " + (b.qSd * 60).toFixed(0) : "") + " L/min, return at " + b.tRet.toFixed(0) + "°C. No sensor measures this branch, and the CDU flow meter moved by " + Math.abs(h.cduFlowDropPct).toFixed(1) + "%.";
  }
  // "Flagged 4 min before the server alarm": said in the After view once it is true, and in the Before view at the alarm
  function leadText(fr, alarm) {
    if (leadMin == null) return "";
    const t0 = FR[M.watchFrame].t;
    if (state.view === "before") return alarm ? "With NCL: flagged " + fmtMin(leadMin) + " earlier, at " + t0 + ", with the branch located." : "";
    if (fr.status === "normal" || state.frame < M.watchFrame) return "";
    return state.frame < throttleFrame ? "Flagged at " + t0 + ". No server alarm yet." : "Flagged at " + t0 + ", " + fmtMin(leadMin) + " before the first server alarm.";
  }
  function updatePanel() {
    const fr = FR[state.frame], h = fr.hidden, rk = RACKS[h.rack];
    $("clock").textContent = fr.t;
    $("explainer").innerHTML = opt("explainerNarrow").innerHTML = explainerText(fr);
    let alarmNow = false;
    if (state.view === "before") {
      const throttling = fr.branches.filter(b => b.throttle).map((b, i) => RACKS[fr.branches.indexOf(b)].id);
      const alarm = alarmNow = throttling.length > 0;
      $("liveDot").className = "live-dot" + (alarm ? " warning" : "");
      $("statusWord").textContent = alarm ? "Warning" : "Normal";
      $("statusPill").textContent = alarm ? "Server alarm" : "No alarm";
      $("statusLine").textContent = alarm ? `${throttling.join(", ")} reports thermal throttling. CDU-A1 reads normal, so the cause is not located.` : "CDU-A1 reads within band: supply, return, pressures, flow, pumps. No alarm from the servers.";
      $("statusCard").className = "status-card" + (alarm ? " warning" : "");
      $("gapCard").style.display = "none";
      $("mLocation").textContent = alarm ? "Unknown (rack alarm only)" : "None";
      $("mConfidence").textContent = "n/a"; $("mDistance").textContent = "n/a";
      $("actionText").textContent = alarm ? `Dispatch a technician to ${throttling.join(", ")} and check the whole loop by hand.` : "Continue normal monitoring. No intervention indicated by the sensors.";
      $("actionCard").className = "action-card" + (alarm ? " warning" : "");
    } else {
      const info = STATUS[fr.status];
      $("liveDot").className = "live-dot" + (fr.status === "normal" ? "" : " " + fr.status);
      $("statusWord").textContent = info.word; $("statusPill").textContent = info.pill; $("statusLine").textContent = info.line;
      $("statusCard").className = "status-card" + (fr.status === "normal" ? "" : " " + fr.status);
      $("gapCard").style.display = "";
      $("gapHidden").textContent = (h.deficitPct >= 1 ? "-" : "") + h.deficitPct.toFixed(0) + "%" + (MODEL && h.deficitSdPct >= 0.5 ? " ± " + h.deficitSdPct.toFixed(0) : "");
      $("gapHiddenCap").textContent = h.deficitPct >= 1 ? `flow deficit on the ${rk.id} branch, estimated, not measured` : "flow deficit on the worst branch, estimated";
      $("gapCdu").textContent = (h.cduFlowDropPct >= 0.05 ? "-" : "") + h.cduFlowDropPct.toFixed(1) + "%";
      // "of" this branch's own unrestricted flow, so the two numbers agree with the deficit above
      $("gapBranch").textContent = h.branchFlowLpm.toFixed(0) + " of " + (h.expectedFlowLpm != null ? h.expectedFlowLpm : h.nominalFlowLpm).toFixed(0) + " L/min";
      $("gapCard").className = "gap-card" + (h.deficitPct < 2 ? " calm" : "");
      const located = fr.status !== "normal";
      $("mLocation").textContent = located ? `${rk.id} supply branch · bay ${rk.bay} ${rk.side}` : "None";
      const pr = located ? h.pRestricted : 1 - h.pRestricted;                        // probability that the located branch is (or is not) restricted
      $("mConfidence").textContent = !MODEL ? "n/a (stand-in)" : (pr >= 0.9 ? "High" : pr >= 0.65 ? "Moderate" : "Low") + " · " + (pr > 0.99 ? ">99%" : Math.round(100 * pr) + "%");
      $("mDistance").textContent = located ? fmtPipeDistance(rk) : "in range";
      $("actionText").textContent = actionText(fr.status, rk.id, rk.side, rk.bay);
      $("actionCard").className = "action-card" + ((fr.status === "warning" || fr.status === "critical") ? " " + fr.status : "");
    }
    const lead = leadText(fr, alarmNow);
    const leadEl = opt("leadLine"); leadEl.textContent = lead; leadEl.hidden = !lead;
    renderTelemetry(fr);
    measureBlockers();
  }
  function renderTelemetry(fr) {
    const c = fr.cdu, rows = [];
    const g = t => rows.push(`<div class="tele-group">${t}</div>`);
    const r = (k, v, cls) => rows.push(`<div class="tele-row ${cls || ""}"><span>${k}</span><b>${v}</b></div>`);
    g("Secondary coolant connector (to racks)");
    r("SupplyTemperatureCelsius", c.SEC_SupplyTemperatureCelsius.toFixed(1)); r("ReturnTemperatureCelsius", c.SEC_ReturnTemperatureCelsius.toFixed(1));
    r("DeltaTemperatureCelsius", c.SEC_DeltaTemperatureCelsius.toFixed(1));
    r("SupplyPressurekPa", c.SEC_SupplyPressurekPa.toFixed(0)); r("ReturnPressurekPa", c.SEC_ReturnPressurekPa.toFixed(0)); r("DeltaPressurekPa", c.SEC_DeltaPressurekPa.toFixed(0));
    r("FlowLitersPerMinute", c.SEC_FlowLitersPerMinute.toFixed(0)); r("HeatRemovedkW", c.SEC_HeatRemovedkW.toFixed(0));
    r("pH", c.SEC_pH.toFixed(2)); r("ConductivityMSPerCm", c.SEC_ConductivityMSPerCm.toFixed(3)); r("DewPointProximityCelsius", c.SEC_DewPointProximityCelsius.toFixed(1));
    g("Primary coolant connector (facility water)");
    r("SupplyTemperatureCelsius", c.PRI_SupplyTemperatureCelsius.toFixed(1)); r("ReturnTemperatureCelsius", c.PRI_ReturnTemperatureCelsius.toFixed(1));
    r("SupplyPressurekPa", c.PRI_SupplyPressurekPa.toFixed(0)); r("ReturnPressurekPa", c.PRI_ReturnPressurekPa.toFixed(0));
    r("FlowLitersPerMinute", c.PRI_FlowLitersPerMinute.toFixed(0)); r("ValvePositionPercent", c.PRI_ValvePositionPercent.toFixed(0));
    g("Pumps (N+1)");
    r("Pump1 PumpSpeedPercent", c.Pump1_PumpSpeedPercent.toFixed(1)); r("Pump2 PumpSpeedPercent", c.Pump2_PumpSpeedPercent.toFixed(1));
    r("Pump1 InletPressurekPa", c.Pump1_InletPressurekPa.toFixed(0)); r("Pump1 PowerWatts", c.Pump1_PowerWatts.toLocaleString("en-US")); r("Pump2 PowerWatts", c.Pump2_PowerWatts.toLocaleString("en-US"));
    g("Filters, leak zones, reservoir");
    c.Filter_DeltaPressurekPa.forEach((v, i) => r(`Filter${i + 1} DeltaPressurekPa`, v.toFixed(1)));
    r("LeakDetection zones 1 to 3", c.LeakDetection_Zones.join(" · ")); r("Reservoir LevelPercent", c.Reservoir_LevelPercent.toFixed(0));
    g("Rack branches (CoolantConnector per rack)");
    const est = state.view === "after" ? (MODEL ? "estimated by the model" : "from the simulation") : "not populated";
    r("FlowLitersPerMinute x16", est, "unmeasured");
    r("ReturnTemperatureCelsius x16", est, "unmeasured");
    g("IT racks (Chassis thermal, hottest component)");
    fr.branches.forEach((b, i) => r(RACKS[i].id + " TemperatureCelsius", b.tChip.toFixed(0) + (b.throttle ? " · throttling" : ""), b.throttle ? "hot" : ""));
    $("teleList").innerHTML = rows.join("");
  }

  // ---- hover readout -------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster(); raycaster.params.Line = { threshold: 0.05 };
  const pointer = new THREE.Vector2(); let pointerPx = null;
  const hoverTargets = rackObjs.map(o => o.box.face).concat(hosePick, [cduBox.face]);
  renderer.domElement.addEventListener("pointermove", e => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1; pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    pointerPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    $("hudHint").style.opacity = "0.5";
  });
  renderer.domElement.addEventListener("pointerleave", () => { pointerPx = null; $("probeTip").hidden = true; });
  function updateHover() {
    const tip = $("probeTip");
    if (!pointerPx) { tip.hidden = true; return; }
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(hoverTargets, false)[0];
    if (!hit) { tip.hidden = true; return; }
    const fr = FR[state.frame], u = hit.object.userData, after = state.view === "after";
    let html = "";
    if (u.kind === "rack") {
      const b = fr.branches[u.index], rk = RACKS[u.index];
      html = `<b>${rk.id}</b> · bay ${rk.bay} ${rk.side}<small>IT load ${b.kw.toFixed(0)} kW · hottest component ${b.tChip.toFixed(0)}°C (measured)</small>` +
        (!after ? `<small>branch flow and return temperature: not measured</small>`
          : MODEL ? `<small>branch flow ${(b.q * 60).toFixed(0)} ± ${(b.qSd * 60).toFixed(0)} L/min · return ${b.tRet.toFixed(1)} ± ${b.tRetSd.toFixed(1)}°C (estimated)</small><small>simulator truth ${(b.truth.q * 60).toFixed(0)} L/min · ${b.truth.tRet.toFixed(1)}°C</small>`
          : `<small>branch flow ${(b.q * 60).toFixed(0)} L/min · return ${b.tRet.toFixed(1)}°C (simulation, stand-in)</small>`);
    } else if (u.kind === "hoseS" || u.kind === "hoseR") {
      const b = fr.branches[u.rack], rk = RACKS[u.rack], sup = u.kind === "hoseS";
      html = `<b>${rk.id} ${sup ? "supply" : "return"} hose</b>` + (after ? `<small>${(sup ? fr.cdu.SEC_SupplyTemperatureCelsius : b.tRet).toFixed(1)}°C · ${(b.q * 60).toFixed(0)}${MODEL ? " ± " + (b.qSd * 60).toFixed(0) : ""} L/min (${MODEL ? "estimated" : "simulation, stand-in"})</small>` : `<small>no sensor on this branch</small>`);
    } else if (u.kind === "cdu") {
      const c = fr.cdu;
      html = `<b>CDU-A1</b> · 2 MW liquid to liquid<small>secondary ${c.SEC_SupplyTemperatureCelsius.toFixed(1)} to ${c.SEC_ReturnTemperatureCelsius.toFixed(1)}°C · ${c.SEC_FlowLitersPerMinute.toFixed(0)} L/min · ${c.SEC_HeatRemovedkW.toFixed(0)} kW</small><small>primary ${c.PRI_SupplyTemperatureCelsius.toFixed(1)} to ${c.PRI_ReturnTemperatureCelsius.toFixed(1)}°C · valve ${c.PRI_ValvePositionPercent.toFixed(0)}%</small>`;
    }
    tip.innerHTML = html; tip.hidden = false; tip.style.left = pointerPx.x + "px"; tip.style.top = pointerPx.y + "px";
  }

  // ---- camera ----------------------------------------------------------------------------------
  let focus = null;   // { target, camPos } eased toward each frame
  function fitGoal() {
    const target = new THREE.Vector3(rowLen * 0.5 + 0.9, 1.4, 0.2);
    const dist = 12.8 * Math.max(1, 1.2 / camera.aspect);
    return { target: target, camPos: target.clone().add(new THREE.Vector3(5.2, 4.6, -8.6).normalize().multiplyScalar(dist)) };
  }
  function lookAt(target, offset) { focus = { target: target.clone(), camPos: target.clone().add(offset) }; }
  function resetView() { focus = fitGoal(); }
  function easeFocus() {
    if (!focus) return;
    controls.target.lerp(focus.target, 0.09); camera.position.lerp(focus.camPos, 0.09);
    if (camera.position.distanceTo(focus.camPos) < 0.02) focus = null;
  }
  $("resetView").addEventListener("click", resetView);
  $("viewCdu").addEventListener("click", () => {                 // from beyond the row end, clear of the header pipes
    const k = Math.max(1, 1.25 / camera.aspect);
    lookAt(new THREE.Vector3(cduX - 0.2, 1.45, 0), new THREE.Vector3(3.0 * k, 1.5 * k, 4.6 * k));
  });
  $("viewFault").addEventListener("click", () => lookAt(faultPos.clone(), new THREE.Vector3(1.6, 1.2, faultRack.sgn * 2.6)));

  // ---- controls --------------------------------------------------------------------------------
  document.querySelectorAll(".seg-btn").forEach(btn => btn.addEventListener("click", () => {
    state.view = btn.dataset.view;
    document.querySelectorAll(".seg-btn").forEach(b => b.classList.toggle("is-active", b === btn));
    syncConfidence(); buildTicks(); renderField(); updatePanel();
  }));
  const confPill = document.querySelector('.pill[data-layer="confidence"]');
  function syncConfidence() {
    if (state.view === "before" || !MODEL) { state.layers.confidence = false; confPill.classList.remove("is-active"); confPill.classList.add("disabled"); confPill.setAttribute("aria-disabled", "true"); confPill.title = MODEL ? "Confidence is an NCL output, available After NCL" : "Confidence needs the trained model's output (run ncl_demo_row_ml/export_demo.py)"; }
    else { confPill.classList.remove("disabled"); confPill.removeAttribute("aria-disabled"); confPill.title = ""; confPill.classList.toggle("is-active", state.layers.confidence); }
  }
  document.querySelectorAll(".pill[data-layer]").forEach(btn => btn.addEventListener("click", () => {
    if (btn.classList.contains("disabled")) return;
    const k = btn.dataset.layer; state.layers[k] = !state.layers[k]; btn.classList.toggle("is-active", state.layers[k]);
    groups.structure.visible = state.layers.structure; groups.rdhx.visible = state.layers.rdhx;
    renderField(); updatePanel();
  }));
  const timeline = $("timeline"), playBtn = $("playBtn");
  timeline.max = NF - 1;
  function setFrame(i) { state.frame = Math.max(0, Math.min(NF - 1, i)); timeline.value = state.frame; renderField(); updatePanel(); }
  function play() {
    if (state.frame >= NF - 1) state.frame = 0;
    state.playing = true; playBtn.textContent = "❚❚"; playBtn.setAttribute("aria-label", "Pause"); clearInterval(play._t);
    play._t = setInterval(() => { if (state.frame >= NF - 1) { pause(); return; } setFrame(state.frame + 1); }, PLAY_MS);
  }
  function pause() { state.playing = false; playBtn.textContent = "▶"; playBtn.setAttribute("aria-label", "Play"); clearInterval(play._t); }
  timeline.addEventListener("input", e => { pause(); setFrame(+e.target.value); });
  playBtn.addEventListener("click", () => state.playing ? pause() : play());
  document.addEventListener("keydown", e => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.key === " ") { e.preventDefault(); state.playing ? pause() : play(); }
    else if (e.key === "ArrowRight") { pause(); setFrame(state.frame + 1); }
    else if (e.key === "ArrowLeft") { pause(); setFrame(state.frame - 1); }
  });
  // The flag label sits left of its tick and the alarm label right of its tick, so the space between them
  // is free for the lead ("4 min earlier") and the two labels cannot collide on a narrow screen.
  function buildTicks() {
    const before = state.view === "before", pct = f => f / (NF - 1) * 100;
    const marks = [{ f: 0, label: FR[0].t, cls: "start" }];
    if (!before && M.watchFrame != null) marks.push({ f: M.watchFrame, label: MODEL ? "NCL flags " + M.faultRackId : "Watch threshold", cls: "watch" });
    if (throttleFrame != null) marks.push({ f: throttleFrame, label: before ? "Server alarm" : "Throttling", cls: "critical" });
    let html = marks.map(m => `<span class="${m.cls}" style="left:${pct(m.f)}%"><b></b>${m.label}</span>`).join("");
    if (!before && leadMin != null) html += `<i class="lead" style="left:${pct(M.watchFrame)}%;width:${pct(throttleFrame - M.watchFrame)}%"><u class="long">${fmtMin(leadMin)} earlier</u><u class="short">${fmtMin(leadMin)}</u></i>`;
    $("ticks").innerHTML = html;
    fitLead();
  }
  // the lead label takes the wording that fits between the two ticks at this width, or none
  function fitLead() {
    const el = document.querySelector("#ticks .lead"); if (!el) return;
    const gap = el.getBoundingClientRect().width;
    el.classList.toggle("short", gap < 96); el.classList.toggle("bare", gap < 46);
    const st = document.querySelector("#ticks .start"), wt = document.querySelector("#ticks .watch");   // the start time yields to the flag label
    if (st) st.style.visibility = wt && st.getBoundingClientRect().right > wt.getBoundingClientRect().left - 4 ? "hidden" : "";
  }
  buildTicks();

  // ---- resize + loop -------------------------------------------------------------------------------
  function resize() {
    const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
    camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
    labels.forEach(L => { L.dirty = true; }); measureBlockers(); fitLead();
  }
  window.addEventListener("resize", resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  function animate(t) {
    requestAnimationFrame(animate);
    easeFocus(); controls.update();
    if (ring.visible) { const s = 1 + 0.18 * Math.sin((t || 0) / 220); ring.scale.set(s, s, s); ring2.scale.set(s, s, s); ring.material.opacity = 0.55 + 0.4 * (0.5 + 0.5 * Math.sin((t || 0) / 220)); }
    renderer.render(scene, camera);
    placeLabels(); updateHover();
  }

  // ---- init ------------------------------------------------------------------------------------------
  opt("footnote").textContent = 'Geometry and sensor set from the Open Compute Project "Project Deschutes" specification (Google, 2026): a 2 MW CDU and two hot-aisle bays of 28-inch racks. The incident and its telemetry are simulated. '
    + (MODEL ? "In the After view, branch flow and return temperature are estimated by a neural network ensemble (" + M.model.members + " members) trained on simulated incidents. It has not run on a real plant."
             : "The After view shows the simulation state, standing in for the NCL model output.");
  resize(); syncConfidence(); setFrame(0);
  const fit = fitGoal(); controls.target.copy(fit.target); camera.position.copy(fit.target).add(fit.camPos.clone().sub(fit.target).multiplyScalar(1.35)); focus = fit;
  requestAnimationFrame(animate);

  // ---- screen positions of scene objects (used by the recording script to move a visible cursor) ---------
  function toScreen(v3) {
    const r = renderer.domElement.getBoundingClientRect(), p = v3.clone().project(camera);
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height, visible: p.z < 1 };
  }
  window.NCL_ROW_SCREEN = {
    cdu() { return toScreen(new THREE.Vector3(cduX, CDU.h * 0.45, CDU.d * 0.5)); },
    rack(i) { const rk = RACKS[i]; return toScreen(new THREE.Vector3(rk.x, R.h * 0.5, (rk.zRear + rk.zFront) / 2)); },
    hoseR(i) { const rk = RACKS[i]; return toScreen(new THREE.Vector3(rk.x, (yR + R.h) / 2, rk.sgn * (zR + Math.abs(rk.zFront) - 0.28) / 2)); },
    frame() { return state.frame; },
  };

  // ---- agent API: the hook "Ask your plant" works through, the same contract as the loop views ----------
  // Normalized frame for the agent: nx along the row toward the CDU, ny height, nz across the hot aisle.
  const BX0 = -0.5, BX1 = cduX + CDU.w / 2 + 0.3, BY1 = G.structureH, BZ = wmfZ + 0.4;
  const toN = (x, y, z) => ({ nx: +((x - BX0) / (BX1 - BX0)).toFixed(3), ny: +(y / BY1).toFixed(3), nz: +((z + BZ) / (2 * BZ)).toFixed(3) });
  const fromN = (nx, ny, nz) => new THREE.Vector3(BX0 + nx * (BX1 - BX0), ny * BY1, -BZ + (nz == null ? 0.5 : nz) * 2 * BZ);
  const branchAnchor = i => { const rk = RACKS[i]; return new THREE.Vector3(rk.x, (yR + R.h) / 2, rk.sgn * (zR + Math.abs(rk.zFront) - 0.28) / 2); };   // middle of the return hose
  // confidence of a branch reading: 100 when a sensor pins it, 0 when the spread reaches 20 percent of the estimate
  const confPct = (b, fr) => Math.round(100 * (1 - uBranch(b, fr.cdu.SEC_SupplyTemperatureCelsius)));
  // the model's probability that a branch is restricted (health below 85 percent), from its health estimate and spread
  const erf = x => { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
  const pRestricted = b => b.kSd > 0 ? 0.5 * (1 + erf((0.85 - b.k) / (b.kSd * Math.SQRT2))) : (b.k < 0.85 ? 1 : 0);
  const locatedRack = fr => fr.status !== "normal" ? fr.hidden.rack : -1;
  const SRC = MODEL ? "estimated by the trained ensemble" : "simulation state, a stand-in for the NCL model";
  function branchReading(i, fr) {
    const b = fr.branches[i], rk = RACKS[i], q = Math.round(b.q * 60), t = Math.round(b.tRet), cf = confPct(b, fr);
    return { key: "rack" + i, label: rk.id + " branch", found: true, onPipe: true, snapCells: 0, tempC: t, tempSdC: +b.tRetSd.toFixed(1),
      flowLpm: q, flowSdLpm: Math.round(b.qSd * 60), confidencePct: cf, flowDeficitPct: Math.round((1 - b.k) * 100),
      restrictionProbabilityPct: MODEL ? Math.round(100 * pRestricted(b)) : undefined,
      hottestComponentC: Math.round(b.tChip), itLoadKw: Math.round(b.kw), throttling: !!b.throttle,
      source: SRC, summary: q + " L/min · return " + t + "°C · " + cf + "% confidence" };
  }
  function cduReading(fr) {
    const c = fr.cdu, t = Math.round(c.SEC_ReturnTemperatureCelsius), q = Math.round(c.SEC_FlowLitersPerMinute);
    return { key: "cdu", label: "CDU-A1", found: true, onPipe: true, snapCells: 0, tempC: t, supplyC: Math.round(c.SEC_SupplyTemperatureCelsius), flowLpm: q, confidencePct: 97,
      source: "measured by the CDU's own sensors", summary: "return " + t + "°C · " + q.toLocaleString("en-US") + " L/min, measured" };
  }
  window.NCL_AGENT_API = {
    view: "ROW",
    agentBrief: "The asset is a liquid-cooled rack row built to the Open Compute Project Deschutes specification: 16 IT racks in two hot-aisle bays (R-01 to R-08 on the north side, R-09 to R-16 on the south side) fed by one 2 MW coolant distribution unit, CDU-A1, at the row end. The CDU measures its supply and return temperature, pressures, total flow, pump and valve state. Each rack reports its IT power and its hottest component temperature. No sensor measures the coolant flow or the return temperature of a single rack branch. " +
      (MODEL ? "A trained neural network ensemble estimates those per-branch values from the measured channels, with a confidence from its spread. " : "On this page a network simulation stands in for the NCL model. ") +
      "A restricted branch starves its rack until the servers throttle at " + M.throttleC + " C. In this view a temperature is a coolant return temperature, probe_point snaps to a rack branch or to the CDU and also returns the branch flow in L/min, and the hottest physical sensor in get_overview is the CDU return sensor, which mixes all 16 branches. Two different figures: confidencePct is the precision of a reading (100 means a sensor pins it, lower means a wider spread around the estimate), and restrictionProbabilityPct is the model's probability that the branch is restricted. A branch can be restricted with near certainty while its exact flow still carries a spread.",
    viewpoints: ["overview", "fault", "cdu", "top", "front", "side", "iso"],
    layers: ["confidence", "structure", "rdhx", "labels"],
    actions: ["inspect", "open_bypass", "migrate_workload"],
    ensureReconstruction() { if (state.view !== "after") document.querySelector('.seg-btn[data-view="after"]').click(); },
    seekCritical() { setFrame(M.criticalFrame != null ? M.criticalFrame : NF - 1); },
    getOverview() {
      const fr = FR[state.frame], h = fr.hidden, c = fr.cdu, loc = locatedRack(fr);
      const peak = Math.max.apply(null, fr.branches.map(b => b.tRet));
      const out = { timeLabel: fr.t, status: fr.status, faultPresent: loc >= 0,
        faultLocation: loc >= 0 ? RACKS[loc].id + " supply branch (bay " + RACKS[loc].bay + ", " + RACKS[loc].side + " side)" : "none",
        peakC: Math.round(peak), hottestSensorC: +c.SEC_ReturnTemperatureCelsius.toFixed(1), hiddenRiseC: Math.round(Math.max(0, peak - c.SEC_ReturnTemperatureCelsius)),
        cduFlowLpm: Math.round(c.SEC_FlowLitersPerMinute), cduFlowDropPct: h.cduFlowDropPct,
        hottestComponentC: Math.round(Math.max.apply(null, fr.branches.map(b => b.tChip))),
        throttlingRacks: fr.branches.map((b, i) => b.throttle ? RACKS[i].id : null).filter(Boolean) };
      if (loc >= 0) {
        out.worstBranch = RACKS[loc].id; out.worstBranchFlowLpm = Math.round(h.branchFlowLpm);
        out.worstBranchExpectedFlowLpm = Math.round(h.expectedFlowLpm != null ? h.expectedFlowLpm : h.nominalFlowLpm);
        out.worstBranchDeficitPct = Math.round(h.deficitPct); out.worstBranchReturnC = Math.round(h.branchReturnC);
        if (MODEL) { out.worstBranchDeficitSdPct = Math.round(h.deficitSdPct); out.restrictionProbabilityPct = Math.round(100 * h.pRestricted); }
        if (leadMin != null && state.frame >= M.watchFrame) { out.flaggedAt = FR[M.watchFrame].t; if (state.frame >= throttleFrame) out.leadBeforeServerAlarmMin = leadMin; }
      }
      out.note = "hottestSensorC is the CDU secondary return sensor, the mix of all 16 branches. peakC is the hottest branch return and hiddenRiseC their difference. Branch values: " + SRC + ". The incident is simulated.";
      return out;
    },
    listSensors() {
      const fr = FR[state.frame], c = fr.cdu;
      return Object.keys(c).filter(k => typeof c[k] === "number").map(k => /TemperatureCelsius$/.test(k) ? { id: k, readingC: c[k] } : { id: k, reading: c[k] })
        .concat(fr.branches.map((b, i) => ({ id: RACKS[i].id + " hottest component", readingC: b.tChip, itLoadKw: b.kw, throttling: !!b.throttle })));
    },
    // the CDU first, then a neighbour of the suspect branch and the rack across the aisle as calm references
    listLocations() {
      const fr = FR[state.frame], loc = locatedRack(fr), ref = loc >= 0 ? loc : M.faultRack;
      const order = [ref + (ref % 8 === 7 ? -1 : 1), (ref + 8) % N].concat(RACKS.map((r, i) => i)).filter((v, i, a) => a.indexOf(v) === i && v !== loc);
      const out = [{ key: "cdu", label: "CDU-A1", hot: false }].concat(order.map(i => ({ key: "rack" + i, label: RACKS[i].id + " branch", hot: false })));
      if (loc >= 0) out.push({ key: "rack" + loc, label: RACKS[loc].id + " branch", hot: true });
      return out;
    },
    describeAsset() {
      const loc = locatedRack(FR[state.frame]);
      const anchors = RACKS.map((rk, i) => { const p = branchAnchor(i); return Object.assign({ name: rk.id + " branch (bay " + rk.bay + ", " + rk.side + " side)", key: "rack" + i, hot: i === loc }, toN(p.x, p.y, p.z)); });
      anchors.push(Object.assign({ name: "CDU-A1 (2 MW: secondary supply and return, flow meter, pumps, primary valve)", key: "cdu", hot: false }, toN(cduX, 1.4, 0)));
      return { view: "ROW",
        coordinateSpace: "normalized [0,1] over the row's bounding box: nx along the row toward the CDU, ny height, nz across the hot aisle (0 = south racks R-09 to R-16, 1 = north racks R-01 to R-08). probe_point snaps to the nearest rack branch or to the CDU and returns snapCells (0 = on it).",
        extent: { nx: 1, ny: 1, nz: 1 }, anchors: anchors,
        note: "The hidden state is per rack branch: coolant flow and return temperature, " + SRC + ". The CDU values are measured." };
    },
    // Perception: the state of every branch and of the CDU connectors (no markers), so the agent sees where
    // the return runs hot and where the estimate is loose; snapshot() returns the rendered scene.
    viewField() {
      const fr = FR[state.frame], c = fr.cdu, profile = [];
      RACKS.forEach((rk, i) => { const b = fr.branches[i], p = branchAnchor(i);
        profile.push(Object.assign(toN(p.x, p.y, p.z), { tempC: Math.round(b.tRet), confidencePct: confPct(b, fr), flowLpm: Math.round(b.q * 60), label: rk.id + " branch return" })); });
      profile.push(Object.assign(toN(rx, yR, 0.3), { tempC: Math.round(c.SEC_ReturnTemperatureCelsius), confidencePct: 97, label: "CDU secondary return (measured)" }));
      profile.push(Object.assign(toN(sx, yS, 0.3), { tempC: Math.round(c.SEC_SupplyTemperatureCelsius), confidencePct: 97, label: "CDU secondary supply (measured)" }));
      const byHot = profile.slice().sort((a, b) => b.tempC - a.tempC), byUnc = profile.slice().sort((a, b) => a.confidencePct - b.confidencePct);
      return { view: "ROW", summary: { peakTempC: byHot[0].tempC, peakAt: byHot[0], minConfidencePct: byUnc[0].confidencePct, minConfAt: byUnc[0] },
        hottest: byHot.slice(0, 3), mostUncertain: byUnc.slice(0, 3), profile: profile };
    },
    snapshot(maxW) {
      maxW = maxW || 384;
      const src = renderer.domElement;
      if (!src || !src.width || !src.height) return { dataURL: null, w: 0, h: 0 };   // not sized or rendered yet
      try { renderer.render(scene, camera); } catch (e) {}                            // a WebGL buffer is readable only in the task that drew it
      const k = Math.min(1, maxW / src.width), w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(src, 0, 0, w, h);
      return { dataURL: cv.toDataURL("image/jpeg", 0.85), w: w, h: h };
    },
    probe(key) {
      const fr = FR[state.frame];
      if (key === "cdu") return cduReading(fr);
      const i = parseInt(String(key).replace("rack", ""), 10); if (isNaN(i) || !fr.branches[i]) return null;
      return branchReading(i, fr);
    },
    probeAt(nx, ny, nz) {
      const fr = FR[state.frame], p = fromN(nx, ny, nz);
      let best = -1, bd = Infinity;
      for (let i = 0; i < N; i++) { const d = branchAnchor(i).distanceTo(p); if (d < bd) { bd = d; best = i; } }
      const dc = new THREE.Vector3(cduX, 1.4, 0).distanceTo(p);
      if (Math.min(bd, dc) > 2.6) return { onPipe: false, found: false, nx: nx, ny: ny, nz: nz, label: "off the network (empty space)" };
      const cduWins = dc < bd, d = cduWins ? dc : bd, r = cduWins ? cduReading(fr) : branchReading(best, fr), a = cduWins ? new THREE.Vector3(cduX, 1.4, 0) : branchAnchor(best);
      return Object.assign(r, toN(a.x, a.y, a.z), { snapCells: Math.max(0, Math.round((d - 0.3) / 0.1)) });
    },
    focusOn(key) { if (key === "cdu") $("viewCdu").click(); else { const i = parseInt(String(key).replace("rack", ""), 10); if (RACKS[i]) lookAt(new THREE.Vector3(RACKS[i].x, 2.2, RACKS[i].zFront), new THREE.Vector3(1.4, 1.0, RACKS[i].sgn * 2.4)); } },
    resetView: resetView, clearProbes() {},
    // ---- view control (the agent's hands on the console) ----
    setViewpoint(preset) {
      preset = String(preset || "overview").toLowerCase();
      const fit = fitGoal(), t = fit.target.clone(), dist = fit.camPos.distanceTo(t);
      const go = (dx, dy, dz) => { focus = { target: t, camPos: t.clone().add(new THREE.Vector3(dx, dy, dz).normalize().multiplyScalar(dist)) }; };
      if (/overview|fit|reset|default/.test(preset)) { resetView(); return { view: "overview" }; }
      if (/cdu/.test(preset)) { $("viewCdu").click(); return { view: "cdu" }; }
      if (/fault|hot|incident|inside|problem|risk/.test(preset)) {
        const loc = locatedRack(FR[state.frame]), rk = RACKS[loc >= 0 ? loc : M.faultRack];
        lookAt(branchPos(rk), new THREE.Vector3(1.6, 1.2, rk.sgn * 2.6));
        return { view: "fault", rack: rk.id };
      }
      if (preset === "top") go(0.001, 1, -0.03); else if (preset === "front") go(0, 0.25, -1); else if (preset === "side") go(1, 0.25, -0.05); else go(5.2, 4.6, -8.6);
      return { view: preset };
    },
    zoomView(dir) {
      dir = String(dir || "in").toLowerCase();
      if (/fit|reset|all/.test(dir)) { resetView(); return { zoom: "fit" }; }
      const t = controls.target.clone();
      focus = { target: t, camPos: t.clone().add(camera.position.clone().sub(t).multiplyScalar(/out/.test(dir) ? 1.5 : 0.66)) };
      return { zoom: dir };
    },
    setLayer(layer, on) { const p = document.querySelector('.pill[data-layer="' + layer + '"]'); if (p && !p.classList.contains("disabled") && p.classList.contains("is-active") !== !!on) p.click(); return { layer: layer, on: !!state.layers[layer] }; },
    seekTime(to) { to = (to || "incident").toLowerCase(); if (/start|begin/.test(to)) setFrame(0); else if (/end|now|latest|present/.test(to)) setFrame(NF - 1); else this.seekCritical(); const fr = FR[state.frame]; return { time: fr.t, status: fr.status }; },
    playTimeline() { play(); return { playing: true }; },
    // the offline scripted investigator's wording for this asset (the loop views use the shared one)
    narrate(intent, ov, obs) {
      const hot = obs.find(o => ov.worstBranch && o.label === ov.worstBranch + " branch"), cdu = obs.find(o => o.key === "cdu");
      const calm = obs.filter(o => o !== hot && o.key !== "cdu"), by = MODEL ? "by the model's estimate" : "in the simulation";
      const flows = calm.map(o => o.flowLpm), lo = Math.min.apply(null, flows), hi = Math.max.apply(null, flows);
      const names = calm.map(o => o.label.replace(" branch", "")).join(" and ");
      if (ov.faultPresent && hot) {
        let s = "";
        if (calm.length) s += "I checked the CDU and " + (calm.length === 1 ? "one healthy branch" : calm.length + " healthy branches") + " first. " + names + " draw" + (calm.length === 1 ? "s " : " ") + (lo === hi ? lo : lo + " to " + hi) + " L/min, normal. ";
        s += "But the " + ov.worstBranch + " branch draws only " + hot.flowLpm + " L/min " + by + ", and its coolant returns at " + hot.tempC + "°C. ";
        if (cdu) s += "The CDU return sensor reads just " + ov.hottestSensorC + "°C because it mixes all 16 branches, so about " + ov.hiddenRiseC + "°C is hidden from it. ";
        if (ov.leadBeforeServerAlarmMin != null) s += "The model flagged this branch at " + ov.flaggedAt + ", " + fmtMin(ov.leadBeforeServerAlarmMin) + " before the first server alarm. ";
        else if (ov.flaggedAt) s += "The model flagged this branch at " + ov.flaggedAt + ", and no server has raised an alarm yet. ";
        if (intent === "recommend") s += "Recommendation: " + actionText(ov.status, ov.worstBranch, RACKS[FR[state.frame].hidden.rack].side, RACKS[FR[state.frame].hidden.rack].bay);
        else if (intent === "where") s = "The risk is at the " + ov.faultLocation + ". " + s;
        else s += "A restriction is developing where you have no flow sensor: I would inspect the " + ov.faultLocation + ".";
        return s.trim();
      }
      let t = "I checked the CDU and the rack branches beyond what the sensors measure. ";
      if (calm.length) t += "The branches I read (" + names + ") draw " + (lo === hi ? lo : lo + " to " + hi) + " L/min, each close to its share, and ";
      else t += "The ";
      t += (calm.length ? "the " : "") + "estimate agrees with the CDU, whose return reads " + ov.hottestSensorC + "°C. No branch reads restricted. Nothing to action right now.";
      return t;
    },
  };
})();
