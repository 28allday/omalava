.pragma library

// Omalava -- the wax.
//
// Pure functions over plain JS objects, shared by Lamp.qml (which runs them
// thirty times a second and hands the result to the shader) and dev/sim.js
// (which runs them headless under node to check the dynamics). Nothing in
// here touches QML.
//
// Space: x runs 0..aspect, y runs 0 (base) to 1 (cap).
//
// The physics, in normalised units (lamp height = 1, seconds), each law
// named where it is applied below:
//
//   Archimedes + thermal expansion   rho_wax(T) = rho0 (1 - beta (T - T*)); the
//                                    net buoyant acceleration is ~ g beta (T-T*),
//                                    up above the neutral temperature T*, down
//                                    below it. T here is (T - T*) scaled so the
//                                    coil is ~+1 and the cap ~-1.
//   Stokes drag (creeping flow)      F = 6 pi mu r v, so per unit mass the damping
//                                    is gamma = 9 mu / (2 rho r^2): terminal speed
//                                    goes as r^2 -- bigger blobs move FASTER.
//   Newton's law of cooling (lumped) dT/dt = (T_env - T) / tau, with
//                                    tau = rho c r / (3 h) proportional to r:
//                                    bigger blobs lag more. Two regimes, because
//                                    h differs by an order of magnitude: wax in
//                                    the pool is heated by CONDUCTION from the
//                                    coil (fast); free wax exchanges heat with the
//                                    liquid by CONVECTION only (slow -- wax is a
//                                    poor conductor). The bulk liquid is mixed to
//                                    near-uniform temperature, just under neutral
//                                    in a well-tuned lamp, with a thin hot layer
//                                    over the coil and a cool layer under the
//                                    cap. No temperature gradient in the bulk
//                                    means no height at which wax can hover: it
//                                    leaves the coil hot and keeps rising while
//                                    it slowly cools, is chilled at the cap, and
//                                    sinks the whole way back.
//   Bond number                      a lump leaves the pool only when buoyancy
//                                    beats surface tension holding it to the mass:
//                                    beta (T-T*) g r^3 > C sigma r, so the needed
//                                    superheat goes as 1/r^2 -- small wax must get
//                                    hotter than big wax before it lifts off.
//   Plateau-Rayleigh                 the column a lifting blob draws up is unstable
//                                    once its length exceeds ~2 pi R_col; viscous
//                                    threads hold somewhat longer. That sets the
//                                    pinch height.
//   Capillary retraction             after the break the stump pulls back into the
//                                    pool at a roughly constant viscocapillary speed
//                                    ~ sigma / mu (Taylor-Culick for thin films);
//                                    the remnant under the blob is absorbed the
//                                    same way. Nothing disappears in a frame.
//   Young-Laplace / viscocapillarity every change of shape is driven by surface
//                                    tension (pressure ~ sigma * curvature) and,
//                                    in a viscous liquid, proceeds at a rate
//                                    ~ sigma / mu -- never in a frame. Three
//                                    places that matters:
//     - neck thinning (Papageorgiou)  once unstable, the neck radius shrinks
//                                    LINEARLY in time at ~0.07 sigma/mu until it
//                                    breaks, whatever the blob above is doing;
//     - shape relaxation              a deformed blob rounds off on tau = mu r /
//                                    sigma, so its stretch lags its velocity;
//     - end recoil                    the broken ends round and recede at ~sigma/mu.
//   Capillary number                 Ca = mu v / sigma sets how far viscous stress
//                                    deforms a blob from a sphere; the shader
//                                    stretches along (the relaxed) velocity.
//   Rayleigh-Benard convection       the liquid itself circulates; the slow random
//                                    lateral drift stands in for those currents.

// ---- constants ------------------------------------------------------------
var R_REF      = 0.11    // reference radius the constants are quoted at
var T_COIL     = 1.25    // liquid temperature at the coil (scaled, T* = 0)
var T_BULK     = -0.15   // bulk liquid: a well-tuned lamp sits a little under neutral, so cooled wax sinks
var T_CAP      = -0.9    // under the cap
var COIL_L     = 0.04    // e-folding height of the thin hot layer above the coil
var CAP_FROM   = 0.66    // where cap cooling starts
var TAU_COIL   = 4.0     // s, Newton-cooling time constant for R_REF in contact with the coil (conduction)
var TAU_LIQ    = 24.0    // s, the same free in the liquid (convection only; wax is a poor conductor)
var TAU_CAP    = 6.0     // s, pressed against the cool glass at the top (contact again)
var CAP_TOUCH  = 0.86    // height above which wax is against the cap
var G_BETA     = 0.085   // buoyant acceleration per unit superheat (g*beta*dT)
var GAMMA_REF  = 1.1     // 1/s, Stokes damping for R_REF
var BOND_K     = 0.0065  // lift-off: need (T-T*) > BOND_K / r^2   (0.54 at R_REF)
var SIGMA_PULL = 0.012   // tension of the column, as a pull-back acceleration
var RETRACT_V  = 0.045   // lamp-heights/s, capillary retraction of the stump
var NECK_V     = 0.018   // lamp-heights/s, viscous neck thinning (~0.07 sigma/mu, Papageorgiou): linear in time
var TAU_SHAPE  = 1.4     // s, capillary relaxation of a blob's shape (mu r / sigma): stretch lags velocity
var VISC_HOLD  = [1.0, 2.0] // Plateau-Rayleigh: length/(2 pi R) at which the neck starts

