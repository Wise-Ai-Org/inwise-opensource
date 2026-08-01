import * as assert from 'node:assert/strict';
import { createLoginItemRegistration, shouldStartHidden } from './login-item';

assert.deepEqual(createLoginItemRegistration('darwin', true), { openAtLogin: true });
assert.deepEqual(createLoginItemRegistration('darwin', false), { openAtLogin: false });
assert.deepEqual(createLoginItemRegistration('win32', true), {
  openAtLogin: true,
  args: ['--hidden'],
});
assert.deepEqual(createLoginItemRegistration('win32', false), {
  openAtLogin: false,
  args: ['--hidden'],
});

assert.equal(shouldStartHidden('darwin', false, { wasOpenedAtLogin: true }), true);
assert.equal(shouldStartHidden('darwin', false, { wasOpenedAsHidden: true }), true);
assert.equal(shouldStartHidden('darwin', false, {}), false);
assert.equal(shouldStartHidden('darwin', true, {}), true);
assert.equal(shouldStartHidden('win32', false, { wasOpenedAtLogin: true }), false);
assert.equal(shouldStartHidden('win32', true, {}), true);

console.log('login-item: all tests passed');
