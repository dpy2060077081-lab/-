import assert from 'node:assert/strict';
import test from 'node:test';

test('editor boots desktop mode when the pywebview file bridge already exists', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let bridgeCalls = 0;
  globalThis.window = {
    location: { protocol: 'file:' },
    pywebview: { api: { files: new Proxy({}, { get: () => async () => { bridgeCalls += 1; throw new Error('probe'); } }) } },
    addEventListener() {},
  };
  globalThis.document = { querySelector: () => ({ textContent: '', dataset: {} }) };
  try {
    await import(`../static/js/editor.js?early-bridge=${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(bridgeCalls > 0, 'the existing desktop bridge was ignored');
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

