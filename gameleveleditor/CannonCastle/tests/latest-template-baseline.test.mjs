import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { resolveLevelEditorSkillRoot } from '../scripts/verify.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = resolve(resolveLevelEditorSkillRoot(), 'assets/template');
const AUTHORIZED_MATERIAL_VISUAL_CSS = Buffer.from([
  '.asset-visual.material-preview{--asset-color:#738096;color:#f4f7ff;text-shadow:0 1px 2px rgba(0,0,0,.45);background:var(--asset-color)}',
  '.asset-visual[data-material="wood"]{background:linear-gradient(180deg,rgba(255,244,213,.46) 0 2px,transparent 2px),repeating-linear-gradient(0deg,rgba(71,43,24,.38) 0 2px,transparent 2px 7px),repeating-linear-gradient(0deg,transparent 0 4px,rgba(255,230,181,.30) 4px 5px,transparent 5px 9px),var(--asset-color)}',
  '.asset-visual[data-material="glass"]{background:linear-gradient(32deg,transparent 47%,rgba(218,252,255,.64) 48% 49%,transparent 50%),linear-gradient(148deg,transparent 40%,rgba(255,255,255,.82) 42% 45%,transparent 47%),repeating-linear-gradient(135deg,rgba(151,232,245,.56) 0 1px,transparent 1px 8px),color-mix(in srgb,var(--asset-color) 38%,transparent)}',
  '.asset-visual[data-material="stone"]{background:radial-gradient(ellipse at 24% 32%,rgba(205,220,231,.14) 0 18%,transparent 20%),linear-gradient(112deg,transparent 44%,rgba(48,55,63,.42) 45% 48%,transparent 49%),linear-gradient(68deg,transparent 52%,rgba(48,55,63,.42) 53% 56%,transparent 57%),var(--asset-color)}',
  '.asset-visual[data-material="metal"]{background:linear-gradient(180deg,rgba(226,239,255,.68) 0 2px,transparent 2px),repeating-linear-gradient(0deg,rgba(255,255,255,.34) 0 1px,transparent 1px 5px),var(--asset-color)}',
  '.asset-visual[data-material="rubber"]{background:radial-gradient(circle at 30% 24%,rgba(255,255,255,.26),transparent 48%),linear-gradient(135deg,transparent 50%,rgba(41,26,58,.58)),var(--asset-color);box-shadow:inset 0 0 0 2px rgba(41,26,58,.58),inset 0 1px rgba(255,255,255,.12)}',
  '',
].join('\n'));
const AUTHORIZED_PROJECTILE_AND_ENVIRONMENT_CSS = Buffer.from([
  '.play-hud{position:absolute;z-index:4;bottom:48px;left:18px;display:flex;gap:8px}.projectile-card{min-width:128px;min-height:52px;display:flex;align-items:center;gap:9px;padding:8px 10px;border:1px solid #46546a;border-radius:9px;background:#1a2534;color:#dce8f5;text-align:left;box-shadow:0 8px 18px rgba(0,0,0,.2);transition:border-color .15s ease,background .15s ease,box-shadow .15s ease}.projectile-card--normal .projectile-icon{background:#52667c;color:#eaf4ff}.projectile-card--explosive{border-color:#754232;background:#38211f;color:#ffe3d8}.projectile-card--explosive .projectile-icon{background:#b95032;color:#fff4e8}.projectile-icon{width:30px;height:30px;flex:0 0 30px;display:grid;place-items:center;border-radius:8px;font-size:16px}.projectile-copy{display:grid;gap:1px}.projectile-name{font-size:11px;font-weight:700}.projectile-ammo{font-size:9px;color:#aebdce}.projectile-card--explosive .projectile-ammo{color:#edb4a6}.projectile-ammo b{font-size:12px;color:inherit}.projectile-card[aria-pressed="true"]{border-color:#e9f5ff;background:#253a50;box-shadow:0 0 0 1px rgba(214,242,255,.45),0 0 18px rgba(100,191,244,.34),0 8px 18px rgba(0,0,0,.24)}.projectile-card--explosive[aria-pressed="true"]{border-color:#ffb05e;background:#513027;box-shadow:0 0 0 1px rgba(255,203,128,.48),0 0 18px rgba(250,111,61,.42),0 8px 18px rgba(0,0,0,.24)}',
  '.inspector{container:inspector/inline-size}',
  '.field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
  '.field-grid--two{grid-template-columns:repeat(2,minmax(0,1fr))}',
  '.field-grid--three{grid-template-columns:repeat(3,minmax(0,1fr))}',
  '.field-grid>.field{min-width:0;margin-top:8px}',
  '.field-span-two{grid-column:span 2}',
  '.field-span-full{grid-column:1/-1}',
  '@container inspector (max-width:260px){.field-grid--three{grid-template-columns:repeat(2,minmax(0,1fr))}.field-span-two{grid-column:1/-1}}',
  '@container inspector (max-width:210px){.field-grid,.field-grid--three,.field-grid--two{grid-template-columns:1fr}.field-span-two{grid-column:auto}}',
  '',
].join('\n'));
function normalizedTextBuffer(buffer) {
  return Buffer.from(buffer.toString('utf8').replaceAll('\r\n', '\n'));
}

