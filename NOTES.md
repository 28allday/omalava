# Implementation notes

How Omalava is put together and the non-obvious things worth knowing before
changing it. For installing and using it, see the [README](README.md).

## Layout

The repo root *is* the plugin — that is what Omarchy clones and validates.

| Path | What it is |
|---|---|
| `manifest.json` | plugin manifest (`kinds`: `service`, `bar-widget`) |
| `Service.qml` | the service: state, IPC target, fullscreen watch, one surface per monitor |
| `Lamp.qml` | one lamp: runs the simulation and feeds the shader |
| `Sim.js` | the wax physics, pure JS |
| `BarWidget.qml` | bar icon; owns the dropdown's open state |
| `Panel.qml` | the dropdown's contents, loaded by the widget |
| `shaders/lava.frag` | the metaball shader; `bake.sh` compiles it to the committed `.qsb` |
| `preview.jpg` | listing image; the marketplace only reads it at the ROOT |

## Architecture

`Service.qml` creates one `PanelWindow` per monitor on the Wayland background
layer (namespace `omarchy-omalava-background`). It loads after the first-party
static-wallpaper surface (`omarchy-background`), so it stacks above it. When
the lamp is off **no surface exists at all** — the static wallpaper shows
through, which is why a broken state never leaves a black rectangle.

Each surface holds its own `Lamp.qml`, which owns its own population of
blobs, so two monitors never show the same wax.

### The wax

A blob is a plain JS object: position, velocity, radius, temperature, and a
few per-blob random rates. Five by default, large (radius 7–16 % of the
lamp height): real lamps have a few big masses, not a swarm. `Sim.js` advances the population; the functions are pure JS with no QML
dependency, so the dynamics can be exercised headlessly under node.

The motion comes from named laws, each quoted where it is applied in
`Sim.js` and with its constants at the top of that file:

| Law | What it does here |
|---|---|
| Archimedes + thermal expansion | buoyant acceleration ∝ β(T−T*): up above the neutral temperature, down below |
| Stokes drag | damping ∝ 1/r²: **big blobs move faster** |
| Newton's law of cooling, lumped | dT/dt = (T_env − T)/τ, τ ∝ r: big blobs lag more. **Three regimes** by contact: conduction from the coil while in the pool *or still on a column* (fast), convection with the liquid when free (slow — wax conducts poorly), contact with the cool glass at the cap (fast) |
| Bond number | a lump leaves the pool only when buoyancy beats the surface tension holding it to the mass: needed superheat ∝ 1/r² |
| Plateau–Rayleigh | says **when**: the column a lifting blob draws up goes unstable once its length passes ~2πR_col (× a viscous hold factor, capped at the glass) |
| Viscous pinch-off (Papageorgiou) | says **how fast**: from then on the neck radius thins *linearly in time* at ~0.07σ/μ until it breaks, whatever the blob above is doing — a stalled blob still pinches; nothing breaks instantly |
| Column geometry | a tethered blob is held over its foot and the foot creeps under the blob, so columns stay vertical; a leaning column encloses pockets of liquid against the next mound |
| Capillary shape relaxation | a deformed blob rounds off on τ = μr/σ, so the teardrop stretch follows a *relaxed* velocity, not the instantaneous one — a blob landing in the pool rounds off, it does not snap round |
| Capillary retraction | after the break the stump pulls back into the pool at a roughly constant viscocapillary speed and fattens as it shortens (volume); the remnant under the blob is absorbed. **Nothing is swapped at the break**: the column keeps its geometry and the neck gap simply widens from the break point, and the needle tips the cut leaves round off within the first hair of gap (end-pinching — curvature is highest there). Swapping the column for separate stump/remnant capsules, even matched ones, reads as a snap. |
| Capillary number | viscous stress stretches a moving blob along its velocity, in proportion to speed |
| Rayleigh–Bénard | the liquid circulates; a slow random lateral drift stands in for it |

