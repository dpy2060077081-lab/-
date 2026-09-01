import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlayEffects, drawPlayEffects } from '../static/js/play-effects.js';

const position = { x: 4, y: 7 };

test('damage events reproduce the original Demo hit and destruction particles', () => {
  const effects = createPlayEffects();
  effects.ingest([{ type: 'collision', position }]);
  assert.deepEqual(effects.snapshot().particles, []);

  effects.ingest([{ type: 'hit', position }]);
  assert.deepEqual(effects.snapshot().particles, [{
    x: 4, y: 7, vx: 0, vy: -0.8,
    life: 650, initialLife: 650, kind: 'text', text: '-1', color: '#ef476f',
  }]);

  effects.reset();
  effects.ingest([{ type: 'destroyed', position }]);
  const particles = effects.snapshot().particles;
  assert.equal(particles.length, 7);
  assert.deepEqual(particles[0], {
    x: 4, y: 7, vx: 0, vy: -0.8,
    life: 650, initialLife: 650, kind: 'text', text: '破碎', color: '#d93855',
  });
  assert.deepEqual(particles.slice(1).map(({ vx, vy }) => [vx, vy]), [
    [-1.1, -0.9], [-0.55, -1.25], [0.25, -1.4],
    [0.9, -1.05], [1.25, -0.45], [-1.3, -0.3],
  ]);
  assert.ok(particles.slice(1).every(({ kind, life, initialLife, color }) => (
    kind === 'fragment' && life === 500 && initialLife === 500 && color === '#d93855'
  )));
});

test('particles advance, fade, expire, and snapshots stay detached', () => {
  const effects = createPlayEffects();
  effects.ingest([{ type: 'destroyed', position: { x: 1, y: 2 } }]);
  effects.advance(250);
  const particles = effects.snapshot().particles;
  const firstFragment = particles[1];
  assert.equal(firstFragment.x, 0.725);
  assert.equal(firstFragment.y, 1.775);
  assert.equal(firstFragment.life / firstFragment.initialLife, 0.5);
  firstFragment.x = 99;
  assert.equal(effects.snapshot().particles[1].x, 0.725);

  effects.advance(251);
  assert.equal(effects.snapshot().particles.filter(({ kind }) => kind === 'fragment').length, 0);
  effects.advance(150);
  assert.deepEqual(effects.snapshot().particles, []);
});

test('drawing uses the level world transform and keeps fragments four screen pixels square', () => {
  const calls = [];
  const context = new Proxy({}, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) {
      target[property] = value;
      calls.push(['set', property, value]);
      return true;
    },
  });
  const effects = createPlayEffects();
  effects.ingest([{ type: 'destroyed', position }]);

  drawPlayEffects(context, effects.snapshot(), {
    layout: { left: 10, top: 20, scale: 50 },
    viewport: { x: 3, y: 4, zoom: 2 },
  });

  assert.ok(calls.some(call => call[0] === 'translate' && call[1] === 13 && call[2] === 24));
  assert.ok(calls.some(call => call[0] === 'scale' && call[1] === 100 && call[2] === 100));
  assert.ok(calls.some(call => call[0] === 'fillText' && call[1] === '破碎' && call[2] === 4 && call[3] === 7));
  const fragments = calls.filter(call => call[0] === 'fillRect');
  assert.equal(fragments.length, 6);
  assert.ok(fragments.every(call => call[3] === 0.04 && call[4] === 0.04));
});

test('explosion waves expand and expire with the original 350ms lifetime', () => {
  const effects = createPlayEffects();
  effects.ingestExplosions([
    { position: { x: 4, y: 5 }, radius: 3 },
    { position: { x: 1, y: 2 }, radius: 2, startsWave: false },
  ]);

  assert.deepEqual(effects.snapshot().explosionRings, [{
    x: 4, y: 5, radius: 3, life: 350, initialLife: 350,
  }]);
  effects.advance(175);
  assert.equal(effects.snapshot().explosionRings[0].life, 175);
  effects.advance(176);
  assert.deepEqual(effects.snapshot().explosionRings, []);
});

test('out-of-arc feedback uses the original 500ms lifetime and resets with all effects', () => {
  const effects = createPlayEffects();
  effects.showOutOfArc();
  assert.equal(effects.snapshot().outOfArcLife, 500);
  effects.advance(250);
  assert.equal(effects.snapshot().outOfArcLife, 250);
  effects.advance(251);
  assert.equal(effects.snapshot().outOfArcLife, 0);
  effects.showOutOfArc();
  effects.reset();
  assert.deepEqual(effects.snapshot(), { particles: [], explosionRings: [], outOfArcLife: 0 });
});
