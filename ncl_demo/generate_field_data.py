"""
NCL demo data engine (pipe-loop geometry).

Simulates a coolant flowing around a closed pipe loop: heat and flow are
confined to the pipes (insulated walls), the coolant circulates clockwise, a
heat exchanger on the top run removes heat, and a developing fault on the right
run injects heat that pools and advects downstream. Several sensors sit on the
pipe near the fault (carrying a small graded signal) while the peak stays in a
gap between them.

Outputs `demo_data.js` (window.NCL_DATA) consumed by the browser demo: the field
(masked to the pipes), the pipe geometry, the sparse sensors, a confidence proxy,
status / hotspot / action, and the inferno colormap.

Run:  python3 generate_field_data.py
Deps: numpy (required); matplotlib (optional, preview only).
"""

import base64
import json
import os

import numpy as np

# ----------------------------------------------------------------------------
# Grid + time
# ----------------------------------------------------------------------------
NX, NY = 190, 116
NFRAMES = 48
SUBSTEPS = 14
DT = 0.20
KAPPA = 0.16                  # thermal diffusivity (cells^2 / step)
U0 = 0.85                     # peak coolant speed at the pipe centerline (cells/step)
AMBIENT_C = 35.0

FRAME_MINUTES = 0.5
START_CLOCK = (9, 0)

# ----------------------------------------------------------------------------
# Pipe-loop geometry (rounded rectangle, clockwise flow)
# ----------------------------------------------------------------------------
CX, CY = 95, 58              # loop centre
HW, HH = 72, 40             # half extents to the straight runs
CORNER_R = 22               # corner radius
PIPE_R = 8.0                # pipe inner radius

PUMP = {"x": CX - HW, "y": CY, "r": 12}              # left run
EXCHANGER = {"x": CX, "y": CY - HH, "w": 46, "h": 22}  # top run (heat sink)
HX_REACH = 26               # how far along the loop the exchanger cools
HX_RATE = 0.06              # cooling strength

# Developing fault on the right run (no sensor sits on the hot riser).
FAULT_XY = (CX + HW, CY - 6)        # (167, 52) on the right straight
FAULT_RADIUS = 7.0
FAULT_STRENGTH = 2.5
FAULT_START_FRAME = 14
FAULT_RAMP_FRAMES = 9

# Sensors on the pipe loop. The hot riser (right run below the fault) has none,
# so it is blind; the downstream bottom run carries a graded, cooled signal.
SENSORS = [
    {"id": "T-01", "x": CX - HW,      "y": CY + 14, "place": "pump outlet"},   # far
    {"id": "P-03", "x": CX - 35,      "y": CY - HH, "place": "exchanger"},     # far
    {"id": "T-04", "x": CX + 40,      "y": CY - HH, "place": "top run"},       # far
    {"id": "T-07", "x": CX + HW,      "y": CY - 14, "place": "riser"},         # mild (upstream)
    {"id": "T-09", "x": CX + 45,      "y": CY + HH, "place": "lower bend"},    # strongest (downstream)
    {"id": "T-12", "x": CX + 33,      "y": CY + HH, "place": "lower run"},     # moderate
    {"id": "F-08", "x": CX - 5,       "y": CY + HH, "place": "lower run"},     # mild
]

WATCH_RISE = 4.0
WARNING_RISE = 16.0
CRITICAL_RISE = 55.0

OUT_JS = os.path.join(os.path.dirname(__file__), "demo_data.js")
PREVIEW_DIR = os.path.join(os.path.dirname(__file__), "_preview")


