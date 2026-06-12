# NCL Physical Observability Demo

A self-contained browser demo of the NCL product story: reconstruct a full
physical field from a facility's existing sparse sensors, flag where the
estimate is trustworthy, and turn a hidden fault into an operator decision.

The field is a **real 2D advection-diffusion simulation on a pipe loop**: coolant
circulates clockwise around a closed loop (with a pump and a heat exchanger),
heat and flow are confined to the pipes, and a developing fault on the right
riser injects heat that pools and advects downstream into a sensor blind zone.
The naive sparse-sensor baseline and the confidence map are computed, not drawn.
The "After NCL" reconstruction stands in for the model output (this is a visual
mock, by design, not a trained model).

## Run it

No install, no network. Either:

- **Double-click `index.html`** (opens in any browser, works offline), or
- Serve the folder: `python3 -m http.server 8137 --directory .` then open
  `http://localhost:8137`.

Best shown full-screen on a wide display. Keyboard: `Space` plays/pauses,
arrow keys step frame by frame.

## Suggested demo flow (about 60 seconds)

1. **Start at 09:00, "After NCL", Sensors on.** "Here is a coolant loop, a pump,
   a heat exchanger, and seven existing sensors. Everything reads normal."
2. **Press play.** The clock runs and the status steps up on its own: Watch
   around 09:09, Warning at 09:11, then Critical at 09:17 as a hotspot blooms on
   the right riser, flows downstream along the pipe, and the panel turns red.
3. **Point to the sensors and the panel.** "The sensors flanking the fault are
   running warm, T-09 at about 49 degrees, but none is alarming and none sits on
   the hot riser. NCL reads the faint, correlated pattern across them plus the
   physics and reconstructs a 107 degree core between them, a 58 degree hidden
   rise." The dots are tinted by how much signal each carries.
4. **Toggle to "Before NCL".** The bright riser collapses into a dim glow and the
   whole panel flips to "Normal, no alarm": no fault, no recommendation. "With
   only the sensors, interpolation never reads hotter than the sensors
   themselves, so the operator's world looks completely calm. This is all they
   had before NCL, while a 107 degree fault was developing."
5. **Toggle back to "After NCL", then "Confidence".** "NCL also says where to
   trust the estimate. The fault sits in the least-instrumented stretch of pipe,
   exactly where you would never have put a sensor. Confidence is an NCL output,
   so this layer does not exist in the Before view."
6. **Click the hot riser to plant a virtual sensor.** "I just added a sensor
   where there is no physical one. It reads about 105 degrees, and it climbs as I
   scrub time while the real sensors beside it barely move. Toggle to Before and
   the same virtual sensor reads only the interpolation, about 43." Plant a
   couple more on cool sections for contrast; click one again to remove it.
7. **End on the Critical action card:** isolate and inspect the flagged segment
   immediately.

## Likely questions (and answers)

**"If the sensors barely move, how can the model know the peak is there?"**
It does not rely on any single sensor crossing a threshold. A real hotspot
perturbs the whole field, so the nearby sensors run a few degrees warm in a
specific, correlated pattern (the gradient T-09 +14, T-07 +8, T-12 +5, while far
sensors stay flat). NCL reads that joint signature plus the physics and infers
the hidden peak, which is far hotter than any single sensor and below any alarm
threshold. The signal is in the data, distributed and subtle.

**"Why trust the peak value if no sensor sits on it?"**
It is not claimed as certain. The confidence map and the "confidence here"
metric report low confidence at the peak precisely because it sits in a sensor
gap. NCL delivers a best estimate plus where to physically verify, not a
guarantee.

**"Why does the confidence map only appear After NCL?"**
Calibrated confidence is itself an NCL output. Before NCL you have raw sensors
and crude interpolation with no quantified uncertainty, so the Confidence
control is disabled in the Before view.

## Controls

- **Before NCL / After NCL** : sparse-sensor interpolation vs. full reconstruction.
- **Sensors** : show the existing physical sensors and their live readings.
- **Confidence** : overlay the uncertainty map (blue haze = under-instrumented).
  After-NCL only; disabled in the Before view.
- **Timeline** : scrub or play the incident from 09:00 to 09:23.
- **Hover the pipe** : read the temperature at any point (interpolation in
  Before, NCL reconstruction in After).
- **Click the pipe** : plant a persistent virtual sensor (up to 8); click one
  again to remove it. Each reads the field live as you scrub time, so a virtual
  sensor on the blind riser climbs to ~107 C while the physical sensors stay low.

## What is real vs. illustrative

| Element | Source |
|---|---|
| Pipe-loop geometry + flow | Real: heat and a clockwise flow are confined to the pipes (insulated walls), with a heat-exchanger sink |
| Temperature field over time | Real advection-diffusion simulation on the loop (numpy) |
| Sparse sensor readings | Sampled from the true field (+ small noise); the fault genuinely warms nearby sensors |
| Sensor signal gradient | Real: the peak is kept on a sensor-free stretch of pipe, so it must be inferred, not measured |
| "Before NCL" estimate | Inverse-distance interpolation between sensors, computed live in the browser |
| Confidence map | Distance from the nearest sensor; shown only in the After view, as an NCL output |
| Status / hotspot / action | Thresholded from the reconstructed field |
| "After NCL" reconstruction | The simulation ground truth, standing in for the NCL model |

## Regenerate or tune the data

The browser reads `demo_data.js`, produced by the simulation:

```bash
python3 generate_field_data.py
```

Tune the parameters at the top of `generate_field_data.py`: grid size, number of
frames, sensor placement, fault location and strength, status thresholds. A
preview montage is written to `_preview/montage.png` if matplotlib is installed.

## Files

- `index.html`, `styles.css`, `app.js` : the demo (open `index.html`)
- `demo_data.js` : generated field data (do not edit by hand)
- `generate_field_data.py` : the simulation that produces `demo_data.js`
