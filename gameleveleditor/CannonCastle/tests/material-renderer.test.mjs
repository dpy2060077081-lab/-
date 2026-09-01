import assert from 'node:assert/strict';
import test from 'node:test';

import { drawMaterialSurface } from '../static/js/material-renderer.js';

function createContext() {
  const calls = [];
  const context = new Proxy({ canvas: { width: 750, height: 1624 } }, {
    get(target, property) {
      if (property === 'createLinearGradient') {
        return (...args) => {
          const gradient = { addColorStop: (...stop) => calls.push(['addColorStop', ...stop]) };
          calls.push(['createLinearGradient', ...args]);
          return gradient;
        };
      }
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

function draw(materialId, shape = { kind: 'box', width: 2, height: 1 }, color = '#123456') {
  const { context, calls } = createContext();
  const before = structuredClone(shape);

  drawMaterialSurface(context, { shape, materialId, color, hollow: false });

  assert.deepEqual(shape, before, `${materialId} surface drawing must not mutate the shape`);
  return calls;
}

test('wood draws dark and light grain plus an edge highlight inside the supplied shape', () => {
  const calls = draw('wood');

  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === 'rgba(71,43,24,.38)'));
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === 'rgba(255,230,181,.30)'));
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === 'rgba(255,244,213,.46)'));
  assert.ok(calls.some(call => call[0] === 'moveTo' && call[1] === -1 && call[2] === -0.25));
  assert.ok(calls.some(call => call[0] === 'lineTo' && call[1] === 1 && call[2] === -0.25));
  assert.ok(calls.some(call => call[0] === 'clip'));
});

test('glass uses a clipped translucent base without an opaque prefill and adds refraction, highlight, and cracks', () => {
  const calls = draw('glass');

  assert.equal(calls.some(call => call[0] === 'fill'), false, 'glass must not receive the common opaque path fill');
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'fillStyle' && call[2] === '#123456'));
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'globalAlpha' && call[2] === 0.38));
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'globalAlpha' && call[2] === 1));
  for (const cue of ['rgba(151,232,245,.56)', 'rgba(255,255,255,.82)', 'rgba(218,252,255,.64)']) {
    assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === cue), cue);
  }
  assert.ok(calls.some(call => call[0] === 'clip'));
  assert.ok(calls.some(call => call[0] === 'fillRect' && call[1] === -1 && call[2] === -0.5 && call[3] === 2 && call[4] === 1));
});

test('stone draws irregular texture patches and deterministic crack strokes', () => {
  const calls = draw('stone');

  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'fillStyle' && call[2] === 'rgba(205,220,231,.14)'));
  assert.ok(calls.filter(call => call[0] === 'fill').length >= 2, 'stone must add a texture patch after its base fill');
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === 'rgba(48,55,63,.42)'));
  assert.ok(calls.some(call => call[0] === 'moveTo' && call[1] === -0.5 && call[2] === -0.5));
  assert.ok(calls.some(call => call[0] === 'lineTo' && Math.abs(call[1] - -0.18) < 1e-9 && Math.abs(call[2] - -0.1) < 1e-9));
});

test('metal draws deterministic brushed highlights and an edge reflection', () => {
  const calls = draw('metal');

  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === 'rgba(255,255,255,.34)'));
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === 'rgba(226,239,255,.68)'));
  assert.ok(calls.some(call => call[0] === 'moveTo' && call[1] === -1 && call[2] === -0.35));
  assert.ok(calls.some(call => call[0] === 'lineTo' && call[1] === 1 && call[2] === -0.35));
});

test('rubber signals a soft highlight with a linear gradient and a dark edge', () => {
  const calls = draw('rubber');

  assert.ok(calls.some(call => call[0] === 'createLinearGradient' && call[1] === -1 && call[2] === -0.5 && call[3] === 1 && call[4] === 0.5));
  assert.ok(calls.some(call => call[0] === 'addColorStop' && call[1] === 0 && call[2] === 'rgba(255,255,255,.26)'));
  assert.ok(calls.some(call => call[0] === 'addColorStop' && call[1] === 1 && call[2] === 'rgba(255,255,255,0)'));
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === 'rgba(41,26,58,.58)'));
  assert.ok(calls.some(call => call[0] === 'strokeRect'));
});

