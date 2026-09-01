import { drawLevel } from '../../gamelogic.js';
import { generateLevelBatch, REJECTION_LABELS, reserveCandidateNumbers } from './batch-level-generator.js';
import { validateLevelStability } from './level-stability-validator.js';
import { createCandidateZip, batchZipName } from './stored-zip.js';
import { createPlaySession } from './play-session.js';
import { objectBounds } from './placement-collision.js';

const $ = (root, selector) => root.querySelector(selector);
const clone = value => structuredClone(value);
const numberOf = level => Number(level.levelNumber ?? level.id);
const pathOf = level => level.filePath || `level/level-${numberOf(level)}.json`;

export function selectedCandidates(candidates, selected) {
  return candidates.filter(candidate => selected.has(candidate.signature));
}

export function visibleCandidates(candidates, platform = '', topology = '', sort = 'number') {
  const filtered = candidates.filter(candidate => (!platform || candidate.platformType === platform) && (!topology || candidate.family === topology));
  const novelty = candidate => 1 - (candidate.nearest?.contourJaccard ?? 0);
  const keys = {
    number: candidate => candidate.suggestedNumber,
    platform: candidate => `${candidate.platformType}/${String(candidate.suggestedNumber).padStart(4, '0')}`,
    topology: candidate => `${candidate.family}/${String(candidate.suggestedNumber).padStart(4, '0')}`,
    novelty: candidate => -novelty(candidate),
  };
  const key = keys[sort] ?? keys.number;
  return filtered.sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : left.suggestedNumber - right.suggestedNumber);
}

export const batchCompletionLabel = result => result.cancelled ? '已取消，保留' : result.insufficient ? '生成不足' : '完成';
export const batchProgressLabel = progress => `尝试 ${progress.attempted} · 静态通过 ${progress.staticPassed} · 物理通过 ${progress.physicsPassed} · 候选入池 ${progress.accepted} · 正在寻找合格组合 · ${(progress.elapsedMs / 1000).toFixed(1)} 秒`;

export function createSessionSeed(crypto = globalThis.crypto) {
  if (crypto?.getRandomValues) {
    const words = new Uint32Array(2);
    crypto.getRandomValues(words);
    return `${words[0].toString(36)}-${words[1].toString(36)}`;
  }
  return 'cannon-castle';
}

export function createBatchRunCoordinator() {
  let revision = 0;
  return {
    invalidate() { revision += 1; },
    async run(task, commit, finish = () => {}) {
      const current = ++revision;
      try {
        const result = await task();
        if (current !== revision) return false;
        commit(result);
        return true;
      } finally {
        if (current === revision) finish();
      }
    },
  };
}

function download(bytes, name, ownerDocument) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const link = ownerDocument.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function diagnosticText(diagnostics = {}) {
  const rejected = Object.entries(diagnostics.rejected ?? {})
    .filter(([, count]) => count)
    .map(([reason, count]) => `${REJECTION_LABELS[reason] ?? reason} ${count}`)
    .join(' · ');
  return rejected || '暂无淘汰';
}

function movingLevel(level, snapshot) {
  const bodies = new Map((snapshot?.bodies ?? []).map(body => [body.id, body]));
  return {
    ...level,
    castle: (level.castle ?? []).map(object => {
      const body = bodies.get(object.id);
      return body ? { ...object, x: body.x, y: body.y, angle: body.angle } : object;
    }),
  };
}

