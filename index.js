'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const VERSION = '1.2.3';
const parseDefinition = require('tera-data-parser/lib/parsers/def');
const CLASSES = ['warrior', 'lancer', 'slayer', 'berserker', 'sorcerer', 'archer',
  'priest', 'mystic', 'reaper', 'gunner', 'brawler', 'ninja', 'valkyrie'];
const PERSONAL = new Set(['S1EquipmentPresetController', 'S1SkillCrestPresetController']);
const CHAT_UI = 'S1ChatController';
const SHARED = new Set([CHAT_UI]);
const UI_CONTROLLERS = new Set(['S1UI_GFxManager', 'S1GameOption_S1InterfaceGroup', 'S1SystemOption_S1AbnormalityOption']);
const KEY_CONTROLLER = 'S1CustomizeKeyGroup';
const SKILL_CONTROLLERS = new Set(['S1ShortCutController', 'S1SkillHotKeyController']);
const LIMIT = 4 * 1024 * 1024;
const CHAT_DEFINITION = `ref tabs
ref channels
array tabs
- ref channels
- ref name
- ref defaultInputChannel
- int16 index
- float x
- float y
- int16 width
- int16 height
- int16 opacity
- int16 fontSize
- bool undocked
- bool partyAutoInputChange
- bool autoInputChange
- array<int32> channels
- string name
- string defaultInputChannel
array channels
- int32 id
- byte r
- byte g
- byte b
`;
const CHAT_SAVE_DEFINITION = CHAT_DEFINITION.replace('array tabs\n', 'uint64 accountId\narray tabs\n');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function emptyState() { return { version: 1, classes: {}, legacy: {}, characterShortcuts: {}, characterBars: {}, chat: { locked: false, options: null, ui: null, savedAt: null },
  ui: { locked: false, windows: [], account: null, patch: null, savedAt: null },
  keys: { locked: false, user: null, patch: null, savedAt: null },
  shortcuts: { locked: false, controller: null, commonSkills: [], templateId: null, source: null, writer: null, patch: null, savedAt: null } }; }
