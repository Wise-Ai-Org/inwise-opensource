// Copies the versioned NSIS installer to the stable asset name the website
// links to (https://github.com/.../releases/latest/download/Inwise-Setup-Windows.exe).
// Runs automatically after `npm run dist:win`; upload BOTH files to the release.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'release-v2');
const version = require('../package.json').version;
const src = path.join(dir, `Inwise-Setup-${version}.exe`);
const dest = path.join(dir, 'Inwise-Setup-Windows.exe');

if (!fs.existsSync(src)) {
  console.error(`stable-installer: ${src} not found — did electron-builder run?`);
  process.exit(1);
}
fs.copyFileSync(src, dest);
console.log(`stable-installer: Inwise-Setup-${version}.exe -> Inwise-Setup-Windows.exe`);
