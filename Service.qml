import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Hyprland
import qs.Commons

// Omalava service plugin for omarchy-shell.
//
// Paints a procedurally animated liquid motion lamp on the Wayland background layer
// (namespace "omarchy-lava-background"), one PanelWindow per monitor, above the
// first-party static wallpaper (namespace "omarchy-background"). Each monitor
// runs its own Lamp.qml, so two screens never show the same wax.
//
// There is no video and no loop: the wax is a metaball field driven by a
// buoyancy simulation that is seeded from the clock every time it starts.
//
// State model
// -----------
//   * shell.json plugins[] entry (this plugin's id) is an optional seed for
//     every setting. The plugin runs without one.
//   * ~/.local/state/omalava/state.json is the runtime truth. IPC and panel
//     mutations write it, so they survive shell restarts and reboots.
Item {
  id: root

  // ---- injected by shell.qml (_syncServices/ensureService) ----
  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null
  property var pluginRegistry: null

  readonly property string pluginId: "nosignal.omalava"
  readonly property string home: Quickshell.env("HOME")
  readonly property string stateDir: home + "/.local/state/omalava"
  readonly property string statePath: stateDir + "/state.json"

  // ---------------------------------------------------------------- config
  readonly property var pluginConfig: {
    var cfg = shell && shell.shellConfig ? shell.shellConfig : null
    if (!cfg || !Array.isArray(cfg.plugins)) return ({})
    for (var i = 0; i < cfg.plugins.length; i++) {
      var e = cfg.plugins[i]
      if (e && String(e.id).replace(/^@/, "") === pluginId) return e
    }
    return ({})
  }

  function cfg(name, fallback) {
    var v = pluginConfig ? pluginConfig[name] : undefined
    return (v === undefined || v === null) ? fallback : v
  }

  // ------------------------------------------------------------- bounds
  // state.json is user-writable and the shell that reads it never exits, so
  // everything taken from it (or from the config entry, or from IPC) is
  // clamped before it is kept. The values here are all small scalars and a
  // palette name, so the clamps are ranges and a length cap.
  readonly property int maxStateBytes: 65536
  readonly property int maxNameLength: 64
  readonly property int helperSeconds: 5
  readonly property var timeoutPrefix: ["timeout", "-k", "1", String(root.helperSeconds)]

  function clampNum(v, lo, hi, fallback) {
    var n = Number(v)
    if (!isFinite(n)) return fallback
    return Math.max(lo, Math.min(hi, n))
  }

  function asBool(v, fallback) {
    if (v === true || v === false) return v
    var s = String(v === undefined || v === null ? "" : v).trim().toLowerCase()
    if (s === "true" || s === "on" || s === "1" || s === "yes") return true
    if (s === "false" || s === "off" || s === "0" || s === "no") return false
    return fallback
  }

  // ------------------------------------------------------------- palettes
  // "theme" follows the live Omarchy theme; the rest are fixed.
  readonly property var paletteNames: ["theme", "classic", "ocean", "acid", "sunset", "ember", "ice"]

  // bgTop/bgBottom: the liquid at the cap / at the base by the bulb.
  // edge: thin backlit wax. core: thick wax. hot: the bulb. glow: halo.
  readonly property var fixedPalettes: ({
    classic: { bgTop: "#160a2c", bgBottom: "#4a1f5e", edge: "#ffb347", core: "#e8301a", hot: "#ffd98a", glow: "#ff7a3d" },
    ocean:   { bgTop: "#02101f", bgBottom: "#0b3a5c", edge: "#b9f3ff", core: "#1596b3", hot: "#e8fbff", glow: "#3fd7e6" },
    acid:    { bgTop: "#030a03", bgBottom: "#17361a", edge: "#e6ff7a", core: "#2fbf2a", hot: "#ffffff", glow: "#8cff5a" },
    sunset:  { bgTop: "#130722", bgBottom: "#4a1a3f", edge: "#ffc46b", core: "#ff3d8a", hot: "#fff0c4", glow: "#ff6fa8" },
    ember:   { bgTop: "#070505", bgBottom: "#3a1410", edge: "#ffb15c", core: "#b3130f", hot: "#ffd27a", glow: "#ff5a1f" },
    ice:     { bgTop: "#05091a", bgBottom: "#1c3560", edge: "#ffffff", core: "#6ea8fe", hot: "#ffffff", glow: "#9fc3ff" }
  })

  readonly property var themePalette: ({
    bgTop:    Qt.darker(Color.background, 1.6),
    bgBottom: Qt.lighter(Color.background, 1.9),
    edge:     Qt.lighter(Color.accent, 1.45),
    core:     Qt.darker(Color.accent, 1.25),
    hot:      Qt.lighter(Color.accent, 1.8),
    glow:     Color.accent
  })

  function safePalette(v, fallback) {
    var s = String(v === undefined || v === null ? "" : v)
    if (s.length > root.maxNameLength) return fallback      // length first, before any work on it
    s = s.trim().toLowerCase()
    return s !== "" && root.paletteNames.indexOf(s) !== -1 ? s : fallback
  }
  function safeQuality(v, fallback) {
    var s = String(v === undefined || v === null ? "" : v)
    if (s.length > root.maxNameLength) return fallback
    s = s.trim().toLowerCase()
    return root.qualityLevels[s] ? s : fallback
  }

  readonly property var activePalette: root.paletteName === "theme" ? root.themePalette
                                       : (root.fixedPalettes[root.paletteName] || root.fixedPalettes.classic)

  // ------------------------------------------------------------- quality
  // One knob for "how much GPU": the shader's render scale and the tick rate.
  readonly property var qualityLevels: ({
    low:    { scale: 0.25, fps: 24 },
    medium: { scale: 0.5,  fps: 30 },
    high:   { scale: 1.0,  fps: 60 }
  })
  readonly property real renderScale: root.qualityLevels[root.quality].scale
  readonly property int fps: root.qualityLevels[root.quality].fps

  // ---------------------------------------------------------------- state
  property bool enabled: false
  property string paletteName: "theme"
  property real speed: 1.0
  property int blobCount: 5
  property real blobSize: 1.0
  property string quality: "medium"
  property bool pauseOnFullscreen: true

  // Not persisted: a manual pause and the shuffle token (each Lamp reseeds
  // when it ticks over).
  property bool manualPaused: false
  property int seedToken: 0

  property bool _stateLoaded: false

  readonly property bool rendering: root.enabled && root._stateLoaded

  function statusObject() {
    return {
      enabled: root.enabled,
      paused: root.manualPaused,
      palette: root.paletteName,
      speed: root.speed,
      blobs: root.blobCount,
      size: root.blobSize,
      quality: root.quality,
      pauseOnFullscreen: root.pauseOnFullscreen,
      screens: Quickshell.screens.length,
      frozen: Object.keys(root.fullscreenMonitors || ({}))
    }
  }

  // ------------------------------------------------------- persistence
  function persistState() {
    var payload = JSON.stringify({
      enabled: root.enabled,
      palette: root.paletteName,
      speed: root.speed,
      blobs: root.blobCount,
      size: root.blobSize,
      quality: root.quality,
      pauseOnFullscreen: root.pauseOnFullscreen
    }, null, 2) + "\n"
    root.writeState(payload)
  }

  // Apply a settings object (from the state file, the config seed, or IPC),
  // every field optional and clamped.
  function applySettings(o) {
    if (!o || typeof o !== "object") return
    if (o.enabled !== undefined) root.enabled = asBool(o.enabled, root.enabled)
    if (o.palette !== undefined) root.paletteName = safePalette(o.palette, root.paletteName)
    if (o.speed !== undefined) root.speed = clampNum(o.speed, 0.25, 3.0, root.speed)
    if (o.blobs !== undefined) root.blobCount = Math.round(clampNum(o.blobs, 3, 12, root.blobCount))
    if (o.size !== undefined) root.blobSize = clampNum(o.size, 0.5, 1.6, root.blobSize)
    if (o.quality !== undefined) root.quality = safeQuality(o.quality, root.quality)
    if (o.pauseOnFullscreen !== undefined) root.pauseOnFullscreen = asBool(o.pauseOnFullscreen, root.pauseOnFullscreen)
  }

  function applyStateText(txt) {
    var t = String(txt || "").trim()
    if (!t) return false
    // Refuse an oversized file rather than handing it to JSON.parse.
    if (t.length > root.maxStateBytes) {
      console.warn("omalava: state.json is", t.length, "bytes, over the", root.maxStateBytes, "limit - ignoring it")
      return false
    }
    try {
      var o = JSON.parse(t)
      if (!o || typeof o !== "object") return false
      root.applySettings(o)
      return true
    } catch (e) {
      console.warn("omalava: state.json unreadable:", e)
      return false
    }
  }

  // The config entry seeds a fresh install; once a state file exists it wins.
  function seedFromConfig() {
    root.applySettings({
      enabled: cfg("enabled", undefined),
      palette: cfg("palette", undefined),
      speed: cfg("speed", undefined),
      blobs: cfg("blobs", undefined),
      size: cfg("size", undefined),
      quality: cfg("quality", undefined),
      pauseOnFullscreen: cfg("pauseOnFullscreen", undefined)
    })
  }

  // state.json is read through `head -c` with a deadline, never a FileView:
  // a FileView loads the whole file before any handler runs, and a FIFO at
  // the path would block an unguarded open for the life of the session.
  Process {
    id: stateReadProc
    command: root.timeoutPrefix.concat(
      ["bash", "-c",
       'if [ -L "$2" ] || [ ! -f "$2" ]; then exit 0; fi; ' +
       'head -c "$1" -- "$2" 2>/dev/null || true',
       "_", String(root.maxStateBytes + 1), root.statePath])
    stdout: StdioCollector {
      onStreamFinished: {
        stateReadFallback.stop()
        root.finishStateLoad(text)
      }
    }
    onExited: stateReadFallback.restart()
  }

  Timer {
    id: stateReadFallback
    interval: 250
    onTriggered: root.finishStateLoad("")
  }

  function finishStateLoad(txt) {
    if (root._stateLoaded) return
    var had = root.applyStateText(txt)
    if (!had) root.seedFromConfig()
    root._stateLoaded = true
  }

  // Atomic write: temp file in the same directory, then rename over the
  // target. The payload is a positional parameter, never interpolated.
  Process {
    id: stateWriteProc
    onExited: if (root._pendingState !== "") { var q = root._pendingState; root._pendingState = ""; root.writeState(q) }
  }

  property string _pendingState: ""

  function writeState(payload) {
    if (stateWriteProc.running) { root._pendingState = payload; return }
    stateWriteProc.command = root.timeoutPrefix.concat(["bash", "-c",
      'd=$(dirname -- "$1"); mkdir -p -- "$d" || exit 1; ' +
      'if [ -L "$1" ]; then rm -f -- "$1"; fi; ' +
      't=$(mktemp -- "$1.XXXXXX") || exit 1; ' +
      'printf %s "$2" > "$t" && mv -f -- "$t" "$1" || { rm -f -- "$t"; exit 1; }',
      "_", root.statePath, payload])
    stateWriteProc.running = true
  }

  Process {
    id: mkStateDir
    command: root.timeoutPrefix.concat(["mkdir", "-p", root.stateDir])
    onExited: stateReadProc.running = true
  }

  Component.onCompleted: mkStateDir.running = true

  // ------------------------------------------------------- fullscreen watch
  // Hyprland's event stream says WHEN to re-check; hyprctl gives per-monitor
  // ground truth (whose visible workspace has a fullscreen window). The lamp
  // on that monitor freezes -- it is covered anyway, so ticking it is waste.
  property var fullscreenMonitors: ({})

  readonly property string fsScript:
    "import json,subprocess\n" +
    "def q(c):\n" +
    "    return json.loads(subprocess.check_output(['hyprctl','-j',c]))\n" +
    "try:\n" +
    "    mons=q('monitors'); wss=q('workspaces')\n" +
    "    fs={w.get('id'): bool(w.get('hasfullscreen')) for w in wss}\n" +
    "    for m in mons:\n" +
    "        aw=m.get('activeWorkspace') or {}\n" +
    "        if fs.get(aw.get('id')):\n" +
    "            print(m.get('name'))\n" +
    "except Exception:\n" +
    "    pass\n"

  function refreshFullscreen() {
    if (!root.pauseOnFullscreen || !root.enabled) return
    if (fsProc.running) { fsDebounce.restart(); return }
    fsProc.running = true
  }

  Process {
    id: fsProc
    command: root.timeoutPrefix.concat(["python3", "-c", root.fsScript])
    stdout: StdioCollector {
      onStreamFinished: {
        var set = ({})
        var lines = String(text || "").split("\n")
        for (var i = 0; i < lines.length; i++) {
          var n = lines[i].trim()
          if (n) set[n] = true
        }
        root.fullscreenMonitors = set
      }
    }
  }

  Timer {
    id: fsDebounce
    interval: 120
    repeat: false
    onTriggered: root.refreshFullscreen()
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      switch (event.name) {
        case "fullscreen":
        case "fullscreenv2":
        case "activewindow":
        case "activewindowv2":
        case "openwindow":
        case "closewindow":
        case "movewindowv2":
        case "changefloatingmode":
        case "workspace":
        case "workspacev2":
        case "focusedmon":
        case "focusedmonv2":
          fsDebounce.restart()
          break
      }
    }
  }

  Timer { interval: 400; running: true; repeat: false; onTriggered: root.refreshFullscreen() }
  onEnabledChanged: if (enabled) fsDebounce.restart()
  onPauseOnFullscreenChanged: if (pauseOnFullscreen) fsDebounce.restart(); else fullscreenMonitors = ({})

  // ---------------------------------------------------------------- render
  readonly property var activeScreens: root.rendering ? Quickshell.screens : []

  Variants {
    model: root.activeScreens

    PanelWindow {
      id: panel
      required property var modelData

      screen: modelData
      visible: true
      color: "transparent"
      anchors { top: true; bottom: true; left: true; right: true }
      updatesEnabled: true

      WlrLayershell.namespace: "omarchy-omalava-background"
      WlrLayershell.layer: WlrLayer.Background
      WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
      exclusionMode: ExclusionMode.Ignore

      readonly property string monName: String(modelData.name)
      readonly property bool monFullscreen: root.pauseOnFullscreen
                                            && (root.fullscreenMonitors[monName] === true)

      Lamp {
        anchors.fill: parent
        running: !root.manualPaused && !panel.monFullscreen
        speed: root.speed
        blobCount: root.blobCount
        blobSize: root.blobSize
        renderScale: root.renderScale
        fps: root.fps
        colors: root.activePalette

        property int seedToken: root.seedToken
        onSeedTokenChanged: reseed()
      }
    }
  }

  // ------------------------------------------------------------ mutators
  // Root-level mutators are the single source of truth; the IpcHandler and
  // the bar widget both call them.
  function applyOn()      { root.enabled = true; root.manualPaused = false; root.persistState(); return root.statusObject() }
  function applyOff()     { root.enabled = false; root.manualPaused = false; root.persistState(); return root.statusObject() }
  function applyToggle()  { return root.enabled ? root.applyOff() : root.applyOn() }
  function applyPause()   { root.manualPaused = true; return root.statusObject() }
  function applyResume()  { root.manualPaused = false; return root.statusObject() }
  function applyShuffle() { root.seedToken++; return root.statusObject() }

  function applySet(key, value) {
    var o = ({}); o[key] = value
    root.applySettings(o)
    root.persistState()
    return root.statusObject()
  }

  IpcHandler {
    target: "omalava"

    function on(): string      { return JSON.stringify(root.applyOn()) }
    function off(): string     { return JSON.stringify(root.applyOff()) }
    function toggle(): string  { return root.applyToggle().enabled ? "on" : "off" }
    function pause(): string   { root.applyPause(); return "paused" }
    function resume(): string  { root.applyResume(); return "running" }
    function shuffle(): string { root.applyShuffle(); return "shuffled" }
    function status(): string  { return JSON.stringify(root.statusObject()) }
    function palettes(): string { return root.paletteNames.join("\n") }

    // setPalette theme|classic|ocean|acid|sunset|ember|ice
    function setPalette(name: string): string { return JSON.stringify(root.applySet("palette", name)) }
    // setSpeed 0.25..3
    function setSpeed(x: string): string      { return JSON.stringify(root.applySet("speed", x)) }
    // setBlobs 3..12
    function setBlobs(n: string): string      { return JSON.stringify(root.applySet("blobs", n)) }
    // setSize 0.5..1.6
    function setSize(x: string): string       { return JSON.stringify(root.applySet("size", x)) }
    // setQuality low|medium|high
    function setQuality(q: string): string    { return JSON.stringify(root.applySet("quality", q)) }
    function setPauseOnFullscreen(on: string): string { return JSON.stringify(root.applySet("pauseOnFullscreen", on)) }
  }
}