def build_loop(cx, cy, hw, hh, r, per=160):
    """Clockwise centerline of a rounded rectangle as an (N,2) point array."""
    sw, sh = hw - r, hh - r
    t = np.linspace(0, 1, per, endpoint=False)
    a = np.linspace(0, np.pi / 2, per, endpoint=False)
    parts = [
        np.c_[cx - sw + 2 * sw * t, np.full_like(t, cy - hh)],                       # top L->R
        np.c_[cx + sw + r * np.cos(-np.pi/2 + a), (cy - sh) + r * np.sin(-np.pi/2 + a)],  # TR
        np.c_[np.full_like(t, cx + hw), cy - sh + 2 * sh * t],                       # right T->B
        np.c_[cx + sw + r * np.cos(a), (cy + sh) + r * np.sin(a)],                   # BR
        np.c_[cx + sw - 2 * sw * t, np.full_like(t, cy + hh)],                       # bottom R->L
        np.c_[cx - sw + r * np.cos(np.pi/2 + a), (cy + sh) + r * np.sin(np.pi/2 + a)],   # BL
        np.c_[np.full_like(t, cx - hw), cy + sh - 2 * sh * t],                       # left B->T
        np.c_[cx - sw + r * np.cos(np.pi + a), (cy - sh) + r * np.sin(np.pi + a)],   # TL
    ]
    return np.concatenate(parts, axis=0)


def build_geometry():
    """Return mask, velocity (u,v), nearest-loop distance and arc index per cell."""
    loop = build_loop(CX, CY, HW, HH, CORNER_R)
    nxt = np.roll(loop, -1, axis=0)
    tang = nxt - loop
    tang /= (np.linalg.norm(tang, axis=1, keepdims=True) + 1e-9)   # clockwise unit tangents

    ys, xs = np.mgrid[0:NY, 0:NX].astype(np.float64)
    dist2 = np.full((NY, NX), np.inf)
    idx = np.zeros((NY, NX), dtype=int)
    for i in range(len(loop)):
        d2 = (xs - loop[i, 0]) ** 2 + (ys - loop[i, 1]) ** 2
        upd = d2 < dist2
        dist2[upd] = d2[upd]
        idx[upd] = i
    dist = np.sqrt(dist2)
    mask = dist <= PIPE_R

    profile = np.clip(1.0 - (dist / PIPE_R) ** 2, 0.0, 1.0)       # 0 at wall, 1 at centre
    tx = tang[idx, 0]
    ty = tang[idx, 1]
    u = U0 * profile * tx * mask
    v = U0 * profile * ty * mask
    return loop, mask, u, v, idx, len(loop)


def fault_amplitude(frame):
    if frame < FAULT_START_FRAME:
        return 0.0
    return float(min(1.0, (frame - FAULT_START_FRAME) / float(FAULT_RAMP_FRAMES)))


def step(T, u, v, src, mask):
    """Masked advection-diffusion: zero-flux at pipe walls (insulated)."""
    def nb(shift, axis):                       # neighbour value, zero-gradient outside mask
        n = np.roll(T, shift, axis)
        m = np.roll(mask, shift, axis)
        return np.where(m, n, T)
    Txm, Txp = nb(1, 1), nb(-1, 1)
    Tym, Typ = nb(1, 0), nb(-1, 0)

    adv = (np.where(u > 0, u * (T - Txm), u * (Txp - T))
           + np.where(v > 0, v * (T - Tym), v * (Typ - T)))
    lap = Txm + Txp + Tym + Typ - 4.0 * T

    T = T + DT * (-adv + KAPPA * lap + src)
    T = T - HX_RATE * (T - AMBIENT_C) * step.hx * DT          # heat exchanger sink
    T = T * mask + AMBIENT_C * (~mask)                         # keep outside ambient
    return T


