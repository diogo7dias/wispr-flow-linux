import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Wispr Flow's dictation state, drawn in the bar's own icon language.
//
// State comes from $XDG_RUNTIME_DIR/wispr-flow/status.json, published by the
// app's main bundle (scripts/patches/status-broadcast.cjs in the wispr-flow-linux
// fork). Idle is a hairline; listening follows the microphone level the app
// already computes for its own pill; transcribing is a travelling wave; a click
// copies the last transcription.
BarWidget {
  id: root
  moduleName: "ddm.wispr"

  readonly property string statusPath: Quickshell.env("XDG_RUNTIME_DIR") + "/wispr-flow/status.json"
  readonly property real gain: Math.max(0.5, Math.min(4, Number(setting("gain", 2.2)) || 2.2))
  readonly property bool showIdle: setting("showIdle", true) !== false
  readonly property int slot: 16
  readonly property int barWidth: 2
  readonly property var shape: [0.45, 0.8, 1.0, 0.8, 0.45]

  property string state: "idle"
  property real level: 0
  property string text: ""
  property var pasted: null
  property real pulse: 0
  property bool copied: false

  readonly property bool listening: state === "listening"
  readonly property bool transcribing: state === "transcribing"
  readonly property bool running: listening || transcribing
  readonly property bool failed: state === "error" || pasted === false
  readonly property color tone: failed ? Color.urgent
    : (copied || running ? Color.accent : button.foreground)

  // The smoothed, exaggerated level the bars follow.
  readonly property real shown: {
    var scaled = level * gain
    if (scaled > 1) scaled = 1
    return Math.pow(scaled, 0.7)
  }

  // The app hands the helper a boundary space it needs for pasting; the
  // clipboard copy and the tooltip both want the sentence itself.
  readonly property string clipboardText: String(text).trim()

  readonly property string preview: {
    var trimmed = clipboardText.replace(/\s+/g, " ")
    return trimmed.length <= 60 ? trimmed : trimmed.slice(0, 59) + "…"
  }

  readonly property string tip: {
    if (copied) return text ? "Wispr Flow — copied to clipboard" : "Wispr Flow — nothing to copy"
    if (listening) return "Wispr Flow — listening"
    if (transcribing) return "Wispr Flow — transcribing"
    if (state === "error") return "Wispr Flow — error"
    if (preview) return "Wispr Flow — click to copy: " + preview
    return "Wispr Flow — idle"
  }

  function apply(raw) {
    var parsed
    try {
      parsed = JSON.parse(String(raw))
    } catch (error) {
      return
    }
    if (!parsed || typeof parsed !== "object") return
    if (typeof parsed.state === "string") root.state = parsed.state
    if (typeof parsed.level === "number" && isFinite(parsed.level))
      root.level = Math.max(0, Math.min(1, parsed.level))
    if (typeof parsed.text === "string") root.text = parsed.text
    root.pasted = (parsed.pasted === true || parsed.pasted === false) ? parsed.pasted : null
  }

  function copy() {
    if (!root.clipboardText) return
    if (root.bar) root.bar.hideTooltip(root)
    Quickshell.execDetached(["bash", "-c", "printf %s " + Util.shellQuote(root.clipboardText) + " | wl-copy"])
    root.copied = true
    copiedTimer.restart()
  }

  visible: showIdle || running || preview !== "" || failed
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Drives the transcribing wave; only runs while Flow is working.
  NumberAnimation on pulse {
    running: root.transcribing
    loops: Animation.Infinite
    from: 0
    to: 1
    duration: 900
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    slotSize: Style.bar.statusSlot
    text: ""
    tooltipText: root.tip
    iconComponent: visuals
    onPressed: function(b) {
      if (b === Qt.LeftButton) root.copy()
    }
  }

  Component {
    id: visuals

    Item {
      id: canvas
      anchors.fill: parent

      // Idle: a hairline. Nothing else in the slot moves until Flow does.
      Rectangle {
        visible: !root.running && !root.copied
        anchors.centerIn: parent
        width: Math.round(root.slot * 0.75)
        height: 1.5
        radius: height / 2
        color: root.tone
        opacity: root.failed ? 0.9 : (button.tooltipHovered ? 0.85 : 0.55)

        Behavior on opacity {
          NumberAnimation { duration: 120; easing.type: Easing.OutCubic }
        }
        Behavior on color {
          ColorAnimation { duration: 140 }
        }
      }

      // Listening and transcribing: five columns inside the same footprint as
      // the bar's other glyphs.
      Row {
        visible: root.running
        anchors.centerIn: parent
        spacing: (root.slot - 5 * root.barWidth) / 4

        Repeater {
          model: 5

          Item {
            width: root.barWidth
            height: root.slot

            Rectangle {
              anchors.centerIn: parent
              width: root.barWidth
              radius: root.barWidth / 2
              color: root.tone
              height: {
                if (root.listening) return Math.max(2, 2 + 12 * root.shown * root.shape[index])
                // Transcribing: a wave travelling left to right, always moving.
                var phase = (root.pulse + index / 5) % 1
                var wave = 1 - Math.abs(phase * 2 - 1)
                return Math.max(2, 2 + 13 * (0.25 + 0.75 * wave))
              }

              Behavior on height {
                enabled: root.listening
                NumberAnimation { duration: 90; easing.type: Easing.OutCubic }
              }
              Behavior on color {
                ColorAnimation { duration: 140 }
              }
            }
          }
        }
      }

      // Click confirmation: the slot acknowledges before it fades back.
      Text {
        anchors.centerIn: parent
        visible: root.copied
        text: root.text ? "󰄬" : "󰅖"
        color: root.tone
        font.family: button.fontFamily
        font.pixelSize: Style.bar.iconFont
        renderType: Text.NativeRendering
      }
    }
  }

  Timer {
    id: copiedTimer
    interval: 900
    repeat: false
    onTriggered: root.copied = false
  }

  // The app replaces the file by rename, which a path watcher only sees once,
  // so poll it directly: briskly while Flow is working, gently when idle.
  FileView {
    id: statusFile
    path: root.statusPath
    watchChanges: false
    printErrors: false
    onLoaded: root.apply(text())
  }

  Timer {
    interval: root.running ? 60 : 400
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: statusFile.reload()
  }
}