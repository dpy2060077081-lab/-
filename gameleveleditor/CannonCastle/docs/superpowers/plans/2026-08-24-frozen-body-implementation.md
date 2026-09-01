# Frozen Body Gameplay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add editor-authored, globally configured two-hit frozen compound bodies that move as one rigid body and release their original pieces with inherited motion when shattered.

**Architecture:** Keep the hash-protected original runtime unchanged. Add a closed frozen-body domain module shared by validation, codecs, templates, and editor operations; add an adapter-owned physics controller that temporarily deactivates member bodies and represents their fixtures on one dynamic compound body; expose frozen state in immutable runtime snapshots for a dedicated render overlay.

**Tech Stack:** Browser ES modules, Node.js 22 built-in test runner, extracted Planck-compatible original runtime, Canvas 2D, pywebview file bridge.

**Spec:** `CannonCastle/docs/superpowers/specs/2026-08-24-frozen-body-design.md`

## Global Constraints

- Do not modify `static/vendor/meteor-original-runtime.js` or its expected SHA-256.
- Frozen-body durability is fixed at exactly 2 and is not persisted per level.
- Frozen-body mass equals the sum of resolved member masses; ice adds no mass.
- Formal level JSON persists only `{ id, memberIds }` groups; runtime physics values remain global.
- Existing levels without `frozenBodies` remain byte-semantically compatible and need no migration.
- Preserve the untracked user file `CannonCastle/level/level-101.json`; do not add, delete, or rewrite it.
- Every production behavior is introduced through a failing test first.
- The authoritative final verification remains `node scripts/verify.mjs`.

---

### Task 1: Frozen-body domain model and validation

**Files:**
- Create: `CannonCastle/static/js/frozen-body-model.js`
- Create: `CannonCastle/tests/frozen-body-model.test.mjs`
- Modify: `CannonCastle/gamelogic.js`
- Modify: `CannonCastle/tests/gamelogic.test.mjs`

**Interfaces:**
- Produces: `normalizeFrozenBodies(level): FrozenBodyRecord[]`
- Produces: `validateFrozenBodies(level, assets, { contactTolerance }): { valid, errors }`
- Produces: `frozenMembership(level): Map<objectId, frozenBodyId>`
- Produces: `expandFrozenSelection(level, selectedIds): string[]`
- Produces: `createFrozenBody(level, memberIds): { level, frozenBodyId }`
- Produces: `removeFrozenBodies(level, selectedIds): Level`
- Consumes existing resolved object shapes from `assets.shapes` and object transforms.

- [ ] **Step 1: Write failing schema and membership tests**

```js
test('rejects missing, duplicate, overlapping and fixed-bolt frozen members with exact paths', () => {
  const level = fixtureLevel({
    frozenBodies: [
      { id: 'ice-a', memberIds: ['wood-a', 'missing'] },
      { id: 'ice-b', memberIds: ['wood-a', 'bolt-a', 'bolt-a'] },
    ],
  });
  const result = validateFrozenBodies(level, assets, { contactTolerance: 0.02 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.path === 'frozenBodies.ice-a.memberIds.missing'));
  assert.ok(result.errors.some(error => error.path === 'frozenBodies.ice-b.memberIds.wood-a'));
  assert.ok(result.errors.some(error => error.path === 'frozenBodies.ice-b.memberIds.bolt-a'));
});
```

- [ ] **Step 2: Run `node --test tests/frozen-body-model.test.mjs` and verify RED because the module does not exist**

- [ ] **Step 3: Implement closed records, unique IDs, membership maps and exact validation paths**

```js
export function frozenMembership(level) {
  const membership = new Map();
  for (const group of normalizeFrozenBodies(level)) {
    for (const memberId of group.memberIds) membership.set(memberId, group.id);
  }
  return membership;
}
```

- [ ] **Step 4: Write failing connectivity tests for one piece, edge contact, corner contact, rotated contact and disconnected islands**

- [ ] **Step 5: Implement transformed box/circle/polygon contact graphs using the existing placement geometry helpers and a 0.02 m default tolerance**

- [ ] **Step 6: Write failing tests for selection expansion, group creation and ungrouping without input mutation**

- [ ] **Step 7: Implement the immutable operations and integrate their errors into `validateLevel`**

- [ ] **Step 8: Run `node --test tests/frozen-body-model.test.mjs tests/gamelogic.test.mjs` and verify GREEN**

