import { createEmptyLevel, validateLevel } from "../../gamelogic.js";
import { findFreePlacement } from "./placement-collision.js";
import { assetEntries, createAssetObject, scanAssetDefinitionReferences, scanAssetReferences, validateAssetGraph } from "./asset-store.js";
import { assertProjectConfig, patchProjectConfig } from "./global-physics-store.js";
import { decodeLevelDocument, encodeLevelDocument } from "./level-document.js";
import { levelExtensionValues, mergeLevelExtensionValues } from "./level-fields.js";
import { createGlobalConfigDocument, encodeGlobalConfig } from "./global-config-document.js";
import { createFrozenBody, expandFrozenSelection, frozenMembership, removeFrozenBodies } from "./frozen-body-model.js";
import { EXPORT_MANIFEST_FILE, exportManifestLevelEntries } from "../../levellist.js";

const clone = value => structuredClone(value);
const levelNumber = level => Number(level.levelNumber ?? level.id);
const identity = level => level.workspaceId ?? levelNumber(level);
const levelPath = level => level.filePath || `level/level-${levelNumber(level)}.json`;
const comparable = value => JSON.stringify(value);
const levelFilename = (number, name) => `关卡-${String(number).padStart(3, "0")}-${String(name).trim() || `新关卡 ${number}`}.json`;
const levelPathFor = (number, name) => `level/${levelFilename(number, name)}`;
const sortLevelsByNumber = levels => levels.sort((left, right) => levelNumber(left) - levelNumber(right)
  || String(levelPath(left)).localeCompare(String(levelPath(right)), undefined, { numeric: true, sensitivity: "base" }));

function resolveLevel(levels, id) {
  const exact = levels.find(level => String(identity(level)) === String(id));
  if (exact) return exact;
  const numbered = levels.filter(level => String(levelNumber(level)) === String(id));
  if (numbered.length > 1) throw Object.assign(new Error(`关卡编号 ${id} 存在冲突，请使用稳定关卡标识`), { code: "LEVEL_IDENTITY_CONFLICT" });
  return numbered[0] ?? null;
}

function levelDocument(level) {
  const document = clone(level);
  delete document.fileName;
  delete document.filePath;
  delete document.workspaceId;
  delete document.workspaceKind;
  delete document.numberConflict;
  return encodeLevelDocument(document);
}

function levelManifestEntry(level) {
  return {
    id: String(level.__levelDocument?.levelId ?? `level-${levelNumber(level)}`),
    number: levelNumber(level),
    name: String(level.levelName),
    difficulty: level.difficulty,
  };
}

function manifestEntryMatches(entry, expected) {
  return Boolean(entry)
    && entry.id === expected.id
    && entry.number === expected.number
    && entry.name === expected.name
    && entry.difficulty === expected.difficulty;
}

function imageEntries(images) {
  const entries = images instanceof Map
    ? [...images].map(([path, value]) => typeof value === "object" && value !== null ? { path, ...value } : { path, content: value })
    : [...(images || [])];
  return entries.map(entry => ({ ...entry, isNew: entry.isNew ?? true }));
}

function assertLevelValid(level, assets) {
  const result = validateLevel(level, assets);
  if (result.ok) return level;
  const first = result.errors[0];
  throw Object.assign(new Error(`${first.path} ${first.message}`), {
    code: "LEVEL_INVALID",
    details: { ...first, errors: result.errors },
  });
}

export async function saveWorkspace({ files, globalDocument, config, assets, writeGlobal = true, manifest = null, dirtyLevels = [], newImages = [], deletions = {} }) {
  if (!files) throw new Error("当前为只读演示模式");
  const journal = {
    created: { images: [], levels: [] },
    written: [],
    deleted: { images: [], levels: [] },
  };
  try {
    try { await files.mkdir("level/asset", true); } catch (error) { if (error.code !== "ALREADY_EXISTS") throw error; }
    for (const image of imageEntries(newImages)) {
      let changed = false;
      try {
        await files.writeBase64(image.path, image.content, !image.isNew);
        changed = true;
      } catch (error) {
        if (!image.isNew || error.code !== "ALREADY_EXISTS") throw error;
        const existing = await files.readBase64(image.path);
        if (existing.content !== image.content) throw error;
      }
      if (changed) {
        if (image.isNew) journal.created.images.push(image.path);
        else journal.written.push(image.path);
      }
    }
    if (writeGlobal) {
      const unified = encodeGlobalConfig({ document: globalDocument, config, assets });
      await files.writeText("全局配置.json", JSON.stringify(unified, null, 2), true);
      journal.written.push("全局配置.json");
    }
    for (const entry of dirtyLevels) {
      const content = JSON.stringify(levelDocument(entry.level), null, 2);
      let changed = false;
      try {
        await files.writeText(entry.path, content, !entry.isNew);
        changed = true;
      } catch (error) {
        if (!entry.isNew || error.code !== "ALREADY_EXISTS") throw error;
        const existing = await files.readText(entry.path);
        if (existing.content !== content) throw error;
      }
      if (changed) {
        if (entry.isNew) journal.created.levels.push(entry.path);
        else journal.written.push(entry.path);
      }
    }
    if (manifest) {
      await files.writeText(`level/${EXPORT_MANIFEST_FILE}`, JSON.stringify(manifest, null, 2), true);
      journal.written.push(`level/${EXPORT_MANIFEST_FILE}`);
    }
    for (const path of deletions.levels || []) {
      try { await files.remove(path, false); } catch (error) { if (error.code !== "NOT_FOUND") throw error; }
      journal.deleted.levels.push(path);
    }
    for (const path of deletions.images || []) {
      try { await files.remove(path, false); } catch (error) { if (error.code !== "NOT_FOUND") throw error; }
      journal.deleted.images.push(path);
    }
    return { journal };
  } catch (error) {
    error.journal = journal;
    throw error;
  }
}