function uiWindows(input) {
  if (!Array.isArray(input) || input.length > 512) throw new Error('Invalid UI window list');
  const names = new Set();
  return input.map(row => {
    if (!row || typeof row.name !== 'string' || !row.name.length || row.name.length > 160 ||
        /[\x00-\x1f\x7f]/.test(row.name) || names.has(row.name) ||
        !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0xffffffff ||
        !Number.isFinite(row.x) || !Number.isFinite(row.y) || Math.abs(row.x) > 100000 || Math.abs(row.y) > 100000)
      throw new Error('Invalid UI window entry');
    names.add(row.name);
    return { name: row.name, mode: row.mode, x: row.x, y: row.y };
  });
}
function mergeUiWindows(previous, incoming) {
  const rows = new Map(uiWindows(previous).map(row => [row.name, row]));
  for (const row of uiWindows(incoming)) rows.set(row.name, row);
  return uiWindows([...rows.values()]);
}
function readUiPacket(buffer, save) {
  const prefix = save ? 16 : 8, fixed = save ? 15 : 18;
  if (!Buffer.isBuffer(buffer) || buffer.length < prefix || buffer.length > 65535 || buffer.readUInt16LE(0) !== buffer.length)
    throw new Error('Unsupported UI packet envelope');
  const count = buffer.readUInt16LE(4), first = buffer.readUInt16LE(6), rows = [];
  if (count > 512 || (count ? first !== prefix : first !== 0 && first !== prefix)) throw new Error('Unsupported UI array header');
  let at = prefix;
  for (let i = 0; i < count; i++) {
    if (at + fixed + 2 > buffer.length || buffer.readUInt16LE(at) !== at || buffer.readUInt16LE(at + 4) !== at + fixed)
      throw new Error('Unsupported UI array entry');
    const next = buffer.readUInt16LE(at + 2), stringAt = at + fixed;
    let end = stringAt;
    while (end + 1 < buffer.length && end - stringAt <= 320 && buffer.readUInt16LE(end) !== 0) end += 2;
    if (end + 1 >= buffer.length || end - stringAt > 320 || buffer.readUInt16LE(end) !== 0)
      throw new Error('Invalid UI window name');
    const pos = at + (save ? 7 : 10);
    rows.push({ name: buffer.subarray(stringAt, end).toString('utf16le'),
      mode: save ? buffer.readUInt8(at + 6) : buffer.readUInt32LE(at + 6),
      x: buffer.readFloatLE(pos), y: buffer.readFloatLE(pos + 4) });
    at = end + 2;
    if (next !== (i === count - 1 ? 0 : at)) throw new Error('Unsupported UI array links');
  }
  if (at !== buffer.length) throw new Error('Unknown UI packet trailing data');
  return uiWindows(rows);
}
function uiReply(buffer, windows) {
  const rows = uiWindows(windows), strings = rows.map(row => Buffer.from(row.name + '\0', 'utf16le'));
  const size = strings.reduce((sum, text) => sum + 18 + text.length, 8);
  if (size > 65535) throw new Error('Shared UI layout exceeds the packet limit');
  const result = Buffer.alloc(size); buffer.copy(result, 0, 0, 4);
  result.writeUInt16LE(size, 0); result.writeUInt16LE(rows.length, 4); result.writeUInt16LE(rows.length ? 8 : 0, 6);
  let at = 8;
  rows.forEach((row, i) => {
    const end = at + 18 + strings[i].length;
    result.writeUInt16LE(at, at); result.writeUInt16LE(i === rows.length - 1 ? 0 : end, at + 2);
    result.writeUInt16LE(at + 18, at + 4); result.writeUInt32LE(row.mode, at + 6);
    result.writeFloatLE(row.x, at + 10); result.writeFloatLE(row.y, at + 14);
    strings[i].copy(result, at + 18); at = end;
  });
  return result;
}
function hexBuffer(value) {
  if (typeof value !== 'string' || value.length > 131054 || value.length % 2 || !/^[a-f\d]*$/i.test(value))
    throw new Error('Invalid settings bytes');
  return Buffer.from(value, 'hex');
}
function varint(buffer, start) {
  let result = 0, factor = 1;
  for (let i = start; i < buffer.length && i < start + 10; i++) {
    result += (buffer[i] & 127) * factor;
    if (!Number.isSafeInteger(result)) throw new Error('Settings integer is out of range');
    if (buffer[i] < 128) return { value: result, end: i + 1 };
    factor *= 128;
  }
  throw new Error('Truncated settings integer');
}
function fields(buffer) {
  const result = [];
  for (let at = 0; at < buffer.length;) {
    const start = at, tag = varint(buffer, at);
    at = tag.end;
    const number = Math.floor(tag.value / 8), wire = tag.value % 8;
    if (!number || number > 0x1fffffff) throw new Error('Invalid settings field');
    let value;
    if (wire === 0) { const v = varint(buffer, at); value = v.value; at = v.end; }
    else if (wire === 2) {
      const v = varint(buffer, at); at = v.end;
      if (v.value > buffer.length - at) throw new Error('Truncated settings value');
      value = buffer.subarray(at, at + v.value); at += v.value;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (at + size > buffer.length) throw new Error('Truncated fixed settings field');
      value = buffer.subarray(at, at + size); at += size;
    } else throw new Error('Unsupported settings wire type');
    result.push({ number, wire, value, raw: buffer.subarray(start, at) });
  }
  return result;
}
function document(buffer) {
  const result = fields(buffer), names = new Set();
  for (const field of result) {
    if (field.number !== 10 || field.wire !== 2) continue;
    const sub = fields(field.value), nameField = sub.find(f => f.number === 10 && f.wire === 2);
    if (!nameField || nameField.value.length % 2) throw new Error('Invalid settings controller name');
    const name = nameField.value.toString('utf16le');
    if (!/^[\w.-]{1,180}$/.test(name) || names.has(name)) throw new Error('Invalid or duplicate settings controller');
    names.add(name); field.name = name;
  }
  return result;
}
function rawData(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.length > 65535 ||
      buffer.readUInt16LE(0) !== buffer.length || buffer.readUInt16LE(4) !== 8 ||
      buffer.readUInt16LE(6) !== buffer.length - 8) throw new Error('Unsupported settings packet layout');
  const data = Buffer.from(buffer.subarray(8)); document(data); return data;
}
function replaceRaw(buffer, data) {
  if (data.length + 8 > 65535) throw new Error('Settings packet is too large');
  const result = Buffer.alloc(data.length + 8);
  buffer.copy(result, 0, 0, 8); // Preserve this connection's opcode, never a saved opcode.
  result.writeUInt16LE(result.length, 0); result.writeUInt16LE(data.length, 6);
  data.copy(result, 8); return result;
}
function sameOwner(a, b) {
  return !!a && !!b && a.playerId != null && b.playerId != null &&
    String(a.playerId) === String(b.playerId) && String(a.serverId) === String(b.serverId) &&
    a.accountId != null && b.accountId != null && String(a.accountId) === String(b.accountId);
}
function writerInfo(value) {
  if (value == null) return null;
  if (!value || !/^\d{1,24}$/.test(String(value.accountId)) || !/^\d{0,12}$/.test(String(value.serverId)))
    throw new Error('Invalid profile writer identity');
  return { accountId: String(value.accountId), serverId: String(value.serverId) };
}
function skillControllers(data) {
  return Buffer.concat(document(data).filter(f => SKILL_CONTROLLERS.has(f.name)).map(f => f.raw));
}
function completeBar(data) {
  const controllers = document(data).filter(f => SKILL_CONTROLLERS.has(f.name));
  if (controllers.length !== 2 || new Set(controllers.map(f => f.name)).size !== 2) throw new Error('Both native bar controllers are required');
  for (const controller of controllers) {
    const wrapper = fields(controller.value), values = wrapper.filter(f => f.number === 20 && f.wire === 2), flags = wrapper.filter(f => f.number === 30 && f.wire === 0), sizes = wrapper.filter(f => f.number === 40 && f.wire === 0);
    if (values.length !== 1 || flags.length !== 1 || sizes.length !== 1 || ![0,1].includes(flags[0].value) || sizes[0].value > 262144)
      throw new Error('Unsupported native bar wrapper');
    const payload = flags[0].value ? boundedInflate(values[0].value, sizes[0].value) : values[0].value;
    if (payload.length !== sizes[0].value) throw new Error('Native bar size mismatch');
  }
  return Buffer.concat(controllers.map(f => f.raw));
}
function mergeData(live, saved, ownerMatches, chatUi, skipSharedUi = false, skipSharedKeys = false, skipSkills = false) {
  const original = document(live), stored = document(saved), replacements = new Map();
  for (const field of stored) {
    if (field.name && !SHARED.has(field.name) && (!PERSONAL.has(field.name) || ownerMatches) &&
        (!skipSharedUi || !UI_CONTROLLERS.has(field.name)) && (!skipSharedKeys || field.name !== KEY_CONTROLLER) &&
        (!skipSkills || !SKILL_CONTROLLERS.has(field.name)))
      replacements.set(field.name, field.raw);
  }
  if (chatUi) {
    const field = document(hexBuffer(chatUi));
    if (field.length !== 1 || field[0].name !== CHAT_UI) throw new Error('Invalid common chat controller');
    replacements.set(CHAT_UI, field[0].raw);
  }
  const result = original.map(field => {
    if (!field.name || !replacements.has(field.name)) return field.raw;
    const replacement = replacements.get(field.name); replacements.delete(field.name); return replacement;
  });
  // New controllers in a saved profile may be absent from a freshly reset character.
  for (const raw of replacements.values()) result.push(raw);
  return Buffer.concat(result);
}
function captureUpdate(previous, incoming) {
  if (!previous) return incoming;
  // A client save may contain only changed controllers. Keep the rest of the
  // already captured full login snapshot rather than saving a partial profile.
  const old = document(previous), update = document(incoming);
  const replacements = new Map(update.filter(f => f.name).map(f => [f.name, f.raw]));
  const metadata = update.filter(f => !f.name);
  const result = (metadata.length ? metadata : old.filter(f => !f.name)).map(f => f.raw);
  for (const field of old) {
    if (!field.name) continue;
    result.push(replacements.get(field.name) || field.raw); replacements.delete(field.name);
  }
  for (const raw of replacements.values()) result.push(raw);
  const data = Buffer.concat(result);
  if (data.length + 8 > 65535) throw new Error('Captured settings are too large');
  return data;
}
function protobuf(number, value, bytes = true) {
  const encode = n => { const out = []; do { let v = n % 128; n = Math.floor(n / 128); out.push(v | (n ? 128 : 0)); } while (n); return Buffer.from(out); };
  const tag = encode(number * 8 + (bytes ? 2 : 0));
  return bytes ? Buffer.concat([tag, encode(value.length), value]) : Buffer.concat([tag, encode(value)]);
}
// Node12 has no maxOutputLength option. Count the bounded DEFLATE output before
// calling native inflateSync, so a forged size field cannot allocate a huge result.
function boundedInflate(input, expected) {
  if (!Buffer.isBuffer(input) || input.length < 6 || !Number.isInteger(expected) || expected < 0 || expected > 262144 ||
      (input[0] & 15) !== 8 || (input[0] >>> 4) > 7 || ((input[0] << 8) + input[1]) % 31 || (input[1] & 32))
    throw new Error('Unsupported compressed shortcut data');
  let bit = 16, count = 0, steps = 0, blocks = 0;
  function read(n) {
    if (bit + n > (input.length - 4) * 8) throw new Error('Truncated shortcut compression');
    let value = 0; for (let i = 0; i < n; i++, bit++) value |= ((input[bit >>> 3] >>> (bit & 7)) & 1) << i;
    return value;
  }
  function tree(lengths) {
    const counts = Array(16).fill(0), next = Array(16).fill(0), table = new Map(); let code = 0, left = 1;
    for (const length of lengths) { if (length < 0 || length > 15) throw new Error('Invalid compression tree'); if (length) counts[length]++; }
    for (let n = 1; n <= 15; n++) { left = left * 2 - counts[n]; if (left < 0) throw new Error('Oversubscribed compression tree'); code = (code + counts[n - 1]) << 1; next[n] = code; }
    lengths.forEach((length, value) => { if (!length) return; let code = next[length]++, reversed = 0; for (let n = 0; n < length; n++) { reversed = (reversed << 1) | (code & 1); code >>>= 1; } table.set((1 << length) | reversed, value); });
    return table;
  }
  function symbol(table) {
    let value = 0; for (let n = 1; n <= 15; n++) { value |= read(1) << (n - 1); const found = table.get((1 << n) | value); if (found !== undefined) return found; }
    throw new Error('Invalid compression code');
  }
  const lengthBase = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const lengthBits = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const distanceBase = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  let final;
  do {
    if (++steps > 524288 || ++blocks > 256) throw new Error('Compression work limit exceeded');
    final = read(1); const type = read(2);
    if (type === 0) {
      bit = (bit + 7) & ~7; const length = read(16); if ((length ^ read(16)) !== 65535) throw new Error('Invalid stored block');
      if (bit + length * 8 > (input.length - 4) * 8) throw new Error('Truncated stored block'); bit += length * 8; count += length;
    } else if (type === 1 || type === 2) {
      let literals, distances;
      if (type === 1) {
        literals = tree(Array.from({ length: 288 }, (_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8));
        distances = tree(Array(32).fill(5));
      } else {
        const literalCount = read(5) + 257, distanceCount = read(5) + 1, codeCount = read(4) + 4;
        const order = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
        const lengths = Array(19).fill(0); for (let i = 0; i < codeCount; i++) lengths[order[i]] = read(3);
        const codes = tree(lengths), values = [];
        while (values.length < literalCount + distanceCount) {
          const value = symbol(codes); if (value < 16) values.push(value);
          else {
            if (value === 16 && !values.length) throw new Error('Invalid repeated compression code');
            const repeat = value === 16 ? read(2) + 3 : value === 17 ? read(3) + 3 : read(7) + 11;
            if (values.length + repeat > literalCount + distanceCount) throw new Error('Compression tree overflow');
            const last = value === 16 ? values[values.length - 1] : 0; for (let n = 0; n < repeat; n++) values.push(last);
          }
        }
        if (!values[256]) throw new Error('Missing compression end code');
        literals = tree(values.slice(0, literalCount)); distances = tree(values.slice(literalCount));
      }
      for (;;) {
        if (++steps > 524288) throw new Error('Compression work limit exceeded');
        const value = symbol(literals); if (value === 256) break;
        if (value < 256) count++;
        else {
          if (value < 257 || value > 285) throw new Error('Invalid compression length');
          const index = value - 257, length = lengthBase[index] + read(lengthBits[index]), distance = symbol(distances);
          if (distance > 29) throw new Error('Invalid compression distance');
          const extra = distance < 4 ? 0 : (distance >>> 1) - 1;
          if (distanceBase[distance] + read(extra) > count) throw new Error('Compression history overflow');
          count += length;
        }
        if (count > expected) throw new Error('Shortcut expansion exceeds its declared limit');
      }
    } else throw new Error('Unsupported compression block');
    if (count > expected) throw new Error('Shortcut expansion exceeds its declared limit');
  } while (!final);
  if (count !== expected || ((bit + 7) >>> 3) !== input.length - 4) throw new Error('Shortcut compression size mismatch');
  const result = zlib.inflateSync(input); if (result.length !== expected) throw new Error('Shortcut size mismatch'); return result;
}
function shortcutDocument(controller) {
  const doc = document(controller);
  if (doc.length !== 1 || doc[0].name !== 'S1ShortCutController') throw new Error('Invalid shortcut controller');
  const wrapper = fields(doc[0].value), value = wrapper.filter(f => f.number === 20 && f.wire === 2), flag = wrapper.filter(f => f.number === 30 && f.wire === 0), size = wrapper.filter(f => f.number === 40 && f.wire === 0);
  if (value.length !== 1 || flag.length !== 1 || size.length !== 1 || ![0,1].includes(flag[0].value)) throw new Error('Unsupported shortcut wrapper');
  const data = flag[0].value ? boundedInflate(value[0].value, size[0].value) : value[0].value;
  if (data.length !== size[0].value || data.length > 262144) throw new Error('Invalid shortcut size');
  const entries = fields(data), slots = entries.filter(f => f.number === 40), references = entries.filter(f => f.number === 70);
  if (slots.length > 512 || references.length !== slots.length || slots.some(f => f.wire !== 2) || references.some(f => f.wire !== 2))
    throw new Error('Unsupported shortcut slot/reference layout');
  const seen = new Set(), rows = slots.map((entry, index) => {
    const values = fields(entry.value);
    if (values.length !== 4 || values.some((f,i) => f.number !== i + 1 || f.wire !== 0)) throw new Error('Unsupported shortcut slot fields');
    const [bar, slot, kind, id] = values.map(f => f.value), key = bar + ':' + slot;
    if (bar > 15 || slot > 255 || kind > 65535 || id > 0xffffffff || seen.has(key)) throw new Error('Invalid or duplicate shortcut slot');
    seen.add(key); return { bar, slot, kind, id, raw: entry.raw, reference: references[index].raw };
  });
  return { wrapper, entries, rows };
}
function shortcutField(user) { const field = document(user).find(f => f.name === 'S1ShortCutController'); return field ? field.raw : null; }
function commonShortcut(row, skills) { return [100,300,400].includes(row.kind) || (row.kind === 0 && skills.has(row.id)); }
function shortcutPosition(row) { return row.bar + ':' + row.slot; }
function sameShortcut(a, b) { return !!a && !!b && a.kind === b.kind && a.id === b.id; }
function characterShortcutKey(owner) {
  if (!owner || !/^\d{1,24}$/.test(String(owner.accountId)) || !/^\d{1,12}$/.test(String(owner.serverId)) ||
      !/^\d{1,24}$/.test(String(owner.playerId))) return null;
  return [owner.accountId, owner.serverId, owner.playerId].map(String).join(':');
}
function writeShortcutRows(live, rows) {
  if (rows.length > 512) throw new Error('Too many shortcut slots');
  const parts = []; let slotsWritten = false, refsWritten = false;
  for (const field of live.entries) {
    if (field.number === 40) { if (!slotsWritten) { parts.push(...rows.map(r => r.raw)); slotsWritten = true; } }
    else if (field.number === 70) { if (!refsWritten) { parts.push(...rows.map(r => r.reference)); refsWritten = true; } }
    else parts.push(field.raw); // Keep premium inventory and unknown metadata.
  }
  if (!slotsWritten) parts.push(...rows.map(r => r.raw));
  if (!refsWritten) parts.push(...rows.map(r => r.reference));
  const payload = Buffer.concat(parts), compressed = zlib.deflateSync(payload);
  const wrapper = live.wrapper.map(f => f.number === 20 ? protobuf(20, compressed) : f.number === 30 ? protobuf(30,1,false) : f.number === 40 ? protobuf(40,payload.length,false) : f.raw);
  const result = protobuf(10, Buffer.concat(wrapper)); shortcutDocument(result); return result;
}
function applyCharacterShortcuts(controller, native, saved, slots) {
  const live = shortcutDocument(controller), own = shortcutDocument(native), allowed = new Map(slots.map(row => [shortcutPosition(row),row]));
  const replacements = new Map(saved.filter(row => allowed.has(shortcutPosition(row))).map(row => [shortcutPosition(row),row]));
  let changed = false;
  const rows = live.rows.map(row => {
    const choice = replacements.get(shortcutPosition(row));
    if (!choice || sameShortcut(choice, row)) return row;
    changed = true;
    const match = own.rows.find(r => sameShortcut(r, choice));
    return { ...choice, raw: protobuf(40, Buffer.concat([choice.bar,choice.slot,choice.kind,choice.id].map((v,i) => protobuf(i+1,v,false)))),
      reference: match ? match.reference : protobuf(70, Buffer.from('08ffffffffffffffffff01','hex')) };
  });
  return changed ? writeShortcutRows(live, rows) : controller;
}
function mergeShortcuts(target, source, commonSkills, full = false) {
  const live = shortcutDocument(target), saved = shortcutDocument(source), shared = new Set(commonSkills);
  const selected = full ? saved.rows : saved.rows.filter(row => commonShortcut(row, shared));
  if (!selected.length) return target;
  const rows = full ? [] : live.rows.slice(), bySlot = new Map(rows.map((row,i) => [row.bar + ':' + row.slot,i]));
  const noReference = protobuf(70, Buffer.from('08ffffffffffffffffff01','hex'));
  for (const row of selected) {
    const own = live.rows.find(r => r.kind === row.kind && r.id === row.id);
    const value = { ...row, reference: own ? own.reference : noReference };
    const key = row.bar + ':' + row.slot, index = bySlot.get(key);
    if (index !== undefined) rows[index] = value; else { bySlot.set(key, rows.length); rows.push(value); }
  }
  return writeShortcutRows(live, rows);
}
function classifyShortcutSkills(nodes, templateId, players, ids) {
  if (!(players instanceof Set) || !players.has(templateId) || !Array.isArray(nodes)) throw new Error('Player template catalog is not ready');
  const className = /(?:^|[_\s])(warrior|lancer|slayer|berserker|sorcerer|archer|priest|mystic|reaper|gunner|brawler|ninja|valkyrie)(?:[_\s]|$)/i;
  const commonName = /(?:^|[_\s])(common|ride|riding|mount|vehicle|premium|social)(?:[_\s]|$)/i;
  const common = [], unknown = [];
  for (const id of ids) {
    const rows = nodes.map(n => n && n.attributes).filter(a => a && a.id === id && Number.isInteger(a.templateId) && typeof a.name === 'string');
    const own = rows.filter(a => a.templateId === templateId);
    if (own.some(a => className.test(a.name))) continue;
    if (own.length && !own.some(a => commonName.test(a.name))) { unknown.push(id); continue; }
    if (own.some(a => commonName.test(a.name)) || rows.some(a => !players.has(a.templateId) && !className.test(a.name) && a.name.length)) common.push(id);
    else unknown.push(id);
  }
  return { common, unknown };
}
function chatOptions(value) {
  if (!value || !Array.isArray(value.tabs) || value.tabs.length < 1 || value.tabs.length > 32 ||
      !Array.isArray(value.channels) || value.channels.length > 512) throw new Error('Invalid chat options');
  const integer = (n, low, high) => Number.isInteger(n) && n >= low && n <= high;
  const indices = new Set();
  const tabs = value.tabs.map(tab => {
    if (!tab || !integer(tab.index, -32768, 32767) || indices.has(tab.index) ||
        !Number.isFinite(tab.x) || !Number.isFinite(tab.y) || Math.abs(tab.x) > 100000 || Math.abs(tab.y) > 100000 ||
        !['width', 'height', 'opacity', 'fontSize'].every(k => integer(tab[k], -32768, 32767)) ||
        !['undocked', 'partyAutoInputChange', 'autoInputChange'].every(k => typeof tab[k] === 'boolean') ||
        !Array.isArray(tab.channels) || tab.channels.length > 512 ||
        !tab.channels.every(n => integer(n, -2147483648, 2147483647)) ||
        typeof tab.name !== 'string' || tab.name.length > 256 || tab.name.includes('\0') ||
        typeof tab.defaultInputChannel !== 'string' || tab.defaultInputChannel.length > 128 || tab.defaultInputChannel.includes('\0'))
      throw new Error('Invalid chat tab');
    indices.add(tab.index);
    const result = {};
    for (const key of ['index', 'x', 'y', 'width', 'height', 'opacity', 'fontSize', 'undocked',
      'partyAutoInputChange', 'autoInputChange', 'channels', 'name', 'defaultInputChannel']) result[key] = tab[key];
    return clone(result);
  });
  const channels = value.channels.map(c => {
    if (!c || !integer(c.id, -2147483648, 2147483647) || !['r', 'g', 'b'].every(k => integer(c[k], 0, 255)))
      throw new Error('Invalid chat color');
    return { id: c.id, r: c.r, g: c.g, b: c.b };
  });
  return { tabs, channels }; // accountId/BigInt is intentionally not persisted.
}
function validateState(input) {
  if (!input || input.version !== 1 || !input.classes || Array.isArray(input.classes) ||
      !input.chat || typeof input.chat.locked !== 'boolean') throw new Error('Invalid profile file');
  const state = emptyState();
  if (input.legacy && (typeof input.legacy !== 'object' || Array.isArray(input.legacy) || Object.keys(input.legacy).length > 1000))
    throw new Error('Invalid legacy profiles');
  for (const key of Object.keys(input.legacy || {})) {
    const p = input.legacy[key];
    if (!/^[^\\/\x00-\x1f]{1,150}-\d+$/.test(key) || !p ||
        !document(hexBuffer(p.account)).some(f => f.name) || !document(hexBuffer(p.user)).some(f => f.name))
      throw new Error('Invalid legacy snapshot');
    state.legacy[key] = { account: p.account, user: p.user };
  }
  for (const key of Object.keys(input.classes)) {
    if (!/^(?:[0-9]|1[0-2])$/.test(key)) throw new Error('Invalid saved class');
    const p = input.classes[key];
    if (!p || typeof p.locked !== 'boolean' || typeof p.savedAt !== 'string' || !p.source ||
        !Number.isInteger(p.patch) || p.patch < 1) throw new Error('Invalid class profile');
    if (!document(hexBuffer(p.account)).some(f => f.name) || !document(hexBuffer(p.user)).some(f => f.name))
      throw new Error('Empty class settings');
    state.classes[key] = { locked: p.locked, savedAt: p.savedAt, patch: p.patch,
      source: { name: String(p.source.name || '').slice(0, 100), serverId: String(p.source.serverId || ''),
        playerId: p.source.playerId == null ? null : String(p.source.playerId),
        accountId: p.source.accountId == null ? null : String(p.source.accountId) }, account: p.account, user: p.user };
    if (p.skills != null) {
      if (!p.skills.source || (p.skills.level !== null && (!Number.isInteger(p.skills.level) || p.skills.level < 1 || p.skills.level > 1000)))
        throw new Error('Invalid skill profile source');
      const owner = p.skills.source;
      state.classes[key].skills = { level: p.skills.level, source: {
        name: String(owner.name || '').slice(0, 100), serverId: String(owner.serverId || ''),
        playerId: owner.playerId == null ? null : String(owner.playerId),
        accountId: owner.accountId == null ? null : String(owner.accountId) } };
    }
    if (p.writer != null) state.classes[key].writer = writerInfo(p.writer);
  }
  if (input.chat.options) state.chat.options = chatOptions(input.chat.options);
  if (input.chat.ui) {
    const f = document(hexBuffer(input.chat.ui));
    if (f.length !== 1 || f[0].name !== CHAT_UI) throw new Error('Invalid shared chat settings');
    state.chat.ui = input.chat.ui;
  }
  state.chat.savedAt = typeof input.chat.savedAt === 'string' ? input.chat.savedAt : null;
  state.chat.locked = input.chat.locked;
  if (state.chat.locked && !state.chat.options) throw new Error('Locked chat has no snapshot');
  if (input.ui !== undefined) {
    const ui = input.ui;
    if (!ui || typeof ui.locked !== 'boolean') throw new Error('Invalid shared UI profile');
    const windows = uiWindows(ui.windows);
    if (windows.length && (!Number.isInteger(ui.patch) || ui.patch < 1 || typeof ui.savedAt !== 'string'))
      throw new Error('Incomplete shared UI profile');
    if (ui.locked && !windows.length) throw new Error('Locked UI has no window snapshot');
    let account = null;
    if (ui.account != null) {
      const controllers = document(hexBuffer(ui.account));
      if (!controllers.length || controllers.some(f => !UI_CONTROLLERS.has(f.name))) throw new Error('Invalid shared UI preferences');
      account = ui.account;
    }
    state.ui = { locked: ui.locked, windows, account, patch: windows.length ? ui.patch : null,
      savedAt: windows.length ? ui.savedAt : null };
  }
  if (input.keys !== undefined) {
    const keys = input.keys;
    if (!keys || typeof keys.locked !== 'boolean') throw new Error('Invalid shared keyboard profile');
    if (keys.user != null) {
      const controller = document(hexBuffer(keys.user));
      if (controller.length !== 1 || controller[0].name !== KEY_CONTROLLER ||
          !Number.isInteger(keys.patch) || keys.patch < 1 || typeof keys.savedAt !== 'string')
        throw new Error('Invalid shared keyboard snapshot');
      state.keys = { locked: keys.locked, user: keys.user, patch: keys.patch, savedAt: keys.savedAt };
    } else if (keys.locked) throw new Error('Locked keyboard has no snapshot');
  }
  for (const key of ['chat', 'ui', 'keys']) {
    if (input[key] && input[key].writer != null) state[key].writer = writerInfo(input[key].writer);
  }
  if (input.shortcuts != null) {
    const shared = input.shortcuts;
    if (typeof shared.locked !== 'boolean') throw new Error('Invalid shared shortcut profile');
    if (shared.controller != null) {
      const controller = hexBuffer(shared.controller), parsed = shortcutDocument(controller);
      if (!Number.isInteger(shared.classJob) || shared.classJob < 0 || shared.classJob >= CLASSES.length ||
          !Number.isInteger(shared.templateId) || shared.templateId < 1 || !Number.isInteger(shared.patch) || shared.patch < 1 ||
          typeof shared.savedAt !== 'string' || !shared.source || !Array.isArray(shared.commonSkills) || shared.commonSkills.length > 512)
        throw new Error('Incomplete shared shortcut profile');
      const ids = new Set(parsed.rows.filter(r => r.kind === 0).map(r => r.id));
      if (new Set(shared.commonSkills).size !== shared.commonSkills.length || shared.commonSkills.some(id => !Number.isInteger(id) || !ids.has(id)))
        throw new Error('Invalid shared skill classification');
      const source = shared.source;
      state.shortcuts = { locked: shared.locked, controller: shared.controller, commonSkills: shared.commonSkills.slice(),
        classJob: shared.classJob, templateId: shared.templateId, patch: shared.patch, savedAt: shared.savedAt,
        source: { name: String(source.name || '').slice(0,100), accountId: source.accountId == null ? null : String(source.accountId),
          playerId: source.playerId == null ? null : String(source.playerId), serverId: String(source.serverId || '') },
        writer: writerInfo(shared.writer), catalogReady: shared.catalogReady === true, unknownSkills: Number.isInteger(shared.unknownSkills) ? Math.max(0,shared.unknownSkills) : 0 };
      if (!state.shortcuts.writer) throw new Error('Shared shortcut source account is missing');
    } else if (shared.locked) throw new Error('Locked shortcuts have no snapshot');
  }
  if (input.characterShortcuts !== undefined) {
    const saved = input.characterShortcuts;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).length > 1000)
      throw new Error('Invalid character shortcut collection');
    for (const key of Object.keys(saved)) {
      const item = saved[key];
      if (!item || characterShortcutKey(item.owner) !== key || !Number.isInteger(item.patch) || item.patch < 1 ||
          typeof item.savedAt !== 'string' || !Array.isArray(item.rows) || item.rows.length > 512)
        throw new Error('Invalid character shortcut snapshot');
      const seen = new Set(), rows = item.rows.map(row => {
        if (!row || ![row.bar,row.slot,row.kind,row.id].every(Number.isInteger) || row.bar < 0 || row.bar > 15 ||
            row.slot < 0 || row.slot > 255 || ![0,100,300,400].includes(row.kind) || row.id < 1 || row.id > 0xffffffff || seen.has(shortcutPosition(row)))
          throw new Error('Invalid character shortcut choice');
        seen.add(shortcutPosition(row)); return { bar: row.bar, slot: row.slot, kind: row.kind, id: row.id };
      });
      state.characterShortcuts[key] = { owner: { accountId: String(item.owner.accountId), serverId: String(item.owner.serverId),
        playerId: String(item.owner.playerId) }, patch: item.patch, savedAt: item.savedAt, rows };
    }
  }
  if (input.characterBars !== undefined) {
    const saved = input.characterBars;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).length > 1000)
      throw new Error('Invalid character bar collection');
    for (const key of Object.keys(saved)) {
      const item = saved[key];
      if (!item || characterShortcutKey(item.owner) !== key || !Number.isInteger(item.job) || item.job < 0 || item.job >= CLASSES.length ||
          !Number.isInteger(item.patch) || item.patch < 1 || typeof item.savedAt !== 'string') throw new Error('Invalid character bar snapshot');
      const data = hexBuffer(item.user), bar = completeBar(data);
      if (!bar.equals(data)) throw new Error('Character bars cannot contain shared settings or presets');
      state.characterBars[key] = { owner: { accountId: String(item.owner.accountId), serverId: String(item.owner.serverId),
        playerId: String(item.owner.playerId) }, job: item.job, patch: item.patch, savedAt: item.savedAt, user: item.user };
    }
  }
  return state;
}

