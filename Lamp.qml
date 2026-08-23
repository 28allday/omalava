import QtQuick
import "Sim.js" as Sim

// One lamp: the buoyancy simulation plus the ShaderEffect that draws it.
// Service.qml mounts one of these per monitor, so every screen runs its own
// independent wax. Nothing here is scripted or recorded -- every blob starts at
// a random position with a random temperature and wanders under random
// currents, so the lamp never repeats.
//
// Simulation space is the lamp's own: x runs 0..aspect, y runs 0 (base) to 1
// (cap). The shader uses the same frame, so positions go straight through.
Item {
    id: lamp

    // ---- inputs from the service -------------------------------------
    property bool running: true          // tick the sim; false freezes the frame
    property real speed: 1.0             // 0.25 .. 3
    property int blobCount: 5            // 3 .. 12
    property real blobSize: 1.0          // 0.5 .. 1.6, multiplier on radius
    property real renderScale: 0.5       // 0.25 .. 1; fragment work is scaled by its square
    property int fps: 30                 // sim + redraw rate
    property var colors: ({})            // { bgTop, bgBottom, edge, core, hot, glow }
    property real glow: 0.8
    property real heater: 0.8
    property real wobble: 0.035

    readonly property int maxBlobs: Sim.MAX_BLOBS
    // Nominal height of the wax pool's surface, in lamp units (the shader
    // undulates around it).
    readonly property real poolHeight: 0.13 * lamp.blobSize
    readonly property real aspect: height > 0 ? width / height : 1.0

    // ---- simulation state ---------------------------------------------
    // Plain JS objects, not QML items: twelve of them, touched thirty times a
    // second, and nothing outside this file reads them.
    property var blobs: []
    property real simTime: 0
    property double _lastTick: 0
    property int _seedCount: 0

    // The population is plain JS, advanced by Sim.js; see there for the model.
    function newBlob(fromBottom) { return Sim.newBlob(lamp.aspect, lamp.blobSize, fromBottom) }

    // (Re)build the whole population. Called on first run and by "shuffle".
    function reseed() {
        var out = []
        var n = Math.max(1, Math.min(lamp.maxBlobs, lamp.blobCount))
        // Most of the wax starts in the pool, as a real lamp does when it is
        // switched on; a couple are already adrift so the glass is not empty.
        for (var i = 0; i < n; i++) out.push(newBlob(i >= 2))
        lamp.blobs = out
        lamp._seedCount++
        pushUniforms()
    }

    // Grow or shrink the population in place, so changing the slider does not
    // reset the lamp -- new blobs enter from the base, surplus ones go last-out.
    function resizePopulation() {
        var n = Math.max(1, Math.min(lamp.maxBlobs, lamp.blobCount))
        var b = lamp.blobs.slice()
        while (b.length > n) b.pop()
        while (b.length < n) b.push(newBlob(true))
        lamp.blobs = b
        pushUniforms()
    }

    onBlobCountChanged: if (lamp.blobs.length) resizePopulation()
    onBlobSizeChanged: { Sim.rescale(lamp.blobs, lamp.blobSize); pushUniforms() }

    function step(dt) {
        Sim.step(lamp.blobs, dt, { aspect: lamp.aspect, heater: lamp.heater, time: lamp.simTime,
                                   poolTop: lamp.poolHeight })
    }

    function pushUniforms() {
        var b = lamp.blobs
        for (var i = 0; i < lamp.maxBlobs; i++) {
            if (i < b.length) {
                var o = b[i]
                fx["b" + i] = Qt.vector4d(o.x, o.y, o.r, o.shapeV)
                // y packs fade-in and pinch: 0..1 = fading in, >= 1 = 1 + pinch
                // (the notch keeps deepening after the break, which is how the
                // gap opens). zw = where the column top was when it broke
                // (0 = still connected).
                var code = 0
                if (o.stalkState === "up") code = o.stalkVis < 1 ? o.stalkVis : 1 + o.stalkPinch
                else if (o.bfY > 0) code = 1 + o.stalkPinch
                fx["s" + i] = Qt.vector4d(o.stalkX, code, o.bfY || 0, o.bfX || 0)
            } else {
                fx["b" + i] = Qt.vector4d(0, 0, 0, 0)
                fx["s" + i] = Qt.vector4d(0, 0, 0, 0)
            }
        }
        fx.time = lamp.simTime
        // The pool scales with the population's size setting and breathes a
        // little in the shader; here it just tracks the glass.
        fx.pool = Qt.vector4d(lamp.aspect * 0.5, lamp.aspect, lamp.poolHeight, 0)
    }

    function tick() {
        var now = Date.now()
        var dt = (lamp._lastTick > 0) ? (now - lamp._lastTick) / 1000 : 1 / Math.max(1, lamp.fps)
        lamp._lastTick = now
        // A tab-away or a suspend produces one huge dt; clamp it rather than
        // let the wax teleport, and sub-step so the springs stay stable.
        if (dt > 0.25) dt = 0.25
        dt *= lamp.speed
        var steps = dt > 0.05 ? Math.ceil(dt / 0.05) : 1
        var h = dt / steps
        for (var s = 0; s < steps; s++) { lamp.simTime += h; step(h) }
        pushUniforms()
    }

    Timer {
        id: ticker
        interval: Math.max(16, Math.round(1000 / Math.max(5, Math.min(60, lamp.fps))))
        repeat: true
        running: lamp.running && lamp.visible && lamp.width > 0 && lamp.blobs.length > 0
        triggeredOnStart: false
        onTriggered: lamp.tick()
        onRunningChanged: lamp._lastTick = 0   // pause must not bank up dt
    }

    Component.onCompleted: reseed()

    // Monitors change size (hotplug, scale change), and the first population
    // may be seeded before the surface has its size at all: keep the wax's
    // RELATIVE positions, so it spreads across the glass rather than piling
    // into whatever width it was born in.
    property real _lastAspect: 1.0
    onAspectChanged: {
        if (lamp.aspect > 0 && lamp._lastAspect > 0) Sim.rescaleX(lamp.blobs, lamp.aspect / lamp._lastAspect)
        lamp._lastAspect = lamp.aspect
        Sim.clampToAspect(lamp.blobs, lamp.aspect)
        pushUniforms()
    }

    // ---- the glass -------------------------------------------------------
    // The shader runs per pixel of its layer, so `renderScale` is the power
    // knob: 0.5 is a quarter of the fragment work and, on wax this soft, not
    // visibly different from full resolution.
    ShaderEffect {
        id: fx
        anchors.fill: parent
        fragmentShader: Qt.resolvedUrl("shaders/lava.frag.qsb")

        layer.enabled: lamp.renderScale < 0.999
        layer.smooth: true
        layer.textureSize: Qt.size(Math.max(1, Math.round(lamp.width * lamp.renderScale)),
                                   Math.max(1, Math.round(lamp.height * lamp.renderScale)))

        property real aspect: lamp.aspect
        property real threshold: 1.0
        property real glow: lamp.glow
        property real heater: lamp.heater
        property real wobble: lamp.wobble
        property real time: 0
        property vector4d pool: Qt.vector4d(0.5, 1.0, 0.13, 0)

        property color bgTop:     lamp.colors && lamp.colors.bgTop    ? lamp.colors.bgTop    : "#1b1030"
        property color bgBottom:  lamp.colors && lamp.colors.bgBottom ? lamp.colors.bgBottom : "#090414"
        property color edgeColor: lamp.colors && lamp.colors.edge     ? lamp.colors.edge     : "#ff3d1f"
        property color coreColor: lamp.colors && lamp.colors.core     ? lamp.colors.core     : "#ffb347"
        property color hotColor:  lamp.colors && lamp.colors.hot      ? lamp.colors.hot      : "#fff0a8"
        property color glowColor: lamp.colors && lamp.colors.glow     ? lamp.colors.glow     : "#ff5a36"

        property vector4d b0:  Qt.vector4d(0, 0, 0, 0)
        property vector4d b1:  Qt.vector4d(0, 0, 0, 0)
        property vector4d b2:  Qt.vector4d(0, 0, 0, 0)
        property vector4d b3:  Qt.vector4d(0, 0, 0, 0)
        property vector4d b4:  Qt.vector4d(0, 0, 0, 0)
        property vector4d b5:  Qt.vector4d(0, 0, 0, 0)
        property vector4d b6:  Qt.vector4d(0, 0, 0, 0)
        property vector4d b7:  Qt.vector4d(0, 0, 0, 0)
        property vector4d b8:  Qt.vector4d(0, 0, 0, 0)
        property vector4d b9:  Qt.vector4d(0, 0, 0, 0)
        property vector4d b10: Qt.vector4d(0, 0, 0, 0)
        property vector4d b11: Qt.vector4d(0, 0, 0, 0)

        // Stalks: x = where the column meets the pool, y = strength 0..1.
        property vector4d s0:  Qt.vector4d(0, 0, 0, 0)
        property vector4d s1:  Qt.vector4d(0, 0, 0, 0)
        property vector4d s2:  Qt.vector4d(0, 0, 0, 0)
        property vector4d s3:  Qt.vector4d(0, 0, 0, 0)
        property vector4d s4:  Qt.vector4d(0, 0, 0, 0)
        property vector4d s5:  Qt.vector4d(0, 0, 0, 0)
        property vector4d s6:  Qt.vector4d(0, 0, 0, 0)
        property vector4d s7:  Qt.vector4d(0, 0, 0, 0)
        property vector4d s8:  Qt.vector4d(0, 0, 0, 0)
        property vector4d s9:  Qt.vector4d(0, 0, 0, 0)
        property vector4d s10: Qt.vector4d(0, 0, 0, 0)
        property vector4d s11: Qt.vector4d(0, 0, 0, 0)
    }
}
