import QtQuick
import QtQuick.Shapes
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Wispr Flow's dictation state, drawn in the bar's own icon language.
//
// State comes from $XDG_RUNTIME_DIR/wispr-flow/status.json, published by the
// app's main bundle (scripts/patches/status-broadcast.cjs in the wispr-flow-linux
// fork). Idle reads Wispr; listening is five columns travelling; transcribing
// is a rotating circle; a click copies the last transcription.
//
// The app's published level is not usable as an amplitude: measured on this
// machine it sits at 1.0 whether the room is silent or loud, which pinned the
// bars at full height and read as a still image. Motion is therefore drawn on a
// timer, and the level only nudges the size, so the slot always looks alive
// while Flow is working.
BarWidget {
  id: root
  moduleName: "ddm.wispr"

  readonly property string statusPath: Quickshell.env("XDG_RUNTIME_DIR") + "/wispr-flow/status.json"
  readonly property real gain: Math.max(0.5, Math.min(4, Number(setting("gain", 2.2)) || 2.2))
  readonly property bool showIdle: setting("showIdle", true) !== false
  readonly property int slot: 16
  readonly property int barWidth: 2
  readonly property int barCount: 5
  readonly property var shape: [0.55, 0.85, 1.0, 0.85, 0.55]

  property string state: "idle"
  property real level: 0
  property string text: ""
  property var pasted: null
  property real wavePhase: 0
  property bool copied: false

  readonly property bool listening: state === "listening"
  readonly property bool transcribing: state === "transcribing"
  readonly property bool running: listening || transcribing
  readonly property bool failed: state === "error" || pasted === false
  readonly property color tone: failed ? Color.urgent
    : (copied || running ? Color.accent : button.foreground)

  // Ever only a nudge: 0.6 travel when the level says nothing, full when it does.
  readonly property real amplitude: 0.6 + 0.4 * Math.max(0, Math.min(1, level * gain))

  // The phase is stepped by a timer rather than a NumberAnimation: the bars are
  // bound through a helper property, and an animation on the property left them
  // frozen at their start height in practice. Twenty steps of 32 ms is one
  // 640 ms pass.
  readonly property real waveStep: 0.05

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

  // Drives the listening travel: short enough to read as movement, long enough
  // not to flicker at icon size.
  Timer {
    interval: 32
    running: root.listening
    repeat: true
    onTriggered: root.wavePhase = (root.wavePhase + root.waveStep) % 1
  }

  TextMetrics {
    id: idleLabelMetrics
    text: "Wispr"
    font.family: button.fontFamily
    font.pixelSize: Style.font.body
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    slotSize: Math.max(Style.bar.statusSlot,
      Math.ceil(idleLabelMetrics.width) + scaledHorizontalMargin * 2)
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

      Text {
        visible: !root.running && !root.copied
        anchors.centerIn: parent
        text: "Wispr"
        color: root.tone
        font: idleLabelMetrics.font
        renderType: Text.NativeRendering

        Behavior on color {
          ColorAnimation { duration: 140 }
        }
      }

      // Listening: five columns with a wave travelling across them.
      Row {
        visible: root.listening
        anchors.centerIn: parent
        spacing: (root.slot - root.barCount * root.barWidth) / (root.barCount - 1)

        Repeater {
          model: root.barCount

          Item {
            width: root.barWidth
            height: root.slot

            // Per-bar so the height binding depends on wavePhase directly,
            // instead of through a helper function.
            property real travel: {
              var phase = (root.wavePhase + index * 0.14) % 1
              if (phase < 0) phase += 1
              return 1 - Math.abs(phase * 2 - 1)
            }

            Rectangle {
              anchors.centerIn: parent
              width: root.barWidth
              radius: root.barWidth / 2
              color: root.tone
              height: Math.max(2.5,
                2.5 + 12 * travel * root.shape[index] * root.amplitude)

              Behavior on height {
                NumberAnimation { duration: 70; easing.type: Easing.OutCubic }
              }
              Behavior on color {
                ColorAnimation { duration: 140 }
              }
            }
          }
        }
      }

      // Transcribing: a ring with a gap, spinning.
      Shape {
        id: spinner
        visible: root.transcribing
        anchors.centerIn: parent
        width: 15
        height: 15

        ShapePath {
          strokeColor: root.tone
          strokeWidth: 2
          fillColor: "transparent"
          capStyle: ShapePath.RoundCap

          PathAngleArc {
            centerX: spinner.width / 2
            centerY: spinner.height / 2
            radiusX: spinner.width / 2 - 1
            radiusY: spinner.height / 2 - 1
            startAngle: 0
            sweepAngle: 275
          }
        }

        NumberAnimation on rotation {
          running: root.transcribing
          loops: Animation.Infinite
          from: 0
          to: 360
          duration: 850
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