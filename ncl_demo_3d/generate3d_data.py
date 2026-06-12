"""
NCL 3D demo data engine: the coolant loop with vertical risers, over time.

A genuinely non-planar 3D circuit: coolant runs along a lower-front pipe, climbs
a right vertical riser, crosses over to the back at the top, runs along an
upper-back pipe, comes down a left riser, and crosses back to the front. A fault
on the right riser ramps on; heat pools and advects downstream. Captured as
frames so the browser can play it.

Each frame stores only the pipe-voxel values (in the flat z,y,x order of the
mask); the browser scatters them back into the grid.

Outputs `demo3d_data.js` (window.NCL_DATA_3D).  Run: python3 generate3d_data.py
"""

import base64
import json
import os

import numpy as np

# Full 3D grid (the loop now uses all three axes). T indexed [z, y, x].
NX, NY, NZ = 100, 72, 60
KAPPA = 0.16
DT = 0.18
SUBSTEPS = 12
NFRAMES = 40
FRAME_MINUTES = 0.5
START_CLOCK = (9, 0)
U0 = 0.8
AMBIENT_C = 35.0
PIPE_R = 6.0

# Loop waypoints (x, y, z), traversed clockwise and closed back to the first.
XL, XR = 16, 84
YLO, YHI = 14, 58
ZF, ZB = 14, 46
WAYPOINTS = [
    (XL, YLO, ZF),   # lower-front-left
    (XR, YLO, ZF),   # lower-front run -> right
    (XR, YHI, ZF),   # right riser (vertical, front)  <- fault here
    (XR, YHI, ZB),   # top crossover -> back
    (XL, YHI, ZB),   # upper-back run -> left
    (XL, YLO, ZB),   # left riser (vertical, back)
]                    # closes via the bottom crossover (back -> front)

PUMP = {"x": 50, "y": YLO, "z": ZF, "r": 8}
EXCHANGER = {"x": 50, "y": YHI, "z": ZB, "w": 34, "h": 14}
HX_REACH = 15
HX_RATE = 0.06

FAULT = (ZF, 36, XR)            # (z, y, x): on the right-front riser
FAULT_SIGMA = 6.0
FAULT_STRENGTH = 3.0
FAULT_START_FRAME = 12
FAULT_RAMP_FRAMES = 10

# Sensors on the pipe (z, y, x). None on the hot riser; a couple downstream.
SENSORS = [
    {"id": "S-1", "z": 24, "y": YHI, "x": XR, "place": "top crossover"}, # downstream, strongest
    {"id": "S-2", "z": 38, "y": YHI, "x": XR, "place": "top crossover"}, # downstream, mild
    {"id": "S-3", "z": ZF, "y": YLO, "x": 40, "place": "lower run"},     # upstream / far
    {"id": "S-4", "z": ZB, "y": 34,  "x": XL, "place": "left riser"},    # far
    {"id": "S-5", "z": ZF, "y": YLO, "x": 70, "place": "lower run"},     # upstream
    {"id": "S-6", "z": ZB, "y": YHI, "x": 20, "place": "exchanger"},     # far
]

WATCH_RISE, WARNING_RISE, CRITICAL_RISE = 4.0, 16.0, 55.0
OUT_JS = os.path.join(os.path.dirname(__file__), "demo3d_data.js")


def chaikin(p, iters):
    """Corner-cutting on a closed polyline: rounds sharp corners, keeps runs straight."""
    for _ in range(iters):
        a, b = p, np.roll(p, -1, axis=0)
        q = np.empty((2 * len(p), p.shape[1]))
        q[0::2] = 0.75 * a + 0.25 * b
        q[1::2] = 0.25 * a + 0.75 * b
        p = q
    return p


def build_loop(per_unit=1.0):
    """Closed polyline through the 3D waypoints, with rounded elbows."""
    wp = np.array(WAYPOINTS + [WAYPOINTS[0]], dtype=np.float64)
    pts = []
    for i in range(len(wp) - 1):
        a, b = wp[i], wp[i + 1]
        n = max(2, int(np.linalg.norm(b - a) / per_unit))
        for t in np.linspace(0, 1, n, endpoint=False):
            pts.append(a + (b - a) * t)
    return chaikin(np.array(pts), 2)[::2]   # round corners, then thin slightly


