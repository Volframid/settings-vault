'use strict';

const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const PATCHED = '19e305e0edefec2d4d43327c2ee7eec01aaf41acaa901634ec3d88b51fab8e59';
const SOURCES = ['c37ff5b1276f61281d127bb9711e15c6a2287b7fe632b207d266569b72ed338b',
  'e717d512b410dacb02037fe00ba5e10067fe451c83931a1d20867cce8ebde144'];
const FILE = 'c7a706fb_301.gpk', BYTES = 72942214, OFFSET = 6996, MOVIE = 985939;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function requireValue(ok, text) { if (!ok) throw new Error(text); }
function recipe() {
  const file = path.join(__dirname, 'minimap-data.json');
  requireValue(fs.statSync(file).size <= 262144, 'Patch recipe is too large.');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  requireValue(value.version === 1 && value.file === FILE && value.bytes === BYTES && value.movieOffset === OFFSET &&
    value.movieBytes === MOVIE && value.patchedHash === PATCHED && Array.isArray(value.sources) && value.sources.length === 2 &&
    new Set(value.sources.map(s => s.hash)).size === 2 && value.sources.every(s => SOURCES.includes(s.hash)), 'Unsupported patch recipe.');
  return value;
}
function apply(bytes, data) {
  requireValue(Buffer.isBuffer(bytes) && bytes.length === BYTES, 'Unsupported game resource size. No files changed.');
  const current = hash(bytes);
  if (current === PATCHED) return bytes;
  const source = data.sources.find(s => s.hash === current);
  requireValue(source && SOURCES.includes(current), 'This game resource is not a supported Asura build. No files changed.');
  requireValue(Array.isArray(source.ops) && source.ops.length <= 2048, 'Invalid patch operations.');
  const old = bytes.subarray(OFFSET, OFFSET + MOVIE), movie = Buffer.alloc(MOVIE);
  requireValue(hash(old) === source.movieHash, 'Source movie checksum mismatch.');
  let at = 0;
  for (const op of source.ops) {
    let part;
    if (op && Object.keys(op).length === 2 && Number.isInteger(op.copy) && Number.isInteger(op.length)) {
      requireValue(op.copy >= 0 && op.length > 0 && op.copy + op.length <= old.length, 'Invalid copy range.');
      part = old.subarray(op.copy, op.copy + op.length);
    } else {
      requireValue(op && Object.keys(op).length === 1 && typeof op.data === 'string' && op.data.length > 0 &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(op.data), 'Invalid patch bytes.');
      part = Buffer.from(op.data, 'base64');
    }
    requireValue(at + part.length <= MOVIE, 'Patch exceeds movie bounds.');
    part.copy(movie, at); at += part.length;
  }
  requireValue(at === MOVIE && hash(movie) === data.patchedMovieHash, 'Patched movie checksum mismatch.');
  const result = Buffer.from(bytes); movie.copy(result, OFFSET);
  requireValue(hash(result) === PATCHED, 'Patched game checksum mismatch. No files changed.');
  return result;
}
function resolveTarget(input) {
  requireValue(typeof input === 'string' && input.trim().length > 0, 'No game path selected.');
  let root = path.resolve(String(input).trim().replace(/^"|"$/g, ''));
  requireValue(fs.existsSync(root), 'The selected game path does not exist.');
  if (fs.statSync(root).isFile()) {
    if (path.basename(root).toLowerCase() === FILE) return fs.realpathSync(root);
    requireValue(path.basename(root).toLowerCase() === 'tera.exe', 'Select TERA.exe or its game folder.');
    root = path.dirname(root);
  }
  for (let depth = 0; depth < 5; depth++) {
    const candidate = path.join(root, 'S1Game', 'CookedPC', FILE);
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    const parent = path.dirname(root); if (parent === root) break; root = parent;
  }
  throw new Error('Could not find the supported resource under that game folder.');
}
function closedAndUnlocked(target) {
  requireValue(process.platform === 'win32', 'This optional game patch requires Windows.');
  const command = "$ErrorActionPreference='Stop'; $running=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne [int]$env:CEM_MINIMAP_PID -and ($_.Name -in @('TERA.exe','Toolbox.exe','tera-toolbox.exe') -or ($_.Name -in @('electron.exe','node.exe') -and ($_.ExecutablePath -like '*\\Toolbox\\*' -or $_.CommandLine -like '*\\Toolbox\\*') -and $_.CommandLine -notmatch '--type=')) }); if($running.Count){throw 'Close TERA and Toolbox completely before installing or restoring the map patch.'}; $f=[System.IO.File]::Open($env:CEM_MINIMAP_TARGET,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); $f.Dispose()";
  const result = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, encoding: 'utf8',
    env: { ...process.env, CEM_MINIMAP_PID: String(process.pid), CEM_MINIMAP_TARGET: target } });
  requireValue(!result.error && result.status === 0, 'Close TERA and Toolbox completely. The game resource must be writable and unused. No files changed.');
}
function atomic(file, bytes, expected) {
  const temporary = file + '.settings-vault-' + process.pid + '.tmp';
  let descriptor;
  requireValue(!fs.existsSync(temporary), 'A previous temporary file needs inspection; no overwrite attempted.');
  try {
    descriptor = fs.openSync(temporary, 'wx'); fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    if (expected) requireValue(hash(fs.readFileSync(file)) === expected, 'Game resource changed during preparation. No overwrite attempted.');
    requireValue(hash(fs.readFileSync(temporary)) === hash(bytes), 'Temporary file checksum mismatch.');
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function records(file) {
  if (!fs.existsSync(file)) return { version: 1, installs: {} };
  requireValue(fs.statSync(file).size <= 65536, 'Invalid local installation record size.');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  requireValue(data && data.version === 1 && data.installs && typeof data.installs === 'object' && !Array.isArray(data.installs) && Object.keys(data.installs).length <= 16,
    'Invalid local installation record.');
  for (const entry of Object.values(data.installs)) requireValue(entry && SOURCES.includes(entry.originalHash) &&
    entry.patchedHash === PATCHED && entry.backup === 'minimap-original-' + entry.originalHash + '.gpk', 'Invalid local backup record.');
  return data;
}
function operate(target, action, options = {}) {
  requireValue(['install', 'restore', 'status'].includes(action), 'Choose install, restore or status.');
  const data = options.recipe || recipe(), dataDir = options.dataDir || path.resolve(__dirname, '..', 'data');
  requireValue(fs.statSync(target).size === BYTES, 'Unsupported game resource size. No files changed.');
  const bytes = fs.readFileSync(target), current = hash(bytes), recordFile = path.join(dataDir, 'minimap-installations.json');
  if (action === 'status') return { changed: false, status: current === PATCHED ? 'installed' : SOURCES.includes(current) ? 'supported, not installed' : 'unsupported build' };
  if (action === 'install' && current === PATCHED) return { changed: false, status: 'already installed' };
  const saved = records(recordFile), key = path.resolve(target).toLowerCase(), entry = saved.installs[key];
  if (action === 'restore' && entry && current === entry.originalHash) return { changed: false, status: 'already restored' };
  let replacement, backup, fromHash;
  if (action === 'install') {
    replacement = apply(bytes, data); fromHash = current;
    requireValue(entry || Object.keys(saved.installs).length < 16, 'Local installation record is full.');
    backup = path.join(dataDir, 'minimap-original-' + current + '.gpk');
  } else {
    requireValue(entry && current === PATCHED, 'No matching patch backup, or this game file changed. Nothing was restored.');
    backup = path.join(dataDir, entry.backup);
    requireValue(fs.existsSync(backup) && fs.statSync(backup).size === BYTES, 'Original backup is missing or incomplete.');
    replacement = fs.readFileSync(backup); fromHash = PATCHED;
    requireValue(hash(replacement) === entry.originalHash, 'Backup checksum mismatch. Nothing was restored.');
  }
  (options.guard || closedAndUnlocked)(target);
  requireValue(hash(fs.readFileSync(target)) === fromHash, 'Game file changed. No files changed.');
  if (action === 'install') {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(backup)) fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    requireValue(hash(fs.readFileSync(backup)) === current, 'Existing backup is damaged; it was not overwritten.');
    saved.installs[key] = { originalHash: current, patchedHash: PATCHED, backup: path.basename(backup) };
    // Keep recovery information even if replacement or a later metadata write fails.
    atomic(recordFile, Buffer.from(JSON.stringify(saved, null, 2) + '\n'));
  }
  atomic(target, replacement, fromHash);
  requireValue(hash(fs.readFileSync(target)) === hash(replacement), 'Installed resource checksum mismatch. Keep the verified backup.');
  return { changed: true, status: action === 'install' ? 'installed' : 'restored', backup };
}
async function cli() {
  const input = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const ask = text => new Promise(resolve => input.question(text, resolve));
  try {
    console.log('Settings Vault - optional Asura minimap position patch');
    let action = process.argv[2];
    if (!action) action = ({ '1': 'install', '2': 'restore', '3': 'status' })[(await ask('1 Install | 2 Restore | 3 Status: ')).trim()];
    requireValue(['install', 'restore', 'status'].includes(action), 'No action selected.');
    const location = process.argv[3] || await ask('Paste the full path to TERA.exe or its game folder: ');
    const result = operate(resolveTarget(location), action);
    console.log(result.status + '.');
    if (result.backup) console.log('Verified backup: ' + result.backup);
    if (action === 'install') console.log('Start the game, place the N map once, then test opening/closing it and changing zones.');
  } finally { input.close(); }
}
module.exports = { apply, recipe, resolveTarget, operate, hash, atomic, records, closedAndUnlocked };
if (require.main === module) cli().catch(error => { console.error(error.message); process.exitCode = 1; });
