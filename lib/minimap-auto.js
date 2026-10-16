'use strict';

const fs = require('fs'), path = require('path'), cp = require('child_process');
const patch = require('./minimap-patch');
const FILE = 'c7a706fb_301.gpk';
const DEFAULT_DATA = path.resolve(__dirname, '..', 'data');
function check(ok, text) { if (!ok) throw new Error(text); }
function key(file) { return path.resolve(file).toLowerCase(); }
function read(dataDir) {
  const file = path.join(dataDir, 'minimap-auto.json');
  if (!fs.existsSync(file)) return { version: 1, clients: [] };
  check(fs.statSync(file).size <= 65536, 'Invalid minimap automatic setup record size.');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(value && value.version === 1 && Array.isArray(value.clients) && value.clients.length <= 16,
    'Invalid minimap automatic setup record.');
  const seen = new Set();
  for (const entry of value.clients) {
    check(entry && typeof entry.target === 'string' && entry.target.length < 4096 && path.isAbsolute(entry.target) &&
      path.basename(entry.target).toLowerCase() === FILE && typeof entry.enabled === 'boolean' && !seen.has(key(entry.target)),
    'Invalid minimap client record.');
    seen.add(key(entry.target));
  }
  return value;
}
function setEnabled(target, enabled, dataDir = DEFAULT_DATA) {
  check(typeof enabled === 'boolean', 'Invalid automatic setup preference.');
  const canonical = patch.resolveTarget(target), value = read(dataDir);
  const found = value.clients.find(entry => key(entry.target) === key(canonical));
  if (found && found.enabled === enabled) return;
  check(found || value.clients.length < 16, 'Minimap automatic setup client list is full.');
  if (found) found.enabled = enabled;
  else value.clients.push({ target: canonical, enabled });
  fs.mkdirSync(dataDir, { recursive: true });
  patch.atomic(path.join(dataDir, 'minimap-auto.json'), Buffer.from(JSON.stringify(value, null, 2) + '\n'));
}
function remember(target, dataDir) {
  const value = read(dataDir);
  const found = value.clients.find(entry => key(entry.target) === key(target));
  // An explicit Restore disables this client; discovering it again must not re-enable it.
  if (!found) setEnabled(target, true, dataDir);
  return !found || found.enabled;
}

// The only allowed running TERA is the exact fresh client held by Toolbox's install callback.
// Existing sessions never call install(); protocolVersion/ready provide an additional refusal.
const GUARD = [
  "$ErrorActionPreference='Stop'",
  "$games=@(Get-CimInstance Win32_Process -Filter \"Name='TERA.exe'\")",
  "if($env:CEM_MAP_MODE -eq 'fresh'){",
  "if($games.Count -ne 1){throw 'Another game is running, or the fresh client exited.'}",
  "$game=$games[0]",
  "if($game.ProcessId -ne [int]$env:CEM_MAP_PID -or !$game.ExecutablePath){throw 'Client identity could not be verified.'}",
  "$exe=[System.IO.Path]::GetFullPath($game.ExecutablePath)",
  "$bin=[System.IO.Path]::GetFullPath($env:CEM_MAP_BIN).TrimEnd([char]92)+[char]92",
  "$root=[System.IO.Path]::GetFullPath($env:CEM_MAP_ROOT).TrimEnd([char]92)+[char]92+'Binaries'+[char]92",
  "if(!$exe.StartsWith($bin,[System.StringComparison]::OrdinalIgnoreCase) -or !$exe.StartsWith($root,[System.StringComparison]::OrdinalIgnoreCase)){throw 'The process belongs to a different client.'}",
  "}elseif($games.Count){throw 'Close the game before startup installation.'}",
  "$f=[System.IO.File]::Open($env:CEM_MAP_TARGET,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)",
  "$f.Dispose()"
].join(';');
function guard(target, context, spawn = cp.spawnSync) {
  check(process.platform === 'win32', 'Automatic minimap setup requires Windows.');
  const fresh = context && context.mode === 'fresh';
  if (fresh) check(Number.isSafeInteger(context.pid) && context.pid > 0 && typeof context.bin === 'string' &&
    path.isAbsolute(context.bin) && !context.isReady(), 'The client has already started or has an invalid identity.');
  else check(context && context.mode === 'startup', 'No safe installation window.');
  const result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', GUARD], {
    windowsHide: true, encoding: 'utf8', timeout: 6000, maxBuffer: 131072,
    env: { ...process.env, CEM_MAP_MODE: context.mode, CEM_MAP_PID: fresh ? String(context.pid) : '',
      CEM_MAP_BIN: fresh ? context.bin : '', CEM_MAP_ROOT: path.dirname(path.dirname(path.dirname(target))),
      CEM_MAP_TARGET: target }
  });
  check(!result.error && result.status === 0, 'No safe minimap installation window; the resource must be writable and unused. It will be retried at a later safe startup.');
  if (fresh) check(!context.isReady(), 'The game has already started. Minimap setup deferred.');
}

function createService(mod, options = {}) {
  const dataDir = options.dataDir || path.join(mod.info.path, 'data');
  const run = options.operate || patch.operate, safe = options.guard || guard;
  const reported = new Set();
  function report(target, message, warning) {
    const id = key(target) + ':' + message;
    if (reported.has(id)) return;
    reported.add(id);
    try { (warning ? mod.warn : mod.log).call(mod, 'Minimap [' + target + ']: ' + message); } catch (_) {}
  }
  function install(target, context) {
    try {
      const canonical = patch.resolveTarget(target);
      if (!remember(canonical, dataDir)) return { changed: false, status: 'automatic setup disabled' };
      // operate refuses unrecognized resource bytes before guard/write and no-ops on the exact installed fix.
      const result = run(canonical, 'install', { dataDir, guard: file => safe(file, context),
        beforeReplace: file => safe(file, context) });
      report(canonical, result.status, false);
      return result;
    } catch (error) {
      report(target, error.message, true);
      return { changed: false, status: 'deferred or unsupported' };
    }
  }
  return {
    startup() {
      try { for (const entry of read(dataDir).clients) if (entry.enabled) install(entry.target, { mode: 'startup' }); }
      catch (error) { report(path.join(dataDir, 'minimap-auto.json'), error.message, true); }
    },
    observe(info) {
      try {
        check(info && typeof info.path === 'string' && path.isAbsolute(info.path), 'The client did not supply a valid game path.');
        const target = patch.resolveTarget(info.path);
        remember(target, dataDir);
        return target;
      } catch (error) { report(mod.info.path, error.message, true); return null; }
    },
    install
  };
}
function GlobalMod(mod) {
  this.minimap = createService(mod);
  this.minimap.startup();
}
function ClientMod(mod) {
  const client = mod.clientInterface;
  let ready = !!(client && client.info && client.info.protocolVersion != null), attempted = false;
  const onReady = () => { ready = true; };
  if (client) client.on('ready', onReady);
  let service;
  try { service = mod.globalMod.minimap; } catch (_) {}
  const target = service && service.observe(client && client.info);
  this.install = () => {
    // Called by Toolbox only for a newly spawned, suspended client. Never on hot reload or attachment.
    if (!target || attempted || ready || !client || client.info.protocolVersion != null) return;
    attempted = true;
    service.install(target, { mode: 'fresh', pid: client.info.pid, bin: client.info.path,
      isReady: () => ready || client.info.protocolVersion != null });
  };
  this.destructor = () => { ready = true; if (client) client.removeListener('ready', onReady); };
}

module.exports = { GlobalMod, ClientMod, createService, guard, read, setEnabled };
