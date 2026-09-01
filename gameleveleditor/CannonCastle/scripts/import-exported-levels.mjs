import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceDir = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!sourceDir) throw new Error('Usage: node scripts/import-exported-levels.mjs <export-directory> [--check]');

const names = (await readdir(sourceDir)).filter(name => /^关卡-\d{3}-.+\.json$/u.test(name)).sort();
const manifest = JSON.parse(await readFile(resolve(sourceDir, '导出清单.json'), 'utf8'));
if (manifest?.version !== 1 || manifest?.type !== 'manifest' || !Array.isArray(manifest.levels)) {
  throw new Error('Invalid exported level manifest');
}
if (names.length !== manifest.levels.length) throw new Error(`Manifest lists ${manifest.levels.length} levels, found ${names.length}`);

const documents = await Promise.all(names.map(async name => JSON.parse(await readFile(resolve(sourceDir, name), 'utf8'))));
const numbers = documents.map(document => document?.level?.number);
const ids = documents.map(document => document?.levelId);
if (new Set(numbers).size !== numbers.length || new Set(ids).size !== ids.length) throw new Error('Exported level numbers and ids must be unique');
const manifestByNumber = new Map(manifest.levels.map(entry => [entry.number, entry]));
if (manifestByNumber.size !== manifest.levels.length) throw new Error('Manifest level numbers must be unique');

const sourceHash = '66bb30e7ed4781d27946482f1464f2734697e6d3';
const levels = [];
for (const document of documents) {
  if (document.version !== 2 || document.type !== 'level' || !document.levelId || !Array.isArray(document.level.castle)) {
    throw new Error(`Invalid exported level ${document?.level?.number ?? '?'}`);
  }
  const number = document.level.number;
  const declared = manifestByNumber.get(number);
  if (!declared || declared.id !== document.levelId || declared.name !== document.level.name || declared.difficulty !== document.level.difficulty) {
    throw new Error(`Manifest mismatch for exported level ${number}`);
  }
  const token = String(number).padStart(2, '0');
  const path = `level/original-${token}-level-${token}.json`;
  levels.push({
    id: document.levelId,
    number,
    name: document.level.name,
    difficulty: document.level.difficulty,
    path,
    sourceHash: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
  });
  if (!checkOnly) await writeFile(resolve(root, path), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}
if (!checkOnly) await writeFile(resolve(root, 'level/catalog.json'), `${JSON.stringify({ sourceHash, levels }, null, 2)}\n`, 'utf8');
console.log(`${checkOnly ? 'Validated' : 'Imported'} ${documents.length} exported v2 levels from ${sourceDir}`);
