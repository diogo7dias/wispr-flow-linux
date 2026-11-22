#!/usr/bin/env node
'use strict';
// Local AppDir transactions. No downloads, privilege changes, or profile writes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {spawn, spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const lib = 'usr/lib/wispr-flow';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const startupFailed = text =>
  /Error initializing media recorder|Uncaught SyntaxError|Cannot find module/.test(text);

function inspectTree(root) {
  const rows = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), st = fs.lstatSync(file);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()))
        throw Error('AppDir must contain only regular files and directories');
      if (st.mode & 0o6000) throw Error('Setuid/setgid files are forbidden');
      if (st.isDirectory()) walk(file);
      else rows.push([path.relative(root, file), st.mode & 0o777,
        createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    }
  }
  if (!fs.lstatSync(root).isDirectory()) throw Error('Expected a real AppDir');
  walk(root);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function validate(root) {
  const digest = inspectTree(root);
  const base = path.join(root, lib), resources = path.join(base, 'resources');
  for (const name of ['wispr-flow', 'resources/Release/wispr-flow-linux-helper',
    'resources/app.asar.unpacked/.webpack/main/native_modules/build/Release/better_sqlite3.node',
    'resources/app.asar.unpacked/.webpack/main/native_modules/build/Release/node_sqlite3.node']) {
    const file = path.join(base, name);
    if (!fs.readFileSync(file).subarray(0, 4).equals(Buffer.from([127,69,76,70])))
      throw Error('Non-Linux binary: ' + name);
    if (!name.endsWith('.node')) fs.accessSync(file, fs.constants.X_OK);
  }
  for (const name of ['launcher-common.sh', 'doctor.sh']) {
    if (spawnSync('bash', ['-n', path.join(base, name)]).status !== 0)
      throw Error('Invalid launcher: ' + name);
  }
  const archive = path.join(resources, 'app.asar');
  if (spawnSync('bash', [path.join(__dirname, 'verify-patches.sh'), archive],
    {stdio: 'pipe'}).status !== 0) throw Error('Linux patch verification failed');
  // ASAR pickle header: uint32 payload length at 4, JSON length at 12.
  const bytes = fs.readFileSync(archive);
  const start = 8 + bytes.readUInt32LE(4), length = bytes.readUInt32LE(12);
  if (start > bytes.length || length > start - 16) throw Error('Invalid ASAR header');
  const header = JSON.parse(bytes.subarray(16, 16 + length).toString());
  function visit(files, prefix = '') {
    for (const [name, entry] of Object.entries(files)) {
      if (!name || name === '..' || name.includes('/') || name.includes('\\'))
        throw Error('Unsafe ASAR path');
      const rel = prefix + name;
      if (entry.files) { visit(entry.files, rel + '/'); continue; }
      if (entry.link) throw Error('ASAR links require review');
      let data;
      if (entry.unpacked) data = fs.readFileSync(path.join(archive + '.unpacked', rel));
      else {
        const offset = Number(entry.offset), size = entry.size;
        if (!Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(size) || size < 0 || start + offset + size > bytes.length)
          throw Error('Invalid ASAR entry');
        data = bytes.subarray(start + offset, start + offset + size);
      }
      if (data.length !== entry.size) throw Error('ASAR entry size mismatch');
      if (['.webpack/main/index.js', '.webpack/renderer/hub/index.js',
        '.webpack/renderer/status/index.js'].includes(rel)) new vm.Script(data.toString());
    }
  }
  visit(header.files);
  return digest;
}

function assertStopped(root) {
  for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    let exe;
    try { exe = fs.readlinkSync('/proc/' + pid + '/exe'); } catch { continue; }
    if (exe.startsWith(root + path.sep))
      throw Error('Quit Wispr Flow completely before updating or recovering');
  }
}

function preflight() {
  for (const tool of ['xvfb-run', 'dbus-run-session']) {
    if (spawnSync('which', [tool], {stdio:'ignore'}).status !== 0)
      throw Error('Required startup-check tool missing: ' + tool);
  }
}

async function smoke(root, privateDir) {
  fs.mkdirSync(privateDir, {mode: 0o700});
  const log = path.join(privateDir, 'startup.log');
  const fd = fs.openSync(log, 'wx', 0o600);
  // Fresh profile and private display/bus; never use the logged-in profile.
  const env = {...process.env, XDG_CONFIG_HOME: path.join(privateDir, 'config'),
    XDG_CACHE_HOME: path.join(privateDir, 'cache'),
    XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: '',
    ELECTRON_FORCE_IS_PACKAGED: 'true'};
  for (const key of ['WAYLAND_DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE',
    'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = spawn('xvfb-run', ['-a', 'dbus-run-session', '--',
    path.join(root, lib, 'wispr-flow'), '--disable-setuid-sandbox',
    '--enable-sandbox', '--use-angle=gl', '--force-device-scale-factor=1',
    '--ozone-platform=x11', '--user-data-dir=' + path.join(privateDir, 'profile')],
    {env, detached: true, stdio: ['ignore', fd, fd]});
  fs.closeSync(fd);
  let failed = false;
  child.on('error', () => { failed = true; });
  let readySince = 0;
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (failed || child.exitCode !== null || child.signalCode !== null) break;
      const text = fs.readFileSync(log, 'utf8');
      // A server returning HTML instead of JSON also logs SyntaxError; that
      // is not a JavaScript startup failure. Bundle syntax is checked above.
      if (startupFailed(text)) break;
      if (text.includes('Helper service is ready: true')) {
        if (!readySince) readySince = Date.now();
        if (Date.now() - readySince >= 3000) return;
      }
      await sleep(250);
    }
    throw Error('Startup check failed; private diagnostics: ' + log);
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await sleep(1000);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      // Reaping is asynchronous. Do not race the transaction's stopped guard.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { assertStopped(root); break; } catch { await sleep(100); }
      }
    }
  }
}