def simulate(mask, u, v, idx):
    ys, xs = np.mgrid[0:NY, 0:NX].astype(np.float64)
    fx, fy = FAULT_XY
    src_mask = np.exp(-((xs - fx) ** 2 + (ys - fy) ** 2) / (2.0 * FAULT_RADIUS ** 2)) * mask

    # Heat-exchanger region: loop cells within HX_REACH of the exchanger centre.
    hxd = np.sqrt((xs - EXCHANGER["x"]) ** 2 + (ys - EXCHANGER["y"]) ** 2)
    step.hx = ((hxd <= HX_REACH) & mask).astype(np.float64)

    T = np.full((NY, NX), AMBIENT_C)
    frames = []
    for f in range(NFRAMES):
        src = FAULT_STRENGTH * fault_amplitude(f) * src_mask
        for _ in range(SUBSTEPS):
            T = step(T, u, v, src, mask)
            if not np.all(np.isfinite(T)):
                raise RuntimeError(f"diverged at frame {f}; lower DT/U0")
        frames.append(T.copy())
    return np.array(frames)


def confidence_map(mask):
    """Uncertainty proxy on the pipe: distance to the nearest sensor (normalised)."""
    ys, xs = np.mgrid[0:NY, 0:NX].astype(np.float64)
    dmin = np.full((NY, NX), np.inf)
    for s in SENSORS:
        dmin = np.minimum(dmin, np.sqrt((xs - s["x"]) ** 2 + (ys - s["y"]) ** 2))
    scale = 26.0
    return (1.0 - np.exp(-(dmin / scale) ** 2)) * mask


