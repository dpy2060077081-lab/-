import assert from 'node:assert/strict';
import test from 'node:test';

import { drawLevel } from '../gamelogic.js';
import {
  drawFrozenBodyOverlay,
  frozenCrackSegments,
} from '../static/js/frozen-body-renderer.js';
import { assets, config } from './project-config-fixture.mjs';

function createRecordingContext(initial = {}) {
  const calls = [];
  const context = new Proxy(initial, {
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
  return { context, calls };
}

const group = { id: 'ice-shapes', memberIds: ['box', 'circle', 'polygon'] };
const members = [
  { id: 'box', x: 1, y: 2, angle: 0.1, shape: { kind: 'box', width: 2, height: 1 } },
  { id: 'circle', x: 3, y: 4, angle: 0.2, shape: { kind: 'circle', radius: 0.75 } },
  {
    id: 'polygon', x: 5, y: 6, angle: 0.3,
    shape: { kind: 'polygon', vertices: [{ x: -0.4, y: -0.3 }, { x: 0.5, y: -0.2 }, { x: 0.1, y: 0.6 }] },
  },
];

function drawableLevel() {
  return {
    levelName: '冰冻体渲染测试',
    platformType: 'single-3',
    castle: members.slice(0, 2),
    frozenBodies: [{ id: 'ice-runtime', memberIds: ['box', 'circle'] }],
  };
}

test('frozenCrackSegments is stable for one impact and visibly varies by frozen body ID', () => {
  const hitPoint = { x: 4, y: 7 };
  const first = frozenCrackSegments('ice-alpha', hitPoint);
  const repeated = frozenCrackSegments('ice-alpha', hitPoint);
  const otherGroup = frozenCrackSegments('ice-beta', hitPoint);

  assert.ok(first.length >= 5, 'a crack needs several visible branches');
  assert.deepEqual(repeated, first);
  assert.notDeepEqual(otherGroup, first);
  for (const segment of first) {
    assert.deepEqual(Object.keys(segment), ['from', 'to']);
    assert.ok(Number.isFinite(segment.from.x) && Number.isFinite(segment.from.y));
    assert.ok(Number.isFinite(segment.to.x) && Number.isFinite(segment.to.y));
  }
});

test('drawFrozenBodyOverlay traces and coats each real member shape without filling a group AABB', () => {
  const { context, calls } = createRecordingContext();

  drawFrozenBodyOverlay(context, { group, members });

  assert.ok(calls.some(call => call[0] === 'rect'
    && call[1] === -1 && call[2] === -0.5 && call[3] === 2 && call[4] === 1));
  assert.ok(calls.some(call => call[0] === 'arc'
    && call[1] === 0 && call[2] === 0 && call[3] === 0.75));
  assert.ok(calls.some(call => call[0] === 'moveTo' && call[1] === -0.4 && call[2] === -0.3));
  assert.ok(calls.some(call => call[0] === 'lineTo' && call[1] === 0.5 && call[2] === -0.2));
  assert.deepEqual(calls.filter(call => call[0] === 'translate'), [
    ['translate', 1, 2],
    ['translate', 3, 4],
    ['translate', 5, 6],
  ]);
  assert.equal(calls.filter(call => call[0] === 'fill').length, 3);
  assert.equal(calls.filter(call => call[0] === 'stroke').length, 3);
  assert.equal(calls.some(call => call[0] === 'fillRect'), false, 'the group AABB must never be painted');
  assert.equal(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle'
    && String(call[2]).includes('255, 255, 255')), false, 'intact ice has no white crack');
});

test('drawFrozenBodyOverlay paints stable white crack segments for cracked ice', () => {
  const first = createRecordingContext();
  const repeated = createRecordingContext();
  const options = {
    group: { id: 'ice-cracked', memberIds: ['box'] },
    members: [members[0]],
    state: 'cracked',
    hitPoint: { x: 1.2, y: 2.1 },
  };

  drawFrozenBodyOverlay(first.context, options);
  drawFrozenBodyOverlay(repeated.context, options);

  assert.deepEqual(repeated.calls, first.calls);
  const whiteStyle = first.calls.findIndex(call => call[0] === 'set' && call[1] === 'strokeStyle'
    && String(call[2]).includes('255, 255, 255'));
  assert.ok(whiteStyle >= 0, 'cracked ice needs a white crack stroke');
  assert.ok(first.calls.slice(whiteStyle).filter(call => call[0] === 'moveTo').length >= 5);
  assert.ok(first.calls.slice(whiteStyle).filter(call => call[0] === 'lineTo').length >= 5);
});

test('drawFrozenBodyOverlay performs no canvas operations after release', () => {
  const { context, calls } = createRecordingContext();

  drawFrozenBodyOverlay(context, { group, members, state: 'released', hitPoint: { x: 1, y: 2 } });

  assert.deepEqual(calls, []);
});

test('drawLevel paints intact frozen overlays from authored level groups in preview', () => {
  const { context, calls } = createRecordingContext({
    canvas: { width: config.canvas.width, height: config.canvas.height },
  });

  drawLevel(context, drawableLevel(), { assets, config, mode: 'preview' });

  assert.equal(calls.filter(call => call[0] === 'set' && call[1] === 'fillStyle'
    && call[2] === 'rgba(87, 193, 255, 0.32)').length, 2);
  assert.equal(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle'
    && call[2] === 'rgba(255, 255, 255, 0.94)'), false);
});

test('drawLevel follows simulation crack and release state during play', () => {
  const level = drawableLevel();
  const cracked = createRecordingContext({
    canvas: { width: config.canvas.width, height: config.canvas.height },
  });
  const frozenBody = {
    id: 'ice-runtime', memberIds: ['box', 'circle'], hp: 1, maxHp: 2,
    state: 'cracked', hitPoint: { x: 2, y: 3 },
  };

  drawLevel(cracked.context, level, {
    assets,
    config,
    mode: 'play',
    simulation: { frozenBodies: [frozenBody], projectiles: [], normalAmmo: 3, phase: 'playing' },
  });

  assert.equal(cracked.calls.filter(call => call[0] === 'set' && call[1] === 'fillStyle'
    && call[2] === 'rgba(87, 193, 255, 0.32)').length, 2);
  assert.ok(cracked.calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle'
    && call[2] === 'rgba(255, 255, 255, 0.94)'));

  const released = createRecordingContext({
    canvas: { width: config.canvas.width, height: config.canvas.height },
  });
  drawLevel(released.context, level, {
    assets,
    config,
    mode: 'play',
    simulation: {
      frozenBodies: [{ ...frozenBody, hp: 0, state: 'released' }],
      projectiles: [], normalAmmo: 3, phase: 'playing',
    },
  });

  assert.equal(released.calls.some(call => call[0] === 'set' && call[1] === 'fillStyle'
    && call[2] === 'rgba(87, 193, 255, 0.32)'), false);
  assert.equal(released.calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle'
    && call[2] === 'rgba(255, 255, 255, 0.94)'), false);
});
