import assert from 'node:assert/strict';
import test from 'node:test';

import * as editor from '../static/js/editor.js';

test('editor routes explosion snapshots and out-of-arc results into presentation effects', () => {
  const calls = [];
  const effects = {
    ingestExplosions(events) { calls.push(['explosions', events]); },
    showOutOfArc() { calls.push(['out-of-arc']); },
  };
  const explosionEvents = [{ position: { x: 4, y: 5 }, radius: 3 }];

  assert.equal(typeof editor.applyPlayExplosionFeedback, 'function');
  assert.equal(typeof editor.applyPlayFireFeedback, 'function');
  editor.applyPlayExplosionFeedback(effects, { explosionEvents });
  assert.equal(editor.applyPlayFireFeedback(effects, 'fired'), 'fired');
  assert.equal(editor.applyPlayFireFeedback(effects, 'out-of-arc'), 'out-of-arc');

  assert.deepEqual(calls, [
    ['explosions', explosionEvents],
    ['out-of-arc'],
  ]);
});

test('presentation reset clears the complete effect owner through one lifecycle call', () => {
  const calls = [];
  editor.resetPlayPresentation({ reset() { calls.push('reset'); } });
  assert.deepEqual(calls, ['reset']);
});

test('formal asset readiness redraws after success and degrades after rejection', async () => {
  const ready = [];
  const warnings = [];
  const document = { marker: 'document' };
  assert.equal(await editor.loadPlayPresentationAssets({
    document,
    load: async received => { assert.equal(received, document); },
    onReady: () => ready.push('success'),
    onWarning: warning => warnings.push(warning),
  }), true);
  assert.equal(await editor.loadPlayPresentationAssets({
    document,
    load: async () => { throw new Error('decode failed'); },
    onReady: () => ready.push('fallback'),
    onWarning: warning => warnings.push(warning),
  }), false);

  assert.deepEqual(ready, ['success', 'fallback']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /decode failed/);
});