var MAX_BLOBS = 12

// Uniform random in [a, b). Callers pass Math.random; there is deliberately no
// seed -- a wallpaper that could be replayed would be the loop this plugin
// exists not to be.
function rnd(a, b) { return a + Math.random() * (b - a) }

function newBlob(aspect, blobSize, fromBottom) {
    var seedR = rnd(0.08, 0.16)
    var r = seedR * blobSize
    return {
        x: rnd(r, Math.max(r, aspect - r)),
        y: fromBottom ? rnd(r * 0.5, 0.2) : rnd(r * 0.5, 1.0 - r * 0.5),
        vx: rnd(-0.01, 0.01),
        vy: rnd(-0.01, 0.01),
        r: r,
        seedR: seedR,                       // radius before blobSize, so the slider is reversible
        baseR: r,
        heat: fromBottom ? rnd(0.2, 0.8) : rnd(-0.6, 0.6),   // (T - T*) scaled: coil ~ +1, cap ~ -1
        mass: massFor(r, blobSize),         // bigger wax warms and cools slower
        phase: rnd(0, Math.PI * 2),         // edge-ripple phase, for the shader
        spin: rnd(0.15, 0.45) * (Math.random() < 0.5 ? -1 : 1),
        breath: rnd(0.2, 0.5),
        breathPhase: rnd(0, Math.PI * 2),
        driftX: rnd(-0.6, 0.6),             // lateral current
        driftT: rnd(2, 8),                  // seconds until it shifts
        // Stalk: wax leaving the pool stays joined to it by a column that
        // thins as the blob climbs, until it pinches off. "rest" = sitting in
        // the pool, "up" = tethered and climbing, "free" = pinched off.
        stalkState: fromBottom ? "rest" : "free",
        stalkVis: 0,                        // 0..1 how much of the column is drawn (fades in as the blob clears the pool)
        stalkPinch: 0,                      // 0..1 how deep the neck is (1 = cut)
        stalkX: 0,                          // where the column meets the pool
        stalkY0: 0,                         // height at lift-off
        stalkReach: 0.4,                    // column length at which Plateau-Rayleigh cuts it
        shapeV: 0,                          // velocity the SHAPE has relaxed to (stretch lags vy by TAU_SHAPE)
        gapHalf: 0,                         // after the cut: half the gap opened at the neck, growing at capillary speed
        bfX: 0, bfY: 0                      // after the cut: where the column's top was when it broke
    }
}

function massFor(r, blobSize) {
    return Math.pow(r / (0.11 * blobSize), 2.0)
}

// Re-apply a new blobSize to a live population: the wax just swells.
function rescale(blobs, blobSize) {
    for (var i = 0; i < blobs.length; i++) {
        var o = blobs[i]
        o.baseR = o.seedR * blobSize
        o.r = o.baseR
        o.mass = massFor(o.baseR, blobSize)
    }
}

