#!/usr/bin/env node
// Personal-install tool: rewrite one file inside a packed app.asar while
// preserving every other entry byte-for-byte, including the `unpacked` flags
// whose payloads live in app.asar.unpacked beside the archive.
//
// Rebuilding from an extracted tree cannot do this: `asar extract` writes
// placeholders for unpacked entries, so a plain `asar pack` would replace real
// native modules with 90-byte stubs.
//
// Usage: repack-asar.cjs <source.asar> <archive-path> <replacement-file> <out.asar>
'use strict';
const fs = require('node:fs');
const {createHash} = require('node:crypto');

const [source, target, replacement, output] = process.argv.slice(2);
if (!source || !target || !replacement || !output) {
  console.error('Usage: repack-asar.cjs <source.asar> <archive-path> ' +
    '<replacement-file> <out.asar>');
  process.exit(1);
}

const BLOCK = 4194304;

function integrity(data) {
  const blocks = [];
  for (let at = 0; at < data.length || !blocks.length; at += BLOCK)
    blocks.push(createHash('sha256').update(data.subarray(at, at + BLOCK)).digest('hex'));
  // `hash` is the whole-file digest; `blocks` covers it in 4 MiB slices. The
  // archive reader validates both, so neither may be omitted.
  return {
    algorithm: 'SHA256',
    hash: createHash('sha256').update(data).digest('hex'),
    blockSize: BLOCK,
    blocks,
  };
}

const archive = fs.readFileSync(source);
// ASAR pickle header: uint32 payload length at 4, JSON length at 12.
const dataStart = 8 + archive.readUInt32LE(4);
const jsonLength = archive.readUInt32LE(12);
if (dataStart > archive.length || jsonLength > dataStart - 16)
  throw new Error('Invalid ASAR header');
const header = JSON.parse(archive.subarray(16, 16 + jsonLength).toString());

const packed = [];
let replaced = 0;

function visit(files, prefix = '') {
  for (const [name, entry] of Object.entries(files)) {
    const relative = prefix + name;
    if (entry.files) {
      visit(entry.files, relative + '/');
      continue;
    }
    if (entry.unpacked) continue;
    const offset = Number(entry.offset);
    let data = archive.subarray(dataStart + offset, dataStart + offset + entry.size);
    if (relative === target) {
      data = fs.readFileSync(replacement);
      replaced++;
    }
    packed.push({entry, data});
  }
}
visit(header.files);
if (replaced !== 1)
  throw new Error(`Expected exactly one ${target} in the archive, found ${replaced}`);

let cursor = 0;
for (const {entry, data} of packed) {
  entry.size = data.length;
  entry.offset = String(cursor);
  entry.integrity = integrity(data);
  cursor += data.length;
}

const json = Buffer.from(JSON.stringify(header), 'utf8');
// Pickle layout, matching @electron/asar: uint32 payload, uint32 string
// payload, uint32 string length, then the JSON padded to four bytes, then the
// packed file data. Electron computes the data start as 8 + the second field.
const padding = (4 - (json.length % 4)) % 4;
const stringPayload = 4 + json.length + padding;
const out = Buffer.alloc(16 + json.length + padding + cursor);
out.writeUInt32LE(4, 0);
out.writeUInt32LE(4 + stringPayload, 4);
out.writeUInt32LE(stringPayload, 8);
out.writeUInt32LE(json.length, 12);
json.copy(out, 16);
let at = 16 + json.length + padding;
for (const {data} of packed) {
  data.copy(out, at);
  at += data.length;
}
fs.writeFileSync(output, out);
console.log(`Repacked ${packed.length} entries, replaced ${target}, ${out.length} bytes.`);
