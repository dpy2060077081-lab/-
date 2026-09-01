import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAssetItemSection } from '../static/js/editor.js';

function sectionHarness() {
  class FakeElement {
    constructor(tagName, ownerDocument) {
      this.tagName = tagName.toLowerCase();
      this.ownerDocument = ownerDocument;
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.disabled = false;
      this.inert = false;
      this.onclick = null;
      this.onchange = null;
      this.oninput = null;
      this.id = '';
    }

    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = [...children]; }
    setAttribute(name, value) { this[name] = String(value); }
    removeAttribute(name) { delete this[name]; }
    descendants() { return this.children.flatMap(child => [child, ...(child.descendants?.() ?? [])]); }
    querySelectorAll(selector) {
      if (selector !== 'input,button,select,textarea') return [];
      return this.descendants().filter(node => ['input', 'button', 'select', 'textarea'].includes(node.tagName));
    }
    querySelector(selector) {
      return selector.startsWith('#') ? this.descendants().find(node => node.id === selector.slice(1)) ?? null : null;
    }
  }

  const documentRef = { createElement: tagName => new FakeElement(tagName, documentRef) };
  const section = documentRef.createElement('section');
  const state = { get controls() { return section.querySelectorAll('input,button,select,textarea'); } };
  return { state, section };
}

test('read-only dynamic Item controls are inert and ignore programmatic change and input events', () => {
  const { section, state } = sectionHarness();
  const patches = [];
  let edits = 0;
  const target = {
    value: '0.9',
    dataset: { assetField: 'friction', fieldType: 'number' },
    closest(selector) { return selector === '[data-asset-field]' ? this : null; },
  };

  renderAssetItemSection(section, {
    fields: [
      { path: 'name', type: 'text', label: '名称', value: 'Barrel' },
      { path: 'destructible', type: 'boolean', label: '可破坏', value: true },
      { path: 'explosion', type: 'json', label: '爆炸', value: { radius: 3 } },
      { path: 'materialId', type: 'material', label: '材料', value: 'wood' },
    ],
    assets: { materials: { wood: { id: 'wood', name: '木头' } }, shapes: {} },
    selectedAsset: true,
    readOnly: true,
    onPatch: patch => patches.push(patch),
    onEdit: () => { edits += 1; },
  });

  assert.equal(section.inert, true);
  assert.deepEqual(new Set(state.controls.map(control => control.tagName)), new Set(['input', 'textarea', 'select', 'button']));
  assert.ok(state.controls.every(control => control.disabled));
  const editButton = state.controls.find(control => control.id === 'edit-selected-asset');
  assert.equal(editButton.disabled, true);
  section.onchange({ target });
  section.oninput({ target });
  editButton.onclick();
  assert.deepEqual(patches, []);
  assert.equal(edits, 0);
});

test('play material fields can remain enabled while full resource editing stays disabled', () => {
  const { section } = sectionHarness();
  let edits = 0;

  renderAssetItemSection(section, {
    fields: [{ path: 'friction', type: 'number', label: '摩擦', value: 0.5 }],
    selectedAsset: true,
    readOnly: false,
    allowFullEdit: false,
    onEdit: () => { edits += 1; },
  });

  const input = section.querySelectorAll('input,button,select,textarea').find(control => control.tagName === 'input');
  const editButton = section.querySelector('#edit-selected-asset');
  assert.equal(input.disabled, false);
  assert.equal(editButton.disabled, true);
  editButton.onclick();
  assert.equal(edits, 0);
});
