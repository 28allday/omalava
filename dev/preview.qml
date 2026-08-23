import QtQuick
import Quickshell

// Dev-only harness: one Lamp in a floating window, so the wax can be eyeballed
// and screenshotted without enabling the plugin in the live shell.
//   dev/preview.sh
// Env knobs: LAVA_PALETTE (classic|ocean|...), LAVA_BLOBS, LAVA_SPEED, LAVA_SCALE
ShellRoot {
  FloatingWindow {
    id: win
    title: "omalava-preview"
    implicitWidth: 960
    implicitHeight: 540
    color: "black"

    readonly property var palettes: ({
      classic: { bgTop: "#160a2c", bgBottom: "#4a1f5e", edge: "#ffb347", core: "#e8301a", hot: "#ffd98a", glow: "#ff7a3d" },
      ocean:   { bgTop: "#02101f", bgBottom: "#0b3a5c", edge: "#b9f3ff", core: "#1596b3", hot: "#e8fbff", glow: "#3fd7e6" },
      acid:    { bgTop: "#030a03", bgBottom: "#17361a", edge: "#e6ff7a", core: "#2fbf2a", hot: "#ffffff", glow: "#8cff5a" },
      sunset:  { bgTop: "#130722", bgBottom: "#4a1a3f", edge: "#ffc46b", core: "#ff3d8a", hot: "#fff0c4", glow: "#ff6fa8" },
      ember:   { bgTop: "#070505", bgBottom: "#3a1410", edge: "#ffb15c", core: "#b3130f", hot: "#ffd27a", glow: "#ff5a1f" },
      ice:     { bgTop: "#05091a", bgBottom: "#1c3560", edge: "#ffffff", core: "#6ea8fe", hot: "#ffffff", glow: "#9fc3ff" }
    })

    // preview.sh stages Lamp.qml + shaders/ next to this file first: quickshell
    // refuses to load anything outside the config folder, by import or by URL.
    Loader {
      id: lampLoader
      anchors.fill: parent
      source: Qt.resolvedUrl("Lamp.qml")
      onLoaded: {
        item.colors = win.palettes[Quickshell.env("LAVA_PALETTE") || "classic"] || win.palettes.classic
        item.blobCount = Number(Quickshell.env("LAVA_BLOBS") || 5)
        item.speed = Number(Quickshell.env("LAVA_SPEED") || 1)
        item.renderScale = Number(Quickshell.env("LAVA_SCALE") || 0.5)
      }
    }
    readonly property var lamp: lampLoader.item

    // Stderr heartbeat so a headless run proves the sim is ticking.
    Timer {
      interval: 30000; running: true; repeat: true
      onTriggered: {
        var lamp = win.lamp
        if (!lamp) { console.warn("lava: no lamp"); return }
        var b = lamp.blobs
        var s = []
        for (var i = 0; i < b.length; i++) s.push("[x" + b[i].x.toFixed(2) + " y" + b[i].y.toFixed(2) + " h" + b[i].heat.toFixed(2) + " m" + b[i].mass.toFixed(2) + " vy" + b[i].vy.toFixed(3) + "]")
        console.warn("lava t=" + lamp.simTime.toFixed(0) + " y/heat: " + s.join(" "))
      }
    }
  }
}
