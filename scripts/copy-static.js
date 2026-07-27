// Copies static renderer shells (src/renderer/*.html) into dist/renderer.
// index.html and badge.html predate this script and live only in dist/ on
// dev machines; new windows should keep their shell in src/renderer so a
// clean checkout still builds a complete dist.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'renderer');
const out = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(src)) {
  if (f.endsWith('.html')) {
    fs.copyFileSync(path.join(src, f), path.join(out, f));
    console.log(`copied ${f} -> dist/renderer/`);
  }
}
