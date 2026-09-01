import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEVEL_FIELD_DEFINITIONS,
  levelExtensionValues,
  mergeLevelExtensionValues,
  parseLevelFieldValue,
} from '../static/js/level-fields.js';

const level = {
  levelNumber: 7,
  levelName: '桥头',
  difficulty: 'hard',
  description: '说明',
  normalAmmo: 8,
  explosiveAmmo: 2,
  splitAmmo: 3,
  blackHoleAmmo: 1,
  platformType: 'double-2',
  castle: [],
  fileName: 'level-7.json',
  filePath: 'level/level-7.json',
  workspaceId: 'level/level-7.json',
  bonus: 3,
};

test('known level definitions cover every direct level control', () => {
  assert.deepEqual(LEVEL_FIELD_DEFINITIONS.map(field => field.id), [
    'levelName',
    'levelNumber',
    'difficulty',
    'description',
    'normalAmmo',
    'explosiveAmmo',
    'splitAmmo',
    'blackHoleAmmo',
    'platformType',
  ]);
});

test('extension projection excludes controlled fields, castle, and editor metadata', () => {
  assert.deepEqual(levelExtensionValues(level), { bonus: 3 });
  assert.deepEqual(mergeLevelExtensionValues(level, { bonus: 4, wave: 2 }), {
    bonus: 4,
    wave: 2,
  });
});

test('typed parsing accepts supported values and rejects invalid level inputs', () => {
  assert.equal(parseLevelFieldValue('normalAmmo', '12'), 12);
  assert.equal(parseLevelFieldValue('splitAmmo', '4'), 4);
  assert.equal(parseLevelFieldValue('description', '新的说明'), '新的说明');
  assert.throws(() => parseLevelFieldValue('explosiveAmmo', '-1'), /非负整数/);
  assert.throws(() => parseLevelFieldValue('blackHoleAmmo', '-1'), /非负整数/);
  assert.throws(() => parseLevelFieldValue('levelNumber', '1.5'), /非负整数/);
  assert.throws(() => parseLevelFieldValue('platformType', 'unknown'), /平台类型/);
  assert.throws(() => mergeLevelExtensionValues(level, { castle: [] }), /不能覆盖/);
});
