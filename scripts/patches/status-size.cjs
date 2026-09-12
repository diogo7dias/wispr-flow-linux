#!/usr/bin/env node
// Scale only the status surface, keeping its bottom-center anchor unchanged.
const fs = require('node:fs');
const file = process.argv[2];
const marker = 'WISPR_LINUX_STATUS_SIZE_70';
let html = fs.readFileSync(file, 'utf8');
if (html.includes(marker)) process.exit(0);
html = html.replace(/<style id="WISPR_LINUX_STATUS_HALF_SIZE">[\s\S]*?<\/style>/, '');
if (html.split('</head>').length !== 2) throw new Error('Expected one HTML head');
html = html.replace('</head>', `<style id="${marker}">
body { width:100vw; height:100vh; margin:0; transform:scale(0.7); transform-origin:bottom center; }
</style></head>`);
fs.writeFileSync(file, html);