test('unknown material fills with its supplied color', () => {
  const calls = draw('mystery', { kind: 'box', width: 2, height: 1 }, '#fedcba');

  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'fillStyle' && call[2] === '#fedcba'));
  assert.ok(calls.some(call => call[0] === 'fill'));
});

test('explicitly hollow material clips to an inward border without changing box dimensions', () => {
  const shape = { kind: 'box', width: 2, height: 1 };
  const before = structuredClone(shape);
  const { context, calls } = createContext();

  drawMaterialSurface(context, { shape, materialId: 'wood', color: '#123456', hollow: true });

  assert.deepEqual(shape, before);
  assert.ok(calls.some(call => call[0] === 'rect' && call[1] === -0.78 && call[2] === -0.28 && call[3] === 1.56 && call[4] === 0.56));
  assert.ok(calls.some(call => call[0] === 'clip' && call[1] === 'evenodd'), 'square centre must be excluded from the material fill');
});

test('non-hollow box material keeps a solid surface', () => {
  for (const hollow of [false, undefined]) {
    const shape = { kind: 'box', width: 2, height: 1 };
    const before = structuredClone(shape);
    const { context, calls } = createContext();

    drawMaterialSurface(context, { shape, materialId: 'wood', color: '#123456', hollow });

    assert.deepEqual(shape, before, `${hollow ?? 'omitted hollow flag'} dimensions must remain unchanged`);
    assert.equal(calls.some(call => call[0] === 'clip' && call[1] === 'evenodd'), false, `${hollow ?? 'omitted hollow flag'} must not become hollow`);
  }
});

test('formal renderer receives original identity and damaged HP state before procedural drawing', () => {
  const { context, calls } = createContext();
  const received = [];
  const result = drawMaterialSurface(context, {
    shape: { kind: 'box', width: 2, height: 1 },
    shapePresetId: 'rectangle',
    materialId: 'wood',
    color: '#123456',
    hp: 1,
    maxHp: 2,
    specialType: undefined,
    formalAssetDrawer(options) {
      received.push(options);
      return true;
    },
  });

  assert.equal(result, 'formal');
  assert.equal(received.length, 1);
  assert.equal(received[0].context, context);
  assert.deepEqual({ ...received[0], context: undefined }, {
    context: undefined,
    shapePresetId: 'rectangle',
    materialId: 'wood',
    hp: 1,
    maxHp: 2,
    targetWidth: 2,
    targetHeight: 1,
    specialType: undefined,
  });
  assert.equal(calls.some(call => call[0] === 'clip'), false, 'formal art must not be covered by fallback material');
});

test('formal renderer failure falls back to the existing procedural material path', () => {
  const { context, calls } = createContext();
  const result = drawMaterialSurface(context, {
    shape: { kind: 'box', width: 2, height: 1 },
    shapePresetId: 'rectangle',
    materialId: 'wood',
    color: '#123456',
    hp: 1,
    maxHp: 2,
    formalAssetDrawer: () => false,
  });

  assert.equal(result, 'procedural');
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === 'rgba(71,43,24,.38)'));
});

test('explosive barrel fallback keeps the original warning stripe and highlight', () => {
  const { context, calls } = createContext();
  drawMaterialSurface(context, {
    shape: { kind: 'box', width: 1, height: 1 },
    shapePresetId: 'square',
    materialId: 'wood',
    specialType: 'explosive-barrel',
    color: '#D9493F',
    formalAssetDrawer: () => false,
  });

  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'fillStyle' && call[2] === '#F2B134'));
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'fillStyle' && call[2] === 'rgba(255,255,255,.22)'));
});

test('explosive barrel ignores the hollow-square clip so its body stays solid', () => {
  const { context, calls } = createContext();
  drawMaterialSurface(context, {
    shape: { kind: 'box', width: 0.5, height: 0.5 },
    shapePresetId: 'square',
    materialId: 'wood',
    specialType: 'explosive-barrel',
    color: '#D9493F',
    hollow: true,
    formalAssetDrawer: () => false,
  });

  assert.equal(calls.some(call => call[0] === 'clip' && call[1] === 'evenodd'), false, 'special square must not be hollow-clipped');
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'fillStyle' && call[2] === '#F2B134'));
});
