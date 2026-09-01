import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGeneratedCandidate } from '../static/js/batch-level-generator.js';
import { EditorStore } from '../static/js/editor-store.js';
import { assets, config, globalDocument } from './project-config-fixture.mjs';

const level = (number, familyIndex) => ({
  ...buildGeneratedCandidate({ seed: 'store', attempt: familyIndex, number, platformType: 'single-5', familyIndex, assets }).level,
  fileName: `level-${number}.json`,
  filePath: `level/level-${number}.json`,
});

test('generated levels are accepted atomically as new dirty levels', () => {
  const store = new EditorStore({ globalDocument, config, assets, levels: [level(1, 0)] });
  const accepted = store.acceptGeneratedLevels([level(101, 1), level(102, 2)]);

  assert.deepEqual(accepted.map(item => item.levelNumber), [101, 102]);
  assert.equal(store.levels.length, 3);
  assert.equal(store.dirty, true);
  assert.deepEqual([...store.newLevelPaths].sort(), ['level/level-101.json', 'level/level-102.json']);
  assert.equal(store.history.length, 1, 'one batch is one undo transaction');
});

test('a conflict rejects the whole generated batch without dirtying the store', () => {
  const store = new EditorStore({ globalDocument, config, assets, levels: [level(1, 0)] });
  const before = structuredClone(store.levels);

  assert.throws(() => store.acceptGeneratedLevels([level(101, 1), level(1, 2)]), /编号已存在/);
  assert.deepEqual(store.levels, before);
  assert.equal(store.dirty, false);
  assert.equal(store.history.length, 0);
});

