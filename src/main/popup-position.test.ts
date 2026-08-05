import * as assert from 'node:assert/strict';
import { computePopupBounds } from './popup-position';

const workArea = { x: 0, y: 25, width: 1440, height: 875 };

assert.deepEqual(
  computePopupBounds({
    platform: 'win32',
    trayBounds: null,
    workArea,
    width: 380,
    height: 680,
  }),
  { x: 1048, y: 208, width: 380, height: 680 },
);

assert.deepEqual(
  computePopupBounds({
    platform: 'darwin',
    trayBounds: { x: 1200, y: 0, width: 24, height: 24 },
    workArea,
    width: 380,
    height: 680,
  }),
  { x: 1022, y: 33, width: 380, height: 680 },
);

assert.deepEqual(
  computePopupBounds({
    platform: 'darwin',
    trayBounds: { x: 4, y: 0, width: 20, height: 24 },
    workArea,
    width: 380,
    height: 680,
  }),
  { x: 12, y: 33, width: 380, height: 680 },
  'left-edge menu items remain on screen',
);

console.log('popup-position: all tests passed');
