// Numeric microphone events only. No audio capture, transcript access, or logging.
(() => {
 const start = () => {
  if (!window.electron?.ipc || window.__wisprVoiceBars) return;
  window.__wisprVoiceBars = true;
  let target = 0, level = 0, lastEvent = -Infinity, lastFrame = 0, frame = 0;
  const history = [];
  const touched = new Set();
  const reset = () => {
   for (const element of touched) {
    element.style.removeProperty('transform');
    element.style.removeProperty('animation');
   }
   touched.clear(); history.length = 0;
  };
  const draw = now => {
   frame = 0;
   const dt = Math.min(64, lastFrame ? now - lastFrame : 16);
   lastFrame = now;
   const desired = now - lastEvent < 350 ? target : 0;
   level += (desired - level) * (1 - Math.exp(-dt / (desired > level ? 35 : 140)));
   history.push([now, level]);
   while (history.length && history[0][0] < now - 250) history.shift();
   const bars = [...document.querySelectorAll('[style*="--bar-height-scale"]')]
    .filter(el => el.getBoundingClientRect().width > 0);
   const side = document.querySelector('[data-bar-position="left"], [data-bar-position="right"]');
   bars.forEach((bar, index) => {
    const distance = Math.abs(index - (bars.length - 1) / 2);
    const time = now - distance * 18;
    const sample = history.find(item => item[0] >= time)?.[1] ?? level;
    const shape = Math.max(.45, 1 - distance * .09);
    bar.style.setProperty('animation', 'none', 'important');
    bar.style.setProperty('transform', `scale${side ? 'X' : 'Y'}(${1 + 6 * sample * shape})`, 'important');
    touched.add(bar);
   });
   if (desired === 0 && level < .002) {
    level = 0; reset(); lastFrame = 0; return;
   }
   frame = requestAnimationFrame(draw);
  };
  const subscription = window.electron.ipc.on('status:audioLevel', value => {
   if (!Number.isFinite(value)) return;
   // The incoming display range is -55 to -5 dBFS. Suppress room noise.
   target = Math.max(0, Math.min(1, (value - .22) / .58));
   lastEvent = performance.now();
   if (!frame && (target > 0 || level > 0)) frame = requestAnimationFrame(draw);
  });
  window.addEventListener('unload', () => {
   cancelAnimationFrame(frame);
   window.electron.ipc.off('status:audioLevel', subscription);
   reset();
  }, {once:true});
 };
 if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
 else start();
})();
