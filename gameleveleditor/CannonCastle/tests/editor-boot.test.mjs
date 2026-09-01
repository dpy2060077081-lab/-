import assert from 'node:assert/strict';
import test from 'node:test';
import { createEditorBootCoordinator } from '../static/js/editor-boot.js';

function fakeWindow(protocol, files = null) {
  const listeners = new Map();
  return {
    location: { protocol },
    ...(files ? { pywebview: { api: { files } } } : {}),
    addEventListener(type, listener) { listeners.set(type, listener); },
    emit(type) { return listeners.get(type)?.(); },
  };
}

test('boot coordinator handles bridges present before module startup', async () => {
  const calls = [];
  const window = fakeWindow('file:', {});
  const coordinator = createEditorBootCoordinator({ window, startDesktop: () => calls.push('desktop'), startBrowser: () => calls.push('browser') });
  await coordinator.start();
  assert.deepEqual(calls, ['desktop']);
});

test('file pages wait indefinitely for a delayed desktop bridge', async () => {
  const calls = [];
  const window = fakeWindow('file:');
  const coordinator = createEditorBootCoordinator({ window, startDesktop: () => calls.push('desktop'), startBrowser: () => calls.push('browser') });
  await coordinator.start();
  await new Promise(resolve => setTimeout(resolve, 520));
  assert.deepEqual(calls, []);
  window.pywebview = { api: { files: {} } };
  await window.emit('pywebviewready');
  assert.deepEqual(calls, ['desktop']);
});

test('http pages start browser mode and successful mounting is idempotent', async () => {
  const calls = [];
  const window = fakeWindow('https:');
  const coordinator = createEditorBootCoordinator({ window, startDesktop: () => calls.push('desktop'), startBrowser: () => calls.push('browser') });
  await coordinator.start();
  await coordinator.start();
  assert.deepEqual(calls, ['browser']);
});

test('a failed start does not block a later desktop bridge', async () => {
  const calls = [];
  const window = fakeWindow('https:');
  const coordinator = createEditorBootCoordinator({
    window,
    startBrowser: () => { calls.push('browser'); return false; },
    startDesktop: () => calls.push('desktop'),
  });
  await coordinator.start();
  window.pywebview = { api: { files: {} } };
  await window.emit('pywebviewready');
  assert.deepEqual(calls, ['browser', 'desktop']);
});

test('desktop takeover is replayed when its bridge arrives during a pending failed browser boot', async () => {
  const calls = [];
  const window = fakeWindow('https:');
  let finishBrowser;
  const browser = new Promise(resolve => { finishBrowser = resolve; });
  const coordinator = createEditorBootCoordinator({
    window,
    startBrowser: () => { calls.push('browser'); return browser; },
    startDesktop: () => { calls.push('desktop'); return true; },
  });
  const started = coordinator.start();
  window.pywebview = { api: { files: {} } };
  const bridge = window.emit('pywebviewready');
  finishBrowser(false);
  assert.equal(await started, true);
  assert.equal(await bridge, true);
  assert.deepEqual(calls, ['browser', 'desktop']);
});

