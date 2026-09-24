#!/usr/bin/env node
// Compares two app.asar archives entry by entry: paths, unpacked flags, sizes
// and content hashes. Used to prove a repack changed only what was intended.
// Usage: diff-asar.cjs <original.asar> <rebuilt.asar>
'use strict';
const fs = require('node:fs');
const {createHash} = require('node:crypto');

function read(file) {
  const archive = fs.readFileSync(file);
  const dataStart = 8 + archive.readUInt32LE(4);
  const jsonLength = archive.readUInt32LE(12);
  const header = JSON.parse(archive.subarray(16, 16 + jsonLength).toString());
  const entries = new Map();
  (function visit(files, prefix) {
    for (const [name, entry] of Object.entries(files)) {
      const relative = prefix + name;
      if (entry.files) { visit(entry.files, relative + '/'); continue; }
      entries.set(relative, {
        unpacked: entry.unpacked === true,
        size: entry.size,
        hash: entry.unpacked
          ? null
          : createHash('sha256')
            .update(archive.subarray(dataStart + Number(entry.offset),
              dataStart + Number(entry.offset) + entry.size))
            .digest('hex'),
      });
    }
  })(header.files, '');
  return {archive, entries};
}

const [before, after] = process.argv.slice(2);
if (!before || !after) {
  console.error('Usage: diff-asar.cjs <original.asar> <rebuilt.asar>');
  process.exit(1);
}
const a = read(before), b = read(after);
const onlyA = [...a.entries.keys()].filter(key => !b.entries.has(key));
const onlyB = [...b.entries.keys()].filter(key => !a.entries.has(key));
const changed = [], flagFlips = [];
for (const [key, entry] of a.entries) {
  const other = b.entries.get(key);
  if (!other) continue;
  if (entry.unpacked !== other.unpacked) flagFlips.push(key);
  else if (entry.hash && entry.hash !== other.hash) changed.push(key);
}
console.log(`entries: ${a.entries.size} -> ${b.entries.size}`);
console.log(`unpacked: ${[...a.entries.values()].filter(e => e.unpacked).length} -> ` +
  `${[...b.entries.values()].filter(e => e.unpacked).length}`);
console.log('only in original:', onlyA.length ? onlyA : 'none');
console.log('only in rebuilt:', onlyB.length ? onlyB : 'none');
console.log('unpacked flag flips:', flagFlips.length ? flagFlips : 'none');
console.log('changed content:', changed.length ? changed : 'none');