export class EditorStore {
  constructor({ globalDocument, config, assets, levels, files = null, reservedLevelNumbers = [], manifest = null }) {
    this.globalDocument = clone(globalDocument ?? createGlobalConfigDocument({ config, assets }));
    this.config = clone(config);
    this.assets = clone(assets);
    this.levels = clone(levels).map(level => decodeLevelDocument(level, this.assets));
    this.files = files;
    this.manifest = clone(manifest ?? { version: 1, type: "manifest", levels: [] });
    this.reservedLevelNumbers = new Set(reservedLevelNumbers);
    // Last-saved baseline per level path; discardLevelChanges() reverts to this.
    this.savedLevels = new Map(this.levels.map(level => [levelPath(level), clone(level)]));
    this.currentLevelId = this.levels[0] ? identity(this.levels[0]) : null;
    this.selectedObjectIds = [];
    this.selectedAssetId = null;
    this.selectedAssetKind = null;
    this.dirty = false;
    this.configDirty = false;
    this.assetsDirty = false;
    this.dirtyLevelPaths = new Set();
    this.newLevelPaths = new Set();
    this.history = [];
    this.future = [];
    this.pendingImages = new Map();
    this.deletedLevelPaths = new Set();
    this.deletedImagePaths = new Set();
    this.listeners = new Set();
    this.revision = 0;
    this.savePromise = null;
  }