// Kept separate so transaction failures can be tested without executing Flow.
async function transaction(root, candidate, hooks) {
  hooks.stopped(root);
  const initial = hooks.validate(candidate);
  hooks.preflight();
  inspectTree(path.join(root, 'AppDir'));
  const tx = fs.mkdtempSync(path.join(root, '.update-'));
  const current = path.join(root, 'AppDir');
  const previous = path.join(tx, 'previous');
  const stage = path.join(tx, 'candidate');
  fs.cpSync(candidate, stage, {recursive: true});
  if (hooks.validate(stage) !== initial) throw Error('Candidate changed during staging');
  hooks.stopped(root);
  // Journal is written BEFORE the first rename. Interrupted transactions are
  // refused on the next update until explicit recovery, never guessed away.
  fs.writeFileSync(path.join(root, 'pending-update'), path.basename(tx), {flag:'wx', mode:0o600});
  try {
    fs.renameSync(current, previous);
    fs.renameSync(stage, current);
    await hooks.smoke(current, path.join(tx, 'smoke'));
    hooks.stopped(root);
    fs.unlinkSync(path.join(root, 'pending-update'));
    return tx;
  } catch (error) {
    recover(root, hooks.stopped);
    throw error;
  }
}

function recover(root, stopped = assertStopped) {
  stopped(root);
  const journal = path.join(root, 'pending-update');
  const name = fs.readFileSync(journal, 'utf8');
  if (!/^\.update-[A-Za-z0-9]+$/.test(name)) throw Error('Invalid recovery journal');
  const tx = path.join(root, name), current = path.join(root, 'AppDir');
  const previous = path.join(tx, 'previous');
  if (fs.existsSync(previous)) {
    if (fs.existsSync(current)) fs.renameSync(current, path.join(tx, 'rejected'));
    fs.renameSync(previous, current);
  } else if (!fs.existsSync(current)) throw Error('Recovery needs manual inspection');
  fs.unlinkSync(journal);
}

async function main() {
  const [command, candidate, extra] = process.argv.slice(2);
  const root = path.join(os.homedir(), '.local/share/wispr-flow');
  if (extra || !['check', 'install', 'recover', 'rollback'].includes(command) ||
    (command === 'recover' ? candidate : !candidate))
    throw Error('Usage: safe-update.cjs check|install <AppDir> | recover | rollback <.update-ID>');
  if (command === 'check') {
    console.log('Static checks passed. SHA-256 tree: ' + validate(path.resolve(candidate)));
    preflight();
    console.log('Startup-check dependencies available (app not launched).');
    return;
  }
  // Kernel-held lock is released even if the updater is killed.
  if (!process.env.WISPR_UPDATE_LOCKED) {
    const result = spawnSync('flock', ['-n', path.join(root, '.update.lock'),
      process.execPath, __filename, ...process.argv.slice(2)],
      {stdio:'inherit', env:{...process.env, WISPR_UPDATE_LOCKED:'1'}});
    process.exitCode = result.status ?? 1;
    return;
  }
  if (command === 'recover') { recover(root); console.log('Previous installation restored.'); return; }
  if (fs.existsSync(path.join(root, 'pending-update')))
    throw Error('Interrupted update: quit Flow and run recover first');
  if (command === 'rollback') {
    assertStopped(root);
    if (!/^\.update-[A-Za-z0-9]+$/.test(candidate)) throw Error('Invalid backup ID');
    const previous = path.join(root, candidate, 'previous');
    inspectTree(previous);
    fs.writeFileSync(path.join(root, 'pending-update'), candidate, {flag:'wx', mode:0o600});
    recover(root);
    console.log('Previous AppDir restored; account data was not changed.');
    return;
  }
  const source = fs.realpathSync(candidate);
  if (source === root || source.startsWith(root + path.sep) || root.startsWith(source + path.sep))
    throw Error('Candidate must be outside the installation directory');
  const tx = await transaction(root, source, {stopped:assertStopped, validate, preflight, smoke});
  console.log('Update accepted; previous AppDir retained in ' + tx + '/previous');
  console.log('Start Wispr Flow normally. Account/profile compatibility is not tested.');
}
module.exports = {inspectTree, validate, transaction, recover, assertStopped,
  preflight, smoke, startupFailed};
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
