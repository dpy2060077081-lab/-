import { createEditorState } from './editor-state.js';
import { downloadLevel, levelPath, parseImportedFiles } from './file-transfer.js';

function formatFilename(path) {
  return String(path).replace(/\\/g, '/').split('/').at(-1) || path;
}

async function callRepository(repository, method, ...args) {
  try {
    if (typeof repository?.[method] !== 'function') throw new TypeError(`repository.${method} 不可用`);
    return await repository[method](...args);
  } catch (error) {
    return { ok: false, error: { code: 'REPOSITORY_ERROR', message: error instanceof Error ? error.message : String(error) } };
  }
}

function availablePath(entries, filename) {
  const first = levelPath(filename);
  const stem = formatFilename(first).replace(/\.json$/i, '');
  const existing = new Set(entries.map((entry) => levelPath(entry.path)));
  if (!existing.has(first)) return first;
  let suffix = 2;
  const suffixed = () => {
    const suffixText = `-${suffix}`;
    return levelPath(`${stem.slice(0, 80 - suffixText.length)}${suffixText}.json`);
  };
  let path = suffixed();
  while (existing.has(path)) { suffix += 1; path = suffixed(); }
  return path;
}

export function createLevelLibraryController({
  repository,
  config,
  assets,
  cloneLevel,
  validateLevel,
  confirm,
  onDraft,
  onLibrary,
  onFailure,
  onStatus,
}) {
  let currentRepository = repository;
  let entries = [];
  let activePath = null;
  let detachedSavePath = null;
  let repositoryGeneration = 0;
  let repositoryTransitioning = false;
  const pendingOperations = new Map();
  const pendingWaiters = new Map();
  let state = createEditorState(cloneLevel(config));
  const filters = { search: '', difficulty: '' };

  const notifyLibrary = () => onLibrary?.(controller);
  const transitionFailure = (code = 'REPOSITORY_TRANSITION') => ({
    ok: false,
    error: {
      code,
      message: code === 'STALE_REPOSITORY' ? '存储库已切换，旧操作结果未应用' : '存储库正在切换，请稍后重试',
    },
  });
  const rejectDuringTransition = (label) => {
    if (!repositoryTransitioning) return null;
    const failure = transitionFailure();
    onFailure?.(label, failure.error);
    return failure;
  };
  const beginPersistence = (label) => {
    const blocked = rejectDuringTransition(label);
    if (blocked) return { blocked };
    const operation = { generation: repositoryGeneration, repository: currentRepository };
    pendingOperations.set(operation.generation, (pendingOperations.get(operation.generation) ?? 0) + 1);
    return operation;
  };
  const finishPersistence = (operation) => {
    if (operation.blocked) return;
    const remaining = (pendingOperations.get(operation.generation) ?? 1) - 1;
    if (remaining > 0) {
      pendingOperations.set(operation.generation, remaining);
      return;
    }
    pendingOperations.delete(operation.generation);
    for (const resolve of pendingWaiters.get(operation.generation) ?? []) resolve();
    pendingWaiters.delete(operation.generation);
  };
  const waitForPersistence = (generation) => {
    if (!pendingOperations.has(generation)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = pendingWaiters.get(generation) ?? [];
      waiters.push(resolve);
      pendingWaiters.set(generation, waiters);
    });
  };
  const staleCreateResult = async (repository, path) => {
    const cleanup = await callRepository(repository, 'remove', path, true);
    const failure = cleanup.ok ? transitionFailure('STALE_REPOSITORY') : {
      ok: false,
      error: {
        code: 'PARTIAL_PERSISTENCE',
        message: '存储库切换后清理旧文件失败，请检查关卡库',
        details: { cleanupFailure: cleanup.error, path },
      },
    };
    return failure;
  };
  const rollbackPaths = async (repository, paths) => {
    const rollbackFailures = [];
    for (const path of [...paths].reverse()) {
      const rollback = await callRepository(repository, 'remove', path, true);
      if (!rollback.ok) rollbackFailures.push({ path, error: rollback.error });
    }
    return rollbackFailures;
  };
  const rollbackStaleImport = async (repository, paths) => {
    const rollbackFailures = await rollbackPaths(repository, paths);
    return {
      ok: false,
      error: {
        code: rollbackFailures.length === 0 ? 'STALE_REPOSITORY' : 'PARTIAL_IMPORT',
        message: rollbackFailures.length === 0
          ? '导入期间存储库已切换，已回滚导入'
          : '存储库切换后部分导入回滚失败，请检查关卡库',
        details: { rollbackFailures },
      },
    };
  };
  const reportCleanupFailure = (label, result) => {
    if (result?.error?.code?.startsWith('PARTIAL_')) onFailure?.(label, result.error);
    return result;
  };
  const sameSelection = (left, right) => left.length === right.length
    && left.every((id, index) => id === right[index]);
  const showDraft = (level, path) => {
    state = createEditorState(cloneLevel(level));
    activePath = path;
    onDraft?.(controller);
    notifyLibrary();
  };
  const createPersistedEntry = async (path, level, label) => {
    const operation = beginPersistence(label);
    if (operation.blocked) return operation.blocked;
    const initiatingState = state;
    const initiatingPath = activePath;
    const initiatingRevision = state.snapshot.revision;
    try {
      const created = await callRepository(operation.repository, 'create', path, level);
      if (operation.generation !== repositoryGeneration) {
        return created?.ok
          ? reportCleanupFailure(label, await staleCreateResult(operation.repository, path))
          : transitionFailure('STALE_REPOSITORY');
      }
      if (!created?.ok) {
        onFailure?.(label, created?.error);
        return created;
      }
      entries.push({ path, level: cloneLevel(level) });
      if (state === initiatingState && activePath === initiatingPath && state.snapshot.revision === initiatingRevision) {
        showDraft(level, path);
      } else {
        notifyLibrary();
      }
      return created;
    } finally {
      finishPersistence(operation);
    }
  };

  const actions = {
    setSearch(value) { filters.search = String(value ?? ''); },
    setDifficulty(value) { filters.difficulty = String(value ?? ''); },
    async select(path) {
      const blocked = rejectDuringTransition('读取关卡');
      if (blocked) return blocked;
      if (path === activePath) return { ok: true, data: state.level };
      const selectingGeneration = repositoryGeneration;
      const selectingRepository = currentRepository;
      const entry = entries.find((candidate) => candidate.path === path);
      const loaded = entry?.level ? { ok: true, data: entry.level } : await callRepository(selectingRepository, 'read', path);
      if (selectingGeneration !== repositoryGeneration) return transitionFailure('STALE_REPOSITORY');
      if (!loaded?.ok) {
        onFailure?.('读取关卡', loaded?.error);
        return loaded;
      }
      if (entry) entry.level = cloneLevel(loaded.data);
      showDraft(loaded.data, path);
      return loaded;
    },
    newLevel() {
      return createPersistedEntry(availablePath(entries, 'new-level.json'), cloneLevel(config), '新建关卡');
    },
    copy() {
      const stem = formatFilename(activePath || 'level.json').replace(/\.json$/i, '');
      return createPersistedEntry(availablePath(entries, `${stem}-copy.json`), cloneLevel(state.level), '复制关卡');
    },
    async remove() {
      const operation = beginPersistence('删除关卡');
      if (operation.blocked) return operation.blocked;
      try {
      if (!activePath) {
        const error = { code: 'NO_ACTIVE_LEVEL', message: '当前草稿尚未关联关卡文件' };
        onFailure?.('删除关卡', error);
        return { ok: false, error };
      }
      if (typeof confirm !== 'function' || !confirm(`确定删除“${formatFilename(activePath)}”吗？此操作无法撤销。`)) {
        return { ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: '已取消删除' } };
      }
      const removedPath = activePath;
      const removingState = state;
      const removed = await callRepository(operation.repository, 'remove', removedPath, true);
      if (repositoryGeneration !== operation.generation) {
        if (removed?.ok && currentRepository === operation.repository) {
          entries = entries.filter((entry) => entry.path !== removedPath);
          if (activePath === removedPath) {
            activePath = null;
            detachedSavePath = availablePath(entries, removedPath);
            notifyLibrary();
          }
        }
        return transitionFailure('STALE_REPOSITORY');
      }
      if (!removed?.ok) {
        onFailure?.('删除关卡', removed?.error);
        return removed;
      }
      entries = entries.filter((entry) => entry.path !== removedPath);
      if (state !== removingState || activePath !== removedPath) {
        notifyLibrary();
        return removed;
      }
      const next = entries[0];
      showDraft(next?.level ?? config, next?.path ?? null);
      return removed;
      } finally {
        finishPersistence(operation);
      }
    },
    async save() {
      const operation = beginPersistence('保存');
      if (operation.blocked) return operation.blocked;
      try {
      const validation = validateLevel(state.level, assets);
      if (!validation.ok) {
        const first = validation.errors?.[0];
        const detail = `校验未通过${first?.path ? `（${first.path}）` : ''}${first?.message ? `：${first.message}` : ''}`;
        onFailure?.('保存', { message: detail });
        return { ok: false, error: { code: 'VALIDATION_FAILED', message: '关卡校验未通过', details: validation.errors } };
      }
      const savedSnapshot = state.snapshot;
      const savingState = state;
      const savedLevel = cloneLevel(savedSnapshot.level);
      const path = activePath ?? availablePath(entries, 'new-level.json');
      const savePath = activePath ?? detachedSavePath ?? path;
      const creating = !activePath;
      const saved = creating
        ? await callRepository(operation.repository, 'create', savePath, savedLevel)
        : await callRepository(operation.repository, 'save', savePath, savedLevel);
      if (repositoryGeneration !== operation.generation) {
        if (!creating && saved?.ok && currentRepository === operation.repository) {
          const restoredEntry = entries.find((candidate) => candidate.path === savePath);
          if (restoredEntry) restoredEntry.level = cloneLevel(savedLevel);
          notifyLibrary();
        }
        return creating && saved?.ok
          ? reportCleanupFailure('保存', await staleCreateResult(operation.repository, savePath))
          : transitionFailure('STALE_REPOSITORY');
      }
      if (!saved?.ok) {
        onFailure?.('保存', saved?.error);
        return saved;
      }
      const entry = entries.find((candidate) => candidate.path === savePath);
      if (entry) entry.level = cloneLevel(savedLevel);
      else entries.push({ path: savePath, level: cloneLevel(savedLevel) });
      if (state !== savingState) {
        notifyLibrary();
        return saved;
      }
      activePath = savePath;
      detachedSavePath = null;
      state.markClean(savedSnapshot.revision);
      notifyLibrary();
      const browser = currentRepository.mode !== 'desktop';
      onStatus?.(`关卡已保存${browser ? '；浏览器模式仅保存在当前页面，请使用导出下载文件' : ''}`, browser ? 'warning' : 'success');
      return saved;
      } finally {
        finishPersistence(operation);
      }
    },
    async importFiles(files) {
      const operation = beginPersistence('导入');
      if (operation.blocked) return operation.blocked;
      try {
      const initiatingState = state;
      const initiatingPath = activePath;
      const initiatingRevision = state.snapshot.revision;
      const initiatingSelection = state.selection;
      const importRepository = operation.repository;
      const importGeneration = operation.generation;
      const parsed = await parseImportedFiles(files);
      if (repositoryGeneration !== importGeneration) return transitionFailure('STALE_REPOSITORY');
      if (!parsed.ok) {
        onFailure?.('导入', parsed.error);
        return parsed;
      }
      const existing = new Set(entries.map((entry) => levelPath(entry.path)));
      const pending = parsed.data.map((item) => ({ ...item, path: levelPath(item.filename) }));
      const duplicate = pending.find((item) => existing.has(item.path));
      if (duplicate) {
        const result = { ok: false, error: { code: 'DUPLICATE_IMPORT', message: `关卡“${duplicate.filename}”已存在，请重命名后重试` } };
        onFailure?.('导入', result.error);
        return result;
      }

      const createdPaths = [];
      for (const item of pending) {
        if (repositoryGeneration !== importGeneration) {
          return reportCleanupFailure('导入', await rollbackStaleImport(importRepository, createdPaths));
        }
        const created = await callRepository(importRepository, 'create', item.path, item.level);
        if (repositoryGeneration !== importGeneration) {
          if (created?.ok) createdPaths.push(item.path);
          return reportCleanupFailure('导入', await rollbackStaleImport(importRepository, createdPaths));
        }
        if (!created?.ok) {
          const rollbackFailures = await rollbackPaths(importRepository, createdPaths);
          if (repositoryGeneration !== importGeneration) {
            return reportCleanupFailure('导入', {
              ok: false,
              error: {
                code: rollbackFailures.length === 0 ? 'STALE_REPOSITORY' : 'PARTIAL_IMPORT',
                message: rollbackFailures.length === 0
                  ? '导入期间存储库已切换，旧错误未应用'
                  : '存储库切换后部分导入回滚失败，请检查关卡库',
                details: { rollbackFailures },
              },
            });
          }
          const error = rollbackFailures.length === 0 ? created.error : {
            code: 'PARTIAL_IMPORT',
            message: `${created.error?.message ?? '导入失败'}；部分文件回滚失败，请检查关卡库`,
            details: { cause: created.error, rollbackFailures },
          };
          onFailure?.('导入', error);
          return { ok: false, error };
        }
        createdPaths.push(item.path);
      }
      if (repositoryGeneration !== importGeneration) {
        return reportCleanupFailure('导入', await rollbackStaleImport(importRepository, createdPaths));
      }
      entries.push(...pending.map((item) => ({ path: item.path, level: cloneLevel(item.level) })));
      if (state === initiatingState
        && activePath === initiatingPath
        && state.snapshot.revision === initiatingRevision
        && sameSelection(state.selection, initiatingSelection)) {
        showDraft(pending[0].level, pending[0].path);
      } else {
        notifyLibrary();
      }
      onStatus?.(`已导入 ${pending.length} 个关卡${currentRepository.persistent ? '' : '；浏览器模式仅保存在当前页面'}`, 'success');
      return parsed;
      } finally {
        finishPersistence(operation);
      }
    },
    export() {
      const result = downloadLevel(state.level, activePath || 'level.json');
      if (!result.ok) onFailure?.('导出', result.error);
      else onStatus?.(`已下载“${result.data.filename}”`, 'success');
      return result;
    },
  };

  const controller = {
    get entries() { return entries; },
    get activePath() { return activePath; },
    get state() { return state; },
    filters,
    actions,
  };

  const stageRepository = async (nextRepository, paths) => {
      const hydrated = [];
      const identities = new Set();
      if (paths.length > 0 && typeof nextRepository?.read !== 'function') {
        return { ok: false, error: { code: 'FILE_API_UNAVAILABLE', message: 'repository.read 不可用' } };
      }
      for (const path of paths) {
        const identity = levelPath(path);
        if (identities.has(identity)) {
          return { ok: false, error: { code: 'DUPLICATE_LEVEL_IDENTITY', message: `关卡库包含重复文件标识“${identity}”` } };
        }
        identities.add(identity);
        const loaded = await callRepository(nextRepository, 'read', path);
        if (!loaded.ok) return loaded;
        hydrated.push({ path, level: cloneLevel(loaded.data) });
      }
      return { ok: true, data: { repository: nextRepository, entries: hydrated } };
  };
  const commitRepository = (staged, { preserveDraft = false } = {}) => {
      const previousRepository = currentRepository;
      const previousEntries = entries;
      const previousState = state;
      const previousPath = activePath;
      const previousDetachedSavePath = detachedSavePath;
      currentRepository = staged.repository;
      entries = staged.entries;
      try {
        if (preserveDraft) {
          detachedSavePath = availablePath(entries, previousPath || 'new-level.json');
          activePath = null;
        } else {
          const first = entries[0];
          state = createEditorState(cloneLevel(first?.level ?? config));
          activePath = first?.path ?? null;
          detachedSavePath = null;
        }
        notifyLibrary();
      } catch (error) {
        currentRepository = previousRepository;
        entries = previousEntries;
        state = previousState;
        activePath = previousPath;
        detachedSavePath = previousDetachedSavePath;
        throw error;
      }
  };
  const changeRepository = async (nextRepository, paths, preserveDraft, { transition = false } = {}) => {
      let transitionGeneration = null;
      let committed = false;
      if (transition) {
        if (repositoryTransitioning) return transitionFailure();
        repositoryTransitioning = true;
        repositoryGeneration += 1;
        transitionGeneration = repositoryGeneration - 1;
      }
      try {
        const staged = await stageRepository(nextRepository, paths);
        if (!staged.ok) return staged;
        commitRepository(staged.data, { preserveDraft });
        committed = true;
        return { ok: true, data: entries };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'REPOSITORY_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      } finally {
        if (transition) {
          if (!committed) {
            repositoryGeneration += 1;
            await waitForPersistence(transitionGeneration);
          }
          repositoryTransitioning = false;
        }
      }
  };
  actions.initializeRepository = (paths) => changeRepository(currentRepository, paths, false);
  actions.upgradeRepository = (nextRepository, paths) => changeRepository(nextRepository, paths, true, { transition: true });
  Object.freeze(actions);
  return controller;
}