- [ ] **Step 9: Commit `feat: add frozen body domain validation`**

### Task 2: Level/global codecs, imports, exports and templates

**Files:**
- Modify: `CannonCastle/static/js/level-document.js`
- Modify: `CannonCastle/static/js/global-config-document.js`
- Modify: `CannonCastle/static/js/level-config.js`
- Modify: `CannonCastle/static/js/editor-store.js`
- Modify: `CannonCastle/static/js/editor.js`
- Modify: `CannonCastle/全局配置.json`
- Modify: `CannonCastle/tests/level-document.test.mjs`
- Modify: `CannonCastle/tests/global-config-document.test.mjs`
- Modify: `CannonCastle/tests/compatibility.test.mjs`
- Modify: `CannonCastle/tests/import-export.test.mjs`
- Modify: relevant template tests discovered by `rg "Template|template" tests`

**Interfaces:**
- Adds `level.frozenBodies?: Array<{ id: string, memberIds: string[] }>`.
- Adds `globalObjectProfiles.frozenBody = { friction, restitution, hitSpeedThreshold }`.
- Template records gain optional internal `frozenBodies` using template-local member IDs.
- Produces ID rewriting helper `cloneFrozenBodies(groups, objectIdMap, allocateGroupId)`.

- [ ] **Step 1: Write failing exact round-trip tests proving frozen groups persist and runtime-only ice fields never enter a level document**

```js
test('round-trips compact frozen groups without per-level physics', () => {
  const encoded = encodeLevelDocument(runtimeLevelWithFrozenGroup());
  assert.deepEqual(encoded.level.frozenBodies, [{ id: 'ice-1', memberIds: ['a', 'b'] }]);
  assert.equal(JSON.stringify(encoded).includes('hitSpeedThreshold'), false);
  assert.deepEqual(decodeLevelDocument(encoded, assets).frozenBodies, encoded.level.frozenBodies);
});
```

- [ ] **Step 2: Run the focused codec tests and verify RED on the missing global profile and dropped group**

- [ ] **Step 3: Add `frozenBodies` to level codec ownership while preserving unknown extensions and omitting an unused empty array**

- [ ] **Step 4: Add and validate the default global profile `{ friction: 0.1, restitution: 0.2, hitSpeedThreshold: 5 }` in `全局配置.json` and global codecs**

- [ ] **Step 5: Write failing ZIP/JSON import-export tests proving old documents load, frozen documents round-trip, and malformed references are rejected before mutation**

- [ ] **Step 6: Wire frozen groups through archive export/import and atomic workspace saving**

- [ ] **Step 7: Write failing template clone tests proving every member/group ID is regenerated on repeated template placement**

- [ ] **Step 8: Implement template extraction/placement rewriting with `cloneFrozenBodies`**

- [ ] **Step 9: Run all codec, import/export, compatibility and template tests and verify GREEN**

- [ ] **Step 10: Commit `feat: persist frozen body configuration`**

### Task 3: Atomic editor grouping operations

**Files:**
- Modify: `CannonCastle/static/js/editor-store.js`
- Modify: `CannonCastle/static/js/free-world-editor.js`
- Modify: `CannonCastle/static/js/editor-state.js`
- Modify: `CannonCastle/tests/editor-store.test.mjs`
- Modify: `CannonCastle/tests/canvas-editor.test.mjs`
- Create or modify: `CannonCastle/tests/frozen-body-editor.test.mjs`

**Interfaces:**
- Adds `EditorStore.createFrozenBody(ids): MutationResult`.
- Adds `EditorStore.removeFrozenBodies(ids): MutationResult`.
- Makes selection, move, rotate, duplicate and delete operate on `expandFrozenSelection(...)`.
- Duplicate returns/selects all copied member IDs and rewrites copied groups.

- [ ] **Step 1: Write failing tests for whole-group selection from one clicked member and Shift-selection across groups**

- [ ] **Step 2: Verify RED, then make selection expansion the single boundary used by canvas and store operations**

- [ ] **Step 3: Write failing tests for create/ungroup, rejecting disconnected/fixed-bolt/previously grouped selections, and undo/redo**

- [ ] **Step 4: Implement create/ungroup as one history transaction affecting both `castle` and `frozenBodies`**

- [ ] **Step 5: Write failing tests for group move/rotation, group deletion, and duplication with collision-free offset/new IDs/default copied selection**