def clock_label(frame):
    total = START_CLOCK[0] * 60 + START_CLOCK[1] + frame * FRAME_MINUTES
    h = int(total // 60) % 24
    m = int(total % 60)
    s = int(round((total - int(total)) * 60))
    return f"{h:02d}:{m:02d}" if s == 0 else f"{h:02d}:{m:02d}:{s:02d}"


def segment_label(x):
    band = "ABCD"[min(3, int(x / NX * 4))]
    return f"{band}-{1 + int((x % (NX / 4)) / (NX / 4) * 9)}"


def quant(field, lo, hi):
    return (np.clip((field - lo) / (hi - lo), 0, 1) * 255).round().astype(np.uint8)


def b64(arr):
    return base64.b64encode(arr.astype(np.uint8).tobytes()).decode("ascii")


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
                t0, c0 = ctrl[j]
                t1, c1 = ctrl[j + 1]
                if t0 <= t <= t1:
                    f = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
                    lut.append([int(round(c0[k] + (c1[k] - c0[k]) * f)) for k in range(3)])
                    break
        return lut


def main():
    print("Building pipe-loop geometry ...")
    loop, mask, u, v, idx, nloop = build_geometry()
    print(f"  grid {NX}x{NY} | pipe cells {int(mask.sum())} | loop pts {nloop}")

    print("Simulating coolant + fault ...")
    fields = simulate(mask, u, v, idx)
    tmin = float(AMBIENT_C)
    tmax = float(np.ceil(fields.max() + 1.0))
    print(f"  {NFRAMES} frames | T range {tmin:.1f}..{tmax:.1f} C")

    unc = confidence_map(mask)
    fx, fy = FAULT_XY

    frames_out = []
    for f in range(NFRAMES):
        T = fields[f]
        peak = float(T.max())
        rise = peak - AMBIENT_C
        iy, ix = np.unravel_index(np.argmax(T), T.shape)
        status = ("critical" if rise >= CRITICAL_RISE else
                  "warning" if rise >= WARNING_RISE else
                  "watch" if rise >= WATCH_RISE else "normal")
        rng = np.random.default_rng(1000 + f)
        readings = [round(float(T[s["y"], s["x"]] + rng.normal(0, 0.15)), 2) for s in SENSORS]
        frames_out.append({
            "t": clock_label(f), "status": status,
            "peakC": round(peak, 1), "riseC": round(rise, 1),
            "hotspot": {"x": int(ix), "y": int(iy), "segment": segment_label(ix)}
            if rise >= WATCH_RISE else None,
            "sensorVals": readings,
            "gt": b64(quant(T, tmin, tmax)),
        })

    def first(name):
        for f, fr in enumerate(frames_out):
            if fr["status"] == name:
                return f
        return None

    loop_ds = loop[::4].round(1).tolist()                       # downsampled for drawing
    data = {
        "meta": {
            "nx": NX, "ny": NY, "nframes": NFRAMES, "ambientC": AMBIENT_C,
            "tempRange": [tmin, tmax], "frameMinutes": FRAME_MINUTES,
            "asset": "Coolant Loop C-17",
            "watchFrame": first("watch"), "warningFrame": first("warning"),
            "criticalFrame": first("critical"), "faultSegment": segment_label(fx),
        },
        "geometry": {
            "loop": loop_ds, "pipeRadius": PIPE_R,
            "pump": PUMP, "exchanger": EXCHANGER,
        },
        "sensors": [{"id": s["id"], "x": s["x"], "y": s["y"], "place": s["place"]} for s in SENSORS],
        "mask": b64(mask.astype(np.uint8) * 255),
        "confidence": b64(quant(unc, 0.0, 1.0)),
        "colormap": colormap_lut("inferno"),
        "frames": frames_out,
    }

    payload = "window.NCL_DATA = " + json.dumps(data, separators=(",", ":")) + ";\n"
    with open(OUT_JS, "w") as fh:
        fh.write(payload)
    print(f"Wrote {OUT_JS} ({len(payload) / 1e6:.2f} MB)")

    print("Status timeline:")
    for f in (0, FAULT_START_FRAME, first("watch"), first("warning"), first("critical"), NFRAMES - 1):
        if f is None:
            continue
        fr = frames_out[f]
        print(f"  f{f:2d} {fr['t']:>8} | {fr['status']:>8} | peak {fr['peakC']:6.1f}C "
              f"| hottest sensor {max(fr['sensorVals']):5.1f}C")
    print("Sensor signal at final frame:")
    for v_, sid, sx_, sy_ in sorted(
            [(frames_out[-1]['sensorVals'][k], s['id'], s['x'], s['y']) for k, s in enumerate(SENSORS)],
            reverse=True):
        on = mask[sy_, sx_]
        d = ((sx_ - fx) ** 2 + (sy_ - fy) ** 2) ** 0.5
        print(f"   {sid} ({sx_:3d},{sy_:3d}) {v_:5.1f}C  +{v_-AMBIENT_C:4.1f}  "
              f"d_fault {d:4.0f}  on_pipe={'yes' if on else 'NO'}")

    save_previews(fields, mask, loop, unc, tmin, tmax)


def save_previews(fields, mask, loop, unc, tmin, tmax):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        print("matplotlib not available; skipping preview.")
        return
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    fig, axes = plt.subplots(2, 2, figsize=(12, 7))
    for ax, fi in zip(axes.flat[:3], [0, NFRAMES // 2, NFRAMES - 1]):
        disp = np.where(mask, fields[fi], np.nan)
        ax.imshow(disp, cmap="inferno", vmin=tmin, vmax=tmax, origin="upper", aspect="auto")
        ax.plot(loop[:, 0], loop[:, 1], color="#7788aa", lw=0.6)
        for s in SENSORS:
            ax.plot(s["x"], s["y"], "o", mfc="none", mec="cyan", mew=1.5, ms=7)
        ax.set_title(f"frame {fi} ({clock_label(fi)})")
        ax.set_xticks([]); ax.set_yticks([])
    axc = axes.flat[3]
    axc.imshow(np.where(mask, unc, np.nan), cmap="viridis", origin="upper", aspect="auto")
    for s in SENSORS:
        axc.plot(s["x"], s["y"], "o", mfc="white", mec="black", ms=6)
    axc.set_title("confidence proxy (on pipe)")
    axc.set_xticks([]); axc.set_yticks([])
    fig.tight_layout()
    out = os.path.join(PREVIEW_DIR, "montage.png")
    fig.savefig(out, dpi=92)
    print(f"Wrote preview {out}")


if __name__ == "__main__":
    main()
