import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPlaySequence, createPlaySession } from '../static/js/play-session.js';
import { bindPlayHud } from '../static/js/editor.js';

const originalLevel = JSON.parse(await readFile(new URL('../level/关卡-007-爆炸炮弹引导.json', import.meta.url), 'utf8'));
const { assets: originalAssets, config: originalConfig } = await import('./project-config-fixture.mjs');

function draftFixture() {
  return {
    levelName: '未保存草稿',
    castle: [{ id: 'tower', hp: 3, nested: { unknown: true } }],
    unknownTopLevel: { preserved: ['yes'] },
  };
}

function recordingGameFactory(log) {
  return (level) => {
    log.level = level;
    let generation = 0;
    let snapshot = { phase: 'playing', normalAmmo: 2, explosiveAmmo: 1, castle: level.castle };
    return {
      snapshot: () => snapshot,
      selectProjectile(type) { log.projectile = type; return true; },
      aim(delta) { log.aim = (log.aim ?? 0) + delta; return true; },
      fire() { log.fires = (log.fires ?? 0) + 1; return 'fired'; },
      step(elapsedMs) {
        log.elapsed = (log.elapsed ?? 0) + elapsedMs;
        snapshot = { ...snapshot, generation: ++generation, castle: snapshot.castle };
        return snapshot;
      },
      reset() {
        log.resets = (log.resets ?? 0) + 1;
        snapshot = { phase: 'playing', normalAmmo: 2, explosiveAmmo: 1, castle: level.castle };
        return snapshot;
      },
    };
  };
}

test('simulation receives an owned deep copy and cannot mutate the editor draft', () => {
  const draft = draftFixture();
  const before = structuredClone(draft);
  const log = {};
  const session = createPlaySession(draft, (level) => {
    level.castle[0].hp = 0;
    level.castle[0].nested.unknown = false;
    level.unknownTopLevel.preserved.push('simulation-only');
    return recordingGameFactory(log)(level);
  });

  session.step(16);
  assert.deepEqual(draft, before);
  assert.notStrictEqual(log.level, draft);
  assert.notStrictEqual(log.level.castle[0], draft.castle[0]);
});

test('projectile, aim, fire, step, reset, and result interactions refresh subscribers', () => {
  const log = {};
  const session = createPlaySession(draftFixture(), recordingGameFactory(log));
  const phases = [];
  const unsubscribe = session.subscribe((snapshot) => phases.push(snapshot.phase));

  assert.equal(session.selectProjectile('explosive'), true);
  assert.equal(session.aim(-5), true);
  assert.equal(session.aim(10), true);
  assert.equal(session.fire(), 'fired');
  assert.equal(session.step(20).generation, 1);
  assert.equal(session.reset().phase, 'playing');
  unsubscribe();
  session.step(5);

  assert.equal(log.projectile, 'explosive');
  assert.equal(log.aim, 5);
  assert.equal(log.fires, 1);
  assert.equal(log.elapsed, 25);
  assert.equal(log.resets, 1);
  assert.deepEqual(phases, ['playing', 'playing', 'playing', 'playing', 'playing', 'playing']);
});

test('exit restores the captured draft value and closes simulation interactions', () => {
  const draft = draftFixture();
  const session = createPlaySession(draft, recordingGameFactory({}));
  session.snapshot().castle[0].hp = 0;

  const restored = session.exit();
  assert.deepEqual(restored, draft);
  assert.notStrictEqual(restored, draft);
  assert.notStrictEqual(restored.castle[0], draft.castle[0]);
  assert.equal(session.closed, true);
  assert.throws(() => session.fire(), /closed/i);
});

test('debug metadata remains session-local and is absent from restored drafts', () => {
  const draft = draftFixture();
  const session = createPlaySession(draft, recordingGameFactory({}));
  session.setDebug({ showVelocity: true, selectedId: 'tower' });

  assert.deepEqual(session.debug, { showVelocity: true, selectedId: 'tower' });
  assert.equal('debug' in session.exit(), false);
  assert.equal(JSON.stringify(draft).includes('showVelocity'), false);
});