function createUiLayoutTrace(mod, root, getSnapshot) {
  const names = ['C_REQUEST_CLIENT_UI_SETTING', 'S_REPLY_CLIENT_UI_SETTING',
    'C_SAVE_CLIENT_UI_SETTING', 'S_SAVE_CLIENT_UI_SETTING'];
  const hooks = [], available = [], cache = new Map();
  let stream = null, file = null, bytes = 0, dropped = 0, packetCount = 0;
  const maxBytes = 4 * 1024 * 1024;
  function stop(reason) {
    if (!stream) return;
    const previous = stream; stream = null;
    try { previous.end(JSON.stringify({ utc: new Date().toISOString(), stage: 'END', reason,
      packets: packetCount, dropped }) + '\n'); }
    catch (error) { mod.warn('UI log close failed: ' + error.message); }
  }
  function write(stage, data) {
    if (!stream) return;
    try {
      if (stream.writableLength > 256 * 1024) { dropped++; return; }
      const line = JSON.stringify({ utc: new Date().toISOString(), stage, ...data }) + '\n';
      if (bytes + Buffer.byteLength(line) > maxBytes) {
        stop('size-limit'); mod.command.message('UI log stopped at its size limit.'); return;
      }
      bytes += Buffer.byteLength(line); stream.write(line);
    } catch (error) { stop('write-error'); mod.warn('UI log write failed: ' + error.message); }
  }
  for (const name of names) {
    try {
      hooks.push(mod.hook(name, 'raw', { order: -8000, filter: { fake: false } }, (opcode, buffer) => {
        // Observe native data only. Never replay an unknown layout or suppress a packet.
        if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length > 65535 ||
            buffer.readUInt16LE(0) !== buffer.length) return;
        const packet = { name, opcode, observedAt: new Date().toISOString(),
          bytes: buffer.length, hash: crypto.createHash('sha256').update(buffer).digest('hex'),
          raw: buffer.toString('hex') };
        cache.set(name, packet); packetCount++;
        write('NATIVE_UI_PACKET', { ...packet, cached: false });
      }));
      available.push(name);
    } catch (error) { mod.warn('UI capture unavailable for ' + name + ': ' + error.message); }
  }
  function snapshot() {
    try {
      const current = getSnapshot();
      write('CONTEXT', { class: current.class, loaded: current.loaded,
        patch: mod.majorPatchVersion, available, cachedPackets: cache.size,
        note: 'Passive native UI capture before shared-layout restoration. Raw saves may contain private account identifiers.' });
      if (current.account) {
        const controllers = document(current.account).filter(f => f.name &&
          /UI_GFxManager|InterfaceGroup|AbnormalityOption|MinimapController/i.test(f.name))
          .map(f => ({ name: f.name, raw: f.raw.toString('hex') }));
        write('OBSERVED_ACCOUNT_UI', { controllers });
      }
    } catch (error) { write('CONTEXT_ERROR', { error: error.message }); }
  }
  function start() {
    try {
      const directory = path.join(root, 'logs'); fs.mkdirSync(directory, { recursive: true });
      file = path.join(directory, 'ui-layout-' + new Date().toISOString().replace(/:/g, '-') +
        '-' + process.pid + '-' + crypto.randomBytes(3).toString('hex') + '.jsonl');
      const current = fs.createWriteStream(file, { flags: 'wx', encoding: 'utf8' });
      stream = current; bytes = 0; dropped = 0;
      current.on('error', error => {
        if (stream === current) { stream = null; mod.command.message('UI log stopped: file write failed.'); }
        current.destroy(); mod.warn('UI log failed: ' + error.message);
      });
      write('START', { format: 1, moduleVersion: VERSION, patch: mod.majorPatchVersion });
      snapshot();
      for (const packet of cache.values()) write('NATIVE_UI_PACKET', { ...packet, cached: true });
      mod.command.message('UI log ON: ' + file + '. Move your boss bar, buff bar and menu bar; then use vault ui log again.');
    } catch (error) { stop('start-error'); mod.warn('UI log could not start: ' + error.message); }
  }
  return {
    catalog: data => write('SHARED_SHORTCUT_CATALOG', data),
    command(action) {
      action = String(action || 'status').toLowerCase();
      if (action === 'log') {
        if (stream) { stop('command'); mod.command.message('UI log OFF. File: ' + file); }
        else start();
      } else if (action === 'mark') {
        if (!stream) { mod.command.message('Use vault ui log first.'); return; }
        snapshot(); write('MARK', { label: 'manual' }); mod.command.message('UI layout marked.');
      } else mod.command.message('UI capture: ' + available.length + '/4 packets available, ' +
        cache.size + ' native packet types observed. Log ' + (stream ? 'ON' : 'OFF') +
        '. Use vault ui log to toggle diagnostic recording.');
    },
    leave() { write('LEAVE', {}); cache.clear(); },
    close() { stop('unload'); for (const h of hooks) { try { mod.unhook(h); } catch (_) {} } cache.clear(); }
  };
}