def build_geometry():
    loop = build_loop()
    tang = np.roll(loop, -1, axis=0) - loop
    tang /= (np.linalg.norm(tang, axis=1, keepdims=True) + 1e-9)
    zs, ys, xs = np.mgrid[0:NZ, 0:NY, 0:NX].astype(np.float64)
    dist2 = np.full((NZ, NY, NX), np.inf)
    idx = np.zeros((NZ, NY, NX), dtype=int)
    for i in range(len(loop)):
        d2 = (xs - loop[i, 0])**2 + (ys - loop[i, 1])**2 + (zs - loop[i, 2])**2
        upd = d2 < dist2
        dist2[upd] = d2[upd]; idx[upd] = i
    mask = np.sqrt(dist2) <= PIPE_R
    prof = np.clip(1.0 - (np.sqrt(dist2) / PIPE_R)**2, 0.0, 1.0)
    u = U0 * prof * tang[idx, 0] * mask   # x
    v = U0 * prof * tang[idx, 1] * mask   # y
    w = U0 * prof * tang[idx, 2] * mask   # z
    return loop, mask, u, v, w


def step(T, u, v, w, src, mask, hx):
    def nb(s, ax):
        n = np.roll(T, s, ax); m = np.roll(mask, s, ax)
        return np.where(m, n, T)
    Txm, Txp = nb(1, 2), nb(-1, 2)
    Tym, Typ = nb(1, 1), nb(-1, 1)
    Tzm, Tzp = nb(1, 0), nb(-1, 0)
    adv = (np.where(u > 0, u*(T - Txm), u*(Txp - T))
           + np.where(v > 0, v*(T - Tym), v*(Typ - T))
           + np.where(w > 0, w*(T - Tzm), w*(Tzp - T)))
    lap = Txm + Txp + Tym + Typ + Tzm + Tzp - 6.0 * T
    T = T + DT * (-adv + KAPPA * lap + src)
    T = T - HX_RATE * (T - AMBIENT_C) * hx * DT
    return T * mask + AMBIENT_C * (~mask)


def simulate(mask, u, v, w):
    zs, ys, xs = np.mgrid[0:NZ, 0:NY, 0:NX].astype(np.float64)
    fz, fy, fx = FAULT
    src_mask = np.exp(-(((zs-fz)**2 + (ys-fy)**2 + (xs-fx)**2)) / (2.0 * PIPE_R**2)) * mask
    hxd = np.sqrt((xs - EXCHANGER["x"])**2 + (ys - EXCHANGER["y"])**2 + (zs - EXCHANGER["z"])**2)
    hx = ((hxd <= HX_REACH) & mask).astype(np.float64)
    T = np.full((NZ, NY, NX), AMBIENT_C)
    frames = []
    for f in range(NFRAMES):
        amp = min(1.0, max(0.0, (f - FAULT_START_FRAME) / FAULT_RAMP_FRAMES))
        src = FAULT_STRENGTH * amp * src_mask
        for _ in range(SUBSTEPS):
            T = step(T, u, v, w, src, mask, hx)
            if not np.all(np.isfinite(T)):
                raise RuntimeError("diverged")
        frames.append(T.copy())
    return np.array(frames)