  get currentLevel() { return this.levels.find(level => identity(level) === this.currentLevelId) || null; }
  get itemContext() {
    if (this.selectedAssetId) return { type: "asset", kind: this.selectedAssetKind, id: this.selectedAssetId };
    return this.selectedObjectIds.length ? { type: "object", ids: [...this.selectedObjectIds] } : null;
  }
  allAssets() { return assetEntries(this.assets); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { this.listeners.forEach(listener => listener(this)); }
  snapshot() {
    return clone({
      config: this.config,
      assets: this.assets,
      levels: this.levels,
      currentLevelId: this.currentLevelId,
      selectedObjectIds: this.selectedObjectIds,
      selectedAssetId: this.selectedAssetId,
      selectedAssetKind: this.selectedAssetKind,
      configDirty: this.configDirty,
      assetsDirty: this.assetsDirty,
      dirtyLevelPaths: this.dirtyLevelPaths,
      newLevelPaths: this.newLevelPaths,
      pendingImages: this.pendingImages,
      deletedLevelPaths: this.deletedLevelPaths,
      deletedImagePaths: this.deletedImagePaths,
    });
  }
  refreshDirty() {
    this.dirty = this.configDirty || this.assetsDirty || this.dirtyLevelPaths.size > 0
      || this.pendingImages.size > 0 || this.deletedLevelPaths.size > 0 || this.deletedImagePaths.size > 0;
  }
  savedLevelFor(level) {
    if (level?.workspaceId != null) {
      const workspaceId = String(level.workspaceId);
      const matched = [...this.savedLevels.values()].find(saved => String(saved.workspaceId) === workspaceId);
      if (matched) return matched;
    }
    return this.savedLevels.get(levelPath(level)) ?? null;
  }
  recalculateLevelChanges() {
    const current = new Map(this.levels.map(level => [levelPath(level), level]));
    const dirtyLevelPaths = new Set();
    const newLevelPaths = new Set();
    const deletedLevelPaths = new Set();
    for (const [path, level] of current) {
      const saved = this.savedLevels.get(path);
      if (!saved) {
        dirtyLevelPaths.add(path);
        newLevelPaths.add(path);
      } else if (comparable(saved) !== comparable(level)) {
        dirtyLevelPaths.add(path);
      }
    }
    for (const path of this.savedLevels.keys()) if (!current.has(path)) deletedLevelPaths.add(path);
    this.dirtyLevelPaths = dirtyLevelPaths;
    this.newLevelPaths = newLevelPaths;
    this.deletedLevelPaths = deletedLevelPaths;
  }
  workspaceChanged(before) {
    return comparable(before.config) !== comparable(this.config)
      || comparable(before.assets) !== comparable(this.assets)
      || comparable(before.levels) !== comparable(this.levels)
      || comparable([...before.pendingImages]) !== comparable([...this.pendingImages])
      || comparable([...before.deletedLevelPaths]) !== comparable([...this.deletedLevelPaths])
      || comparable([...before.deletedImagePaths]) !== comparable([...this.deletedImagePaths]);
  }
  trackChanges(before) {
    if (comparable(before.config) !== comparable(this.config)) this.configDirty = true;
    if (comparable(before.assets) !== comparable(this.assets)) this.assetsDirty = true;
    this.recalculateLevelChanges();
    this.refreshDirty();
  }
  restore(state) { Object.assign(this, clone(state)); this.revision += 1; this.refreshDirty(); this.emit(); }
  mutate(change) {
    const before = this.snapshot();
    change();
    if (!this.workspaceChanged(before)) {
      this.refreshDirty();
      this.emit();
      return false;
    }
    this.trackChanges(before);
    this.revision += 1;
    this.history.push(before);
    if (this.history.length > 100) this.history.shift();
    this.future = [];
    this.emit();
    return true;
  }
  undo() {
    if (!this.history.length) return false;
    this.future.push(this.snapshot());
    this.restore(this.history.pop());
    return true;
  }
  redo() {
    if (!this.future.length) return false;
    this.history.push(this.snapshot());
    this.restore(this.future.pop());
    return true;
  }

  selectLevel(id) {
    const level = resolveLevel(this.levels, id);
    if (!level) return false;
    this.currentLevelId = identity(level);
    this.selectedObjectIds = [];
    this.selectedAssetId = null;
    this.selectedAssetKind = null;
    this.emit();
    return true;
  }
  /** 丢弃指定关卡的未保存修改：已有关卡回退到上次保存内容；新建未保存关卡则整体移除。 */
  discardLevelChanges(id) {
    const level = resolveLevel(this.levels, id);
    if (!level) return false;
    const path = levelPath(level);
    const saved = this.savedLevelFor(level);
    if (!saved && this.newLevelPaths.has(path)) {
      this.levels = this.levels.filter(item => item !== level);
      this.savedLevels.delete(path);
      if (this.currentLevelId === identity(level)) this.currentLevelId = this.levels[0] ? identity(this.levels[0]) : null;
    } else {
      if (!saved) return false;
      const restorations = new Map([[level, saved]]);
      const pending = [level];
      while (pending.length) {
        const restoring = pending.shift();
        const baseline = restorations.get(restoring);
        const conflict = this.levels.find(candidate => candidate !== restoring && !restorations.has(candidate)
          && (levelNumber(candidate) === levelNumber(baseline) || levelPath(candidate) === levelPath(baseline)));
        if (!conflict) continue;
        const conflictBaseline = this.savedLevelFor(conflict);
        if (!conflictBaseline) throw new Error("无法单独放弃改号：原编号已被新关卡占用");
        restorations.set(conflict, conflictBaseline);
        pending.push(conflict);
      }
      for (const [restoring, baseline] of restorations) {
        const wasCurrent = this.currentLevelId === identity(restoring);
        Object.keys(restoring).forEach(key => { delete restoring[key]; });
        Object.assign(restoring, clone(baseline));
        if (wasCurrent) this.currentLevelId = identity(restoring);
      }
      sortLevelsByNumber(this.levels);
    }
    this.recalculateLevelChanges();
    this.selectedObjectIds = [];
    this.selectedAssetId = null;
    this.selectedAssetKind = null;
    this.history = [];
    this.future = [];
    this.refreshDirty();
    this.emit();
    return true;
  }
  selectObjects(ids) {
    const existing = new Set((this.currentLevel?.castle || []).map(object => object.id));
    this.selectedObjectIds = expandFrozenSelection(this.currentLevel, [...new Set(ids)].filter(id => existing.has(id)));
    if (this.selectedObjectIds.length) {
      this.selectedAssetId = null;
      this.selectedAssetKind = null;
    }
    this.emit();
  }
  selectAsset(id, kind = null) {
    if (id == null) {
      this.selectedAssetId = null;
      this.selectedAssetKind = null;
      this.emit();
      return;
    }
    const asset = this.allAssets().find(item => item.id === id && (!kind || item.kind === kind));
    if (!asset) throw Object.assign(new Error(`资源不存在：${id}`), { code: "ASSET_INVALID", details: { kind, id } });
    this.selectedAssetId = asset.id;
    this.selectedAssetKind = asset.kind;
    this.selectedObjectIds = [];
    this.emit();
  }
  updateConfig(patch) {
    const next = { ...clone(this.config), ...clone(patch) };
    assertProjectConfig(next);
    return this.mutate(() => { this.config = next; });
  }
  updateConfigPath(path, value) {
    const result = patchProjectConfig(this.config, path, value);
    if (!result.ok) throw Object.assign(new Error(`${result.error.path} ${result.error.message}`), {
      code: result.error.code,
      details: clone(result.error),
    });
    this.mutate(() => { this.config = result.data; });
    return clone(this.config);
  }
  updateLevel(patch) {
    const level = this.currentLevel;
    if (!level) return;
    const currentNumber = levelNumber(level);
    const nextNumber = Number(patch.levelNumber ?? currentNumber);
    if (Object.hasOwn(patch, "levelNumber") && nextNumber !== currentNumber
      && this.levels.some(candidate => candidate !== level && levelNumber(candidate) === nextNumber)) throw new Error("关卡编号已存在");
    const nextLevelId = `level-${nextNumber}`;
    if (Object.hasOwn(patch, "levelNumber") && nextNumber !== currentNumber
      && this.levels.some(candidate => candidate !== level && candidate.__levelDocument?.levelId === nextLevelId)) {
      throw new Error(`关卡标识 ${nextLevelId} 已存在`);
    }
    const candidate = { ...clone(level), ...clone(patch) };
    assertLevelValid(candidate, this.assets);
    this.mutate(() => {
      const generatedNewFile = this.newLevelPaths.has(levelPath(level));
      Object.assign(level, clone(patch));
      const renumbered = nextNumber !== currentNumber;
      if (renumbered) {
        level.__levelDocument = { ...clone(level.__levelDocument), levelId: `level-${nextNumber}` };
      }
      if ((renumbered && (generatedNewFile || level.workspaceKind === "exported"))
        || ((generatedNewFile || level.workspaceKind === "exported") && Object.hasOwn(patch, "levelName"))) {
        const path = levelPathFor(nextNumber, candidate.levelName);
        level.fileName = path.slice("level/".length);
        level.filePath = path;
      }
      this.currentLevelId = identity(level);
      if (renumbered) sortLevelsByNumber(this.levels);
    });
  }
  replaceLevelExtensions(extensions) {
    const level = this.currentLevel;
    if (!level) return;
    const nextExtensions = mergeLevelExtensionValues(level, extensions);
    const previousKeys = Object.keys(levelExtensionValues(level));
    const candidate = clone(level);
    previousKeys.forEach(key => { delete candidate[key]; });
    Object.assign(candidate, clone(nextExtensions));
    assertLevelValid(candidate, this.assets);
    this.mutate(() => {
      previousKeys.forEach(key => { delete level[key]; });
      Object.assign(level, clone(nextExtensions));
    });
  }
  updateObjects(ids, updater) {
    if (!this.currentLevel || ids.length === 0) return;
    const selected = new Set(expandFrozenSelection(this.currentLevel, ids));
    const castle = this.currentLevel.castle.map(object => selected.has(object.id) ? updater(clone(object)) : clone(object));
    assertLevelValid({ ...clone(this.currentLevel), castle }, this.assets);
    this.mutate(() => {
      this.currentLevel.castle = castle;
    });
  }
  rotateObjects(ids, deltaRadians) {
    if (!this.currentLevel || ids.length === 0) return false;
    const selected = new Set(expandFrozenSelection(this.currentLevel, ids));
    const candidate = clone(this.currentLevel);
    const membership = frozenMembership(candidate);
    const byId = new Map(candidate.castle.map(object => [object.id, object]));
    const centers = new Map();
    for (const group of candidate.frozenBodies || []) {
      if (!group.memberIds.some(id => selected.has(id))) continue;
      const members = group.memberIds.map(id => byId.get(id));
      centers.set(group.id, {
        x: members.reduce((sum, object) => sum + Number(object.x), 0) / members.length,
        y: members.reduce((sum, object) => sum + Number(object.y), 0) / members.length,
      });
    }
    const cosine = Math.cos(deltaRadians);
    const sine = Math.sin(deltaRadians);
    candidate.castle = candidate.castle.map(object => {
      if (!selected.has(object.id)) return object;
      const center = centers.get(membership.get(object.id));
      if (!center) return { ...object, angle: Number(object.angle || 0) + deltaRadians };
      const dx = Number(object.x) - center.x;
      const dy = Number(object.y) - center.y;
      return {
        ...object,
        x: center.x + dx * cosine - dy * sine,
        y: center.y + dx * sine + dy * cosine,
        angle: Number(object.angle || 0) + deltaRadians,
      };
    });
    assertLevelValid(candidate, this.assets);
    return this.mutate(() => { this.currentLevel.castle = candidate.castle; });
  }
  beginGesture() { return this.snapshot(); }
  previewObjects(ids, updater) {
    if (!this.currentLevel) return;
    const selected = new Set(ids);
    const castle = this.currentLevel.castle.map(object => selected.has(object.id) ? updater(clone(object)) : clone(object));
    assertLevelValid({ ...clone(this.currentLevel), castle }, this.assets);
    this.currentLevel.castle = castle;
    this.emit();
  }
  commitGesture(before) {
    if (JSON.stringify(before.levels) === JSON.stringify(this.levels)) return false;
    this.trackChanges(before);
    this.revision += 1;
    this.history.push(before);
    if (this.history.length > 100) this.history.shift();
    this.future = [];
    this.emit();
    return true;
  }
  cancelGesture(before) { Object.assign(this, clone(before)); this.emit(); }

  duplicateObjects(ids, offset = null) {
    if (!this.currentLevel || ids.length === 0) return;
    const selected = new Set(expandFrozenSelection(this.currentLevel, ids));
    let candidate = clone(this.currentLevel);
    const selectedObjects = candidate.castle.filter(object => selected.has(object.id));
    const free = offset ?? findFreePlacement(selectedObjects, candidate.castle);
    const delta = free ?? { x: 0.1, y: 0.1 };
    const used = new Set(candidate.castle.map(object => object.id));
    const copies = selectedObjects.map(object => {
      let id = `${object.id}-copy`;
      let suffix = 2;
      while (used.has(id)) id = `${object.id}-copy-${suffix++}`;
      used.add(id);
      return { ...clone(object), id, x: Number(object.x) + delta.x, y: Number(object.y) + delta.y };
    });
    candidate.castle.push(...copies);
    const copiedIds = new Map(selectedObjects.map((object, index) => [object.id, copies[index].id]));
    const copiedGroups = (candidate.frozenBodies || []).filter(group => group.memberIds.some(id => selected.has(id)));
    for (const group of copiedGroups) {
      candidate = createFrozenBody(candidate, group.memberIds.map(id => copiedIds.get(id))).level;
    }
    assertLevelValid(candidate, this.assets);
    this.mutate(() => {
      this.currentLevel.castle = candidate.castle;
      this.currentLevel.frozenBodies = candidate.frozenBodies;
      this.selectedObjectIds = copies.map(object => object.id);
    });
  }
  pasteObjects(clipboard, offset = { x: 0.1, y: 0.1 }) {
    const objects = Array.isArray(clipboard) ? clipboard : clipboard?.objects;
    const frozenBodies = Array.isArray(clipboard) ? [] : clipboard?.frozenBodies;
    if (!this.currentLevel || !Array.isArray(objects) || objects.length === 0) return [];
    let candidate = clone(this.currentLevel);
    const used = new Set(candidate.castle.map(object => object.id));
    const copies = objects.map(object => {
      let id = `${object.id}-copy`;
      let suffix = 2;
      while (used.has(id)) id = `${object.id}-copy-${suffix++}`;
      used.add(id);
      return {
        ...clone(object),
        id,
        x: Number(object.x) + Number(offset.x),
        y: Number(object.y) + Number(offset.y),
      };
    });
    candidate.castle.push(...copies);
    const copiedIds = new Map(objects.map((object, index) => [object.id, copies[index].id]));
    const completeGroups = (Array.isArray(frozenBodies) ? frozenBodies : [])
      .filter(group => Array.isArray(group?.memberIds) && group.memberIds.length > 0
        && group.memberIds.every(id => copiedIds.has(id)));
    for (const group of completeGroups) {
      candidate = createFrozenBody(candidate, group.memberIds.map(id => copiedIds.get(id))).level;
    }
    assertLevelValid(candidate, this.assets);
    this.mutate(() => {
      this.currentLevel.castle = candidate.castle;
      this.currentLevel.frozenBodies = candidate.frozenBodies;
      this.selectedObjectIds = copies.map(object => object.id);
    });
    return clone(copies);
  }
  deleteObjects(ids) {
    if (!this.currentLevel || ids.length === 0) return;
    const selected = new Set(expandFrozenSelection(this.currentLevel, ids));
    this.mutate(() => {
      this.currentLevel.castle = this.currentLevel.castle.filter(object => !selected.has(object.id));
      this.currentLevel.frozenBodies = (this.currentLevel.frozenBodies || []).filter(group => !group.memberIds.some(id => selected.has(id)));
      this.selectedObjectIds = [];
    });
  }

  createFrozenBody(ids = this.selectedObjectIds) {
    if (!this.currentLevel || ids.length === 0) return null;
    const selected = expandFrozenSelection(this.currentLevel, ids);
    const membership = frozenMembership(this.currentLevel);
    if (selected.some(id => membership.has(id))) throw new Error('选中的物件已经属于冰冻体');
    const result = createFrozenBody(this.currentLevel, selected);
    assertLevelValid(result.level, this.assets);
    this.mutate(() => { this.currentLevel.frozenBodies = result.level.frozenBodies; this.selectedObjectIds = selected; });
    return result.frozenBodyId;
  }

  removeFrozenBodies(ids = this.selectedObjectIds) {
    if (!this.currentLevel || ids.length === 0) return false;
    const next = removeFrozenBodies(this.currentLevel, ids);
    if (JSON.stringify(next.frozenBodies) === JSON.stringify(this.currentLevel.frozenBodies || [])) return false;
    this.mutate(() => { this.currentLevel.frozenBodies = next.frozenBodies; });
    return true;
  }

  addObjectFromAsset(kind, id, point) {
    if (!this.currentLevel) throw Object.assign(new Error("当前没有可编辑关卡"), { code: "LEVEL_MISSING" });
    let created;
    created = createAssetObject({ assets: this.assets, kind, id, level: this.currentLevel, point });
    assertLevelValid({ ...clone(this.currentLevel), castle: [...clone(this.currentLevel.castle), clone(created)] }, this.assets);
    this.mutate(() => {
      this.currentLevel.castle.push(created);
      this.selectedObjectIds = [created.id];
      this.selectedAssetId = null;
      this.selectedAssetKind = null;
    });
    return clone(created);
  }

  assetReferences(id) { return [...scanAssetReferences(this.levels, id), ...scanAssetDefinitionReferences(this.assets, id)]; }
  catalogFor(asset) {
    const kind = asset.kind || asset.catalogType || asset.type;
    if (kind === "materials" || kind === "material") return "materials";
    if (kind === "shapes" || kind === "shape") return "shapes";
    if (kind === "specialObjects" || kind === "special") return "specialObjects";
    throw Object.assign(new Error(`资源类型无效：${kind}`), { code: "ASSET_INVALID", details: { kind } });
  }
  addAsset(categoryId, asset, image = null) {
    if (this.allAssets().some(item => item.id === asset.id)) throw new Error("资源 ID 已存在");
    const catalog = categoryId || this.catalogFor(asset);
    const nextAssets = clone(this.assets);
    nextAssets[catalog] ||= {};
    nextAssets[catalog][asset.id] = clone(asset);
    validateAssetGraph(nextAssets);
    this.mutate(() => {
      if (!["materials", "shapes", "specialObjects"].includes(catalog)) throw Object.assign(new Error(`资源类型无效：${catalog}`), { code: "ASSET_INVALID" });
      this.assets[catalog] ||= {};
      this.assets[catalog][asset.id] = clone(asset);
      if (image && asset.image) {
        this.pendingImages.set(asset.image, { content: image, isNew: true });
        this.deletedImagePaths.delete(asset.image);
      }
      this.selectedAssetId = asset.id;
      this.selectedAssetKind = catalog;
      this.selectedObjectIds = [];
    });
  }
  updateAsset(id, patch, image = null) {
    const asset = this.allAssets().find(item => item.id === id);
    if (!asset) throw new Error("资源不存在");
    const nextId = patch.id || id;
    if (nextId !== id && this.assetReferences(id).length) throw Object.assign(new Error("被关卡引用的资源不能修改 ID"), { code: "ASSET_REFERENCED", details: { references: this.assetReferences(id) } });
    if (nextId !== id && this.allAssets().some(item => item.id === nextId)) throw new Error("资源 ID 已存在");
    const catalog = asset.kind || this.catalogFor(asset);
    const nextAssets = clone(this.assets);
    const nextAsset = { ...nextAssets[catalog][id], ...clone(patch), id: nextId };
    delete nextAssets[catalog][id];
    nextAssets[catalog][nextId] = nextAsset;
    validateAssetGraph(nextAssets);
    this.mutate(() => {
      const stored = clone(this.assets[catalog][id]);
      const oldImage = stored.image;
      delete this.assets[catalog][id];
      this.assets[catalog][nextId] = { ...stored, ...clone(patch), id: nextId };
      if (Object.hasOwn(patch, "image") && oldImage && oldImage !== patch.image) {
        if (this.pendingImages.has(oldImage)) this.pendingImages.delete(oldImage);
        else this.deletedImagePaths.add(oldImage);
      }
      if (image && patch.image) {
        const pending = this.pendingImages.get(patch.image);
        this.pendingImages.set(patch.image, {
          content: image,
          isNew: pending?.isNew ?? patch.image !== oldImage,
        });
        this.deletedImagePaths.delete(patch.image);
      }
      this.selectedAssetId = nextId;
      this.selectedAssetKind = catalog;
      this.selectedObjectIds = [];
    });
  }
  deleteAsset(id) {
    const refs = this.assetReferences(id);
    if (refs.length) {
      const locations = refs.map(reference => `${reference.levelPath}#${reference.objectId}`).join("、");
      throw Object.assign(new Error(`资源仍被 ${refs.length} 个物件引用：${locations}`), { code: "ASSET_REFERENCED", details: { references: refs } });
    }
    const asset = this.allAssets().find(item => item.id === id);
    if (!asset) return;
    this.mutate(() => {
      const catalog = asset.kind || this.catalogFor(asset);
      if (asset.image) {
        if (this.pendingImages.has(asset.image)) this.pendingImages.delete(asset.image);
        else this.deletedImagePaths.add(asset.image);
      }
      delete this.assets[catalog][id];
      this.selectedAssetId = null;
      this.selectedAssetKind = null;
    });
  }

  addLevel(generation = {}) {
    const id = Number(generation.levelNumber ?? generation.number ?? generation.id
      ?? (Math.max(0, ...this.reservedLevelNumbers, ...this.levels.map(levelNumber).filter(Number.isFinite)) + 1));
    if (!Number.isInteger(id) || id < 0) throw new Error("关卡编号必须是非负整数");
    if (this.levels.some(level => levelNumber(level) === id)) throw new Error("关卡编号已存在");
    const name = String(generation.levelName ?? `新关卡 ${id}`).trim() || `新关卡 ${id}`;
    const path = levelPathFor(id, name);
    const levelId = String(generation.levelId ?? `level-${id}`);
    this.mutate(() => {
      const level = createEmptyLevel({ id, levelId, levelName: name, config: this.config, assets: this.assets });
      this.levels.push({ ...level, fileName: path.slice("level/".length), filePath: path });
      this.currentLevelId = identity(level);
      this.selectedObjectIds = [];
    });
  }
  acceptGeneratedLevels(levels) {
    const additions = clone(levels ?? []);
    if (!additions.length) return [];
    const existingNumbers = new Set(this.levels.map(levelNumber));
    const existingPaths = new Set(this.levels.map(levelPath));
    const incomingNumbers = new Set();
    const incomingPaths = new Set();
    for (const level of additions) {
      assertLevelValid(level, this.assets);
      const number = levelNumber(level);
      const path = levelPath(level);
      if (!Number.isInteger(number) || existingNumbers.has(number) || incomingNumbers.has(number)) throw new Error(`关卡编号已存在：${number}`);
      if (existingPaths.has(path) || incomingPaths.has(path)) throw new Error(`关卡路径已存在：${path}`);
      incomingNumbers.add(number);
      incomingPaths.add(path);
    }
    this.mutate(() => { this.levels.push(...additions); });
    return clone(additions);
  }
  deleteLevel(id) {
    if (this.levels.length <= 1) throw new Error("至少保留一个关卡");
    const level = resolveLevel(this.levels, id);
    this.mutate(() => {
      this.levels = this.levels.filter(item => item !== level);
      this.currentLevelId = identity(this.levels[0]);
      this.selectedObjectIds = [];
    });
  }

  save() {
    if (this.savePromise) return this.savePromise;
    this.savePromise = this.performSave().finally(() => { this.savePromise = null; });
    return this.savePromise;
  }

  reconcileFailedSave(transaction, journal) {
    const currentLevels = new Map(this.levels.map(level => [levelPath(level), level]));
    const transactionImages = new Map(imageEntries(transaction.newImages).map(image => [image.path, image]));
    const writtenLevels = new Map(transaction.dirtyLevels.map(entry => [entry.path, entry.level]));
    for (const path of [...(journal?.created?.levels || []), ...(journal?.written || [])]) {
      if (writtenLevels.has(path)) this.savedLevels.set(path, clone(writtenLevels.get(path)));
    }
    if (transaction.manifest && journal?.written?.includes(`level/${EXPORT_MANIFEST_FILE}`)) {
      this.manifest = clone(transaction.manifest);
    }
    for (const path of journal?.deleted?.levels || []) this.savedLevels.delete(path);
    for (const path of journal?.created?.levels || []) {
      if (!currentLevels.has(path)) {
        this.dirtyLevelPaths.delete(path);
        this.newLevelPaths.delete(path);
        this.deletedLevelPaths.add(path);
      } else {
        this.dirtyLevelPaths.add(path);
        this.newLevelPaths.delete(path);
      }
    }
    for (const path of journal?.created?.images || []) {
      const current = this.pendingImages.get(path);
      if (!current) {
        this.deletedImagePaths.add(path);
      } else if (transactionImages.has(path)) {
        this.pendingImages.set(path, { ...current, isNew: false });
      }
    }
    for (const path of journal?.deleted?.levels || []) {
      if (!currentLevels.has(path)) continue;
      this.deletedLevelPaths.delete(path);
      this.dirtyLevelPaths.add(path);
      this.newLevelPaths.add(path);
    }
    for (const path of journal?.deleted?.images || []) {
      const current = this.pendingImages.get(path);
      if (!current) continue;
      this.deletedImagePaths.delete(path);
      this.pendingImages.set(path, { ...current, isNew: true });
    }
    this.refreshDirty();
    this.emit();
  }

  async performSave() {
    if (!this.files) throw new Error("当前为只读演示模式");
    const transaction = {
      revision: this.revision,
      config: clone(this.config),
      assets: clone(this.assets),
      globalDocument: clone(this.globalDocument),
      levels: clone(this.levels),
      configDirty: this.configDirty,
      assetsDirty: this.assetsDirty,
      dirtyLevelPaths: clone(this.dirtyLevelPaths),
      newLevelPaths: clone(this.newLevelPaths),
      newImages: clone(this.pendingImages),
      deletions: {
        levels: [...this.deletedLevelPaths],
        images: [...this.deletedImagePaths],
      },
    };
    validateAssetGraph(transaction.assets);
    const numbers = transaction.levels.map(levelNumber);
    if (new Set(numbers).size !== numbers.length) throw new Error("关卡编号已存在");
    for (const level of transaction.levels) {
      const result = validateLevel(level, transaction.assets);
      if (!result.ok) throw new Error(`${level.fileName || level.levelName}：${result.errors.map(error => `${error.path} ${error.message}`).join("；")}`);
    }
    transaction.dirtyLevels = transaction.levels
      .filter(level => transaction.dirtyLevelPaths.has(levelPath(level)))
      .map(level => ({ path: levelPath(level), level, isNew: transaction.newLevelPaths.has(levelPath(level)) }));
    const manifestById = new Map(this.manifest.levels.map(entry => [entry.id, entry]));
    const manifestIds = new Set(manifestById.keys());
    const savedByWorkspaceId = new Map([...this.savedLevels.values()]
      .filter(level => level.workspaceId != null)
      .map(level => [String(level.workspaceId), level]));
    const changedManifestLevels = transaction.dirtyLevels.filter(entry => {
      const saved = entry.level.workspaceId == null ? null : savedByWorkspaceId.get(String(entry.level.workspaceId));
      const savedId = saved?.__levelDocument?.levelId;
      entry.previousManifestId = savedId;
      return entry.isNew || entry.level.workspaceKind === "exported" || (savedId && manifestIds.has(savedId));
    });
    const changedWorkspaceIds = new Set(changedManifestLevels
      .map(entry => entry.level.workspaceId == null ? null : String(entry.level.workspaceId))
      .filter(Boolean));
    for (const level of transaction.levels.filter(candidate => candidate.workspaceKind === "exported")) {
      const workspaceId = level.workspaceId == null ? null : String(level.workspaceId);
      if (workspaceId && changedWorkspaceIds.has(workspaceId)) continue;
      const expected = levelManifestEntry(level);
      if (manifestEntryMatches(manifestById.get(expected.id), expected)) continue;
      const saved = workspaceId == null ? null : savedByWorkspaceId.get(workspaceId);
      changedManifestLevels.push({
        path: levelPath(level),
        level,
        isNew: false,
        previousManifestId: saved?.__levelDocument?.levelId,
      });
      if (workspaceId) changedWorkspaceIds.add(workspaceId);
    }
    const deletedManifestIds = new Set(transaction.deletions.levels
      .map(path => this.savedLevels.get(path)?.__levelDocument?.levelId)
      .filter(Boolean));
    for (const entry of changedManifestLevels) if (entry.previousManifestId) deletedManifestIds.add(entry.previousManifestId);
    const currentManifestIds = new Set(transaction.levels
      .filter(level => level.workspaceKind === "exported")
      .map(level => level.__levelDocument?.levelId)
      .filter(Boolean));
    for (const id of currentManifestIds) deletedManifestIds.delete(id);
    if (changedManifestLevels.length || deletedManifestIds.size) {
      const byId = new Map(this.manifest.levels.map(entry => [entry.id, clone(entry)]));
      for (const id of deletedManifestIds) byId.delete(id);
      for (const item of changedManifestLevels) {
        const entry = levelManifestEntry(item.level);
        const previous = manifestById.get(item.previousManifestId) ?? manifestById.get(entry.id) ?? {};
        byId.set(entry.id, { ...clone(previous), ...entry });
      }
      transaction.manifest = { ...clone(this.manifest), levels: [...byId.values()].sort((left, right) => left.number - right.number) };
      exportManifestLevelEntries(transaction.manifest);
    }
    let saveResult;
    try {
      saveResult = await saveWorkspace({
        files: this.files,
        globalDocument: transaction.globalDocument,
        config: transaction.config,
        assets: transaction.assets,
        writeGlobal: transaction.configDirty || transaction.assetsDirty,
        manifest: transaction.manifest,
        dirtyLevels: transaction.dirtyLevels,
        newImages: transaction.newImages,
        deletions: transaction.deletions,
      });
    } catch (error) {
      this.reconcileFailedSave(transaction, error.journal);
      throw error;
    }
    // The disk is now authoritative for the written and deleted level paths.
    for (const entry of transaction.dirtyLevels) this.savedLevels.set(entry.path, clone(entry.level));
    if (transaction.manifest) this.manifest = clone(transaction.manifest);
    for (const path of transaction.deletions.levels) this.savedLevels.delete(path);
    if (this.revision === transaction.revision) {
      this.configDirty = false;
      this.assetsDirty = false;
      this.dirtyLevelPaths.clear();
      this.newLevelPaths.clear();
      this.pendingImages.clear();
      this.deletedLevelPaths.clear();
      this.deletedImagePaths.clear();
      this.history = [];
      this.future = [];
    } else {
      if (transaction.configDirty && comparable(this.config) === comparable(transaction.config)) this.configDirty = false;
      if (transaction.assetsDirty && comparable(this.assets) === comparable(transaction.assets)) this.assetsDirty = false;
      const currentLevels = new Map(this.levels.map(level => [levelPath(level), level]));
      for (const entry of transaction.dirtyLevels) {
        const current = currentLevels.get(entry.path);
        if (!current) {
          this.dirtyLevelPaths.delete(entry.path);
          this.newLevelPaths.delete(entry.path);
          if (entry.isNew) this.deletedLevelPaths.add(entry.path);
        } else if (comparable(levelDocument(current)) === comparable(levelDocument(entry.level))) {
          this.dirtyLevelPaths.delete(entry.path);
          this.newLevelPaths.delete(entry.path);
        } else if (entry.isNew) {
          this.newLevelPaths.delete(entry.path);
        }
      }
      for (const image of imageEntries(transaction.newImages)) {
        const current = this.pendingImages.get(image.path);
        if (!current) {
          if (image.isNew) this.deletedImagePaths.add(image.path);
          continue;
        }
        if (comparable(current) === comparable({ content: image.content, isNew: image.isNew })) {
          this.pendingImages.delete(image.path);
        } else if (image.isNew) {
          this.pendingImages.set(image.path, { ...current, isNew: false });
        }
      }
      for (const path of transaction.deletions.levels) {
        if (this.deletedLevelPaths.has(path)) this.deletedLevelPaths.delete(path);
        else if (currentLevels.has(path)) {
          this.dirtyLevelPaths.add(path);
          this.newLevelPaths.add(path);
        }
      }
      for (const path of transaction.deletions.images) {
        if (this.deletedImagePaths.has(path)) this.deletedImagePaths.delete(path);
        else if (this.pendingImages.has(path)) {
          const current = this.pendingImages.get(path);
          this.pendingImages.set(path, { ...current, isNew: true });
        }
      }
    }
    this.refreshDirty();
    this.emit();
    return { dirty: this.dirty, revision: transaction.revision, journal: saveResult.journal };
  }
}
