# NCL Physical Observability Demo (3D loop)

The coolant loop, in 3D. A genuinely non-planar circuit: a lower-front run, a
vertical riser up the right, a crossover to the back, an upper-back run, and a
riser back down. The reconstructed temperature field fills the pipe interior as
a glowing volume (blue where cool, white-hot at the fault), seen through a
translucent glass pipe. **Play the incident over time**, orbit the asset, see
the hidden hot section develop, **look inside the pipe**, and **drop a virtual
sensor anywhere on the pipe** to read the value at that point.

Runs fully offline (Three.js is vendored in `vendor/`), no install, no network.

## Run it

- **Double-click `index.html`** (any modern browser, WebGL required), or
- Serve the folder: `python3 -m http.server 8138 --directory .` then open
  `http://localhost:8138`.

## Controls

- **Timeline** (bottom): play or scrub the incident from 09:00 to 09:19:30. The
  status escalates Normal -> Watch -> Warning -> Critical as the fault develops.
- **Drag** to rotate, **scroll** to zoom (you can push the camera inside the
  pipe). `Space` plays/pauses, arrows step frames.
- **Look inside / Reset view** : jump the camera into the hot section to see the
  field from within the coolant, then frame the whole loop again.
- A **colorbar** maps the field colours to temperature (ambient to peak).
- **Hover the pipe** to read the temperature at any point (a floating tooltip).
- **Click the pipe** to plant a persistent virtual sensor; click it again to
  remove it. Each reads the field at its point, so one on the hot riser reads
  ~110 C while the real sensors nearby stay low. **Clear virtual sensors** resets them.
- **Before NCL / After NCL** : interpolation from the pipe sensors vs. the full
  NCL reconstruction. In Before, the loop looks uniform and the panel reads
  Normal / no alarm (no fault, no recommendation); in After, the hot section
  glows, the status is Critical, and you get a located fault + recommended action.
- **Sensors** : show/hide the existing pipe sensors.
- **Volume** : toggle the volumetric field that fills the pipe interior (the
  glow you see through the glass pipe).
- **Confidence** (After only) : recolour the pipe by where NCL trusts the
  reconstruction (green) vs. flags it as uncertain (purple), which is exactly
  where the fault hides.

The operator panel mirrors the 2D demo: asset status, the sensors-vs-reconstruction
gap, fault location, confidence at the fault, nearest sensor, time, and a
recommended action.

## Suggested demo flow

1. **Start in After NCL at 09:00.** "This is the coolant loop in 3D: it runs
   along the lower level, up a riser, across the top, and back. NCL reconstructs
   the temperature along the whole loop." Rotate it to show the risers and depth.
2. **Press play.** "Watch twenty minutes of operation." The status climbs
   Normal -> Watch -> Warning -> Critical as a hot section blooms on the right
   riser. "By 09:19 it is a 108 degree fault. The hottest sensor reads about 50."
3. **Plant a virtual sensor on the hot riser/crossover.** "I can drop a sensor
   anywhere on the pipe, including where there is none. Here it reads near the
   reconstructed peak." Plant another on a cool run; it reads ~35.
4. **Toggle Before NCL.** "Without NCL, just the sensors and interpolation. The
   loop looks uniform, the panel says Normal, no alarm. Watch my virtual sensor
   on the riser: it now reads only the interpolation, about 35. The fault is
   invisible."
5. **Toggle back to After NCL.** The hot section glows again and the virtual
   sensor jumps back to ~110.
6. **Close.** "Same pipe, same sensors. NCL turns them into the full field along
   the loop, so you can stand a virtual sensor anywhere and see the part of the
   asset you never instrumented."

## What is real vs. illustrative

| Element | Source |
|---|---|
| 3D pipe-loop geometry + flow | Real: a non-planar tube circuit (two levels, vertical risers, crossovers) with flow confined to the pipe and a heat-exchanger sink |
| Temperature field over time | Real 3D advection-diffusion simulation along the loop, captured as frames (numpy) |
| Pipe sensor readings | Sampled from the true field on the pipe |
| "Before NCL" field | 3D inverse-distance interpolation from the sensors (computed in the browser) |
| Glowing tube + volume bloom | The reconstructed field rendered with Three.js |
| Virtual sensors | Read the active field (reconstruction in After, interpolation in Before) at the clicked point |
| "After NCL" reconstruction | The simulation ground truth, standing in for the NCL model |

## Regenerate or tune the data

```bash
python3 generate3d_data.py
```

Tune the loop geometry, fault location/strength, and sensor placement at the top
of `generate3d_data.py`. Output is `demo3d_data.js`.

## Status and possible next steps

A polished prototype: time slider, non-planar riser circuit, bloom-lit pipes,
rounded bends, ground grid, confidence view, hover-to-read, click-to-plant, and
a full operator panel (feature parity with the 2D demo). Possible further work:
projected HTML labels that never bloom and always dodge the panels, a "where to
add a sensor next" hint, and richer equipment models.

A planar-loop version of the generator is kept as `generate3d_data_planar.bak.py`.

## Files

- `index.html`, `styles.css`, `app3d.js` : the demo (open `index.html`)
- `vendor/three.min.js`, `vendor/OrbitControls.js` : Three.js r128 (vendored, offline)
- `demo3d_data.js` : generated 3D loop field (do not edit by hand)
- `generate3d_data.py` : the simulation that produces `demo3d_data.js`
