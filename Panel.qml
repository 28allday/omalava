import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

// Dropdown content for the Omalava bar widget. Loaded by string URL into
// BarWidget.qml's KeyboardPanel, so this is plain content: open/close, IPC and
// popout coordination all live in the widget. Reads and mutations go through
// `widget`, which owns the service handle.
Item {
  id: panel

  property var widget: null
  property QtObject bar: null

  readonly property var service: widget ? widget.service : null
  readonly property bool keysBlocked: paletteDropdown.popupOpen || qualityDropdown.popupOpen

  readonly property color fg: bar ? bar.foreground : Color.foreground
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color dim: Qt.darker(fg, 1.5)

  readonly property bool isOn: !!service && service.enabled === true
  readonly property bool isPaused: isOn && service.manualPaused === true
  readonly property string stateText: !service ? "Service unavailable"
                                     : !isOn ? "Off"
                                     : isPaused ? "Paused" : "Running"
  readonly property string metaText: {
    if (!service) return stateText
    var n = String(service.paletteName || "theme")
    return stateText + "  ·  " + n.charAt(0).toUpperCase() + n.slice(1)
  }

  readonly property var paletteOptions: [
    { value: "theme",   label: "Theme · follows Omarchy" },
    { value: "classic", label: "Classic · orange on purple" },
    { value: "ocean",   label: "Ocean · cyan on deep blue" },
    { value: "acid",    label: "Acid · green on black" },
    { value: "sunset",  label: "Sunset · pink and amber" },
    { value: "ember",   label: "Ember · red and orange" },
    { value: "ice",     label: "Ice · pale blue" }
  ]
  readonly property var qualityOptions: [
    { value: "low",    label: "Low · quarter res, 24 fps" },
    { value: "medium", label: "Medium · half res, 30 fps" },
    { value: "high",   label: "High · full res, 60 fps" }
  ]

  implicitWidth: Style.space(320)
  implicitHeight: col.implicitHeight

  Column {
    id: col
    width: parent.width
    spacing: Style.spacing.panelGap

    PanelHero {
      width: parent.width
      title: "Omalava"
      meta: panel.metaText
      foreground: panel.fg
      fontFamily: panel.fontFamily
      iconComponent: Component {
        Text {
          textFormat: Text.PlainText
          text: "󰟕"
          color: panel.widget ? panel.widget.iconColor : panel.fg
          font.family: panel.fontFamily
          font.pixelSize: Style.font.display
        }
      }
    }

    // ---------- transport ----------
    Row {
      width: parent.width
      spacing: Style.spacing.controlGap

      Button {
        foreground: panel.fg
        fontFamily: panel.fontFamily
        iconText: "󰐥"
        text: panel.isOn ? "Turn off" : "Turn on"
        bordered: true
        onClicked: if (panel.widget) panel.widget.toggleLamp()
      }

      Button {
        foreground: panel.fg
        fontFamily: panel.fontFamily
        iconText: panel.isPaused ? "󰐊" : "󰏤"
        text: panel.isPaused ? "Resume" : "Pause"
        bordered: true
        opacity: panel.isOn ? 1.0 : 0.5
        enabled: panel.isOn
        onClicked: if (panel.widget) panel.widget.togglePause()
      }

      Button {
        foreground: panel.fg
        fontFamily: panel.fontFamily
        iconText: "󰒝"
        text: "Shuffle"
        tooltipText: "Re-seed every lamp with fresh wax"
        bordered: true
        opacity: panel.isOn ? 1.0 : 0.5
        enabled: panel.isOn
        onClicked: if (panel.widget) panel.widget.shuffle()
      }
    }

    // ---------- palette ----------
    Dropdown {
      id: paletteDropdown
      width: parent.width
      label: "PALETTE"
      options: panel.paletteOptions
      value: panel.service ? String(panel.service.paletteName) : "theme"
      onChanged: function(v) { if (panel.widget) panel.widget.set("palette", String(v)) }
    }

    // ---------- sliders ----------
    PanelSectionHeader { text: "SPEED"; foreground: panel.fg; fontFamily: panel.fontFamily }
    PanelSlider {
      width: parent.width
      bar: panel.bar
      minimum: 0.25; maximum: 3.0; step: 0.05
      value: panel.service ? panel.service.speed : 1.0
      onReleased: function(v) { if (panel.widget) panel.widget.set("speed", v) }
    }

    PanelSectionHeader {
      text: "BLOBS · " + (panel.service ? panel.service.blobCount : 7)
      foreground: panel.fg; fontFamily: panel.fontFamily
    }
    PanelSlider {
      width: parent.width
      bar: panel.bar
      minimum: 3; maximum: 12; step: 1; integer: true
      tickCount: 10
      value: panel.service ? panel.service.blobCount : 7
      onReleased: function(v) { if (panel.widget) panel.widget.set("blobs", Math.round(v)) }
    }

    PanelSectionHeader { text: "SIZE"; foreground: panel.fg; fontFamily: panel.fontFamily }
    PanelSlider {
      width: parent.width
      bar: panel.bar
      minimum: 0.5; maximum: 1.6; step: 0.05
      value: panel.service ? panel.service.blobSize : 1.0
      onReleased: function(v) { if (panel.widget) panel.widget.set("size", v) }
    }

    // ---------- quality ----------
    Dropdown {
      id: qualityDropdown
      width: parent.width
      label: "QUALITY"
      options: panel.qualityOptions
      value: panel.service ? String(panel.service.quality) : "medium"
      onChanged: function(v) { if (panel.widget) panel.widget.set("quality", String(v)) }
    }

    Toggle {
      width: parent.width
      label: "Pause on fullscreen"
      description: "Freeze the lamp while a window is fullscreen on that monitor"
      foreground: panel.fg
      checked: panel.service ? panel.service.pauseOnFullscreen === true : true
      onClicked: if (panel.widget) panel.widget.set("pauseOnFullscreen", !checked)
    }
  }
}