// Advance every blob by dt seconds. `env` = { aspect, heater, time, poolTop }.
function step(blobs, dt, env) {
    var n = blobs.length
    var W = env.aspect
    var t = env.time
    var heater = env.heater

    for (var i = 0; i < n; i++) {
        var o = blobs[i]

        // Newton's law of cooling, two regimes. In the pool the wax touches
        // the heater: conduction, fast. The heater runs the whole width of
        // the base, evenly -- this is a screen-wide lamp, not a bottle with a
        // bulb under the middle -- so wax lifts off anywhere along it. Free in the liquid:
        // convection only, slow, against a bulk that is uniform and just
        // under neutral, a thin hot layer over the coil, and a cool layer
        // under the cap. tau grows with r (thermal mass over surface).
        var sideX = Math.abs(o.x / W - 0.5) * 2.0
        // Connected wax counts as in the pool: a lump still on its column is
        // one body with the hot mass and keeps heating by conduction until the
        // column breaks -- which is why columns leave hot enough to climb.
        var inPool = o.stalkState === "rest" || o.stalkState === "up"
        var tEnv, tau
        if (inPool) {
            tEnv = T_BULK + (T_COIL - T_BULK) * heater * (1.0 - 0.45 * sideX * sideX)
            tau = TAU_COIL * (o.r / R_REF)
        } else {
            var coilWarm = (T_COIL - T_BULK) * Math.exp(-o.y / COIL_L) * heater
            var capCool = (T_BULK - T_CAP) * Math.max(0, (o.y - CAP_FROM) / (1.0 - CAP_FROM))
            tEnv = T_BULK + coilWarm - capCool
            tau = (o.y > CAP_TOUCH ? TAU_CAP : TAU_LIQ) * (o.r / R_REF)
        }
        o.heat += (tEnv - o.heat) * dt / tau
        if (o.heat > 1.5) o.heat = 1.5
        if (o.heat < -1.5) o.heat = -1.5

        // Archimedes: buoyant acceleration from thermal expansion; Stokes:
        // damping falling as 1/r^2, so the big ones are the quick ones.
        var gamma = GAMMA_REF * (R_REF / o.r) * (R_REF / o.r)
        // Bond number: while part of the pool the lump is held by surface
        // tension until its superheat clears BOND_K / r^2.
        var lifts = o.stalkState !== "rest" || o.heat > BOND_K / (o.r * o.r)
        if (lifts) {
            o.vy += G_BETA * o.heat * dt
        } else if (o.y > env.poolTop * 0.95) {
            // Landed but still perched on the surface: denser than the liquid,
            // it settles INTO the pool rather than sitting on it -- perching
            // is what left arches trapping a pocket of liquid against a mound.
            o.vy += (-0.02 - o.vy) * 3.0 * dt
        } else {
            o.vy -= o.vy * 4.0 * dt                      // held in the mass
        }
        o.vy -= o.vy * gamma * dt

        // The column. Lift-off draws a column up from the pool that tethers
        // the blob (tension pulls it back and holds it under its launch
        // point); Plateau-Rayleigh says it breaks once its length passes
        // ~2 pi R_col (times a viscous hold factor). After the break the stump
        // retracts into the pool at the capillary speed and the remnant is
        // absorbed into the blob.
        if (o.stalkState === "rest") {
            // (A stump still retracting from the last trip finishes first --
            // the column geometry cannot be both broken and connected.)
            if (lifts && o.vy > 0.003 && !(o.bfY > 0)) {
                o.stalkState = "up"
                o.stalkX = o.x
                o.stalkY0 = o.y
                // Plateau-Rayleigh: unstable once longer than the circumference
                // 2 pi R_col (R_col ~ 0.4 r, the column's mean radius), held a
                // little longer by viscosity. Capped so a column cannot be
                // taller than the glass.
                var rCol = o.r * 0.4
                o.stalkReach = Math.min(0.6, 2 * Math.PI * rCol * rnd(VISC_HOLD[0], VISC_HOLD[1]))
                o.stalkVis = 0
                o.stalkPinch = 0
            }
        } else if (o.stalkState === "up") {
            o.stalkVis = Math.max(0, Math.min(1, (o.y - o.r * 0.2 - env.poolTop) / (o.r * 0.8)))
            // Plateau-Rayleigh says WHEN: the column is unstable once longer
            // than stalkReach. Viscous pinch-off says HOW FAST: from then on
            // the neck thins linearly at NECK_V, whatever the blob does. A
            // column that never gets long enough just stays a column.
            var colLen = o.y - o.r * 0.35 - o.stalkY0
            if (colLen >= o.stalkReach || o.stalkPinch > 0) {
                o.stalkPinch += NECK_V / (1.2 * 0.62 * o.r) * dt
            }
            var tether = 1 - Math.min(1, o.stalkPinch)
            o.vy -= tether * SIGMA_PULL * dt
            // The column stays vertical: the blob is held over its foot and
            // the foot creeps under the blob. A leaning column reads wrong
            // and encloses pockets of liquid against the next mound.
            o.vx += (o.stalkX - o.x) * 3.0 * tether * dt
            o.stalkX += (o.x - o.stalkX) * 0.6 * dt
            // The shader's neck is cut once pinch passes ~0.83; that is the
            // break. Nothing is swapped out: the column keeps its geometry and
            // the gap at the neck opens from here, so the frame after the
            // break is the frame before it plus a hair of gap.
            if (o.stalkPinch >= 0.84) {
                o.stalkState = "free"
                o.bfX = o.x
                o.bfY = o.y - o.r * 0.35
                o.gapHalf = 0
            }
        } else if (o.y - 0.9 * o.r < env.poolTop && o.vy <= 0.002) {
            // Sinking wax that touches the pool rejoins it. A stump it left
            // behind keeps retracting on its own -- deleting it here popped.
            o.stalkState = "rest"
        }
        if (o.stalkState === "up" && o.y - 0.9 * o.r < env.poolTop && o.vy < -0.002 && o.stalkPinch === 0) {
            o.stalkState = "rest"           // a column that sank back before it ever necked
        }
        // After the break: the gap opens at capillary speed. Both ends
        // recede from the neck -- the stump down into the pool, the remnant
        // up into the blob. Expressed to the shader as a notch depth that
        // keeps growing, so the cut band widens from where it started.
        if (o.bfY > 0) {
            o.gapHalf += RETRACT_V * dt
            var dx = o.bfX - o.stalkX, dy = o.bfY
            var L = Math.sqrt(dx * dx + dy * dy) + 1e-6
            var band = o.gapHalf / L                                      // in column-t units
            o.stalkPinch = Math.exp((band / 0.2) * (band / 0.2)) / 1.2   // inverts the shader's notch
            if (band >= 0.72) { o.bfY = 0; o.stalkPinch = 0; o.gapHalf = 0 } // stump under the surface: gone
        }

        // Lateral currents: a slow per-blob drift that flips at random
        // intervals, plus a flicker of noise.
        o.driftT -= dt
        if (o.driftT <= 0) { o.driftX = rnd(-0.6, 0.6); o.driftT = rnd(2, 9) }
        o.vx += o.driftX * 0.02 * dt + rnd(-0.004, 0.004) * dt
        o.vx -= o.vx * 1.2 * dt

        for (var j = i + 1; j < n; j++) {
            var p = blobs[j]
            var dx = o.x - p.x, dy = o.y - p.y
            var d = Math.sqrt(dx * dx + dy * dy) + 1e-6
            // Beyond touching range, a faint lateral repulsion keeps the
            // population spread across the glass instead of one chain.
            var farD = (o.r + p.r) * 2.4
            if (d < farD) {
                var fpush = (farD - d) / farD * 0.01 * dt
                var fx = dx / d
                o.vx += fx * fpush; p.vx -= fx * fpush
            }
            // Wax does not like to fully coincide: a soft shove apart when two
            // blobs overlap deeply, weak enough that they still merge and neck.
            var minD = (o.r + p.r) * 0.9
            if (d < minD) {
                var push = (minD - d) / minD * 0.08 * dt
                var ux = dx / d, uy = dy / d
                o.vx += ux * push; o.vy += uy * push
                p.vx -= ux * push; p.vy -= uy * push
            }
        }

        // Glass: soft springs keep the wax inside, so it pools at the base
        // and cap rather than bouncing off them.
        var mx = o.r * 0.55, my = o.r * 0.1
        if (o.x < mx)        o.vx += (mx - o.x) * 1.6 * dt
        if (o.x > W - mx)    o.vx -= (o.x - (W - mx)) * 1.6 * dt
        if (o.y < my)        o.vy += (my - o.y) * 2.5 * dt
        if (o.y > 1.0 - my)  o.vy -= (o.y - (1.0 - my)) * 2.5 * dt

        o.x += o.vx * dt
        o.y += o.vy * dt

        // Capillary relaxation: the shape follows the velocity with a lag of
        // TAU_SHAPE (bigger wax relaxes slower), so a blob that stops does
        // not snap round -- it rounds off.
        o.shapeV += (o.vy - o.shapeV) * dt / (TAU_SHAPE * Math.sqrt(o.r / R_REF))

        // Breathing radius: warm wax swells a little, and every blob has a
        // slow pulse of its own.
        o.r = o.baseR * (1.0 + 0.03 * o.heat + 0.03 * Math.sin(t * o.breath + o.breathPhase))
        o.phase += o.spin * dt
    }
}

// The glass changed width by `k`: keep every blob (and its column foot) at
// the same fraction of the width.
function rescaleX(blobs, k) {
    if (!(k > 0) || k === 1) return
    for (var i = 0; i < blobs.length; i++) {
        blobs[i].x *= k
        blobs[i].stalkX *= k
        blobs[i].bfX *= k
    }
}

// Keep the wax inside the glass after the glass changes shape (a monitor
// hotplug or scale change).
function clampToAspect(blobs, aspect) {
    for (var i = 0; i < blobs.length; i++) {
        var o = blobs[i]
        if (o.x > aspect - o.r) o.x = Math.max(o.r, aspect - o.r)
    }
}