export function createBatchLevelDialog({ document: ownerDocument, store, writable, onAccepted = () => {} }) {
  const dialog = $(ownerDocument, '#batch-level-dialog');
  const openButton = $(ownerDocument, '#batch-level-button');
  if (!dialog || !openButton) return () => {};
  const seedInput = $(dialog, '#batch-seed');
  const countInput = $(dialog, '#batch-count');
  const startButton = $(dialog, '#batch-start');
  const cancelButton = $(dialog, '#batch-cancel');
  const resultButton = $(dialog, '#batch-result-action');
  const closeButton = $(dialog, '#batch-close');
  const status = $(dialog, '#batch-status');
  const rejection = $(dialog, '#batch-rejections');
  const cards = $(dialog, '#batch-cards');
  const platformFilter = $(dialog, '#batch-platform-filter');
  const topologyFilter = $(dialog, '#batch-topology-filter');
  const sortInput = $(dialog, '#batch-sort');
  let candidates = [];
  const sessionHistory = [];
  let selected = new Set();
  let controller = null;
  let running = false;
  let play = null;
  let playFrame = null;
  let disposed = false;
  const runCoordinator = createBatchRunCoordinator();
  const renderBuffers = new WeakMap();

  seedInput.value ||= createSessionSeed();
  resultButton.textContent = writable ? '接收所选关卡' : '导出所选关卡';

  const pending = () => candidates.length > 0;
  const updateActions = () => {
    startButton.disabled = running;
    cancelButton.disabled = !running;
    resultButton.disabled = running || selected.size === 0;
  };
  const stopPlay = () => {
    if (playFrame != null) globalThis.cancelAnimationFrame?.(playFrame);
    playFrame = null;
    play?.exit();
    play = null;
  };
  const paint = (canvas, level) => {
    let source = renderBuffers.get(canvas);
    if (!source) {
      source = ownerDocument.createElement('canvas');
      source.width = store.config.canvas.width;
      source.height = store.config.canvas.height;
      renderBuffers.set(canvas, source);
    }
    drawLevel(source.getContext('2d'), level, { mode: 'preview', assets: store.assets, config: store.config });
    const context = canvas.getContext('2d');
    const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    context.fillStyle = '#141a24';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  };
  const paintStructure = (canvas, candidate) => {
    const context = canvas.getContext('2d');
    const objects = candidate.level.castle ?? [];
    const nodes = new Map(candidate.descriptor.nodes.map(node => [node.id, node]));
    const byId = new Map(objects.map(object => [object.id, object]));
    const children = new Map(objects.map(object => [object.id, 0]));
    for (const node of nodes.values()) for (const parentId of node.parentIds) children.set(parentId, (children.get(parentId) ?? 0) + 1);
    const drawable = objects.map(object => ({ object, bounds: objectBounds({ ...object, shape: object.shape ?? store.assets.shapes?.[object.shapePresetId]?.shape }) }));
    const minX = Math.min(...drawable.map(entry => entry.bounds.minX));
    const maxX = Math.max(...drawable.map(entry => entry.bounds.maxX));
    const minY = Math.min(...drawable.map(entry => entry.bounds.minY));
    const maxY = Math.max(...drawable.map(entry => entry.bounds.maxY));
    const padding = 10;
    const scale = Math.min((canvas.width - padding * 2) / Math.max(0.1, maxX - minX), (canvas.height - padding * 2) / Math.max(0.1, maxY - minY));
    const point = object => ({ x: padding + (object.x - minX) * scale, y: padding + (object.y - minY) * scale });
    context.fillStyle = '#101722'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = 1.5; context.strokeStyle = '#64748b';
    for (const node of nodes.values()) for (const parentId of node.parentIds) {
      const child = byId.get(node.id); const parent = byId.get(parentId);
      if (!child || !parent) continue;
      const from = point(parent); const to = point(child);
      context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
    }
    for (const { object, bounds } of drawable) {
      const node = nodes.get(object.id);
      context.fillStyle = node?.parentIds.length > 1 ? '#38bdf8' : (children.get(object.id) ?? 0) > 1 ? '#f59e0b' : node?.parentIds.length ? '#94a3b8' : '#22c55e';
      context.fillRect(padding + (bounds.minX - minX) * scale, padding + (bounds.minY - minY) * scale,
        Math.max(2, (bounds.maxX - bounds.minX) * scale), Math.max(2, (bounds.maxY - bounds.minY) * scale));
    }
  };
  const paintCards = () => {
    stopPlay();
    cards.replaceChildren();
    for (const candidate of visibleCandidates(candidates, platformFilter?.value, topologyFilter?.value, sortInput?.value)) {
      const template = ownerDocument.createElement('article');
      template.className = 'batch-card';
      template.dataset.signature = candidate.signature;
      template.dataset.levelNumber = candidate.level.levelNumber;
      template.dataset.family = candidate.family;
      const checked = selected.has(candidate.signature);
      template.innerHTML = `<label class="batch-card-select"><input type="checkbox" ${checked ? 'checked' : ''}> 选择</label><div class="batch-card-previews"><div class="batch-card-preview"><span>成品</span><canvas data-preview="normal"></canvas></div><div class="batch-card-preview"><span>支撑结构</span><canvas data-preview="structure"></canvas></div></div><strong></strong><small></small><small data-metrics></small><div class="batch-card-actions"><button type="button" data-action="compare">比较最近</button><button type="button" data-action="play">试玩</button><button type="button" data-action="discard">丢弃</button></div>`;
      const canvas = $(template, '[data-preview="normal"]');
      const structureCanvas = $(template, '[data-preview="structure"]');
      canvas.width = structureCanvas.width = 320;
      canvas.height = structureCanvas.height = 240;
      $(template, 'strong').textContent = `${candidate.level.levelNumber}. ${candidate.familyName}`;
      $(template, 'small').textContent = `${candidate.platformType} · ${candidate.metrics.count} 件 · 深度 ${candidate.metrics.depth} · 开口 ${candidate.metrics.openings}`;
      const nearest = candidate.nearest;
      $(template, '[data-metrics]').textContent = `最近 ${nearest?.id ?? '无'} · 轮廓 ${nearest ? nearest.contourJaccard.toFixed(3) : '—'} · 层级 ${nearest ? nearest.layerSimilarity.toFixed(3) : '—'} · ${Math.round(candidate.stability.elapsedMs)} ms 稳定`;
      $(template, 'input').onchange = event => {
        if (event.target.checked) selected.add(candidate.signature); else selected.delete(candidate.signature);
        updateActions();
      };
      $(template, '[data-action="discard"]').onclick = () => {
        candidates = candidates.filter(item => item.signature !== candidate.signature);
        selected.delete(candidate.signature);
        paintCards();
        updateActions();
      };
      const compareButton = $(template, '[data-action="compare"]');
      const nearestCard = () => [...cards.children].find(card => card.dataset.levelNumber === String(nearest?.id));
      compareButton.disabled = !nearest?.level;
      compareButton.onclick = () => {
        for (const card of cards.children) card.classList.remove('is-comparison');
        template.classList.add('is-comparison');
        let target = nearestCard();
        if (!target && nearest?.level) {
          target = ownerDocument.createElement('article');
          target.className = 'batch-card batch-card-temporary is-comparison';
          target.dataset.levelNumber = nearest.id;
          target.innerHTML = `<strong>最近关卡 ${nearest.id}</strong><small>只读比较预览</small><div class="batch-card-previews"><div class="batch-card-preview"><span>成品</span><canvas data-preview="normal" width="320" height="240"></canvas></div><div class="batch-card-preview"><span>支撑结构</span><canvas data-preview="structure" width="320" height="240"></canvas></div></div>`;
          cards.append(target);
          paint($(target, '[data-preview="normal"]'), nearest.level);
          paintStructure($(target, '[data-preview="structure"]'), { level: nearest.level, descriptor: nearest.descriptor });
        }
        target?.classList.add('is-comparison'); target?.scrollIntoView?.({ block: 'nearest' });
      };
      $(template, '[data-action="play"]').onclick = () => {
        stopPlay();
        play = createPlaySession({ draft: candidate.level, config: store.config, assets: store.assets });
        const button = $(template, '[data-action="play"]');
        button.textContent = '退出试玩';
        const frame = () => {
          if (!play || play.closed) return;
          const snapshot = play.step(1000 / 60);
          paint(canvas, movingLevel(candidate.level, snapshot));
          playFrame = globalThis.requestAnimationFrame?.(frame) ?? null;
        };
        canvas.onclick = event => {
          const rect = canvas.getBoundingClientRect();
          const scale = Math.min(rect.width / store.config.canvas.width, rect.height / store.config.canvas.height);
          const width = store.config.canvas.width * scale;
          const height = store.config.canvas.height * scale;
          const x = event.clientX - rect.left - (rect.width - width) / 2;
          const y = event.clientY - rect.top - (rect.height - height) / 2;
          if (x >= 0 && x <= width && y >= 0 && y <= height) play?.fireAt?.({ x: x / width * store.config.world.width, y: y / height * store.config.world.height });
        };
        button.onclick = () => { paintCards(); updateActions(); };
        frame();
      };
      cards.append(template);
      paint(canvas, candidate.level);
      paintStructure(structureCanvas, candidate);
    }
  };
  const warnBeforeUnload = event => {
    if (!pending()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  globalThis.addEventListener?.('beforeunload', warnBeforeUnload);

  openButton.onclick = () => dialog.showModal();
  startButton.onclick = async () => {
    if (pending() && !globalThis.confirm('开始新批次会丢弃当前未接收的候选，确定继续吗？')) return;
    stopPlay();
    candidates = [];
    selected.clear();
    cards.replaceChildren();
    running = true;
    controller = new AbortController();
    updateActions();
    status.textContent = '正在生成并验证…';
    rejection.textContent = '暂无淘汰';
    await runCoordinator.run(async () => generateLevelBatch({
        seed: seedInput.value.trim(), targetCount: Number(countInput.value), config: clone(store.config), assets: clone(store.assets),
        existingLevels: clone([...store.levels, ...sessionHistory]), validateStability: validateLevelStability, signal: controller.signal,
        onProgress: progress => {
          status.textContent = batchProgressLabel(progress);
          rejection.textContent = diagnosticText(progress);
        },
      }), result => {
      candidates = result.candidates;
      sessionHistory.push(...candidates.map(candidate => clone(candidate.level)));
      selected = new Set(candidates.map(candidate => candidate.signature));
      if (topologyFilter) {
        topologyFilter.replaceChildren(new Option('全部拓扑', ''));
        for (const family of [...new Set(candidates.map(candidate => candidate.family))].sort()) {
          topologyFilter.add(new Option(candidates.find(candidate => candidate.family === family)?.familyName ?? family, family));
        }
      }
      status.textContent = `${batchCompletionLabel(result)} ${candidates.length}/${result.targetCount} 个候选 · ${(result.diagnostics.elapsedMs / 1000).toFixed(1)} 秒`;
      rejection.textContent = diagnosticText(result.diagnostics);
      paintCards();
    }, () => {
      running = false;
      controller = null;
      updateActions();
    }).catch(error => {
      status.textContent = `不可恢复错误：${error?.message ?? error}`;
      running = false;
      controller = null;
      updateActions();
    });
  };
  cancelButton.onclick = () => {
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    cancelButton.disabled = true;
    status.textContent = '正在停止…';
  };
  $(dialog, '#batch-select-all').onclick = () => { selected = new Set(candidates.map(candidate => candidate.signature)); paintCards(); updateActions(); };
  $(dialog, '#batch-select-invert').onclick = () => { selected = new Set(candidates.filter(candidate => !selected.has(candidate.signature)).map(candidate => candidate.signature)); paintCards(); updateActions(); };
  $(dialog, '#batch-select-none').onclick = () => { selected.clear(); paintCards(); updateActions(); };
  if (platformFilter) platformFilter.onchange = paintCards;
  if (topologyFilter) topologyFilter.onchange = paintCards;
  if (sortInput) sortInput.onchange = paintCards;
  resultButton.onclick = () => {
    const chosen = selectedCandidates(candidates, selected);
    if (!chosen.length) return;
    try {
      if (writable) {
        const occupiedNumbers = new Set(store.levels.map(numberOf));
        const occupiedPaths = new Set(store.levels.map(pathOf));
        const reserved = reserveCandidateNumbers(chosen, occupiedNumbers, occupiedPaths);
        store.acceptGeneratedLevels(reserved.map(candidate => ({ ...candidate.level, fileName: candidate.fileName, filePath: candidate.filePath })));
        candidates = candidates.filter(candidate => !selected.has(candidate.signature));
        selected.clear();
        onAccepted();
        status.textContent = `已接收 ${reserved.length} 个关卡；请使用统一保存写入磁盘。`;
        paintCards();
      } else {
        download(createCandidateZip(chosen), batchZipName(seedInput.value), ownerDocument);
        candidates = candidates.filter(candidate => !selected.has(candidate.signature));
        selected.clear();
        status.textContent = `已导出 ${chosen.length} 个关卡。`;
        paintCards();
      }
    } catch (error) {
      status.textContent = `接收/导出失败：${error?.message ?? error}`;
    }
    updateActions();
  };
  const close = () => {
    if (running || pending()) {
      if (!globalThis.confirm('仍有生成中或未接收的候选。关闭会丢弃它们，确定关闭吗？')) return;
    }
    controller?.abort();
    runCoordinator.invalidate();
    running = false;
    controller = null;
    stopPlay();
    candidates = [];
    selected.clear();
    dialog.close();
    updateActions();
  };
  closeButton.onclick = close;
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  updateActions();
  return () => {
    if (disposed) return;
    disposed = true;
    controller?.abort();
    runCoordinator.invalidate();
    stopPlay();
    globalThis.removeEventListener?.('beforeunload', warnBeforeUnload);
    openButton.onclick = null;
  };
}
