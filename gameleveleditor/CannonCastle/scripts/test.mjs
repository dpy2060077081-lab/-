import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsDirectory = resolve(root, 'tests');
const testFiles = (await readdir(testsDirectory))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

if (testFiles.length === 0) throw new Error('No tests/*.test.mjs files found');
const result = spawnSync(process.execPath, [
  '--test',
  '--test-concurrency=1',
  ...testFiles.map(name => resolve(testsDirectory, name)),
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