The heater runs the whole width of the base, evenly — this is a screen-wide
lamp, not a bottle with a bulb under the middle — so wax lifts off anywhere
along it, and the glow in the liquid is a band along the bottom. The bulk
liquid is modelled as mixed to a uniform temperature a little under
neutral — that is how a well-tuned lamp runs — with a thin hot layer over the
coil and a cool layer under the cap. This matters: **any temperature gradient
in the bulk gives wax a height at which it is neutrally buoyant, and it
hovers there.** Two earlier versions did exactly that (one from a continuous
liquid gradient, one from letting touching blobs share heat). With a uniform
bulk, wax leaves the coil hot, keeps rising while it slowly cools, is chilled
at the cap, and sinks the whole way back; cooled wax that touches the pool
rejoins it.

Randomness is `Math.random()` with no seed, on purpose. Two runs never match,
and there is nothing to persist — a lamp that could be replayed would be the
video loop this plugin exists not to be.

### The glass

`shaders/lava.frag` is one fragment shader over one quad. Twelve `vec4`
uniforms carry blob position, radius and vertical velocity (unused slots have
zero radius and contribute nothing, so the loop is branch-free), plus one for
the pool. Every pixel sums a metaball field and anything above the threshold
is wax. What makes it read as a lava lamp rather than a field of discs — each
of these was added after looking at the first render and at real lamps:

- **Blobs are ellipses stretched along their velocity**, with the half behind
  them longer still: rising wax is a teardrop, a drip has a tail. A blob at
  rest is still slightly taller than wide.
- **A pool of wax spans the whole base** (a slab metaball with a slowly
  undulating surface). Blobs rest in it as mounds, rise out of it and sink
  back into it through the field.
- **Wax extrudes from the pool on a stalk.** When a blob lifts off, the
  simulation tethers it to its launch point and the shader draws a column
  (a capsule metaball) from the pool to just under the blob; the column only
  fades in once the blob has cleared the surface, thins with height, and
  breaks at a **neck** — a notch that deepens at one point until the column
  is cut, the way a Rayleigh–Plateau neck goes. A uniform thinning instead
  draws a hairline thread before the snap, which reads as a wire, not wax.
  The capsule has a bounded core so the shading normal does not crease down
  its axis.
- **The wax is lit from the bulb below.** Thin, low wax is bright; thick, high
  wax is deep and saturated. The ramp is in *distance* space — the field is
  ~(r/d)⁴, so its fourth root is distance to the centre as a fraction of the
  radius; ramping in field space bunches everything into a ring near the skin
  and reads as an outline.
- **Colour comes from absolute wax thickness**, not relative depth: the
  field carries a contribution-weighted local radius (`Σf·r / Σf`), and
  thickness is that times the depth fraction. A relative measure paints a
  line down the middle of every column — thin wax is as "deep" at its axis
  as a fat blob at its centre — where real wax that thin is bright and backlit.
- **Shading uses the analytic field gradient**, summed per blob, not
  `dFdx/dFdy` (noisy at half resolution). The normal is mapped onto a sphere
  (`(u·ρ, √(1−ρ²))`, ρ = distance fraction) before lighting: a z-component
  linear in ρ leaves the highlight strong along the whole ray toward the
  light and draws a streak from every blob's centre; the sphere confines it
  to a spot. Where two blobs merge the gradients cancel at the saddle and the
  2D normal flips, which lit as a seam — the tilt is scaled by the ratio of
  the real gradient to a lone feature's expected one, so merged wax reads as
  one surface.
- The falloff is `(r²/d²)²`, not the textbook `r²/d²`. Steeper, so blobs stay
  distinct until they are genuinely close, then neck and split.
- The antialias band is `fwidth(f)` **clamped**: at a blob's centre the field
  and its derivative run toward infinity, and an AA band wider than the field
  punches a hole through the wax.
- A three-lobed ripple on each radius keeps the outline from ever being a
  clean curve. Kept small; large values read as cartoon.

