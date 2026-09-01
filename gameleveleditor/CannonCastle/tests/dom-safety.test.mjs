import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { levelCardMarkup } from '../static/js/editor.js';

test('editor never sends dynamic project data through innerHTML', async () => {
  const source = await readFile(new URL('../static/js/editor.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /insertAdjacentHTML|document\.write/);
});

test('legacy level-card serialization escapes every dynamic text and attribute context', () => {
  const attack = '\"><img src=x onerror=globalThis.__injected=true>';
  const markup = levelCardMarkup({
    levelNumber: 1,
    levelName: attack,
    fileName: attack,
    filePath: `level/${attack}.json`,
    workspaceId: attack,
    castle: [],
  }, { assets: {}, currentLevelId: attack, writable: false });

  assert.doesNotMatch(markup, /<img/i);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /&quot;&gt;&lt;img/);
});
