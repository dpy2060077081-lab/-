import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { downloadLevel, parseImportedFiles, safeLevelFilename } from '../static/js/file-transfer.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/legacy-level.json', import.meta.url), 'utf8'));
const importedFile = (name, value) => ({
  name,
  async text() { return typeof value === 'string' ? value : JSON.stringify(value); },
});

test('parseImportedFiles accepts valid levels and preserves unknown fields', async () => {
  const extended = structuredClone(fixture);
  extended.future = { enabled: true };
  extended.castle[0].plugin = { channel: 'alpha' };

  const result = await parseImportedFiles([importedFile(' Observatory ?.JSON ', extended)]);

  assert.equal(result.ok, true);
  assert.equal(result.data[0].filename, 'observatory.json');
  assert.deepEqual(result.data[0].level, extended);
  assert.notStrictEqual(result.data[0].level, extended);
});

test('parseImportedFiles rejects duplicate normalized file identities', async () => {
  const result = await parseImportedFiles([
    importedFile('Castle?.json', fixture),
    importedFile('castle*.JSON', fixture),
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DUPLICATE_IMPORT');
  assert.match(result.error.message, /重复/);
});

test('canonical identities normalize Unicode consistently and escape Windows reserved basenames', async () => {
  assert.equal(safeLevelFilename('Caf\u00e9.JSON'), 'cafe.json');
  assert.equal(safeLevelFilename('Cafe\u0301.json'), 'cafe.json');
  for (const reserved of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9']) {
    assert.equal(safeLevelFilename(`${reserved}.json`), `level-${reserved.toLowerCase()}.json`);
  }

  const duplicate = await parseImportedFiles([
    importedFile('Caf\u00e9.json', fixture),
    importedFile('Cafe\u0301.JSON', fixture),
  ]);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, 'DUPLICATE_IMPORT');
});

test('parseImportedFiles rejects malformed JSON and invalid level shapes with file context', async () => {
  const malformed = await parseImportedFiles([importedFile('broken.json', '{')]);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, 'MALFORMED_IMPORT');
  assert.match(malformed.error.message, /broken\.json/);

  const invalid = await parseImportedFiles([importedFile('invalid.json', { difficulty: 'normal' })]);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_LEVEL');
  assert.match(invalid.error.message, /invalid\.json/);
});

test('downloadLevel uses stable safe filenames and preserves JSON fields', async () => {
  const clicks = [];
  const revoked = [];
  const previousDocument = globalThis.document;
  const previousURL = globalThis.URL;
  const anchor = { click() { clicks.push({ download: this.download, href: this.href }); }, remove() {} };
  globalThis.document = {
    body: { append() {} },
    createElement(tagName) { assert.equal(tagName, 'a'); return anchor; },
  };
  globalThis.URL = {
    createObjectURL(blob) { clicks.push(blob); return 'blob:level'; },
    revokeObjectURL(url) { revoked.push(url); },
  };
  try {
    const extended = { ...fixture, future: { value: 7 } };
    const result = downloadLevel(extended, '../ My Castle: 01.JSON ');
    assert.deepEqual(result, { ok: true, data: { filename: 'my-castle-01.json' } });
    assert.equal(clicks[1].download, 'my-castle-01.json');
    assert.equal(clicks[1].href, 'blob:level');
    assert.deepEqual(JSON.parse(await clicks[0].text()), extended);
    assert.deepEqual(revoked, ['blob:level']);
  } finally {
    globalThis.document = previousDocument;
    globalThis.URL = previousURL;
  }
});