Qt 6 loads compiled `.qsb` shaders, so the baked file is committed: a plugin
is installed by `omarchy plugin add`, which is a git clone and nothing else.
After editing the `.frag`, run `shaders/bake.sh` (needs `qt6-shadertools`;
`qsb` lives at `/usr/lib/qt6/bin/qsb` on Arch, not on `PATH`).

### Cost

`Lamp.qml` renders the `ShaderEffect` into a layer at `renderScale` of the
monitor, so fragment work scales with its square; the wax is soft enough that
half resolution is not visibly different from full. The simulation runs on a
`Timer` at the quality level's frame rate, and the shader only redraws when a
uniform changes — so a paused or fullscreen-frozen lamp costs nothing.

### State

Two sources, with a deliberate split:

- an optional **`plugins[]` entry in `shell.json`** for this plugin id seeds a
  fresh install (every key optional);
- **`~/.local/state/omalava/state.json`** is the runtime truth. IPC and
  panel mutations write it, so they survive a shell restart and a reboot.

The state file is user-writable and read by a process that never exits, so
it is treated as untrusted in size as well as content: read through
`head -c` with a byte cap and a `timeout`, refused if it is a symlink or not
a regular file (a FIFO at that path would otherwise block the open for the
life of the session), and written atomically via `mktemp` + `mv`. Every value
from it, from the config entry, or from IPC goes through the same clamps.

`StdioCollector.text` is a **property**, not a function. Calling it throws,
the handler dies, and the fallback initialises on defaults — which looks like
"state never restores" and nothing in the log says why.

### Fullscreen watch

`Quickshell.Hyprland.rawEvent` says *when* to re-check; `hyprctl -j` gives
per-monitor ground truth (whose visible workspace has a fullscreen window).
The lamp on that monitor stops ticking. `status` reports the frozen monitors.

The compositor is a producer outside the plugin, so its output is bounded at
three boundaries — `timeout` limits how *long* the helper runs, never how
*much* it reads or emits: the helper stream-reads each `hyprctl` reply up to
a byte ceiling and treats an over-size reply as no reply; it caps the monitor
and workspace counts it parses, truncates names, and emits at most 64 lines;
and `head -c` sits on the pipe in front of the `StdioCollector`, so the shell
can never be handed more than 8 KB whatever the helper does — the QML handler
caps what it retains independently. On any failure the helper prints
nothing, which reads as "no fullscreen monitor": the lamp keeps running
rather than freezing on bad data.

### What real motion lamps do (the research the rework followed)

In its "prime" a lamp is *a rising column plus blobs*: wax climbs out of
the pool as a column, the head swells, blobs pinch off near the top, and they
come back down as long teardrops or ribbons, passing risers in the same
column, some merging mid-journey. Rise rate is glacial — about half an inch
a minute in a 13" lamp — so the default speed here is deliberately faster
than life and the slider goes slower. On switch-on all the wax is in the
pool; the population is seeded mostly there for that reason. Sources:
[FreshScientific](https://freshscientific.org/how-do-lava-lamps-work),
[a warm-up log](https://salelavalamp.com/blog/lava-lamp-heat-up-process-observation/),
[Lava Lamp 101](https://punkwalrus.livejournal.com/344650.html),
[Plateau–Rayleigh instability](https://en.wikipedia.org/wiki/Plateau%E2%80%93Rayleigh_instability),
[CS184 lava lamp sim](https://jessicaplotkin.github.io/lavalamp/).

## Running it from a checkout

Symlink the folder into `~/.config/omarchy/plugins/nosignal.omalava`, run
`omarchy-shell shell rescanPlugins`, then `omarchy plugin enable
nosignal.omalava --section right`. The service loads live; after a QML edit,
`omarchy-restart-shell`. The dropdown opens headlessly with `omarchy-shell
shell toggle nosignal.omalava`, which is how it gets screenshotted. After
editing the shader, `shaders/bake.sh` rebuilds the committed `.qsb`.
