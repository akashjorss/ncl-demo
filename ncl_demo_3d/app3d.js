/* NCL 3D demo: the coolant loop (with risers) over time.
   Bloom-lit pipes carry the reconstructed field; play the incident, orbit,
   read by hovering, plant virtual sensors, and switch to the confidence view.
   Three.js + OrbitControls + UnrealBloomPass (all vendored, offline). */

(function () {
  "use strict";
  const data = window.NCL_DATA_3D, THREE = window.THREE;
  if (!data || !THREE) { console.error("three.js or demo3d_data.js missing"); return; }

  const NX = data.meta.nx, NY = data.meta.ny, NZ = data.meta.nz, N = NX*NY*NZ;
  const [TMIN, TMAX] = data.meta.tempRange, AMBIENT = data.meta.ambientC;
  const GEO = data.geometry, NFRAMES = data.meta.nframes, SENSOR_ALARM_C = 60, PLAY_MS = 240;
  const M_PER_CELL = 0.06;

  function b64ToBytes(s) { const b = atob(s), o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; }
  const MASK = b64ToBytes(data.mask);
  const fidx = (x, y, z) => z*NY*NX + y*NX + x;
  const LUT = new Uint8Array(256*3);
  data.colormap.forEach((c, i) => { LUT[i*3]=c[0]; LUT[i*3+1]=c[1]; LUT[i*3+2]=c[2]; });
  // Vivid cool->hot field ramp, so the loop reads as a temperature field (not bare steel).
  // Cool stays a visible blue against the dark scene; hot blows out to white for the bloom.
  const FLUT = (() => {
    const stops = [
      [0.00,  40, 110, 235],
      [0.30,  36, 196, 224],
      [0.55, 232, 206,  64],
      [0.75, 240, 140,  40],
      [0.90, 232,  64,  48],
      [1.00, 255, 244, 220],
    ];
    const out = new Uint8Array(256*3);
    for (let i = 0; i < 256; i++) {
      const u = i/255; let a = stops[0], b = stops[stops.length-1];
      for (let s = 0; s < stops.length-1; s++) { if (u >= stops[s][0] && u <= stops[s+1][0]) { a = stops[s]; b = stops[s+1]; break; } }
      const f = b[0] === a[0] ? 0 : (u - a[0])/(b[0] - a[0]);
      out[i*3]   = Math.round(a[1] + (b[1]-a[1])*f);
      out[i*3+1] = Math.round(a[2] + (b[2]-a[2])*f);
      out[i*3+2] = Math.round(a[3] + (b[3]-a[3])*f);
    }
    return out;
  })();
  const tempFromU8 = v => TMIN + v/255*(TMAX - TMIN);
  const u8FromTemp = t => Math.max(0, Math.min(255, Math.round((t - TMIN)/(TMAX - TMIN)*255)));
  function sensorColorHex(d) {
    const t = Math.max(0, Math.min(1, d/15)), st = [[125,211,252],[251,191,36],[248,113,113]];
    const s = t < 0.5 ? 0 : 1, f = t < 0.5 ? t/0.5 : (t-0.5)/0.5, a = st[s], b = st[s+1];
    return (Math.round(a[0]+(b[0]-a[0])*f)<<16) | (Math.round(a[1]+(b[1]-a[1])*f)<<8) | Math.round(a[2]+(b[2]-a[2])*f);
  }
  const cssHex = n => "#" + ("000000" + n.toString(16)).slice(-6);

  // ---- per-frame field ----------------------------------------------------
  const pipeIdx = (() => { const a = []; for (let i = 0; i < N; i++) if (MASK[i]) a.push(i); return Uint32Array.from(a); })();
  const FRAME_VALS = data.frames.map(f => b64ToBytes(f.vals));
  const baseAmbient = new Uint8Array(N).fill(u8FromTemp(AMBIENT));
  const fullCache = new Array(NFRAMES), idwCache = new Array(NFRAMES);
  function fullField(f) {
    if (fullCache[f]) return fullCache[f];
    const out = baseAmbient.slice(), v = FRAME_VALS[f];
    for (let k = 0; k < pipeIdx.length; k++) out[pipeIdx[k]] = v[k];
    return (fullCache[f] = out);
  }
  function idwField(f) {
    if (idwCache[f]) return idwCache[f];
    const out = baseAmbient.slice(), S = data.sensors, sv = data.frames[f].sensorVals;
    for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
      if (!MASK[fidx(x,y,z)]) continue;
      let num = 0, den = 0;
      for (let i = 0; i < S.length; i++) {
        const dx=x-S[i].x, dy=y-S[i].y, dz=z-S[i].z, d2=dx*dx+dy*dy+dz*dz;
        if (d2 < 1) { num = sv[i]; den = 1; break; }
        const w = 1/(d2*d2); num += w*sv[i]; den += w;
      }
      out[fidx(x,y,z)] = u8FromTemp(num/den);
    }
    return (idwCache[f] = out);
  }
  // ---- confidence / uncertainty -------------------------------------------
  // A generative reconstruction is a posterior, not one field: draw many samples
  // that all match the sensors, and the per-voxel spread is the uncertainty. We
  // approximate that posterior spread from three signals a diffusion reconstructor
  // is genuinely sensitive to:
  //   (1) observational support : how many sensors, how close, constrain this point
  //   (2) field structure       : steep gradients (fronts, edges) admit many fits
  //   (3) novelty vs the prior   : how far the local state departs from normal operation
  // Structure and novelty only raise uncertainty where the data does not already
  // pin the field, so they are gated by the observation term, then smoothed into
  // a continuous posterior-spread field. The whole thing is time varying.
  const SIG = 9.5;                    // sensor influence radius (cells)
  const UOBS = new Float32Array(N);   // static: observation-only uncertainty 0..1
  (function () {
    const S = data.sensors, inv2s2 = 1 / (2*SIG*SIG);
    for (let k = 0; k < pipeIdx.length; k++) {
      const i = pipeIdx[k], x = i % NX, y = ((i / NX) | 0) % NY, z = (i / (NX*NY)) | 0;
      let cov = 0;
      for (let s = 0; s < S.length; s++) {
        const dx=x-S[s].x, dy=y-S[s].y, dz=z-S[s].z;
        cov += Math.exp(-(dx*dx+dy*dy+dz*dz)*inv2s2);
      }
      UOBS[i] = Math.exp(-cov*2.2);   // on a sensor: ~0, far from all sensors: ~1
    }
  })();
  function nbVal(f, x, y, z, fb) {
    if (x<0||x>=NX||y<0||y>=NY||z<0||z>=NZ) return f[fb];
    const j = fidx(x,y,z); return MASK[j] ? f[j] : f[fb];
  }
  const uncCache = new Array(NFRAMES);
  function uncertainty(frame) {
    if (uncCache[frame]) return uncCache[frame];
    const f = fullField(frame), U = new Float32Array(N), GRADREF = 30;
    for (let k = 0; k < pipeIdx.length; k++) {
      const i = pipeIdx[k], x = i % NX, y = ((i/NX)|0) % NY, z = (i/(NX*NY))|0;
      const dgx = nbVal(f,x+1,y,z,i) - nbVal(f,x-1,y,z,i);
      const dgy = nbVal(f,x,y+1,z,i) - nbVal(f,x,y-1,z,i);
      const dgz = nbVal(f,x,y,z+1,i) - nbVal(f,x,y,z-1,i);
      const ugrad = Math.min(1, 0.5*Math.sqrt(dgx*dgx+dgy*dgy+dgz*dgz)/GRADREF);
      const unov = Math.min(1, Math.max(0, (tempFromU8(f[i]) - (AMBIENT+8)) / 45));
      const structural = Math.min(1, 0.85*ugrad + 0.55*unov);
      U[i] = UOBS[i] * (0.38 + 0.62*structural);
    }
    for (let p = 0; p < 2; p++) {                 // light smoothing -> continuous field
      const src = U.slice();
      for (let k = 0; k < pipeIdx.length; k++) {
        const i = pipeIdx[k], x = i % NX, y = ((i/NX)|0) % NY, z = (i/(NX*NY))|0;
        let sum = src[i], cnt = 1;
        const nb = [[x+1,y,z],[x-1,y,z],[x,y+1,z],[x,y-1,z],[x,y,z+1],[x,y,z-1]];
        for (let m = 0; m < 6; m++) {
          const a = nb[m];
          if (a[0]<0||a[0]>=NX||a[1]<0||a[1]>=NY||a[2]<0||a[2]>=NZ) continue;
          const j = fidx(a[0],a[1],a[2]); if (!MASK[j]) continue;
          sum += src[j]; cnt++;
        }
        U[i] = sum / cnt;
      }
    }
    return (uncCache[frame] = U);
  }
  // confidence colour ramp: green (sure) -> amber -> orange -> magenta (unsure)
  const CONF_STOPS = [[0.0,34,197,94],[0.45,250,204,66],[0.74,239,135,80],[1.0,192,78,210]];
  function confRGB(u) {
    let a = CONF_STOPS[0], b = CONF_STOPS[CONF_STOPS.length-1];
    for (let s = 0; s < CONF_STOPS.length-1; s++) { if (u >= CONF_STOPS[s][0] && u <= CONF_STOPS[s+1][0]) { a = CONF_STOPS[s]; b = CONF_STOPS[s+1]; break; } }
    const f = b[0]===a[0] ? 0 : (u-a[0])/(b[0]-a[0]);
    return [(a[1]+(b[1]-a[1])*f)/255, (a[2]+(b[2]-a[2])*f)/255, (a[3]+(b[3]-a[3])*f)/255];
  }

  // ---- world <-> grid -----------------------------------------------------
  const SCALE = 2.8 / Math.max(NX, NY, NZ);
  const wx = x => (x-(NX-1)/2)*SCALE, wy = y => (y-(NY-1)/2)*SCALE, wz = z => (z-(NZ-1)/2)*SCALE;
  const gx = v => Math.round(v/SCALE + (NX-1)/2), gy = v => Math.round(v/SCALE + (NY-1)/2), gz = v => Math.round(v/SCALE + (NZ-1)/2);
  function gridIdxAtWorld(p) {
    const x = gx(p.x), y = gy(p.y), z = gz(p.z);
    if (x<0||x>=NX||y<0||y>=NY||z<0||z>=NZ) return -1;
    return fidx(x, y, z);
  }

  // ---- three setup --------------------------------------------------------
  const stage = document.getElementById("stage");
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x080d18);
  scene.fog = new THREE.Fog(0x080d18, 5, 11);
  const camera = new THREE.PerspectiveCamera(45, stage.clientWidth/stage.clientHeight, 0.01, 100);
  camera.position.set(1.7, 1.5, 2.9);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  stage.appendChild(renderer.domElement);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 0.05; controls.maxDistance = 9;

  scene.add(new THREE.HemisphereLight(0x9fc0ff, 0x202838, 0.55));
  const dl = new THREE.DirectionalLight(0xffffff, 0.6); dl.position.set(3, 5, 4); scene.add(dl);

  // bloom
  const composer = new THREE.EffectComposer(renderer);
  composer.addPass(new THREE.RenderPass(scene, camera));
  const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(stage.clientWidth, stage.clientHeight), 0.5, 0.45, 0.74);
  composer.addPass(bloom);

  // ground grid for spatial context
  const grid = new THREE.GridHelper(5, 20, 0x2a3a58, 0x1a2740);
  grid.position.y = wy(0) - 0.18; grid.material.transparent = true; grid.material.opacity = 0.5; scene.add(grid);

  // ---- pipe tube ----------------------------------------------------------
  const pts = GEO.loop.map(p => new THREE.Vector3(wx(p[0]), wy(p[1]), wz(p[2])));
  const curve = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
  const tubeGeo = new THREE.TubeGeometry(curve, 400, GEO.pipeRadius*SCALE, 16, true);
  // Translucent shell: a glassy pipe you can see into. The field lives in the volume inside.
  const SHELL_OPACITY = 0.26;
  const tubeMesh = new THREE.Mesh(tubeGeo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: SHELL_OPACITY, side: THREE.DoubleSide, depthWrite: false }));
  scene.add(tubeMesh);
  const vtmp = new THREE.Vector3();
  function colorTubeTemp(field) {
    const pa = tubeGeo.attributes.position, n = pa.count, col = new Float32Array(n*3);
    for (let i = 0; i < n; i++) {
      vtmp.fromBufferAttribute(pa, i); const gi = gridIdxAtWorld(vtmp);
      const c = (gi < 0 ? 0 : field[gi]) * 3;
      col[i*3]   = FLUT[c]   / 255;
      col[i*3+1] = FLUT[c+1] / 255;
      col[i*3+2] = FLUT[c+2] / 255;
    }
    tubeGeo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  }
  function colorTubeConf() {
    const pa = tubeGeo.attributes.position, n = pa.count, col = new Float32Array(n*3), U = uncertainty(state.frame);
    for (let i = 0; i < n; i++) {
      vtmp.fromBufferAttribute(pa, i); const gi = gridIdxAtWorld(vtmp);
      const rgb = confRGB(gi < 0 ? 0 : U[gi]);
      col[i*3] = rgb[0]; col[i*3+1] = rgb[1]; col[i*3+2] = rgb[2];
    }
    tubeGeo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  }

  // ---- glow ---------------------------------------------------------------
  function discTexture() {
    const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d");
    const grd = g.createRadialGradient(32,32,0,32,32,32);
    grd.addColorStop(0,"rgba(255,255,255,1)"); grd.addColorStop(0.4,"rgba(255,255,255,0.4)"); grd.addColorStop(1,"rgba(255,255,255,0)");
    g.fillStyle = grd; g.fillRect(0,0,64,64); return new THREE.CanvasTexture(c);
  }
  const DISC = discTexture();

  // Volumetric field filling the pipe interior. Positions are fixed (every pipe voxel);
  // only the colours update per frame. This is the field you see when you zoom inside.
  const VOXW = new Float32Array(pipeIdx.length*3);
  for (let k = 0; k < pipeIdx.length; k++) {
    const i = pipeIdx[k], x = i % NX, y = ((i/NX)|0) % NY, z = (i/(NX*NY))|0;
    VOXW[k*3] = wx(x); VOXW[k*3+1] = wy(y); VOXW[k*3+2] = wz(z);
  }
  const volGeo = new THREE.BufferGeometry();
  volGeo.setAttribute("position", new THREE.Float32BufferAttribute(VOXW, 3));
  volGeo.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(pipeIdx.length*3), 3));
  const volume = new THREE.Points(volGeo, new THREE.PointsMaterial({
    size: SCALE*4.8, map: DISC, vertexColors: true, transparent: true,
    opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(volume);
  function colorVolume(field, confView) {
    const arr = volGeo.attributes.color.array, U = confView ? uncertainty(state.frame) : null;
    for (let k = 0; k < pipeIdx.length; k++) {
      const i = pipeIdx[k];
      if (confView) {
        const rgb = confRGB(U[i]), w = 0.42;
        arr[k*3] = rgb[0]*w; arr[k*3+1] = rgb[1]*w; arr[k*3+2] = rgb[2]*w;
      } else {
        const v = field[i], c = v*3, u = v/255, w = 0.19 + 0.81*u; // cool reads as a calm field, hot blows out
        arr[k*3]   = FLUT[c]   / 255 * w;
        arr[k*3+1] = FLUT[c+1] / 255 * w;
        arr[k*3+2] = FLUT[c+2] / 255 * w;
      }
    }
    volGeo.attributes.color.needsUpdate = true;
  }

  // ---- equipment ----------------------------------------------------------
  // Equipment kept deliberately dark and matte, so the glowing field (not the hardware) is the hero.
  const eqMat = new THREE.MeshStandardMaterial({ color: 0x1e2532, roughness: 0.82, metalness: 0.08 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x2c3648, roughness: 0.72, metalness: 0.12 });
  const pr = GEO.pipeRadius*SCALE;
  const pump = new THREE.Group();
  pump.add(new THREE.Mesh(new THREE.CylinderGeometry(GEO.pump.r*SCALE, GEO.pump.r*SCALE, pr*3, 28), eqMat));
  pump.add(new THREE.Mesh(new THREE.SphereGeometry(GEO.pump.r*SCALE*0.7, 20, 20), capMat));
  pump.position.set(wx(GEO.pump.x), wy(GEO.pump.y), wz(GEO.pump.z)); pump.rotation.z = Math.PI/2; scene.add(pump);
  const ex = GEO.exchanger;
  const exch = new THREE.Group();
  exch.add(new THREE.Mesh(new THREE.BoxGeometry(ex.w*SCALE, ex.h*SCALE, pr*3.2), eqMat));
  for (let i = -1; i <= 1; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(ex.w*SCALE*0.04, ex.h*SCALE*1.04, pr*3.4), capMat);
    fin.position.x = i * ex.w*SCALE*0.22; exch.add(fin);
  }
  exch.position.set(wx(ex.x), wy(ex.y), wz(ex.z)); scene.add(exch);

  // ---- sprites ------------------------------------------------------------
  function makeSprite(scaleW) {
    const s = 2, c = document.createElement("canvas"); c.width = 160*s; c.height = 40*s;
    const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(scaleW || 0.66, (scaleW || 0.66)*0.25, 1); spr.userData = { c, tex, s, kmul: (scaleW || 0.66)/0.66 }; return spr;
  }
  function drawSprite(spr, text, hex) {
    const { c, tex, s } = spr.userData, g = c.getContext("2d");
    g.setTransform(s, 0, 0, s, 0, 0); g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = "rgba(8,12,24,0.82)"; g.fillRect(2, 6, 156, 28);
    g.font = "600 20px Inter, system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = hex || "#dce8fb"; g.fillText(text, 80, 21); tex.needsUpdate = true;
  }

  // ---- wall-mounted sensors ----------------------------------------------
  // Real instruments clamp onto the pipe wall; they are not glowing orbs floating
  // in the bore. Each is a small steel puck on the outer wall with a reading-
  // coloured cap. The bodies are matte (no emissive) so the bloom pass leaves
  // them crisp instead of blowing them out to white balls.
  const PIPE_R_W = GEO.pipeRadius * SCALE;
  const LOOP_CENTROID = (() => {
    let x = 0, y = 0, z = 0; const L = GEO.loop;
    for (const p of L) { x += wx(p[0]); y += wy(p[1]); z += wz(p[2]); }
    return new THREE.Vector3(x/L.length, y/L.length, z/L.length);
  })();
  const CLINE = (() => { const n = 720, a = []; for (let i = 0; i < n; i++) a.push(curve.getPoint(i/n)); return a; })();
  const YAXIS = new THREE.Vector3(0, 1, 0);
  function wallMount(world) {
    let bi = 0, bd = Infinity; const n = CLINE.length;
    for (let i = 0; i < n; i++) { const d = CLINE[i].distanceToSquared(world); if (d < bd) { bd = d; bi = i; } }
    const c = CLINE[bi];
    const tan = CLINE[(bi+1)%n].clone().sub(CLINE[(bi-1+n)%n]).normalize();
    let radial = world.clone().sub(c);
    radial.addScaledVector(tan, -radial.dot(tan));               // strip the along-pipe component
    if (radial.lengthSq() < 1e-5) {                              // sensor sits on the centreline
      radial = c.clone().sub(LOOP_CENTROID);
      radial.addScaledVector(tan, -radial.dot(tan));
    }
    radial.normalize();
    return { pos: c.clone().addScaledVector(radial, PIPE_R_W), normal: radial };
  }
  function makeWallSensor(virtual) {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: virtual ? 0x2f6fd0 : 0x768297, roughness: 0.5, metalness: 0.35 });
    const padMat  = new THREE.MeshStandardMaterial({ color: 0x33405a, roughness: 0.6, metalness: 0.3 });
    const capMat  = new THREE.MeshStandardMaterial({ color: virtual ? 0x8fb6ff : 0x7dd3fc, roughness: 0.45, metalness: 0.1 });
    const padH = PIPE_R_W*0.16, bodyH = PIPE_R_W*0.42, capH = PIPE_R_W*0.16;
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(PIPE_R_W*0.95, PIPE_R_W*0.95, padH, 22), padMat);
    pad.position.y = padH/2; g.add(pad);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(PIPE_R_W*0.6, PIPE_R_W*0.72, bodyH, 22), bodyMat);
    body.position.y = padH + bodyH/2; g.add(body);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(PIPE_R_W*0.5, PIPE_R_W*0.5, capH, 22), capMat);
    cap.position.y = padH + bodyH + capH/2; g.add(cap);
    g.userData = { capMat };
    return g;
  }
  function placeWallSensor(g, mount) {
    g.position.copy(mount.pos);
    g.quaternion.setFromUnitVectors(YAXIS, mount.normal);        // local +Y sticks straight out of the wall
  }

  // physical sensors (clamped to the wall)
  const sensorObjs = data.sensors.map(s => {
    const mount = wallMount(new THREE.Vector3(wx(s.x), wy(s.y), wz(s.z)));
    const g = makeWallSensor(false); placeWallSensor(g, mount); scene.add(g);
    const spr = makeSprite(); spr.position.copy(mount.pos).addScaledVector(mount.normal, PIPE_R_W*1.7); scene.add(spr);
    return { base: s, group: g, spr, mount };
  });
  function updateSensors(frame) {
    const sv = data.frames[frame].sensorVals, vis = state.sensors;
    sensorObjs.forEach((o, k) => {
      o.group.visible = vis; o.spr.visible = vis;
      const col = sensorColorHex(sv[k] - AMBIENT);
      o.group.userData.capMat.color.setHex(col);
      drawSprite(o.spr, o.base.id + "  " + sv[k].toFixed(1) + "°C", cssHex(col));
    });
  }

  // anomaly marker
  const anomalySpr = makeSprite(0.92); anomalySpr.visible = false; scene.add(anomalySpr);
  function updateAnomaly(frame) {
    const fr = data.frames[frame], on = state.view === "after" && fr.hotspot && (fr.status === "warning" || fr.status === "critical");
    anomalySpr.visible = !!on;
    if (!on) return;
    anomalySpr.position.set(wx(fr.hotspot.x), wy(fr.hotspot.y), wz(fr.hotspot.z)).add(new THREE.Vector3(0, pr*2.4, 0));
    drawSprite(anomalySpr, "⚠ Hotspot · " + fr.hotspot.segment, "#ffb3b3");
  }

  // ---- planted virtual sensors -------------------------------------------
  const planted = [];
  function plantAt(world) {
    const x = gx(world.x), y = gy(world.y), z = gz(world.z);
    if (x<0||x>=NX||y<0||y>=NY||z<0||z>=NZ) return;
    for (let i = 0; i < planted.length; i++) {
      const p = planted[i].g;
      if (Math.abs(p.x-x)+Math.abs(p.y-y)+Math.abs(p.z-z) < 8) {
        scene.remove(planted[i].mesh); scene.remove(planted[i].spr); planted.splice(i, 1); updatePanel(); return;
      }
    }
    if (planted.length >= 10) return;
    const mount = wallMount(world);
    const mesh = makeWallSensor(true); placeWallSensor(mesh, mount);   // virtual sensor, clamped to the wall
    const spr = makeSprite(); spr.position.copy(mount.pos).addScaledVector(mount.normal, PIPE_R_W*1.5);
    scene.add(mesh); scene.add(spr);
    planted.push({ g: { x, y, z }, mesh, spr, world: world.clone() });
    updatePlanted(); updatePanel();
  }
  function updatePlanted() {
    const field = activeField();
    planted.forEach(p => drawSprite(p.spr, tempFromU8(field[fidx(p.g.x, p.g.y, p.g.z)]).toFixed(0) + "°C", "#bfdcff"));
  }

  // ---- state --------------------------------------------------------------
  const state = { view: "after", glow: true, sensors: true, confidence: false, frame: 0, playing: false, inside: false };
  const activeField = () => state.view === "after" ? fullField(state.frame) : idwField(state.frame);
  // Shell opacity depends on mode: near-solid for the confidence map, faint glass when looking
  // inside, translucent otherwise so the interior field reads through it.
  function applyShell() {
    const confView = state.view === "after" && state.confidence;
    tubeMesh.material.opacity = confView ? 0.82 : (state.inside ? 0.08 : SHELL_OPACITY);
  }
  function refresh() {
    const fld = activeField(), confView = state.view === "after" && state.confidence;
    if (confView) colorTubeConf(); else colorTubeTemp(fld);
    colorVolume(fld, confView); volume.visible = state.glow && !confView; applyShell();
    updateSensors(state.frame); updatePlanted(); updateAnomaly(state.frame); updatePanel();
  }

  const $ = id => document.getElementById(id);
  const STATUS = {
    normal:  { word: "Normal",   pill: "All nominal",      line: "Sensors and the reconstructed field agree. Operating within bounds." },
    watch:   { word: "Watch",    pill: "Early signal",     line: "Heat is rising in a stretch of pipe with no sensor, while the sensors still read normal." },
    warning: { word: "Warning",  pill: "Action needed",    line: "A hot section is developing on the right riser. The sensors alone would not catch it yet." },
    critical:{ word: "Critical", pill: "Immediate action", line: "A hot section far above the safe margin is developing where no sensor sits." },
  };
  function actionText(status, seg) {
    if (status === "critical") return "Isolate and inspect segment " + seg + " immediately. Reconstructed temperature is critically high where no sensor sits.";
    if (status === "warning")  return "Inspect segment " + seg + " now. Reconstructed temperature exceeds the safe margin in an unmonitored stretch.";
    if (status === "watch")    return "Schedule a targeted inspection of segment " + seg + ". Re-check next cycle.";
    return "Continue normal monitoring. No intervention required.";
  }
  function updatePanel() {
    const fr = data.frames[state.frame], maxSensor = Math.max.apply(null, fr.sensorVals);
    $("clock").textContent = fr.t; $("mTime").textContent = fr.t; $("sensorPeak").textContent = maxSensor.toFixed(1) + "°C";
    if (state.view === "before") {
      const tripped = maxSensor >= SENSOR_ALARM_C;
      $("liveDot").className = "live-dot" + (tripped ? " critical" : "");
      $("statusWord").textContent = tripped ? "Warning" : "Normal";
      $("statusPill").textContent = tripped ? "Sensor alarm" : "No alarm";
      $("statusLine").textContent = "All sensors read within normal range. The hot section is invisible to them.";
      $("statusCard").className = "status-card" + (tripped ? " critical" : " normal");
      $("gapCard").classList.add("hide");
      $("mLocation").textContent = "None"; $("mConfidence").textContent = "—"; $("mDistance").textContent = "—";
      $("actionText").textContent = "Continue normal monitoring. No intervention indicated by the sensors.";
      $("actionCard").className = "action-card";
      $("explainer").innerHTML = "<strong>Before NCL:</strong> only the pipe sensors and interpolation. The loop looks uniform and the hot section is invisible.";
      return;
    }
    const info = STATUS[fr.status];
    $("liveDot").className = "live-dot" + (fr.status === "normal" ? "" : " critical");
    $("statusWord").textContent = info.word; $("statusPill").textContent = info.pill;
    $("statusLine").textContent = info.line;
    $("statusCard").className = "status-card" + (fr.status === "normal" ? " normal" : " critical");
    $("gapCard").classList.remove("hide");
    $("reconPeak").textContent = Math.round(fr.peakC) + "°C";
    $("gapHidden").textContent = "Hidden in the pipe: +" + Math.round(Math.max(0, fr.peakC - maxSensor)) + "°C";
    if (fr.hotspot) {
      const U = uncertainty(state.frame);
      const pct = Math.round((1 - U[fidx(fr.hotspot.x, fr.hotspot.y, fr.hotspot.z)]) * 100);
      let dmin = Infinity;
      data.sensors.forEach(s => { const d = Math.hypot(s.x-fr.hotspot.x, s.y-fr.hotspot.y, s.z-fr.hotspot.z); if (d < dmin) dmin = d; });
      $("mLocation").textContent = "Segment " + fr.hotspot.segment;
      $("mConfidence").textContent = (pct >= 70 ? "High" : pct >= 40 ? "Moderate" : "Low") + " · " + pct + "%";
      $("mDistance").textContent = (dmin * M_PER_CELL).toFixed(1) + " m away";
    } else { $("mLocation").textContent = "None"; $("mConfidence").textContent = "High"; $("mDistance").textContent = "in range"; }
    $("actionText").textContent = actionText(fr.status, fr.hotspot ? fr.hotspot.segment : "");
    $("actionCard").className = "action-card" + (fr.status === "warning" || fr.status === "critical" ? " critical" : "");
    const extra = planted.length ? "  " + planted.length + " virtual sensor" + (planted.length>1?"s":"") + " planted." : "";
    $("explainer").innerHTML = state.confidence
      ? "<strong>Confidence:</strong> the spread across posterior reconstructions. Green where sensors pin the field and the pattern is regular; magenta where it is sparsely sensed, changing fast, or unlike normal operation, which is exactly where the fault hides."
      : "<strong>After NCL:</strong> the field is reconstructed through the whole loop; the hot core glows. Plant a virtual sensor anywhere, or look inside the pipe." + extra;
  }

  function setFrame(f) { state.frame = Math.max(0, Math.min(NFRAMES-1, f)); $("timeline").value = state.frame; refresh(); }
  function play() {
    if (state.frame >= NFRAMES-1) state.frame = 0;
    state.playing = true; $("playBtn").textContent = "❚❚"; clearInterval(play._t);
    play._t = setInterval(() => { if (state.frame >= NFRAMES-1) { pause(); return; } setFrame(state.frame+1); }, PLAY_MS);
  }
  function pause() { state.playing = false; $("playBtn").textContent = "▶"; clearInterval(play._t); }

  // ---- confidence availability (After only) -------------------------------
  const confPill = document.querySelector('.pill[data-toggle="confidence"]');
  function syncConfidence() {
    if (state.view === "before") {
      state.confidence = false; confPill.classList.remove("is-active"); confPill.classList.add("disabled");
      confPill.title = "Confidence is an NCL output, available After NCL";
    } else { confPill.classList.remove("disabled"); confPill.title = ""; confPill.classList.toggle("is-active", state.confidence); }
  }

  // ---- UI -----------------------------------------------------------------
  document.querySelectorAll(".seg-btn").forEach(b => b.addEventListener("click", () => {
    state.view = b.dataset.view;
    document.querySelectorAll(".seg-btn").forEach(x => x.classList.toggle("is-active", x === b));
    syncConfidence(); refresh();
  }));
  document.querySelectorAll(".pill[data-toggle]").forEach(b => b.addEventListener("click", () => {
    if (b.classList.contains("disabled")) return;
    const t = b.dataset.toggle; state[t] = !state[t]; b.classList.toggle("is-active", state[t]); refresh();
  }));
  $("clearBtn").addEventListener("click", () => { planted.forEach(p => { scene.remove(p.mesh); scene.remove(p.spr); }); planted.length = 0; updatePanel(); });
  $("lookInBtn").addEventListener("click", diveInside);
  $("resetBtn").addEventListener("click", resetView);
  $("timeline").addEventListener("input", e => { pause(); setFrame(+e.target.value); });
  $("playBtn").addEventListener("click", () => state.playing ? pause() : play());
  document.addEventListener("keydown", e => {
    if (e.key === " ") { e.preventDefault(); state.playing ? pause() : play(); }
    else if (e.key === "ArrowRight") { pause(); setFrame(state.frame+1); }
    else if (e.key === "ArrowLeft") { pause(); setFrame(state.frame-1); }
  });

  function buildTicks() {
    const m = data.meta, marks = [];
    if (m.watchFrame != null) marks.push({ f: m.watchFrame, label: "Fault begins", cls: "watch" });
    if (m.criticalFrame != null) marks.push({ f: m.criticalFrame, label: "Critical", cls: "critical" });
    else if (m.warningFrame != null) marks.push({ f: m.warningFrame, label: "Warning", cls: "warning" });
    $("ticks").innerHTML = marks.map(k => `<span class="${k.cls}" style="left:${k.f/(NFRAMES-1)*100}%">${k.label}</span>`).join("");
  }

  // ---- raycast: click to plant, hover to read -----------------------------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), probeTip = $("probeTip"); let downXY = null;
  function rayHit(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX-r.left)/r.width)*2 - 1; ndc.y = -((e.clientY-r.top)/r.height)*2 + 1;
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(tubeMesh, false);
    return hit.length ? hit[0] : null;
  }
  renderer.domElement.addEventListener("pointerdown", e => { downXY = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener("pointerup", e => {
    if (!downXY) return;
    const moved = Math.hypot(e.clientX-downXY[0], e.clientY-downXY[1]); downXY = null;
    if (moved > 6) return;
    const h = rayHit(e); if (h) plantAt(h.point);
  });
  renderer.domElement.addEventListener("pointermove", e => {
    const h = rayHit(e);
    if (!h) { probeTip.hidden = true; return; }
    const gi = gridIdxAtWorld(h.point); if (gi < 0) { probeTip.hidden = true; return; }
    const t = tempFromU8(activeField()[gi]);
    const rect = stage.getBoundingClientRect();
    probeTip.hidden = false;
    probeTip.style.left = (e.clientX - rect.left) + "px"; probeTip.style.top = (e.clientY - rect.top) + "px";
    const tag = state.view === "before" ? "interpolated" : (state.confidence ? Math.round((1-uncertainty(state.frame)[gi])*100) + "% conf" : "reconstruction");
    probeTip.innerHTML = t.toFixed(1) + "°C<small>" + tag + "</small>";
  });
  renderer.domElement.addEventListener("pointerleave", () => { probeTip.hidden = true; });

  // ---- resize + loop ------------------------------------------------------
  function fitView() {
    const sph = new THREE.Box3().setFromObject(tubeMesh).getBoundingSphere(new THREE.Sphere());
    const vFov = camera.fov*Math.PI/180, hFov = 2*Math.atan(Math.tan(vFov/2)*camera.aspect);
    const dist = sph.radius*1.6 / Math.sin(Math.min(vFov, hFov)/2);
    const dir = camera.position.clone().sub(controls.target).normalize();
    const target = sph.center.clone(); target.x += 0.5;   // shift loop left, clear of the right panel
    controls.target.copy(target); camera.position.copy(target).add(dir.multiplyScalar(dist));
    camera.updateProjectionMatrix(); controls.update();
  }
  // Jump the camera to the hottest point and drop it just inside the pipe wall,
  // so you are looking at the field from within the coolant. Scroll to push further in.
  function hottestWorld() {
    const f = fullField(state.frame); let best = -1, bi = pipeIdx[0];
    for (let k = 0; k < pipeIdx.length; k++) { const v = f[pipeIdx[k]]; if (v > best) { best = v; bi = pipeIdx[k]; } }
    const x = bi % NX, y = ((bi/NX)|0) % NY, z = (bi/(NX*NY))|0;
    return new THREE.Vector3(wx(x), wy(y), wz(z));
  }
  const BORE = (() => { const N = 720, a = []; for (let i = 0; i < N; i++) a.push(curve.getPoint(i/N)); return a; })();
  function diveInside() {
    const c = hottestWorld(), N = BORE.length;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < N; i++) { const d = BORE[i].distanceToSquared(c); if (d < bd) { bd = d; bi = i; } }
    // walk ~0.75 world units upstream along the centerline; staying on the centerline keeps us inside the pipe
    let acc = 0, j = bi;
    for (let step = 0; step < N && acc < 0.75; step++) { acc += BORE[(j-1+N)%N].distanceTo(BORE[(j+N)%N]); j--; }
    controls.target.copy(c); controls.target.x += 0.45;   // keep the hot core clear of the right panel
    camera.position.copy(BORE[(j+N)%N]).add(new THREE.Vector3(0, pr*0.25, 0));
    state.inside = true; applyShell();
    controls.update();
  }
  function resetView() { state.inside = false; applyShell(); fitView(); }
  window.addEventListener("resize", () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    camera.aspect = w/h; camera.updateProjectionMatrix(); renderer.setSize(w, h); composer.setSize(w, h); fitView();
  });
  // Labels are billboards: keep them a constant on-screen size by scaling with the
  // distance to the camera, so they no longer balloon when you zoom into the loop.
  const LABEL_RATIO = 0.25, LABEL_K = 0.13;
  function rescaleLabels() {
    scene.traverse(o => {
      if (!o.isSprite || !o.visible) return;
      const d = camera.position.distanceTo(o.position);
      const km = (o.userData && o.userData.kmul) || 1;
      const w = Math.max(0.2, Math.min(1.05, d * LABEL_K * km));
      o.userData.baseW = w;
      o.scale.set(w, w*LABEL_RATIO, 1);
    });
  }
  function animate(t) {
    requestAnimationFrame(animate);
    rescaleLabels();
    if (anomalySpr.visible) { const s = 1 + 0.12*Math.sin((t||0)/220), w = anomalySpr.userData.baseW || 0.6; anomalySpr.scale.set(w*s, w*LABEL_RATIO*s, 1); }
    controls.update(); composer.render();
  }

  (function fillColorbar() {
    const track = $("cb3dTrack"); if (!track) return;
    const stops = [];
    for (let p = 0; p <= 10; p++) { const c = Math.round(p/10*255)*3; stops.push("rgb(" + FLUT[c] + "," + FLUT[c+1] + "," + FLUT[c+2] + ") " + (p*10) + "%"); }
    track.style.background = "linear-gradient(90deg," + stops.join(",") + ")";
    $("cb3dMin").textContent = Math.round(TMIN) + "°C";
    $("cb3dMax").textContent = Math.round(TMAX) + "°C";
  })();

  $("timeline").max = NFRAMES - 1; buildTicks(); syncConfidence();
  setFrame(0); fitView(); requestAnimationFrame(animate);
})();
