import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { batchCompletionLabel, batchProgressLabel, createBatchLevelDialog, createBatchRunCoordinator, createSessionSeed, selectedCandidates, visibleCandidates } from '../static/js/batch-level-ui.js';

test('selection helpers export only checked candidates', () => {
  const candidates = [{ signature: 'a' }, { signature: 'b' }, { signature: 'c' }];
  assert.deepEqual(selectedCandidates(candidates, new Set(['a', 'c'])), [candidates[0], candidates[2]]);
});

test('candidate filtering and platform, topology and novelty sorting are deterministic', () => {
  const candidates = [
    { suggestedNumber: 103, platformType: 'single-5', family: 'z', nearest: { contourJaccard: 0.7 } },
    { suggestedNumber: 101, platformType: 'single-3', family: 'b', nearest: { contourJaccard: 0.4 } },
    { suggestedNumber: 102, platformType: 'single-3', family: 'a', nearest: { contourJaccard: 0.6 } },
  ];
  assert.deepEqual(visibleCandidates(candidates, 'single-3', '', 'number').map(item => item.suggestedNumber), [101, 102]);
  assert.deepEqual(visibleCandidates(candidates, '', 'a', 'number').map(item => item.suggestedNumber), [102]);
  assert.deepEqual(visibleCandidates(candidates, '', '', 'platform').map(item => item.suggestedNumber), [101, 102, 103]);
  assert.deepEqual(visibleCandidates(candidates, '', '', 'topology').map(item => item.suggestedNumber), [102, 101, 103]);
  assert.deepEqual(visibleCandidates(candidates, '', '', 'novelty').map(item => item.suggestedNumber), [101, 102, 103]);
});

test('session seed is copyable deterministic text from supplied entropy', () => {
  const crypto = { getRandomValues(words) { words[0] = 123; words[1] = 456; return words; } };
  assert.equal(createSessionSeed(crypto), '3f-co');
});

test('batch completion labels prioritize cancellation and show insufficient results', () => {
  assert.equal(batchCompletionLabel({ cancelled: true, insufficient: true }), '已取消，保留');
  assert.equal(batchCompletionLabel({ cancelled: false, insufficient: true }), '生成不足');
  assert.equal(batchCompletionLabel({ cancelled: false, insufficient: false }), '完成');
});

test('batch progress distinguishes the candidate pool from the final qualified subset', () => {
  assert.equal(batchProgressLabel({ attempted: 477, staticPassed: 234, physicsPassed: 32, accepted: 31, elapsedMs: 31_300 }),
    '尝试 477 · 静态通过 234 · 物理通过 32 · 候选入池 31 · 正在寻找合格组合 · 31.3 秒');
});

test('batch dialog exposes a one-shot stop action while generation is running', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../static/js/batch-level-ui.js', import.meta.url), 'utf8');
  assert.match(html, /id="batch-cancel"[^>]*>停止生成<\/button>/);
  assert.match(ui, /controller\.abort\(\);\s*cancelButton\.disabled = true;\s*status\.textContent = '正在停止…';/);
});

test('dialog coordinator queries its supplied document and tolerates an absent host', () => {
  let queries = 0;
  const dispose = createBatchLevelDialog({ document: { querySelector() { queries += 1; return null; } }, store: {}, writable: false });
  assert.equal(typeof dispose, 'function');
  assert.equal(queries, 2);
  dispose();
});

test('batch run coordinator ignores an async result after close invalidates its session', async () => {
  const coordinator = createBatchRunCoordinator();
  let resolve;
  let committed = false;
  let finished = false;
  const running = coordinator.run(() => new Promise(done => { resolve = done; }), () => { committed = true; }, () => { finished = true; });
  coordinator.invalidate();
  resolve({ candidates: [{ signature: 'hidden' }] });
  assert.equal(await running, false);
  assert.equal(committed, false);
  assert.equal(finished, false);
});
