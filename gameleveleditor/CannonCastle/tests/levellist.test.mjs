import assert from 'node:assert/strict';
import test from 'node:test';

import { LEVEL_FILE_PATTERN, sortLevelFiles } from '../levellist.js';

test('latest-template level discovery includes generated originals in numeric order', () => {
  assert.equal(LEVEL_FILE_PATTERN.test('level-12.json'), true);
  assert.equal(LEVEL_FILE_PATTERN.test('original-01-level-01.json'), true);
  assert.deepEqual(
    sortLevelFiles(['notes.txt', 'level-10.json', 'level-2.json', 'original-01-level-01.json']),
    ['original-01-level-01.json', 'level-2.json', 'level-10.json'],
  );
});
