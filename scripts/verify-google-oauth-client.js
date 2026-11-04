const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '../assets/google-oauth-client.json');
let client;
try { client = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error('Release requires assets/google-oauth-client.json. Provision the Inwise Desktop OAuth client before packaging.'); }
if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(client.clientId || '') || !client.clientSecret?.trim()) throw Error('Invalid Google Desktop OAuth configuration');
if (Object.keys(client).some(key => /token/i.test(key))) throw Error('Release configuration must never contain user tokens');
console.log('Google Desktop OAuth release configuration verified (no user tokens).');