function authorizedEditorCss(template) {
  let css = template.toString('utf8');
  for (const [before, after] of [
    ['grid-template-columns:242px minmax(420px,1fr) 286px', 'grid-template-columns:220px minmax(420px,1fr) 286px'],
    ['grid-template-columns:210px minmax(420px,1fr) 250px', 'grid-template-columns:220px minmax(420px,1fr) 250px'],
    ['grid-template-columns:190px minmax(420px,1fr)', 'grid-template-columns:220px minmax(420px,1fr)'],
    ['grid-template-columns:160px minmax(440px,1fr)', 'grid-template-columns:220px minmax(440px,1fr)'],
    ['grid-template-columns:190px 242px minmax(420px,1fr) 286px', 'grid-template-columns:220px 242px minmax(420px,1fr) 286px'],
    ['grid-template-columns:170px 210px minmax(420px,1fr) 250px', 'grid-template-columns:220px 210px minmax(420px,1fr) 250px'],
    ['grid-template-columns:160px 190px minmax(420px,1fr)', 'grid-template-columns:220px 190px minmax(420px,1fr)'],
    ['grid-template-columns:150px 160px minmax(440px,1fr)', 'grid-template-columns:220px 160px minmax(440px,1fr)'],
  ]) {
    assert.ok(css.includes(before), `latest template no longer contains the authorized layout source: ${before}`);
    css = css.replace(before, after);
  }
  let adapted = Buffer.concat([
    Buffer.from(css),
    AUTHORIZED_PROJECTILE_AND_ENVIRONMENT_CSS,
    AUTHORIZED_MATERIAL_VISUAL_CSS,
  ]).toString('utf8');
  return Buffer.from(adapted);
}

async function readProject(path) {
  return readFile(resolve(projectRoot, path));
}

async function readTemplate(path) {
  return readFile(resolve(templateRoot, path));
}

test('adapted editor retains immutable template files and shell landmarks', async () => {
  for (const path of ['start.exe']) {
    assert.deepEqual(
      await readProject(path),
      await readTemplate(path),
      `${path} is not based on the latest template`,
    );
  }
  assert.deepEqual(
    normalizedTextBuffer(await readProject('static/css/editor.css')),
    normalizedTextBuffer(authorizedEditorCss(await readTemplate('static/css/editor.css'))),
    'editor.css must keep the latest template byte-for-byte except for authorized layout, projectile, environment, and material visual CSS',
  );
  const html = (await readProject('index.html')).toString('utf8');
  for (const landmark of ['LevelCraft', 'class="workspace"', 'id="edit-toggle"', 'data-tab="global"', 'data-tab="level"', 'data-tab="element"', 'id="refresh-button"', 'id="save-button"']) {
    assert.ok(html.includes(landmark), `missing adapted template landmark: ${landmark}`);
  }
});