- [ ] **Step 6: Implement these operations without moving any unselected group and without partial group mutation**

- [ ] **Step 7: Run editor/store/canvas tests and verify GREEN**

- [ ] **Step 8: Commit `feat: edit frozen compound groups`**

### Task 4: Compound rigid-body physics controller

**Files:**
- Create: `CannonCastle/static/js/frozen-body-physics.js`
- Create: `CannonCastle/tests/frozen-body-physics.test.mjs`
- Modify: `CannonCastle/static/js/original-runtime-adapter.js`
- Modify: `CannonCastle/tests/original-runtime.test.mjs`

**Interfaces:**
- Produces `createFrozenBodyController({ engine, level, assets, profile }): FrozenBodyController`.
- Controller methods: `beforeStep()`, `afterStep()`, `snapshot()`, `reset()`, `dispose()`.
- Snapshot records: `{ id, hp, maxHp: 2, state, memberIds, x, y, angle, vx, vy, angularVelocity, memberTransforms }`.
- The controller deactivates original member bodies, builds a compound body from their actual fixtures, and remains adapter-owned.

- [ ] **Step 1: Write failing unit tests using a real Planck world for compound mass, fixture geometry and no outer bounding-box fixture**

```js
test('compound mass equals member mass sum', () => {
  const controller = createFrozenBodyController(fixtureRuntime());
  assert.ok(Math.abs(controller.snapshot()[0].mass - 9) < 1e-6);
  assert.equal(controller.debugFixtures('ice-1').length, 3);
});
```

- [ ] **Step 2: Verify RED because no controller exists**

- [ ] **Step 3: Implement mass-weighted centroid, local transforms, fixture cloning and density scaling for box/circle/polygon members**

- [ ] **Step 4: Write failing tests proving members are inactive/non-colliding while the compound is active and restored exactly once**

- [ ] **Step 5: Implement safe step-boundary activation/deactivation and idempotent reset/dispose**

- [ ] **Step 6: Write failing tests for low-speed hits, two distinct effective hits, sustained-contact dedupe and one-explosion-per-group dedupe**

- [ ] **Step 7: Implement contact identity tracking and the fixed 2 -> 1 -> released state machine**

- [ ] **Step 8: Write failing release-motion tests using `v_piece = v_body + omega × r`, inherited angular velocity and unchanged member HP/barrel state**

- [ ] **Step 9: Implement release transforms/velocities and ensure explosion impulse affects only the compound before release**

- [ ] **Step 10: Write an integration test that fires real normal cannonballs twice, observes cracked then released, and verifies original runtime remains hash-identical**

- [ ] **Step 11: Integrate the controller with adapter reset/step/snapshot/dispose and reconcile remaining-target/edge-clear behavior without changing ordinary levels**

- [ ] **Step 12: Run frozen physics and original runtime tests and verify GREEN**

- [ ] **Step 13: Commit `feat: simulate frozen compound bodies`**

### Task 5: Ice rendering, cracks and shatter feedback

**Files:**
- Create: `CannonCastle/static/js/frozen-body-renderer.js`
- Modify: `CannonCastle/gamelogic.js`
- Modify: `CannonCastle/static/js/canvas-editor.js`
- Modify: `CannonCastle/static/js/material-renderer.js`
- Modify: `CannonCastle/static/js/play-effects.js`
- Modify: relevant thumbnail/XLSX renderer found by `rg "thumbnail|XLSX|drawLevel" static/js tests`
- Create: `CannonCastle/tests/frozen-body-renderer.test.mjs`
- Modify: `CannonCastle/tests/canvas-editor.test.mjs`

**Interfaces:**
- Produces `drawFrozenBodyOverlay(ctx, frozenBody, members, options)`.
- Produces deterministic `frozenCrackSegments(frozenId, hitPoint)` so redraws do not flicker.
- Play effects consume a `frozen-shattered` event but do not mutate physics.

- [ ] **Step 1: Write failing draw-command tests for member-shaped ice overlays on box/circle/polygon fixtures and absence of a group AABB fill**

- [ ] **Step 2: Verify RED, then implement cold tint, translucent fill, edge highlight and connected seam treatment**

- [ ] **Step 3: Write failing tests that intact has no cracks, cracked has deterministic visible cracks, and released has no ice overlay**

- [ ] **Step 4: Implement deterministic cracks and the common ice-shard effect**