module.exports = function SettingsVault(mod) {
  const root = mod.path || __dirname, dataDir = path.join(root, 'data');
  const stateFile = path.join(dataDir, 'profiles.json'), backupFile = stateFile + '.bak';
  let state = emptyState(), session = null, closed = false, diskBlocked = false;
  let draft = { account: null, user: null, chat: null };
  const pendingClasses = new Map();
  const pendingCharacterBars = new Map();
  let pendingChat = null, pendingUi = null, pendingKeys = null, pendingShortcuts = null, saveTimer = null, shortcutQuery = null;
  let uiDraft = null, uiSource = null, uiAutoSyncAllowed = false;
  const hooks = [], warnings = new Set();
  const message = text => mod.command.message(text);
  const uiLayoutTrace = createUiLayoutTrace(mod, root, () => ({
    class: session ? CLASSES[session.job] : null, loaded: !!(session && session.loaded), account: draft.account
  }));
  function warn(key, error) {
    if (warnings.has(key)) return;
    warnings.add(key); mod.warn('Settings Vault: ' + key + ': ' + (error.message || String(error)));
  }
  function atomicWrite(file, data) {
    const temporary = file + '.' + process.pid + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temporary, 'w'); fs.writeFileSync(fd, data, 'utf8'); fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
    }
  }
  function read(file) {
    if (fs.statSync(file).size > LIMIT) throw new Error('Profile file is too large');
    return validateState(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(stateFile)) {
      try { state = read(stateFile); }
      catch (error) {
        warn('profile-read', error);
        try {
          state = read(backupFile);
          fs.copyFileSync(stateFile, stateFile + '.invalid-' + Date.now());
          atomicWrite(stateFile, JSON.stringify(state, null, 2));
          warn('profile-recovered', new Error('Recovered the last valid backup; invalid file was preserved.'));
        } catch (recoveryError) { diskBlocked = true; warn('profile-recovery', recoveryError); }
      }
    } else if (fs.existsSync(backupFile)) state = read(backupFile);
  } catch (error) { diskBlocked = true; warn('data-access', error); }
  function persist(next) {
    if (diskBlocked) throw new Error('Profile storage needs repair; original files were preserved.');
    const checked = validateState(next), json = JSON.stringify(checked, null, 2);
    if (Buffer.byteLength(json) > LIMIT) throw new Error('Profile file is too large');
    // Both writes are atomic. Keep the previous complete snapshot before replacing it.
    if (fs.existsSync(stateFile)) atomicWrite(backupFile, JSON.stringify(read(stateFile), null, 2));
    else atomicWrite(backupFile, json);
    atomicWrite(stateFile, json); state = checked;
    try { atomicWrite(backupFile, json); }
    catch (error) { warn('backup-write', error); }
  }
  function refreshState() {
    if (diskBlocked) return;
    try { if (fs.existsSync(stateFile)) state = read(stateFile); }
    catch (error) { diskBlocked = true; warn('profile-refresh', error); }
  }
  function effectiveState() {
    const result = clone(state);
    for (const [key, value] of pendingClasses) result.classes[key] = clone(value);
    if (pendingChat) result.chat = clone(pendingChat);
    if (pendingUi) result.ui = clone(pendingUi);
    if (pendingKeys) result.keys = clone(pendingKeys);
    if (pendingShortcuts) result.shortcuts = clone(pendingShortcuts);
    for (const [key, value] of pendingCharacterBars) {
      result.characterBars[key] = clone(value);
      delete result.characterShortcuts[key]; // Retire old exceptions only with their replacement snapshot.
    }
    return result;
  }
  function clearPending() {
    if (saveTimer !== null) mod.clearTimeout(saveTimer);
    saveTimer = null; pendingClasses.clear(); pendingChat = null; pendingUi = null; pendingKeys = null; pendingShortcuts = null;
    pendingCharacterBars.clear();
  }
  function flushPending() {
    if (!pendingClasses.size && !pendingChat && !pendingUi && !pendingKeys && !pendingShortcuts && !pendingCharacterBars.size) return true;
    if (saveTimer !== null) mod.clearTimeout(saveTimer); saveTimer = null;
    try { refreshState(); persist(effectiveState()); clearPending(); return true; }
    catch (error) {
      const first = !warnings.has('auto-sync-write'); warn('auto-sync-write', error);
      if (first) message('Automatic settings save failed; previous disk data is intact. Check the Toolbox warning.');
      return false;
    }
  }
  function queueSave() {
    if (saveTimer === null) saveTimer = mod.setTimeout(() => { saveTimer = null; flushPending(); }, 300);
  }
  function ready() { return !!session && session.job != null && !closed; }
  function profile() { return ready() ? pendingClasses.get(String(session.job)) || state.classes[String(session.job)] : null; }
  function commonChat() { return pendingChat || state.chat; }
  function commonUi() { return pendingUi || state.ui; }
  function commonKeys() { return pendingKeys || state.keys; }
  function commonShortcuts() { return pendingShortcuts || state.shortcuts; }
  function characterBar() {
    const key = characterShortcutKey(session);
    return key ? pendingCharacterBars.get(key) || state.characterBars[key] : null;
  }
  function isBarSource() {
    const p = profile(), shared = commonShortcuts();
    return !!(p ? sameOwner(skillOrigin(p).source, session) : shared.controller && sameOwner(shared.source, session));
  }
  function capturedBar(user) {
    return { owner: { accountId: String(session.accountId), serverId: String(session.serverId), playerId: String(session.playerId) },
      job: session.job, patch: mod.majorPatchVersion, savedAt: new Date().toISOString(), user: completeBar(user).toString('hex') };
  }
  function queueCharacterBar(user) {
    const key = characterShortcutKey(session);
    if (!key) throw new Error('Character identity is incomplete');
    if (!state.characterBars[key] && !pendingCharacterBars.has(key) &&
        new Set([...Object.keys(state.characterBars), ...pendingCharacterBars.keys()]).size >= 1000) throw new Error('Character bar storage is full');
    const next = capturedBar(user), existing = characterBar();
    if (!existing || existing.user !== next.user || existing.patch !== next.patch || existing.job !== next.job) {
      pendingCharacterBars.set(key, next); queueSave();
    }
  }
  function syncCharacterBar() {
    if (!maySync() || !session.characterBarApplied || isBarSource()) return;
    try {
      queueCharacterBar(draft.user);
    } catch (error) { warn('character-bar-save', error); }
  }
  function importBarTemplate(user, force = false) {
    const p = profile(), shared = commonShortcuts();
    const full = !!(p && (force || p.locked) && uiCompatible(p));
    let result = full ? mergeData(user, completeBar(hexBuffer(p.user)), false, null) : user;
    const common = !!(shared.controller && (force || shared.locked) && uiCompatible(shared));
    if (common && (!full || shared.classJob !== session.job)) {
      const target = shortcutField(result);
      if (!target) throw new Error('Native shortcut controller is missing');
      result = captureUpdate(result, mergeShortcuts(target, hexBuffer(shared.controller), shared.commonSkills));
    }
    if (!full && !common) throw new Error('No compatible bar template is available for this class');
    completeBar(result);
    return result;
  }
  function loadBar() {
    if (!maySync() || !session.userPacket) { message('Finish loading this character before using vault load.'); return; }
    if (!flushPending()) { message('Current local changes could not be saved; import stopped. Check the Toolbox warning.'); return; }
    try {
      const user = importBarTemplate(draft.user, true), packet = replaceRaw(session.userPacket, user);
      if (mod.toClient(packet) === false) throw new Error('Bar template was not delivered');
      draft.user = user; session.skillsApplied = !!(profile() && uiCompatible(profile()));
      session.characterBarApplied = !isBarSource(); session.barMode = isBarSource() ? 'source' : 'template';
      if (!isBarSource()) queueCharacterBar(user);
      if (!flushPending()) { message('Bar template applied; local saving is pending. Check the Toolbox warning before exiting.'); return; }
      message('Main bar template applied' + (isBarSource() ? '.' : ' and saved for this character. Future bar edits stay with this character.'));
    } catch (error) { warn('bar-template-load', error); message('Bar import failed: ' + error.message); }
  }
  function currentWriter() {
    return writerInfo({ accountId: session.accountId, serverId: String(session.serverId || '') });
  }
  function mayWrite(saved) {
    return ready() && !!saved && !!saved.writer && session.accountId != null &&
      saved.writer.accountId === String(session.accountId) && saved.writer.serverId === String(session.serverId || '');
  }
  function currentLevel() {
    const level = mod.game.me.level;
    return Number.isInteger(level) && level > 0 && level <= 1000 ? level : session.level;
  }
  function skillOrigin(p) { return p.skills || { level: null, source: p.source }; }
  function mayUseSkills(p) {
    const origin = skillOrigin(p), level = currentLevel();
    return origin.level !== null ? level !== null && level >= origin.level : sameOwner(origin.source, session);
  }
  function capturedShortcuts(controller, locked, previous) {
    if (!Number.isInteger(session.templateId) || session.templateId < 1) throw new Error('Source player template is not known');
    const rows = shortcutDocument(controller).rows, ids = new Set(rows.filter(r => r.kind === 0).map(r => r.id));
    return { locked, controller: controller.toString('hex'), classJob: session.job, templateId: session.templateId,
      commonSkills: previous && previous.templateId === session.templateId ? previous.commonSkills.filter(id => ids.has(id)) : [],
      catalogReady: false, unknownSkills: ids.size, writer: currentWriter(), patch: mod.majorPatchVersion,
      savedAt: new Date().toISOString(), source: { name: session.name, accountId: String(session.accountId),
        playerId: session.playerId == null ? null : String(session.playerId), serverId: String(session.serverId || '') } };
  }
  function classifySharedShortcuts() {
    const saved = commonShortcuts(), context = session, players = mod.game.data && mod.game.data.users;
    if (!maySync() || !saved.controller || !mayWrite(saved) || !sameOwner(saved.source, session) || saved.catalogReady || shortcutQuery ||
        typeof mod.queryData !== 'function' || !players || typeof players.has !== 'function' || !players.has(saved.templateId)) return;
    const ids = [...new Set(shortcutDocument(hexBuffer(saved.controller)).rows.filter(r => r.kind === 0).map(r => r.id))];
    const templateIds = new Set([...players.keys()].filter(id => Number.isInteger(id) && id >= 10101 &&
      (id - 10101) % 100 >= 0 && (id - 10101) % 100 < CLASSES.length)), signature = saved.controller;
    const query = Promise.resolve().then(() => mod.queryData('/SkillData@huntingZoneId=?/Skill@id=?', [0, ids], true, false, ['id','templateId','name']));
    shortcutQuery = query;
    query.then(nodes => {
      if (closed || session !== context || !maySync() || !mayWrite(commonShortcuts()) || commonShortcuts().controller !== signature) return;
      if (!Array.isArray(nodes) || nodes.length > 32768) throw new Error('Unexpected shared skill catalog size');
      const result = classifyShortcutSkills(nodes, saved.templateId, templateIds, ids);
      pendingShortcuts = { ...clone(commonShortcuts()), commonSkills: result.common, catalogReady: true, unknownSkills: result.unknown.length };
      if (uiLayoutTrace.catalog) uiLayoutTrace.catalog({ templateId: saved.templateId, commonSkills: result.common, unknownSkills: result.unknown,
        definitions: nodes.slice(0,2048).map(n => n.attributes) });
      queueSave();
    }).catch(error => { if (!closed) warn('shared-shortcut-catalog', error); }).then(() => {
      if (shortcutQuery === query) {
        shortcutQuery = null;
        if (!closed && session === context && commonShortcuts().controller !== signature) classifySharedShortcuts();
      }
    });
  }
  function seedSharedShortcuts() {
    if (!maySync()) return;
    const p = profile(), shared = commonShortcuts();
    if (!shared.controller && p && p.locked && uiCompatible(p) && mayWrite(p) && sameOwner(skillOrigin(p).source, session)) {
      try {
        const controller = shortcutField(hexBuffer(p.user));
        if (controller) { pendingShortcuts = capturedShortcuts(controller, true, null); queueSave(); }
      } catch (error) { warn('shared-shortcut-seed', error); }
    }
    classifySharedShortcuts();
  }
  function keyBindings(previous) {
    const field = draft.user && document(draft.user).find(f => f.name === KEY_CONTROLLER);
    return field ? field.raw.toString('hex') : previous || null;
  }
  function uiCompatible(ui) { return ui.patch === mod.majorPatchVersion; }
  function uiPreferences(previous) {
    if (!draft.account) return previous || null;
    const parts = document(draft.account).filter(f => UI_CONTROLLERS.has(f.name));
    if (!parts.length) return previous || null;
    return captureUpdate(previous ? hexBuffer(previous) : null, Buffer.concat(parts.map(f => f.raw))).toString('hex');
  }
  function capturedUi(locked) {
    if (!uiDraft || !uiDraft.length) throw new Error('No native window layout captured. Relog after applying/closing Game Options.');
    return { locked, windows: uiWindows(uiDraft), account: uiPreferences(commonUi().account), writer: currentWriter(),
      patch: mod.majorPatchVersion, savedAt: new Date().toISOString() };
  }
  function restoreChat() { const chat = commonChat(); return chat.locked ? chat.options : draft.chat || chat.options; }
  function capturedProfile(locked, explicit = false) {
    const p = profile(), source = { name: session.name, serverId: String(session.serverId || ''),
        playerId: session.playerId == null ? null : String(session.playerId),
        accountId: session.accountId == null ? null : String(session.accountId) };
    const recordSkills = !p || (mayUseSkills(p) && (explicit ||
      (session.skillsApplied && sameOwner(skillOrigin(p).source, session))));
    const user = recordSkills ? draft.user : mergeData(draft.user, skillControllers(hexBuffer(p.user)), false, null);
    return { locked, savedAt: new Date().toISOString(), patch: mod.majorPatchVersion, source,
      writer: explicit || !p ? currentWriter() : clone(p.writer),
      skills: recordSkills ? { level: currentLevel(), source: clone(source) } : clone(skillOrigin(p)),
      account: draft.account.toString('hex'), user: user.toString('hex') };
  }
  function maySync() {
    return ready() && session.loaded && session.seen.account && session.seen.user && !diskBlocked;
  }
  function syncSettings(key) {
    if (!maySync()) return;
    const p = profile(), chat = commonChat();
    if (p && p.locked && p.patch === mod.majorPatchVersion && mayWrite(p)) pendingClasses.set(String(session.job), capturedProfile(true));
    if (key === 'account' && chat.locked && mayWrite(chat)) {
      const ui = document(draft.account).find(f => f.name === CHAT_UI);
      const value = ui ? ui.raw.toString('hex') : null;
      if (value && value !== chat.ui) pendingChat = { ...clone(chat), ui: value, savedAt: new Date().toISOString() };
    }
    const shared = commonUi();
    if (key === 'account' && shared.locked && uiCompatible(shared) && uiAutoSyncAllowed && mayWrite(shared)) {
      const account = uiPreferences(shared.account);
      if (account !== shared.account) pendingUi = { ...clone(shared), account, savedAt: new Date().toISOString() };
    }
    const keys = commonKeys();
    if (key === 'user' && keys.locked && uiCompatible(keys) && session.keysApplied && mayWrite(keys)) {
      const user = keyBindings(keys.user);
      if (user !== keys.user) pendingKeys = { ...clone(keys), user, savedAt: new Date().toISOString() };
    }
    const shortcuts = commonShortcuts();
    if (key === 'user' && p && mayUseSkills(p) && shortcuts.locked && mayWrite(shortcuts) && uiCompatible(shortcuts) && sameOwner(shortcuts.source, session) && session.skillsApplied && !session.characterBarApplied) {
      try {
        const controller = shortcutField(draft.user);
        if (controller && controller.toString('hex') !== shortcuts.controller) pendingShortcuts = capturedShortcuts(controller, true, shortcuts);
      } catch (error) { warn('shared-shortcut-save', error); }
    }
    if (pendingClasses.size || pendingChat || pendingUi || pendingKeys || pendingShortcuts) queueSave();
    seedSharedShortcuts();
  }
  function onUiReply(opcode, buffer) {
    uiAutoSyncAllowed = false;
    try {
      const incoming = readUiPacket(buffer, false);
      refreshState();
      const shared = commonUi();
      uiDraft = incoming; uiSource = 'server';
      if (!shared.locked) { uiAutoSyncAllowed = true; return; }
      if (!uiCompatible(shared)) {
        warn('ui-patch-mismatch', new Error('Shared UI belongs to a different major patch. Use vault ui save after arranging the current UI.'));
        return;
      }
      const merged = mergeUiWindows(incoming, shared.windows), packet = uiReply(buffer, merged);
      if (!packet.equals(buffer)) {
        if (mod.toClient(packet) === false) throw new Error('Shared UI was not delivered; original packet was preserved.');
        uiDraft = merged; uiSource = 'shared profile'; uiAutoSyncAllowed = true;
        return false;
      }
      uiAutoSyncAllowed = true;
    } catch (error) { uiDraft = null; uiSource = null; warn('ui-reply-layout', error); }
  }
  function onUiSave(opcode, buffer) {
    try {
      const incoming = readUiPacket(buffer, true), shared = commonUi();
      if (!incoming.length) return;
      if (mod.game.accountId != null && buffer.readBigUInt64LE(8).toString() !== String(mod.game.accountId)) {
        warn('ui-save-owner', new Error('Ignored UI save for a different account.')); return;
      }
      // Initial defaults and failed/unsupported restores must never replace a locked layout.
      if (shared.locked && (!maySync() || !uiAutoSyncAllowed || !uiCompatible(shared) || !mayWrite(shared))) return;
      uiDraft = mergeUiWindows(uiDraft || [], incoming); uiSource = 'native edit';
      if (shared.locked) {
        const windows = mergeUiWindows(shared.windows, incoming);
        if (JSON.stringify(windows) !== JSON.stringify(shared.windows)) {
          pendingUi = { ...clone(shared), windows, savedAt: new Date().toISOString() }; queueSave();
        }
      }
    } catch (error) { warn('ui-save-layout', error); }
    // The native save, including its current account ID, always continues unchanged.
  }
  function hook(name, version, callback, order = 0) {
    try { hooks.push(mod.hook(name, version, { order, filter: { fake: false } }, callback)); return true; }
    catch (error) { warn(name, error); return false; }
  }
  function onLogin(event) {
    flushPending();
    refreshState();
    const me = mod.game.me;
    const template = event.templateId;
    const job = Number.isInteger(template) ? (template - 10101) % 100 : CLASSES.indexOf(me.class);
    session = job >= 0 && job < CLASSES.length ? { job, name: event.name || me.name || '',
      playerId: event.playerId == null ? me.playerId : event.playerId,
      accountId: mod.game.accountId, serverId: event.serverId == null ? mod.serverId || mod.game.serverId : event.serverId,
      level: Number.isInteger(event.level) && event.level > 0 && event.level <= 1000 ? event.level : null,
      templateId: template, loaded: false, keysApplied: false, skillsApplied: false, characterBarApplied: false,
      barMode: 'none', userPacket: null, seen: { account: false, user: false } } : null;
    draft = { account: null, user: null, chat: state.chat.options ? clone(state.chat.options) : null };
    if (!session) warn('class-detection', new Error('Unknown class; original settings will pass through.'));
  }
  function leave() {
    uiLayoutTrace.leave();
    flushPending();
    if (saveTimer !== null) mod.clearTimeout(saveTimer); saveTimer = null;
    session = null; draft = { account: null, user: null, chat: null };
  }
  function onLoad(key, name, opcode, buffer) {
    if (!ready()) return;
    if (key === 'user') { session.keysApplied = false; session.skillsApplied = false; session.characterBarApplied = false; session.barMode = 'none'; session.userPacket = null; }
    try {
      const incoming = rawData(buffer);
      // Old files identify only their original character/server, not a class.
      // Restore only to that character until an explicit class save is made.
      const legacy = !profile() && state.legacy[session.name + '-' + session.serverId];
      const p = profile() || (legacy ? { ...legacy, locked: true, patch: mod.majorPatchVersion, source: null } : null);
      draft[key] = incoming;
      session.seen[key] = true;
      let effective = incoming;
      const chat = commonChat(), shared = commonUi(), keys = commonKeys(), shortcuts = commonShortcuts();
      const compatible = p && p.patch === mod.majorPatchVersion;
      const applySkills = !!(p && p.locked && compatible);
      const local = key === 'user' && !isBarSource() ? characterBar() : null;
      const localCompatible = local && uiCompatible(local) && local.job === session.job;
      const barPolicy = applySkills || (shortcuts.locked && shortcuts.controller && uiCompatible(shortcuts));
      let barImportOk = true;
      if (p && p.locked && !compatible) warn('patch-mismatch', new Error('Class snapshot belongs to a different major patch. Save it again before locking.'));
      if (p && p.locked && compatible) effective = mergeData(incoming, hexBuffer(p[key]), sameOwner(p.source, session),
        key === 'account' && chat.locked ? chat.ui : null, !!shared.savedAt, !!keys.savedAt, !applySkills || !!local);
      else if (key === 'account' && chat.locked && chat.ui)
        effective = mergeData(incoming, Buffer.alloc(0), false, chat.ui);
      if (key === 'account' && shared.locked && uiCompatible(shared) && shared.account)
        effective = mergeData(effective, hexBuffer(shared.account), false, null);
      const applyKeys = key === 'user' && keys.locked && uiCompatible(keys);
      if (key === 'user' && keys.locked && !uiCompatible(keys))
        warn('keys-patch-mismatch', new Error('Shared keyboard snapshot belongs to another major patch. Save current keys again before locking.'));
      if (applyKeys) effective = mergeData(effective, hexBuffer(keys.user), false, null);
      if (key === 'user' && !local && shortcuts.locked && uiCompatible(shortcuts) && (!applySkills || shortcuts.classJob !== session.job)) {
        try {
          const target = shortcutField(effective);
          if (target) {
            const merged = mergeShortcuts(target, hexBuffer(shortcuts.controller), shortcuts.commonSkills);
            effective = captureUpdate(effective, merged);
          }
        } catch (error) { barImportOk = false; warn('shared-shortcut-apply', error); }
      }
      let barReady = false;
      if (key === 'user') {
        session.userPacket = Buffer.from(buffer);
        try {
          if (!isBarSource() && barPolicy && !legacy && barImportOk) {
            completeBar(incoming);
            if (local && !localCompatible) {
              warn('character-bar-patch', new Error('Saved character bar belongs to another patch/class; use vault load after saving a compatible template.'));
            } else {
              if (local) effective = mergeData(effective, hexBuffer(local.user), false, null);
              else {
                const old = state.characterShortcuts[characterShortcutKey(session)];
                if (old && uiCompatible(old)) {
                  const target = shortcutField(effective), ids = new Set(shortcuts.commonSkills);
                  const slots = shortcutDocument(target).rows.filter(row => commonShortcut(row, ids));
                  effective = captureUpdate(effective, applyCharacterShortcuts(target, shortcutField(incoming), old.rows, slots));
                }
              }
              completeBar(effective); barReady = true;
            }
          }
        } catch (error) { warn('character-bar-apply', error); }
      }
      if (!effective.equals(incoming)) {
        const packet = replaceRaw(buffer, effective);
        if (mod.toClient(packet) !== false) {
          draft[key] = Buffer.from(effective);
          if (key === 'user') {
            session.keysApplied = applyKeys; session.skillsApplied = applySkills;
            session.characterBarApplied = barReady; session.barMode = barReady ? local ? 'character' : 'template' : 'source/native';
          }
          syncCharacterBar();
          return false;
        }
        warn(name + '-send', new Error('Replacement was not delivered; original packet was preserved.'));
      } else if (key === 'user') {
        session.keysApplied = applyKeys; session.skillsApplied = applySkills; session.characterBarApplied = barReady;
        session.barMode = barReady ? local ? 'character' : 'template' : 'source/native'; syncCharacterBar();
      }
      if (key === 'account' && effective.equals(incoming)) syncCharacterBar();
    } catch (error) { warn(name + '-layout', error); }
  }
  function onSave(key, name, opcode, buffer) {
    if (!ready()) return;
    if (!session.loaded && ((profile() && profile().locked) || (key === 'account' && commonUi().locked) ||
        (key === 'user' && (commonKeys().locked || session.characterBarApplied || commonShortcuts().locked)))) return;
    try {
      const updated = captureUpdate(draft[key], rawData(buffer));
      const changed = !draft[key] || !updated.equals(draft[key]);
      draft[key] = updated;
      if (key === 'user') syncCharacterBar();
      if (changed) syncSettings(key);
    }
    catch (error) { warn(name + '-layout', error); }
    // Native post-loading changes sync the selected class; server saving stays intact.
  }
  const required = [];
  const uiReplyReady = hook('S_REPLY_CLIENT_UI_SETTING', 'raw', onUiReply);
  const uiSaveReady = hook('C_SAVE_CLIENT_UI_SETTING', 'raw', onUiSave);
  const uiReady = uiReplyReady && uiSaveReady;
  required.push(hook('S_LOGIN', mod.majorPatchVersion >= 114 ? 15 : 14, onLogin, -9000));
  required.push(hook('C_LOAD_TOPO_FIN', 'event', () => {
    if (session) session.loaded = true;
    seedSharedShortcuts();
    syncCharacterBar();
  }));
  hook('S_LOAD_TOPO', 'event', () => { if (session) session.loaded = false; });
  for (const [key, suffix] of [['account', 'ACCOUNT'], ['user', 'USER']]) {
    const load = 'S_LOAD_CLIENT_' + suffix + '_SETTING', save = 'C_SAVE_CLIENT_' + suffix + '_SETTING';
    required.push(hook(load, 'raw', onLoad.bind(null, key, load)));
    required.push(hook(save, 'raw', onSave.bind(null, key, save)));
  }
  let chatReady = false;
  try {
    mod.dispatch.addDefinition('S_REPLY_CLIENT_CHAT_OPTION_SETTING', 0,
      parseDefinition(null, CHAT_DEFINITION), true);
    mod.dispatch.addDefinition('C_SAVE_CLIENT_CHAT_OPTION_SETTING', 0,
      parseDefinition(null, CHAT_SAVE_DEFINITION), true);
    const reply = hook('S_REPLY_CLIENT_CHAT_OPTION_SETTING', 0, event => {
      try {
        const source = restoreChat();
        if (source) { event.tabs = clone(source.tabs); event.channels = clone(source.channels); draft.chat = chatOptions(source); return true; }
        draft.chat = chatOptions(event);
      } catch (error) { warn('chat-reply', error); }
    });
    const save = hook('C_SAVE_CLIENT_CHAT_OPTION_SETTING', 0, event => {
      try {
        draft.chat = chatOptions(event);
        const chat = commonChat();
        if (maySync() && chat.locked && mayWrite(chat) && JSON.stringify(draft.chat) !== JSON.stringify(chat.options)) {
          pendingChat = { ...clone(chat), options: clone(draft.chat), savedAt: new Date().toISOString() };
          queueSave();
        }
      }
      catch (error) { warn('chat-save', error); }
    });
    const request = hook('C_REQUEST_CLIENT_CHAT_OPTION_SETTING', 'event', () => {
      const source = restoreChat();
      if (!source) return;
      try {
        if (mod.toClient('S_REPLY_CLIENT_CHAT_OPTION_SETTING', 0, chatOptions(source)) !== false) return false;
      } catch (error) { warn('chat-request', error); }
    });
    chatReady = reply && save && request;
  } catch (error) { warn('chat-definition', error); }
  mod.game.on('leave_game', leave);
  function status() {
    const effective = effectiveState(), p = profile(), chat = commonChat(), keys = commonKeys();
    const list = Object.keys(effective.classes).map(k => CLASSES[Number(k)] + (effective.classes[k].locked ? ' [sync on]' : '')).join(', ') || 'none';
    message((ready() ? CLASSES[session.job] + ': ' + (p ? p.locked ? 'LOCKED' : 'saved, unlocked' : 'not saved') : 'Enter a character first') +
      ' | shared chat: ' + (chat.locked ? 'LOCKED, auto-sync ON' : chat.options ? 'saved, unlocked' : 'not saved'));
    message('Saved classes: ' + list + '. Commands: vault save / lock / unlock / load / status.');
    message('Shared keyboard: ' + (keys.locked ? 'LOCKED, auto-sync ON' : keys.user ? 'saved, unlocked' : 'not saved') + '. Skill assignments remain per class.');
    const shortcuts = commonShortcuts();
    message('Shared item/buff shortcuts: ' + (shortcuts.locked ? 'LOCKED' : shortcuts.controller ? 'saved' : 'not saved') +
      (shortcuts.controller ? ' | common skills: ' + shortcuts.commonSkills.length + ' | catalog: ' + (shortcuts.catalogReady ? 'ready, unknown ' + shortcuts.unknownSkills : 'pending source-client lookup') : '') + '.');
    if (ready()) message('Account write access, class / keyboard / chat / UI: ' +
      [p, keys, chat, commonUi()].map(value => mayWrite(value) ? 'source' : 'read-only').join(' / ') + '.');
    if (ready()) message('Character bar: ' + (isBarSource() ? 'main template source' : characterBar() ? 'saved locally' : 'not initialized') +
      ' | active: ' + session.barMode + '. Use vault load to import the main bar template again.');
    if (ready()) message('Captured account / character / chat: ' +
      [draft.account, draft.user, draft.chat].map(value => value ? 'yes' : 'no').join(' / ') + '.');
    uiStatus();
  }
  function uiStatus() {
    const ui = commonUi();
    message('Shared UI: ' + (ui.locked ? 'LOCKED, auto-sync ON' : ui.windows.length ? 'saved, unlocked' : 'not saved') +
      ' | saved windows: ' + ui.windows.length + ' | captured: ' + (uiDraft ? uiDraft.length : 0) +
      (uiSource ? ' (' + uiSource + ')' : '') + (uiReady ? '' : ' | native UI packets unavailable') + '.');
  }
  function uiCommand(action) {
    action = String(action || 'status').toLowerCase();
    if (action === 'log' || action === 'mark') { uiLayoutTrace.command(action); return; }
    refreshState();
    if (action === 'status') { uiStatus(); return; }
    if (!['save', 'lock', 'unlock'].includes(action)) { message('Use vault ui save / lock / unlock / status / log / mark.'); return; }
    if (!ready() || !session.loaded) { message('Enter a character and finish loading before changing the shared UI profile.'); return; }
    if (!uiReady) { message('Native UI packets are unavailable; the layout was not changed.'); return; }
    if (commonUi().locked && commonUi().writer && !mayWrite(commonUi())) {
      message('Shared UI is locked by another account. Use its source account to change or unlock it.'); return;
    }
    try {
      const next = effectiveState();
      if (action === 'save') next.ui = capturedUi(next.ui.locked);
      else {
        if (!next.ui.windows.length) { message('Use vault ui save first. No shared window layout is available.'); return; }
        if (action === 'lock' && !uiCompatible(next.ui)) throw new Error('Save the current UI again after this major patch.');
        next.ui.locked = action === 'lock';
        if (action === 'lock') next.ui.writer = currentWriter();
      }
      persist(next); clearPending();
      if (action === 'lock' || action === 'save') uiAutoSyncAllowed = !!uiDraft;
      uiStatus();
      if (action === 'save') message('Shared UI saved. Use vault ui lock to apply it across all classes/accounts.');
    } catch (error) { warn('ui-profile-write', error); message('Shared UI operation failed: ' + error.message); }
  }
  function command(action, detail) {
    if (String(action || '').toLowerCase() === 'ui') { uiCommand(detail); return; }
    if (String(action || '').toLowerCase() === 'minimap' && String(detail || '').toLowerCase() === 'pin') {
      message('Minimap setup is automatic for supported clients at a safe startup. Check the Toolbox window for its result. Restart Toolbox before launching TERA; minimap.cmd is only for recovery or manual setup.');
      return;
    }
    refreshState();
    action = String(action || 'status').toLowerCase();
    if (action === 'status') return status();
    if (!['save', 'lock', 'unlock', 'load'].includes(action)) { message('Use vault save, vault lock, vault unlock, vault load or vault status.'); return; }
    if (!ready()) { message('Enter a character before changing profiles.'); return; }
    if (diskBlocked) { message('Profile file could not be read safely. Check the Toolbox warning; no saved data was overwritten.'); return; }
    if (!required.every(Boolean) || !chatReady) { message('Required settings packets are unavailable. Nothing was saved or locked; check the Toolbox warning.'); return; }
    if (action === 'load') { loadBar(); return; }
    const key = String(session.job), p = profile(), next = effectiveState();
    if ([p, next.keys, next.chat, next.ui, next.shortcuts].some(value => value && value.locked && value.writer && !mayWrite(value))) {
      message('These profiles are locked by another account. Its source account controls saving and unlocking. This account only receives them.'); return;
    }
    if (p && p.locked && !p.writer && p.source.accountId !== String(session.accountId)) {
      message('Use the original source account to confirm ownership of this older class profile. Nothing was changed.'); return;
    }
    try {
      if (action === 'save') {
        if (!draft.account || !draft.user || !document(draft.account).some(f => f.name) || !document(draft.user).some(f => f.name)) {
          message('Account/user settings have not been captured yet. Relog, apply and close Game Options, then use vault save.'); return;
        }
        const chat = next.chat.locked ? next.chat.options : draft.chat;
        if (!chat) { message('Apply and close Chat Settings once, then use vault save. Nothing was saved.'); return; }
        next.classes[key] = capturedProfile(!!(p && p.locked), true);
        if (!next.chat.locked) {
          const ui = document(draft.account).find(f => f.name === CHAT_UI);
          next.chat = { locked: false, savedAt: new Date().toISOString(), options: chatOptions(chat), ui: ui ? ui.raw.toString('hex') : null, writer: currentWriter() };
        }
        if (uiReady && uiDraft && uiDraft.length && !next.ui.locked) next.ui = capturedUi(false);
        if (!next.keys.locked) {
          const user = keyBindings(null);
          if (user) next.keys = { locked: false, user, patch: mod.majorPatchVersion, savedAt: new Date().toISOString(), writer: currentWriter() };
        }
        if (!next.shortcuts.locked) {
          try { const controller = shortcutField(draft.user); if (controller) next.shortcuts = capturedShortcuts(controller, false, next.shortcuts); }
          catch (error) { warn('shared-shortcut-capture', error); }
        }
        for (const shared of [next.chat, next.ui, next.keys]) if (shared.locked && !shared.writer) shared.writer = currentWriter();
        persist(next); clearPending();
        seedSharedShortcuts();
        message('Saved ' + CLASSES[session.job] + ' settings and ' + (state.chat.locked ? 'kept synced shared chat' : 'shared chat') +
          (state.classes[key].locked ? '. Lock and automatic sync remain ON.' : '. Use vault lock for automatic application and saving of future edits.'));
        message(state.ui.windows.length ? 'Shared UI: ' + state.ui.windows.length + ' windows saved.' :
          'No native window layout captured yet. Relog after applying/closing Game Options, then use vault ui save.');
        message(state.keys.user ? 'Shared keyboard ' + (state.keys.locked ? 'kept locked and synced.' : 'saved; vault lock enables it for all classes.') :
          'Keyboard settings not captured yet. Apply/close key settings, then use vault save.');
        if (p && !mayUseSkills(p)) message('Existing skill template preserved: this character cannot replace its higher-level source.');
      } else {
        if (!p || !next.chat.options) { message('Use vault save first. No complete profile is available to lock.'); return; }
        next.classes[key].locked = action === 'lock'; next.chat.locked = action === 'lock';
        if (action === 'lock') for (const saved of [next.classes[key], next.chat, next.ui, next.keys, next.shortcuts])
          if (!saved.writer) saved.writer = currentWriter();
        if (next.ui.windows.length) {
          if (action === 'lock' && !uiCompatible(next.ui)) throw new Error('Save the current UI again after this major patch.');
          next.ui.locked = action === 'lock';
        }
        if (next.keys.user) {
          if (action === 'lock' && !uiCompatible(next.keys)) throw new Error('Save the current keyboard again after this major patch.');
          next.keys.locked = action === 'lock';
        }
        if (next.shortcuts.controller) {
          if (action === 'lock' && !uiCompatible(next.shortcuts)) throw new Error('Save current shortcuts after this major patch.');
          next.shortcuts.locked = action === 'lock';
        }
        persist(next); clearPending();
        if (action === 'unlock') { session.characterBarApplied = false; session.barMode = 'source/native'; }
        session.keysApplied = action === 'lock' && !!state.keys.user && keyBindings(null) === state.keys.user;
        session.skillsApplied = action === 'lock' && !!draft.user && mayUseSkills(state.classes[key]) &&
          skillControllers(draft.user).equals(skillControllers(hexBuffer(state.classes[key].user)));
        if (action === 'lock' && uiDraft) uiAutoSyncAllowed = true;
        seedSharedShortcuts();
        message(CLASSES[session.job] + ' profile, shared chat and saved keyboard ' + (action === 'lock' ? 'LOCKED: auto-apply and auto-sync ON. In-game changes will save automatically.' : 'unlocked. Automatic application/saving is OFF; use vault save for a manual snapshot.'));
        if (state.ui.windows.length) uiStatus();
      }
    } catch (error) { warn('profile-write', error); message('Profile operation failed. Previous saved data was preserved; check the Toolbox warning.'); }
  }
  mod.command.add('vault', command);
  this.destructor = () => {
    uiLayoutTrace.close();
    closed = true; leave(); mod.game.removeListener('leave_game', leave);
    for (const h of hooks) mod.unhook(h);
    mod.command.remove('vault');
  };
};

module.exports.NetworkMod = module.exports;
module.exports.GlobalMod = require('./lib/minimap-auto').GlobalMod;
module.exports.ClientMod = require('./lib/minimap-auto').ClientMod;
