//! Hyprland delivers only explicitly bound actions, never ordinary keystrokes.
use super::{emit_keypress, HeldKeys};
use crate::backend::EventSink;
use std::collections::HashSet;
use std::sync::{atomic::AtomicU64, Arc, Mutex};
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::wl_registry::WlRegistry;
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols_hyprland::global_shortcuts::v1::client::{
    hyprland_global_shortcut_v1::{Event, HyprlandGlobalShortcutV1},
    hyprland_global_shortcuts_manager_v1::HyprlandGlobalShortcutsManagerV1,
};

pub fn enabled() -> bool {
    std::env::var("WISPR_SHORTCUT_ONLY").as_deref() == Ok("1")
}

struct State {
    events: EventSink,
    held: Arc<Mutex<HashSet<u32>>>,
    index: AtomicU64,
}

fn transition(held: &mut HashSet<u32>, key: u32, pressed: bool) -> bool {
    if pressed {
        held.insert(key)
    } else {
        held.remove(&key)
    }
}

impl State {
    fn key(&self, key: u32, pressed: bool) {
        if transition(&mut self.held.lock().unwrap(), key, pressed) {
            emit_keypress(&self.events, &self.index, std::process::id(), key, pressed);
        }
    }
    fn release_all(&self) {
        let keys: Vec<_> = self.held.lock().unwrap().iter().copied().collect();
        for key in keys {
            self.key(key, false);
        }
    }
}

impl Dispatch<WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: wayland_client::protocol::wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<HyprlandGlobalShortcutsManagerV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &HyprlandGlobalShortcutsManagerV1,
        _: wayland_protocols_hyprland::global_shortcuts::v1::client::hyprland_global_shortcuts_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<HyprlandGlobalShortcutV1, u32> for State {
    fn event(
        state: &mut Self,
        _: &HyprlandGlobalShortcutV1,
        event: Event,
        key: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            Event::Pressed { .. } => state.key(*key, true),
            Event::Released { .. } => state.key(*key, false),
            _ => {}
        }
    }
}

struct ShortcutHeld(Arc<Mutex<HashSet<u32>>>);
impl HeldKeys for ShortcutHeld {
    fn held_vks(&self) -> HashSet<u32> {
        self.0.lock().unwrap().clone()
    }
}

pub fn start(events: EventSink) -> Result<Box<dyn HeldKeys>, String> {
    let conn = Connection::connect_to_env().map_err(|e| e.to_string())?;
    let (globals, mut queue) = registry_queue_init::<State>(&conn).map_err(|e| e.to_string())?;
    let qh = queue.handle();
    let manager: HyprlandGlobalShortcutsManagerV1 =
        globals.bind(&qh, 1..=1, ()).map_err(|e| e.to_string())?;
    let dictate = manager.register_shortcut(
        "dictate".into(),
        "wispr-flow".into(),
        "Dictate".into(),
        "Left Alt".into(),
        &qh,
        164,
    );
    let cancel = manager.register_shortcut(
        "cancel".into(),
        "wispr-flow".into(),
        "Cancel dictation".into(),
        "Escape".into(),
        &qh,
        27,
    );
    let held = Arc::new(Mutex::new(HashSet::new()));
    let mut state = State {
        events,
        held: held.clone(),
        index: AtomicU64::new(0),
    };
    queue.roundtrip(&mut state).map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("compositor-shortcuts".into())
        .spawn(move || {
            let _objects = (manager, dictate, cancel);
            while queue.blocking_dispatch(&mut state).is_ok() {}
            state.release_all();
            log::error!("compositor shortcut connection ended; raw capture remains disabled");
        })
        .map_err(|e| e.to_string())?;
    log::info!("key capture: compositor shortcuts only (no raw keyboard reads)");
    Ok(Box::new(ShortcutHeld(held)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_edges_are_ignored_and_release_clears_held_state() {
        let mut held = HashSet::new();
        assert!(transition(&mut held, 164, true));
        assert!(!transition(&mut held, 164, true));
        assert!(transition(&mut held, 164, false));
        assert!(!transition(&mut held, 164, false));
        assert!(held.is_empty());
    }
    #[test]
    fn disconnect_emits_release_for_each_held_shortcut() {
        let (tx, rx) = std::sync::mpsc::channel();
        let state = State {
            events: tx,
            held: Arc::new(Mutex::new(HashSet::new())),
            index: AtomicU64::new(0),
        };
        state.key(164, true);
        state.release_all();
        assert!(state.held.lock().unwrap().is_empty());
        assert_eq!(rx.try_iter().count(), 2);
    }

    #[test]
    #[ignore = "requires Hyprland Flow bindings; sends one Alt press/release to the test client"]
    fn compositor_delivers_both_edges_for_alt_binding() {
        let (tx, rx) = std::sync::mpsc::channel();
        let held = start(tx).unwrap();
        let mut keyboard =
            crate::backend::uinput::UInput::create_named(b"Wispr shortcut test").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(700));
        keyboard.key(56, true).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(80));
        keyboard.key(56, false).unwrap();
        let press = rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
        let release = rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
        assert_eq!(
            press["HelperAPIRequest"]["KeypressEvent"]["payload"]["eventType"],
            "key_event_press"
        );
        assert_eq!(
            release["HelperAPIRequest"]["KeypressEvent"]["payload"]["eventType"],
            "key_event_release"
        );
        assert!(held.held_vks().is_empty());
    }
}