- [ ] **Step 5: Write failing thumbnail/XLSX tests proving full ice appears without gameplay cracks**

- [ ] **Step 6: Wire the shared overlay into editor, gameplay, thumbnails and XLSX vector capture with vector fallback**

- [ ] **Step 7: Run renderer, canvas and export tests and verify GREEN**

- [ ] **Step 8: Commit `feat: render frozen body states`**

### Task 6: Editor controls and global inspector

**Files:**
- Modify: `CannonCastle/index.html`
- Modify: `CannonCastle/static/js/editor.js`
- Modify: `CannonCastle/static/js/item-inspector.js`
- Modify: `CannonCastle/static/js/global-physics-store.js`
- Modify: `CannonCastle/static/css/editor.css`
- Modify: `CannonCastle/tests/editor-smoke.test.mjs`
- Modify: `CannonCastle/tests/dom-safety.test.mjs`
- Modify: `CannonCastle/tests/global-physics-store.test.mjs`

**Interfaces:**
- Buttons use `data-action="create-frozen-body"` and `data-action="remove-frozen-body"`.
- Global inspector fields bind only `friction`, `restitution`, and `hitSpeedThreshold`; HP remains read-only/fixed in explanatory text.

- [ ] **Step 1: Write failing DOM tests for control visibility/enabled states in editable, invalid selection, grouped selection and browser read-only modes**

- [ ] **Step 2: Verify RED, add accessible buttons/status text, and route actions through EditorStore only**

- [ ] **Step 3: Write failing global-profile validation tests for bounds, persistence, reload and import/export**

- [ ] **Step 4: Add the three global fields using existing numeric field validation and dirty-state behavior**

- [ ] **Step 5: Write failing live validation tests that show exact frozen group/member IDs and prevent save**

- [ ] **Step 6: Connect validation status, selection refresh and undo/redo UI without allowing partial edits**

- [ ] **Step 7: Run editor DOM/global store tests and verify GREEN**

- [ ] **Step 8: Commit `feat: expose frozen body editor controls`**

### Task 7: Browser acceptance, documentation and release verification

**Files:**
- Modify: `CannonCastle/tests/browser-smoke-runner.mjs`
- Modify: `CannonCastle/tests/browser-smoke-fixture.test.mjs`
- Modify: `CannonCastle/scripts/verify.mjs`
- Modify: `CannonCastle/README.md`
- Modify: `CannonCastle/scripts/template-provenance.json` only through the repository's documented provenance update process

**Interfaces:**
- Browser smoke scenario creates a two-piece frozen body, saves/reloads it, enters play, fires twice and observes cracked/released states.
- Verification checks all existing formal levels plus a generated frozen fixture; it does not rewrite existing level files.

- [ ] **Step 1: Write failing browser smoke assertions for create, whole-group move, save/reload, first-hit crack, second-hit release and console-zero-errors**

- [ ] **Step 2: Run `node tests/browser-smoke-runner.mjs` and verify RED on the missing frozen UI/state**

- [ ] **Step 3: Complete any integration wiring required by the real browser path, without relaxing assertions**

- [ ] **Step 4: Update README with authoring rules, global defaults, JSON example, physics behavior and compatibility notes**

- [ ] **Step 5: Update provenance only for intentionally adapted files and verify the protected vendor hash is unchanged**

- [ ] **Step 6: Run `node scripts/test.mjs` and require PASS**

- [ ] **Step 7: Run `node scripts/verify.mjs --skip-browser` and require static diagnostics PASS**

- [ ] **Step 8: Run `node scripts/verify.mjs` and require full PASS rather than `ENVIRONMENT_BLOCKED`**

- [ ] **Step 9: Inspect `git status --short`, confirm only intended files changed and `level/level-101.json` remains untouched/untracked**

- [ ] **Step 10: Commit `feat: add frozen body level mechanic`**

## Plan Self-Review

- Spec coverage: all player rules, compound physics, global properties, JSON, templates, editing operations, rendering, compatibility and acceptance criteria map to Tasks 1-7.
- Placeholder scan: no TBD/TODO/deferred implementation steps remain.
- Type consistency: `frozenBodies`, `memberIds`, `FrozenBodyController`, `frozenBody` global profile and snapshot states use the same names throughout.
- Scope: no configurable durability, alternate skins, runtime refreezing, auto-merging or new resource-card type is included.
