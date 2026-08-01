import * as assert from 'assert';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  installDisplayMediaHandler,
  installSessionPermissionHandlers,
  isTrustedRendererUrl,
} from './session-permissions';

const rendererDirectory = path.resolve('dist', 'renderer');

assert.equal(isTrustedRendererUrl('app://bundle/index.html', rendererDirectory), true);
assert.equal(isTrustedRendererUrl('app://other/index.html', rendererDirectory), false);
assert.equal(isTrustedRendererUrl('https://example.com', rendererDirectory), false);
assert.equal(isTrustedRendererUrl(pathToFileURL(path.join(rendererDirectory, 'badge.html')).toString(), rendererDirectory), true);
assert.equal(isTrustedRendererUrl(pathToFileURL(path.resolve(rendererDirectory, '..', 'main', 'main.js')).toString(), rendererDirectory), false);
assert.equal(isTrustedRendererUrl('not a url', rendererDirectory), false);

async function testHandlers(): Promise<void> {
  let requestHandler: any;
  let checkHandler: any;
  let displayHandler: any;
  let displayOptions: any;
  const fakeSession = {
    setPermissionRequestHandler: (handler: any) => { requestHandler = handler; },
    setPermissionCheckHandler: (handler: any) => { checkHandler = handler; },
    setDisplayMediaRequestHandler: (handler: any, options: any) => {
      displayHandler = handler;
      displayOptions = options;
    },
  } as any;

  installSessionPermissionHandlers(fakeSession, rendererDirectory);
  const trustedContents = { getURL: () => 'app://bundle/index.html' };
  const remoteContents = { getURL: () => 'https://example.com' };
  let granted: boolean | undefined;
  requestHandler(trustedContents, 'media', (value: boolean) => { granted = value; });
  assert.equal(granted, true);
  requestHandler(trustedContents, 'display-capture', (value: boolean) => { granted = value; });
  assert.equal(granted, true);
  requestHandler(trustedContents, 'speaker-selection', (value: boolean) => { granted = value; });
  assert.equal(granted, true);
  requestHandler(trustedContents, 'clipboard-sanitized-write', (value: boolean) => { granted = value; });
  assert.equal(granted, true);
  requestHandler(remoteContents, 'media', (value: boolean) => { granted = value; });
  assert.equal(granted, false);
  requestHandler(remoteContents, 'speaker-selection', (value: boolean) => { granted = value; });
  assert.equal(granted, false);
  requestHandler(remoteContents, 'clipboard-sanitized-write', (value: boolean) => { granted = value; });
  assert.equal(granted, false);
  requestHandler(trustedContents, 'notifications', (value: boolean) => { granted = value; });
  assert.equal(granted, false);
  assert.equal(checkHandler(trustedContents, 'media'), true);
  assert.equal(checkHandler(trustedContents, 'clipboard-sanitized-write'), true);
  assert.equal(checkHandler(trustedContents, 'geolocation'), false);
  assert.equal(checkHandler(remoteContents, 'media'), false);

  let sourceRequests = 0;
  const source = { id: 'screen:1:0' } as any;
  installDisplayMediaHandler(fakeSession, rendererDirectory, async () => {
    sourceRequests += 1;
    return source;
  });
  assert.deepEqual(displayOptions, { useSystemPicker: false });

  let streams: any;
  await displayHandler(
    { frame: { url: 'app://bundle/index.html' } },
    (value: any) => { streams = value; },
  );
  assert.equal(streams.video, source);
  assert.equal(streams.audio, 'loopback');
  assert.equal(sourceRequests, 1);

  await displayHandler(
    { frame: { url: 'https://example.com' } },
    (value: any) => { streams = value; },
  );
  assert.deepEqual(streams, {});
  assert.equal(sourceRequests, 1, 'untrusted renderers never reach source selection');
}

testHandlers()
  .then(() => console.log('session-permissions: all tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
