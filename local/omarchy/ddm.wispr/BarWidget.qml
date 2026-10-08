import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Dictation state comes from the app's status bridge. Listening uses signal
// code; processing uses rune shuffle. Idle returns to Wispr; click to copy.
BarWidget {
  id: root
  moduleName: "ddm.wispr"

  readonly property string statusPath: Quickshell.env("XDG_RUNTIME_DIR") + "/wispr-flow/status.json"
  readonly property bool showIdle: setting("showIdle", true) !== false
  property string state: "idle"
  property string text: ""
  property var pasted: null
  property real animationElapsed: 0
  property real animationLast: 0
  property bool copied: false

  readonly property bool listening: state === "listening"
  readonly property bool transcribing: state === "transcribing"
  readonly property bool running: listening || transcribing
  readonly property bool failed: state === "error" || pasted === false
  readonly property color tone: failed ? Color.urgent
    : (copied || running ? Color.accent : button.foreground)

  readonly property string animatedLabel: {
    if (!running) return "Wispr"
    var base = "Wispr"
    var tick = Math.floor(animationElapsed / 65)
    var phase = (animationElapsed % 1800) / 1800
    var result = ""
    for (var i = 0; i < base.length; i++) {
      if (listening) {
        result += (Math.floor(animationElapsed / 90) + i) % 8 < 5
          ? glyph("·─", tick, i) : base[i]
      } else {
        result += phase > 0.82 ? base[i] : glyph("░▒▓╳╱╲┼╬◈◇", tick, i)
      }
    }
    return result
  }

  function glyph(set, tick, index) {
    return set[Math.abs(Math.floor(Math.sin(tick * 7.17 + index * 12.43) * 10000)) % set.length]
  }

  onStateChanged: {
    animationElapsed = 0
    animationLast = Date.now()
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

  Timer {
    interval: 16
    running: root.running
    repeat: true
    onTriggered: {
      var now = Date.now()
      root.animationElapsed += Math.min(now - root.animationLast, 100)
      root.animationLast = now
    }
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
        visible: !root.copied
        anchors.centerIn: parent
        text: root.animatedLabel
        color: root.tone
        font: idleLabelMetrics.font
        renderType: Text.NativeRendering

        Behavior on color {
          ColorAnimation { duration: 140 }
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