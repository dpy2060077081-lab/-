import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  cloneLevel,
  patchLevel,
  serializeLevel,
  validateLevelShape,
} from '../static/js/level-config.js';

const fixtureUrl = new URL('./fixtures/legacy-level.json', import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

test('round-trips every legacy value and unknown extension fields', async () => {
  const input = await loadFixture();
  input.vendorExtension = { revision: 7, flags: ['keep', 'all'] };
  input.castle[0].vendorPhysics = { densityHint: 2.75, lockedBy: 'fixture' };

  const result = JSON.parse(serializeLevel(cloneLevel(input)));

  assert.deepEqual(result, input);
  assert.notStrictEqual(result, input);
  assert.notStrictEqual(result.castle[0], input.castle[0]);
});

test('patches only requested paths without mutating or normalizing unrelated data', async () => {
  const original = await loadFixture();
  original.vendorExtension = { preserve: { nested: true } };
  original.castle[1].vendorPhysics = { referenceFrame: 'legacy' };

  const patched = patchLevel(original, {
    'global.initialAmmo': 21,
    'castle.0.angle': Math.PI / 2,
  });

  assert.equal(patched.global.initialAmmo, 21);
  assert.equal(patched.castle[0].angle, Math.PI / 2);
  assert.equal(original.global.initialAmmo, 15);
  assert.equal(original.castle[0].angle, 0);
  assert.deepEqual(patched.vendorExtension, { preserve: { nested: true } });
  assert.deepEqual(patched.castle[1].vendorPhysics, { referenceFrame: 'legacy' });
  assert.notStrictEqual(patched, original);
  assert.notStrictEqual(patched.global, original.global);
  assert.notStrictEqual(patched.castle, original.castle);
  assert.notStrictEqual(patched.castle[0], original.castle[0]);
  assert.strictEqual(patched.castle[1], original.castle[1]);
});

test('rejects prototype-only patch paths', async () => {
  const level = await loadFixture();

  assert.throws(
    () => patchLevel(level, { toString: 'not an own level field' }),
    /Cannot patch missing path: toString/,
  );
});

test('rejects invalid top-level and castle structural shapes without rewriting valid input', async () => {
  const level = await loadFixture();
  const before = structuredClone(level);

  assert.deepEqual(validateLevelShape(level), { valid: true, errors: [] });
  assert.deepEqual(level, before);

  const invalidTopLevel = { ...level, global: [] };
  const invalidCastle = { ...level, castle: [{ ...level.castle[0], shape: null }] };
  const invalidBox = {
    ...level,
    castle: [{ ...level.castle[0], shape: { ...level.castle[0].shape, width: 'wide' } }],
  };
  const invalidPolygon = {
    ...level,
    castle: [{ ...level.castle[4], shape: { ...level.castle[4].shape, vertices: {} } }],
  };

  assert.equal(validateLevelShape(invalidTopLevel).valid, false);
  assert.equal(validateLevelShape(invalidCastle).valid, false);
  assert.equal(validateLevelShape(invalidBox).valid, false);
  assert.equal(validateLevelShape(invalidPolygon).valid, false);
  assert.equal(validateLevelShape({ ...level, castle: [{ ...level.castle[0], shape: { kind: 'circle', radius: 0 } }] }).valid, false);
  assert.equal(validateLevelShape({ ...level, castle: [{ ...level.castle[0], shape: { kind: 'capsule', radius: 1 } }] }).valid, false);
});
