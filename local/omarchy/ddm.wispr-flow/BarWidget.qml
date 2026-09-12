import QtQuick
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "ddm.wispr-flow"
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰍬"
    slotSize: Style.bar.statusSlot
    tooltipText: "Wispr Flow — open dashboard"
    onPressed: function(b) {
      if (b === Qt.LeftButton && root.bar)
        root.bar.run("/home/ddm/.local/bin/wispr-flow --show-hub")
    }
  }
}
