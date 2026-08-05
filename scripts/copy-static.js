// Copies every renderer shell from source into dist. Keeping all HTML here
// makes a clean build independent of stale or previously tracked dist output.
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