test('uses the extracted original runtime by default and fires at world coordinates', () => {
  const session = createPlaySession({ draft: originalLevel, assets: originalAssets, config: originalConfig });

  assert.equal(session.selectProjectile('explosive'), true);
  assert.equal(session.aimAt({ x: 4.5, y: 4 }), true);
  assert.equal(session.fireAt({ x: 4.5, y: 4 }), 'fired');
  assert.equal(session.snapshot().explosiveAmmo, originalLevel.level.explosiveAmmo - 1);
  assert.ok(session.step(16).bodies.length >= originalLevel.level.castle.length);
});

test('passes the current template config and assets into the runtime factory', () => {
  const config = { world: { width: 9, height: 16 } };
  const assets = { materials: { wood: { friction: 0.55 } } };
  const draft = draftFixture();
  let received;
  const runtimeFactory = (options) => {
    received = options;
    return recordingGameFactory({})(options.level);
  };

  createPlaySession({ draft, config, assets, runtimeFactory });

  assert.deepEqual(received.config, config);
  assert.deepEqual(received.assets, assets);
  assert.notStrictEqual(received.level, draft);
  assert.notStrictEqual(received.level.castle[0], draft.castle[0]);
});

test('retry rebuilds the current runtime and next advances only after an original win', () => {
  const created = [];
  const runtimeFactory = ({ level }) => {
    const runtime = recordingGameFactory({})(level);
    runtime.setPhase = (phase) => { runtime.snapshot = () => ({ phase, castle: level.castle }); };
    created.push(runtime);
    return runtime;
  };
  const selected = [];
  const sequence = createPlaySequence({
    levels: [{ ...draftFixture(), levelNumber: 1 }, { ...draftFixture(), levelNumber: 2 }],
    runtimeFactory,
    onLevelChange: (index) => selected.push(index),
  });

  assert.equal(sequence.next(), false);
  sequence.retry();
  assert.equal(created.length, 2);
  created.at(-1).setPhase('won');
  sequence.refresh();
  assert.equal(sequence.next(), true);
  assert.equal(created.length, 3);
  assert.deepEqual(selected, [1]);
  assert.equal(sequence.index, 1);
  assert.equal(sequence.next(), false);
});

test('production HUD keeps explosive ammo selected after firing', () => {
  const nodes = [
    { dataset: { projectile: 'normal' }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } },
    { dataset: { projectile: 'explosive' }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } },
  ];
  const ammo = {
    normal: { textContent: '' },
    explosive: { textContent: '' },
  };
  const root = {
    querySelectorAll(selector) { return selector === '[data-projectile]' ? nodes : []; },
    querySelector(selector) {
      const match = /\[data-ammo="(normal|explosive)"\]/.exec(selector);
      return match ? ammo[match[1]] : null;
    },
  };
  const sequence = createPlaySequence({ levels: [originalLevel], assets: originalAssets, config: originalConfig });
  const dispose = bindPlayHud(root, sequence);
  const explosiveBefore = sequence.snapshot().explosiveAmmo;

  nodes[1].onclick();
  assert.equal(sequence.snapshot().selectedProjectile, 'explosive');
  assert.equal(nodes[0].attributes['aria-pressed'], 'false');
  assert.equal(nodes[1].attributes['aria-pressed'], 'true');
  assert.equal(sequence.fireAt({ x: 4.5, y: 4 }), 'fired');

  assert.equal(sequence.snapshot().explosiveAmmo, explosiveBefore - 1);
  assert.equal(sequence.snapshot().selectedProjectile, 'explosive');
  assert.equal(nodes[0].attributes['aria-pressed'], 'false');
  assert.equal(nodes[1].attributes['aria-pressed'], 'true');
  assert.equal(ammo.explosive.textContent, String(explosiveBefore - 1));
  dispose();
  sequence.exit();
});