def clock_label(f):
    total = START_CLOCK[0]*60 + START_CLOCK[1] + f * FRAME_MINUTES
    h = int(total // 60) % 24; m = int(total % 60); s = int(round((total - int(total))*60))
    return f"{h:02d}:{m:02d}" if s == 0 else f"{h:02d}:{m:02d}:{s:02d}"


def segment_label(x):
    band = "ABCD"[min(3, int(x / NX * 4))]
    return f"{band}-{1 + int((x % (NX/4)) / (NX/4) * 9)}"


def colormap_lut(name="inferno", n=256):
    try:
        import matplotlib
        matplotlib.use("Agg")
        try:
            from matplotlib import colormaps
            m = colormaps[name].resampled(n)
        except Exception:
            from matplotlib import cm
            m = cm.get_cmap(name, n)
        return [[int(round(v * 255)) for v in m(i)[:3]] for i in range(n)]
    except Exception:
        ctrl = [(0.0, (5, 4, 25)), (0.25, (60, 18, 90)), (0.5, (160, 42, 90)),
                (0.72, (224, 92, 42)), (0.86, (246, 160, 44)), (1.0, (252, 252, 198))]
        lut = []
        for i in range(n):
            t = i / (n - 1)
            for j in range(len(ctrl) - 1):
                t0, c0 = ctrl[j]; t1, c1 = ctrl[j + 1]
                if t0 <= t <= t1:
                    f = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
                    lut.append([int(round(c0[k] + (c1[k]-c0[k])*f)) for k in range(3)])
                    break
        return lut


def main():
    print(f"Building 3D riser loop {NX}x{NY}x{NZ} ...")
    loop, mask, u, v, w = build_geometry()
    pipe_idx = np.where(mask.reshape(-1))[0].astype(np.uint32)
    print(f"  pipe voxels {pipe_idx.size}")
    print(f"Simulating {NFRAMES} frames ...")
    fields = simulate(mask, u, v, w)
    tmin, tmax = float(AMBIENT_C), float(np.ceil(fields.max() + 1.0))
    print(f"  T range {tmin:.1f}..{tmax:.1f} | overall peak {fields.max():.1f}")

    frames_out = []
    for f in range(NFRAMES):
        T = fields[f]
        peak = float(T.max()); rise = peak - AMBIENT_C
        iz, iy, ix = np.unravel_index(np.argmax(T), T.shape)
        status = ("critical" if rise >= CRITICAL_RISE else "warning" if rise >= WARNING_RISE
                  else "watch" if rise >= WATCH_RISE else "normal")
        rng = np.random.default_rng(1000 + f)
        readings = [round(float(T[s["z"], s["y"], s["x"]] + rng.normal(0, 0.15)), 1) for s in SENSORS]
        vals = (np.clip((T - tmin) / (tmax - tmin), 0, 1) * 255).round().astype(np.uint8).reshape(-1)[pipe_idx]
        frames_out.append({
            "t": clock_label(f), "status": status, "peakC": round(peak, 1), "riseC": round(rise, 1),
            "hotspot": {"x": int(ix), "y": int(iy), "z": int(iz), "segment": segment_label(ix)}
            if rise >= WATCH_RISE else None,
            "sensorVals": readings,
            "vals": base64.b64encode(vals.tobytes()).decode("ascii"),
        })

    def first(name):
        for f, fr in enumerate(frames_out):
            if fr["status"] == name:
                return f
        return None

    data = {
        "meta": {
            "nx": NX, "ny": NY, "nz": NZ, "ambientC": AMBIENT_C, "nframes": NFRAMES,
            "tempRange": [tmin, tmax], "peakC": round(float(fields.max()), 1),
            "frameMinutes": FRAME_MINUTES, "asset": "Coolant Loop C-17",
            "watchFrame": first("watch"), "warningFrame": first("warning"), "criticalFrame": first("critical"),
        },
        "geometry": {"loop": loop[::3].round(1).tolist(), "pipeRadius": PIPE_R, "pump": PUMP, "exchanger": EXCHANGER},
        "sensors": [{"id": s["id"], "x": s["x"], "y": s["y"], "z": s["z"], "place": s["place"]} for s in SENSORS],
        "mask": base64.b64encode((mask.astype(np.uint8) * 255).tobytes()).decode("ascii"),
        "colormap": colormap_lut("inferno"),
        "frames": frames_out,
    }
    payload = "window.NCL_DATA_3D = " + json.dumps(data, separators=(",", ":")) + ";\n"
    with open(OUT_JS, "w") as fh:
        fh.write(payload)
    print(f"Wrote {OUT_JS} ({len(payload)/1e6:.2f} MB)")

    print("Status timeline:")
    for f in (0, FAULT_START_FRAME, first("watch"), first("warning"), first("critical"), NFRAMES - 1):
        if f is None:
            continue
        fr = frames_out[f]
        print(f"  f{f:2d} {fr['t']:>8} | {fr['status']:>8} | peak {fr['peakC']:6.1f}C "
              f"| hottest sensor {max(fr['sensorVals']):5.1f}C")
    print("Final-frame sensor readings:")
    fr = frames_out[-1]
    for k, s in enumerate(SENSORS):
        on = mask[s["z"], s["y"], s["x"]]
        print(f"   {s['id']} {s['place']:>11} ({s['z']},{s['y']},{s['x']})  {fr['sensorVals'][k]:5.1f}C  on_pipe={'yes' if on else 'NO'}")


if __name__ == "__main__":
    main()
