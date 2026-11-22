// Serialized device refreshes, using Flow's own selection/disconnect handling.
function installAudioRefresh(media, env) {
  // Call injected timer functions without rebinding their receiver to env.
  const {setTimeout, clearTimeout, setInterval, clearInterval} = env;
  let disposed = false, running = false, pending = false, timer = null;
  let lastTick = env.now();
  async function run() {
    timer = null;
    if (disposed || running || !pending) return;
    pending = false;
    running = true;
    try { await media.handleDeviceChange(); }
    catch { env.warn('Linux audio device refresh failed'); }
    finally {
      running = false;
      if (pending && !disposed) schedule();
    }
  }
  function schedule() {
    pending = true;
    if (disposed || running) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, 300);
  }
  const interval = setInterval(() => {
    const now = env.now();
    // A delayed renderer timer is a wake/stall hint, not proof of suspend.
    // Refresh device selection only: never restart recordings or the helper.
    if (now - lastTick > 15000 || now < lastTick) schedule();
    lastTick = now;
  }, 5000);
  return {
    changed: schedule,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      clearInterval(interval);
    },
  };
}
module.exports = installAudioRefresh;
