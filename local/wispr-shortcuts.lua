-- Flow receives only these compositor actions, not general key events.
-- The global dispatcher forwards both press and release; no release bind.
o.bind("Alt_L", "Wispr Flow dictate", hl.dsp.global("wispr-flow:dictate"),
  { non_consuming = true, ignore_mods = true })
o.bind("Escape", "Wispr Flow cancel", hl.dsp.global("wispr-flow:cancel"),
  { non_consuming = true })
