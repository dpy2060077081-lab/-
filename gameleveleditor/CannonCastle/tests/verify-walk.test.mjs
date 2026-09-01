import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import * as verifier from '../scripts/verify.mjs';

test('walk excludes only the requested root sidecar and retains nested worktree-named directories', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'meteor-verify-walk-'));
  try {
    const sidecar = resolve(fixture, '.worktrees');
    const nested = join(fixture, 'template', '.worktrees');
    await mkdir(sidecar, { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(sidecar, 'ignored.mjs'), 'export const ignored = true;\n');
    await writeFile(join(nested, 'included.mjs'), 'export const included = true;\n');
    await writeFile(join(fixture, 'project.mjs'), 'export const project = true;\n');

    const files = await verifier.walk(fixture, { excludedPaths: [sidecar] });
    const relative = files.map(path => path.slice(fixture.length + 1).replaceAll('\\', '/')).sort();

    assert.deepEqual(relative, ['project.mjs', 'template/.worktrees/included.mjs']);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('template skill root honors the environment override and otherwise resolves below the supplied home', () => {
  assert.equal(typeof verifier.resolveLevelEditorSkillRoot, 'function');
  assert.equal(
    verifier.resolveLevelEditorSkillRoot({ env: { LEVEL_EDITOR_SKILL_ROOT: 'D:/portable-skill' }, home: 'C:/ignored' }),
    resolve('D:/portable-skill'),
  );
  assert.equal(
    verifier.resolveLevelEditorSkillRoot({ env: {}, home: 'D:/profiles/alice' }),
    resolve('D:/profiles/alice', '.codex/skills/building-game-level-editors'),
  );
});
