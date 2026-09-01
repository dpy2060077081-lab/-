import { calculateDifficulty, drawLevel, getBoardLayout, getEndActions, validateLevel } from "../../gamelogic.js";
import { EditorStore } from "./editor-store.js";
import { createFreeWorldEditor, projectileVisualShape } from "./free-world-editor.js";
import { LocalFiles } from "./local-files.js";
import { createPlaySequence } from "./play-session.js";
import { editableLevelEntries, EXPORT_MANIFEST_FILE, exportManifestLevelEntries } from "../../levellist.js";
import { assetCardCommand, createItemInspector, sharedObjectValues } from "./item-inspector.js";
import { createAssetObject, isHexColor, libraryAssetEntries, validateAssetGraph } from "./asset-store.js";
import { supportSnap } from "./placement-collision.js";
import { RUNTIME_PHYSICS_FIELDS, assertProjectConfig } from "./global-physics-store.js";
import { decodeLevelDocument } from "./level-document.js";
import { createPlayEffects, drawPlayEffects } from "./play-effects.js";
import { loadMaterialAssets } from "./material-renderer.js";
import { levelExtensionValues, mergeLevelExtensionValues, parseLevelFieldValue } from "./level-fields.js";
import { decodeGlobalConfig } from "./global-config-document.js";
import { createEditorBootCoordinator } from "./editor-boot.js";
import { createBatchLevelDialog } from "./batch-level-ui.js";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const parseJson = (content, path) => { try { return JSON.parse(content); } catch { throw new Error(`${path} 不是有效 JSON`); } };
const safeAssetColor = color => typeof color === "string" && isHexColor(color.trim()) ? color.trim() : "#738096";
const levelNumber = level => Number(level.levelNumber ?? level.id);
const levelId = level => level.workspaceId ?? levelNumber(level);
const levelName = level => level.levelName ?? level.name ?? level.fileName ?? `关卡 ${levelNumber(level)}`;
export function objectAngleDegrees(radians) {
  if (!Number.isFinite(radians)) return "";
  return Number((radians * 180 / Math.PI).toFixed(6));
}
export function objectAngleRadians(degrees) {
  if (degrees === "" || degrees === null || degrees === undefined) return null;
  return Number(degrees) * Math.PI / 180;
}
let store;
let freeEditor;
let files = null;
let search = "";
let mode = "preview";
let tool = "select";
let booted = false;
let booting = null;
let playSequence = null;
let playSnapshot = null;
let playUnsubscribe = null;
let playFrame = null;
let editContext = null;
let playHudDispose = null;
let itemInspector = null;
let batchDialogDispose = null;
let draggedAsset = null;
let dragPreviewObject = null;
const playEffects = createPlayEffects();

const PLAY_ALLOWED_SCOPES = new Set([
  "global-project", "global-runtime", "level-config", "object-config", "asset-config", "material", "level-create",
]);
const PROJECT_GLOBAL_CONTROLS = [
  "#project-name", "#canvas-width", "#canvas-height", "#world-width", "#world-height",
  "#score-mode", "#resource-theme", "#unlock-rule",
].join(",");

export function editorMutationAllowed({ writable, mode: currentMode, scope }) {
  if (!writable) return false;
  return currentMode === "edit" || PLAY_ALLOWED_SCOPES.has(scope);
}

export function editorIntentTab(intent) {
  return intent === "double-click-object" ? "element" : "level";
}

export function createLevelForEditing({ addLevel, currentMode, enterEdit, showLevelTab }) {
  addLevel();
  if (currentMode === "edit") showLevelTab();
  else enterEdit();
}

export function applyPlayDamageFeedback(effects, snapshot) {
  effects.ingest(snapshot?.damageEvents ?? []);
}

export function applyPlayExplosionFeedback(effects, snapshot) {
  effects.ingestExplosions(snapshot?.explosionEvents ?? []);
}

export function applyPlayFireFeedback(effects, result) {
  if (result === "out-of-arc") effects.showOutOfArc();
  return result;
}

export function resetPlayPresentation(effects) {
  effects.reset();
}

export const resetPlayDamageFeedback = resetPlayPresentation;

export async function loadPlayPresentationAssets({
  document: ownerDocument,
  load = loadMaterialAssets,
  onReady = () => {},
  onWarning = message => console.warn(message),
} = {}) {
  try {
    await load(ownerDocument);
    onReady();
    return true;
  } catch (error) {
    onWarning(`原 demo 正式物件素材加载失败，已使用程序化降级：${error?.message ?? error}`);
    onReady();
    return false;
  }
}

export function playDamageFeedbackLayout(level, canvas, config) {
  return getBoardLayout(level, canvas, config);
}

export function resourceCardEditAllowed({ writable, mode: currentMode, kind }) {
  const scope = kind === "materials" ? "material" : "asset-config";
  return editorMutationAllowed({ writable, mode: currentMode, scope });
}

const canMutate = scope => editorMutationAllowed({ writable: Boolean(files), mode, scope });

export function applyGlobalConfigChange({ editorStore, path, value, playing = false, rebuild = () => {} }) {
  try {
    editorStore.updateConfigPath(path, value);
    if (playing) rebuild();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: { code: error.code || "CONFIG_INVALID", path: error.details?.path || path, message: error.message },
    };
  }
}

const GLOBAL_MATERIAL_FIELDS = Object.freeze([
  Object.freeze({ key: 'mass', label: '质量', type: 'number', step: '0.01' }),
  Object.freeze({ key: 'friction', label: '摩擦系数', type: 'number', step: '0.01' }),
  Object.freeze({ key: 'restitution', label: '弹性系数', type: 'number', step: '0.01' }),
  Object.freeze({ key: 'maxHp', label: '耐久', type: 'number', step: '1' }),
  Object.freeze({ key: 'hitSpeedThreshold', label: '碰撞速度阈值', type: 'number', step: '0.1' }),
  Object.freeze({ key: 'destructible', label: '可破坏', type: 'boolean' }),
]);

export function globalObjectProfileSections(assets = {}) {
  return Object.values(assets.materials ?? {}).map(material => ({
    id: material.id,
    title: material.name || material.id,
    fields: GLOBAL_MATERIAL_FIELDS.map(field => ({ ...field })),
  }));
}

export function applyGlobalObjectProfileChange({ editorStore, materialId, field, value, playing = false, rebuild = () => {} }) {
  try {
    editorStore.updateAsset(materialId, { [field]: value });
    if (playing) rebuild();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function applyLevelFieldChange({ editorStore, fieldId, rawValue }) {
  try {
    editorStore.updateLevel({ [fieldId]: parseLevelFieldValue(fieldId, rawValue) });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: { code: error.code || "LEVEL_INVALID", message: error.message } };
  }
}

export function validatePlayInput({ config, assets, level }) {
  assertProjectConfig(config);
  validateAssetGraph(assets);
  const result = validateLevel(level, assets);
  if (result.ok) return true;
  const first = result.errors[0];
  throw Object.assign(new Error(`${first.path} ${first.message}`), {
    code: "LEVEL_INVALID",
    details: { ...first, errors: result.errors },
  });
}

export function setFieldError(input, error) {
  const message = error?.message || "";
  input?.setCustomValidity?.(message);
  if (message) input?.setAttribute?.("aria-invalid", "true");
  else input?.removeAttribute?.("aria-invalid");
  const field = input?.closest?.(".field");
  let node = field?.querySelector?.(".field-error");
  if (!node && message && input?.ownerDocument) {
    node = input.ownerDocument.createElement("small");
    node.className = "field-error";
    field?.append(node);
  }
  if (node) node.textContent = message;
}

function runFieldMutation(input, action) {
  try {
    action();
    setFieldError(input, null);
    return true;
  } catch (error) {
    setFieldError(input, error);
    return false;
  }
}

const responseJson = async (fetcher, path) => {
  const response = await fetcher(path);
  if (!response?.ok) throw new Error(`无法读取 ${path}`);
  return response.json();
};

function levelWithFile(level, path, catalogEntry = null, assets = {}) {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  level = decodeLevelDocument(level, assets);
  return {
    ...level,
    difficulty: level.difficulty ?? catalogEntry?.difficulty,
    fileName,
    filePath: path,
    workspaceId: catalogEntry?.workspaceId ?? `original:${catalogEntry?.id ?? path}`,
    workspaceKind: catalogEntry?.workspaceKind ?? "original",
    numberConflict: catalogEntry?.numberConflict ?? null,
  };
}

function validatedLevel(level, assets, path) {
  const result = validateLevel(level, assets);
  if (!result.ok) {
    throw new Error(`${path} 校验失败：${result.errors.map(error => `${error.path} ${error.message}`).join("；")}`);
  }
  return level;
}

async function loadProject(localFiles, fetcher = globalThis.fetch) {
  if (!localFiles) {
    if (typeof fetcher !== "function") throw new TypeError("浏览器模式需要 fetch");
    const [globalDocument, manifest] = await Promise.all([
      responseJson(fetcher, "全局配置.json"),
      responseJson(fetcher, `level/${EXPORT_MANIFEST_FILE}`),
    ]);
    const { config, assets } = decodeGlobalConfig(globalDocument);
    const entries = exportManifestLevelEntries(manifest);
    const levels = await Promise.all(entries.map(async entry => {
      const level = levelWithFile(await responseJson(fetcher, entry.path), entry.path, entry, assets);
      return validatedLevel(level, assets, entry.path);
    }));
    return { globalDocument, config, assets, levels, manifest, reservedLevelNumbers: entries.map(entry => entry.number) };
  }
  const [globalFile, manifestFile, listing] = await Promise.all([
    localFiles.readText("全局配置.json"),
    localFiles.readText(`level/${EXPORT_MANIFEST_FILE}`),
    localFiles.list("level"),
  ]);
  const manifest = parseJson(manifestFile.content, `level/${EXPORT_MANIFEST_FILE}`);
  const availableNames = listing.entries.filter(entry => entry.type === "file").map(entry => entry.name);
  const exportedEntries = exportManifestLevelEntries(manifest, availableNames);
  const entries = [
    ...exportedEntries,
    ...editableLevelEntries(availableNames, exportedEntries.map(entry => entry.number)),
  ];
  const globalDocument = parseJson(globalFile.content, "全局配置.json");
  const { config, assets } = decodeGlobalConfig(globalDocument);
  const levels = await Promise.all(entries.map(async entry => {
    const level = levelWithFile(parseJson((await localFiles.readText(entry.path)).content, entry.path), entry.path, entry, assets);
    return validatedLevel(level, assets, entry.path);
  }));
  return {
    globalDocument,
    config,
    assets,
    levels,
    manifest,
    reservedLevelNumbers: levels.map(levelNumber).filter(Number.isFinite),
  };
}

export function captureEditContext(editorStore, worldEditor) {
  return {
    currentLevelId: editorStore.currentLevelId,
    selection: structuredClone(editorStore.selectedObjectIds),
    viewport: { ...worldEditor.viewport },
  };
}

export function restoreEditContext(editorStore, worldEditor, context) {
  if (!context) return;
  if (context.currentLevelId !== undefined && context.currentLevelId !== null) editorStore.selectLevel(context.currentLevelId);
  editorStore.selectObjects(context.selection);
  Object.assign(worldEditor.viewport, context.viewport);
}

export function enterCurrentLevelEdit({ store: editorStore, freeEditor: worldEditor, playSequence: sequence, editContext: context }) {
  const currentLevelId = editorStore.currentLevelId;
  sequence?.exit();
  worldEditor.setMode("edit");
  restoreEditContext(editorStore, worldEditor, context ? { ...context, currentLevelId } : context);
  return { mode: "edit", playSequence: null, editContext: null };
}

export function updatePlayHud(root, snapshot) {
  const ammoFields = { normal: 'normalAmmo', explosive: 'explosiveAmmo', split: 'splitAmmo', blackHole: 'blackHoleAmmo' };
  for (const button of root.querySelectorAll('[data-projectile]')) {
    const type = button.dataset.projectile;
    const ammo = snapshot[ammoFields[type]] ?? 0;
    button.setAttribute('aria-pressed', String(snapshot.selectedProjectile === type));
    button.disabled = Number(ammo) <= 0;
  }
  for (const type of Object.keys(ammoFields)) {
    const node = root.querySelector(`[data-ammo="${type}"]`);
    if (node) node.textContent = String(snapshot[ammoFields[type]] ?? 0);
  }
}

export function bindPlayHud(root, sequence) {
  const buttons = [...root.querySelectorAll('[data-projectile]')];
  for (const button of buttons) {
    button.onclick = () => sequence.selectProjectile(button.dataset.projectile);
  }
  const unsubscribe = sequence.subscribe(snapshot => updatePlayHud(root, snapshot));
  updatePlayHud(root, sequence.snapshot());
  return () => {
    unsubscribe();
    for (const button of buttons) button.onclick = null;
  };
}

function setSaveState(text, state = "") { const node = $("#save-state"); node.textContent = text; node.dataset.state = state; }
function setReadOnly() {
  document.body.classList.add("read-only");
  renderPanels();
  applyInteractionState();
}

function applyInteractionState() {
  const objectAllowed = canMutate("object");
  const levelAllowed = canMutate("level");
  const levelCreateAllowed = canMutate("level-create");
  const objectConfigAllowed = canMutate("object-config");
  const levelConfigAllowed = canMutate("level-config");
  const historyAllowed = canMutate("history");
  const libraryAllowed = canMutate("asset-library");
  const projectGlobalAllowed = canMutate("global-project");
  const runtimeGlobalAllowed = canMutate("global-runtime");
  $("#save-button").disabled = !files;
  $("#edit-toggle").disabled = !files;
  $("#add-level").disabled = !levelCreateAllowed;
  $("#undo-button").disabled = !historyAllowed || !store.history.length;
  $("#redo-button").disabled = !historyAllowed || !store.future.length;
  $$("[data-tool],[data-command],#clear-element").forEach(node => { node.disabled = !objectAllowed; });
  $$(".level-delete").forEach(node => { node.disabled = !levelAllowed; node.setAttribute("aria-disabled", String(!levelAllowed)); });
  $$(".asset-edit").forEach(node => {
    node.disabled = !resourceCardEditAllowed({ writable: Boolean(files), mode, kind: node.closest(".asset")?.dataset.kind });
  });
  $$(PROJECT_GLOBAL_CONTROLS).forEach(node => { node.disabled = !projectGlobalAllowed; });
  $$("#runtime-physics-fields input,#runtime-physics-fields select,#runtime-physics-fields textarea,#runtime-physics-fields button").forEach(node => { node.disabled = !runtimeGlobalAllowed; });
  $$("[data-panel=\"level\"] input,[data-panel=\"level\"] select,[data-panel=\"level\"] textarea,[data-panel=\"level\"] button").forEach(node => { node.disabled = !levelConfigAllowed; });
  $$("[data-item-context=\"object\"] input,[data-item-context=\"object\"] select,[data-item-context=\"object\"] textarea,[data-item-context=\"object\"] button").forEach(node => { node.disabled = !objectConfigAllowed; });
}

export function levelCardMarkup(level, { assets, currentLevelId, writable = false }) {
  const difficulty = calculateDifficulty(level, assets);
  const deleteAttributes = writable ? "" : ' disabled aria-disabled="true"';
  const escape = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const active = String(levelId(level)) === String(currentLevelId) ? " active" : "";
  return `<div class="level-card${active}" data-id="${escape(levelId(level))}"><button class="level-delete"${deleteAttributes} title="删除关卡">×</button><canvas class="level-thumbnail" width="120" height="120"></canvas><span class="level-info"><small>${escape(level.fileName)}</small><strong>${escape(levelName(level))}</strong><span>${escape(difficulty.level)} · ${(level.castle || []).length} 个物品</span></span></div>`;
}

function createLevelCard(level, { assets, currentLevelId, writable }, documentRef = document) {
  const difficulty = calculateDifficulty(level, assets);
  const card = documentRef.createElement("div");
  card.className = "level-card";
  card.classList.toggle("active", String(levelId(level)) === String(currentLevelId));
  card.dataset.id = String(levelId(level));
  const deleteButton = documentRef.createElement("button");
  deleteButton.className = "level-delete";
  deleteButton.disabled = !writable;
  deleteButton.setAttribute("aria-disabled", String(!writable));
  deleteButton.title = "删除关卡";
  deleteButton.textContent = "×";
  const canvas = documentRef.createElement("canvas");
  canvas.className = "level-thumbnail";
  canvas.width = 120;
  canvas.height = 120;
  const info = documentRef.createElement("span");
  info.className = "level-info";
  const fileName = documentRef.createElement("small");
  fileName.textContent = level.fileName ?? "";
  const name = documentRef.createElement("strong");
  name.textContent = levelName(level);
  const detail = documentRef.createElement("span");
  detail.textContent = `${difficulty.level} · ${(level.castle || []).length} 个物品`;
  info.append(fileName, name, detail);
  card.append(deleteButton, canvas, info);
  return card;
}

function renderLevels() {
  $("#level-count").textContent = `${store.levels.length} 个关卡`;
  $(".level-list").replaceChildren(...store.levels.map(level => createLevelCard(level, {
    assets: store.assets, currentLevelId: store.currentLevelId, writable: Boolean(files),
  })));
  $$(".level-card").forEach(card => {
    const canvas = card.querySelector("canvas");
    const config = { ...store.config, canvas: { width: canvas.width, height: canvas.height } };
    drawLevel(canvas.getContext("2d"), store.levels.find(level => String(levelId(level)) === card.dataset.id), { mode: "preview", assets: store.assets, config });
  });
}

function assetGroups() {
  const labels = { materials: "材质", shapes: "形状", specialObjects: "特殊物品" };
  const groups = {};
  for (const asset of libraryAssetEntries(store.assets)) (groups[asset.kind] ||= []).push(asset);
  return Object.entries(groups).map(([id, items]) => ({ id, name: labels[id] || id, items }));
}

export function resourceCardVisual(asset) {
  return asset.kind === 'materials'
    ? { classes: ['asset-visual', 'material-preview'], dataset: { material: String(asset.id) }, styles: { '--asset-color': safeAssetColor(asset.color) } }
    : { classes: ['asset-visual'], dataset: {}, styles: {} };
}

export function createAssetDragPreview({ level, assets, kind, id, point }) {
  const probe = createAssetObject({ assets, kind, id, level, point });
  const snapped = supportSnap({
    objects: [probe],
    environment: level?.environment,
    anchorId: probe.id,
    x: probe.x,
    y: probe.y,
    excludeIds: new Set([probe.id]),
  });
  return { ...probe, x: snapped.x, y: snapped.y };
}

export function suppressNativeDragPreview(dataTransfer, documentRef = document, schedule = callback => setTimeout(callback, 0)) {
  const image = documentRef.createElement("canvas");
  image.width = 1;
  image.height = 1;
  Object.assign(image.style, { position: "fixed", left: "-10px", top: "-10px", pointerEvents: "none" });
  documentRef.body.append(image);
  dataTransfer.setDragImage(image, 0, 0);
  schedule(() => image.remove());
  return image;
}

export function createFrozenActionControls(documentRef = document) {
  const frozenActions = documentRef.createElement("div");
  frozenActions.className = "field-row frozen-actions";
  const createFrozenButton = documentRef.createElement("button");
  createFrozenButton.id = "create-frozen-body";
  createFrozenButton.className = "panel-action";
  createFrozenButton.type = "button";
  createFrozenButton.textContent = "包裹为冰冻体";
  const removeFrozenButton = documentRef.createElement("button");
  removeFrozenButton.id = "remove-frozen-body";
  removeFrozenButton.className = "panel-action";
  removeFrozenButton.type = "button";
  removeFrozenButton.textContent = "解除冰冻体";
  frozenActions.append(createFrozenButton, removeFrozenButton);
  return frozenActions;
}

function renderAssets() {
  const library = $(".library");
  const sections = assetGroups().map(category => {
    const items = category.items.filter(asset => !search || `${asset.id}${asset.name}${asset.type}`.toLowerCase().includes(search));
    const section = document.createElement("section");
    section.className = "category";
    const heading = document.createElement("div");
    heading.className = "category-head";
    const arrow = document.createElement("span");
    arrow.textContent = "⌄";
    const name = document.createElement("span");
    name.textContent = category.name;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(items.length);
    heading.append(arrow, name, count);
    const grid = document.createElement("div");
    grid.className = "asset-grid";
    for (const asset of items) {
      const card = document.createElement("div");
      card.className = "asset";
      card.classList.toggle("selected", asset.id === store.selectedAssetId);
      card.dataset.id = String(asset.id);
      card.dataset.kind = String(asset.kind);
      card.draggable = true;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `添加 ${asset.name}`);
      card.style.position = "relative";
      card.style.cursor = "pointer";
      const visual = document.createElement("div");
      const presentation = resourceCardVisual(asset);
      visual.className = presentation.classes.join(" ");
      Object.assign(visual.dataset, presentation.dataset);
      for (const [property, value] of Object.entries(presentation.styles)) visual.style.setProperty(property, value);
      if (asset.kind !== "materials") visual.style.background = asset.color || "#293246";
      visual.textContent = asset.symbol || "●";
      const assetName = document.createElement("div");
      assetName.className = "asset-name";
      assetName.textContent = asset.name;
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "asset-edit";
      edit.setAttribute("aria-label", `编辑资源 ${asset.name}`);
      edit.textContent = "编辑";
      Object.assign(edit.style, { position: "absolute", right: "3px", top: "3px", height: "20px", padding: "0 4px", borderRadius: "5px", background: "#343158", color: "#ddd9ff", fontSize: "9px" });
      card.append(visual, assetName, edit);
      grid.append(card);
    }
    section.append(heading, grid);
    return section;
  });
  library.replaceChildren(...sections);
}

function assetFieldNode(field, assets = store?.assets ?? {}, documentRef = document) {
  const value = field.value;
  const wrapper = documentRef.createElement(field.type === "boolean" ? "label" : "div");
  wrapper.className = "field";
  const label = documentRef.createElement(field.type === "boolean" ? "span" : "label");
  label.textContent = field.label;
  wrapper.append(label);
  if (field.type === "boolean") {
    const input = documentRef.createElement("input");
    input.dataset.assetField = field.path;
    input.dataset.fieldType = "boolean";
    input.type = "checkbox";
    input.checked = Boolean(value);
    wrapper.append(input);
    return wrapper;
  }
  if (field.type === "json") {
    const textarea = documentRef.createElement("textarea");
    textarea.dataset.assetField = field.path;
    textarea.dataset.fieldType = "json";
    textarea.className = "control textarea";
    textarea.value = JSON.stringify(value ?? {}, null, 2);
    wrapper.append(textarea);
    return wrapper;
  }
  if (field.type === "material" || field.type === "shape") {
    const kind = field.type === "material" ? "materials" : "shapes";
    const select = documentRef.createElement("select");
    select.dataset.assetField = field.path;
    select.dataset.fieldType = "text";
    select.className = "control";
    for (const asset of Object.values(assets[kind] ?? {})) {
      const option = documentRef.createElement("option");
      option.value = String(asset.id);
      option.textContent = asset.name;
      option.selected = asset.id === value;
      select.append(option);
    }
    wrapper.append(select);
    return wrapper;
  }
  const type = field.type === "number" ? "number" : field.type === "color" ? "color" : "text";
  const input = documentRef.createElement("input");
  input.dataset.assetField = field.path;
  input.dataset.fieldType = field.type;
  input.className = "control";
  input.type = type;
  if (type === "number") input.step = "0.01";
  input.value = String(value ?? (type === "color" ? "#000000" : ""));
  wrapper.append(input);
  return wrapper;
}

function assetItemValue(input) {
  const type = input.dataset.fieldType;
  if (type === "number") return Number(input.value);
  if (type === "boolean") return input.checked;
  if (type === "json") return parseJson(input.value, input.dataset.assetField);
  return input.value;
}

export function renderAssetItemSection(section, {
  fields = [], assets = {}, selectedAsset = false, readOnly = false, allowFullEdit = !readOnly, onPatch = () => {}, onEdit = () => {}, onError = () => {},
} = {}) {
  const disabled = readOnly || !selectedAsset;
  const documentRef = section.ownerDocument ?? document;
  const editButton = documentRef.createElement("button");
  editButton.id = "edit-selected-asset";
  editButton.type = "button";
  editButton.className = "panel-action";
  editButton.textContent = "编辑完整资源定义";
  section.replaceChildren(...fields.map(field => assetFieldNode(field, assets, documentRef)), editButton);
  section.inert = readOnly;
  section.querySelectorAll("input,button,select,textarea").forEach(node => { node.disabled = disabled; });
  editButton.disabled = disabled || !allowFullEdit;
  const change = event => {
    if (disabled) return;
    const input = event.target.closest("[data-asset-field]");
    if (!input) return;
    try {
      onPatch({ [input.dataset.assetField]: assetItemValue(input) });
      setFieldError(input, null);
    } catch (error) { onError(error, input); }
  };
  section.onchange = change;
  section.oninput = () => {};
  editButton.onclick = () => { if (!disabled && allowFullEdit) onEdit(); };
  return section;
}

export { projectileVisualShape };

export function playLevel(draft, snapshot) {
  if (!snapshot) return draft;
  const originals = new Map((draft.castle || []).map(object => [object.id, object]));
  const frozenTransforms = new Map((snapshot.frozenBodies || [])
    .filter(group => group.state === "intact" || group.state === "cracked")
    .flatMap(group => group.memberTransforms || [])
    .map(transform => [transform.id, transform]));
  const castle = (snapshot.bodies || []).filter(body => originals.has(body.id) && !body.meteorType && body.kind !== "meteor").map(body => {
    const original = originals.get(body.id) || {};
    const frozenTransform = frozenTransforms.get(body.id);
    return {
      ...original,
      ...body,
      x: frozenTransform?.x ?? body.position?.x ?? body.x,
      y: frozenTransform?.y ?? body.position?.y ?? body.y,
      angle: frozenTransform?.angle ?? body.angle ?? original.angle ?? 0,
      shape: projectileVisualShape(body, original),
    };
  });
  return { ...draft, castle };
}

function renderCanvas() {
  if (!store.currentLevel) return;
  const canvas = $("#game-canvas");
  const size = store.config.canvas;
  if (!Number.isFinite(size?.width) || size.width <= 0 || !Number.isFinite(size?.height) || size.height <= 0) {
    throw new Error("全局配置.json 必须提供正数 Canvas 宽高");
  }
  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;
  canvas.closest(".game-frame").style.aspectRatio = `${size.width}/${size.height}`;
  const editLevel = dragPreviewObject
    ? { ...store.currentLevel, castle: [...(store.currentLevel.castle || []), dragPreviewObject] }
    : store.currentLevel;
  const renderedLevel = mode === "play" ? playLevel(store.currentLevel, playSnapshot) : editLevel;
  const context = canvas.getContext("2d");
  drawLevel(context, renderedLevel, {
    mode: mode === "play" ? "play" : mode,
    assets: store.assets,
    config: store.config,
    selection: store.selectedObjectIds,
    preview: dragPreviewObject ? [dragPreviewObject.id] : [],
    alignmentGuides: mode === "edit" ? freeEditor?.alignmentGuides : [],
    viewport: freeEditor?.viewport,
    simulation: mode === "play" ? playSnapshot : undefined,
  });
  if (mode === "play") {
    drawPlayEffects(context, playEffects.snapshot(), {
      layout: playDamageFeedbackLayout(renderedLevel, canvas, store.config),
      viewport: freeEditor?.viewport,
    });
  }
  $(".canvas-title strong").textContent = `游戏画布 · 关卡 ${levelNumber(store.currentLevel)}`;
  $("#edit-status").textContent = `${mode === "edit" ? "编辑模式" : "试玩模式"} · Canvas ${size.width} × ${size.height}`;
  $("#zoom-value").textContent = `${Math.round((freeEditor?.viewport.zoom || 1) * 100)}%`;
}

function selectedObjects() {
  const selected = new Set(store.selectedObjectIds);
  return (store.currentLevel?.castle || []).filter(object => selected.has(object.id));
}

function configPathValue(path) {
  return path.split(".").reduce((value, part) => value?.[part], store.config);
}

function renderRuntimePhysicsFields() {
  const root = $("#runtime-physics-fields");
  if (!root) return;
  const labels = {
    environment: "环境",
    launcher: "炮台",
    normalProjectile: "普通炮弹",
    explosiveProjectile: "爆炸炮弹",
    explosionPropagation: "爆炸传播",
    splitProjectile: "分裂炮弹",
    blackHoleProjectile: "黑洞炮弹",
    frozenBody: "冰冻体",
  };
  root.replaceChildren();
  for (const group of Object.keys(labels)) {
    const fields = RUNTIME_PHYSICS_FIELDS.filter(field => field.group === group);
    const section = document.createElement("section");
    section.className = "runtime-physics-group";
    const heading = document.createElement("div");
    heading.className = "section-label";
    const title = document.createElement("span");
    title.textContent = labels[group];
    heading.append(title);
    section.append(heading);
    const fieldsGrid = document.createElement("div");
    fieldsGrid.className = "runtime-field-grid field-grid field-grid--three";
    for (const field of fields) {
      const wrapper = document.createElement("div");
      wrapper.className = "field";
      const label = document.createElement("label");
      label.textContent = field.label;
      const input = document.createElement("input");
      input.className = "control";
      input.type = "number";
      input.step = field.integer ? "1" : "0.01";
      input.value = String(configPathValue(field.path));
      input.dataset.configPath = field.path;
      input.disabled = !canMutate("global-runtime");
      const errorNode = document.createElement("small");
      errorNode.className = "field-error";
      input.onchange = () => {
        if (!canMutate("global-runtime")) return;
        const result = applyGlobalConfigChange({
          editorStore: store,
          path: field.path,
          value: Number(input.value),
          playing: mode === "play",
          rebuild: () => beginPlay({ preserveEditContext: true }),
        });
        setFieldError(input, result.ok ? null : result.error);
      };
      wrapper.append(label, input, errorNode);
      fieldsGrid.append(wrapper);
    }
    section.append(fieldsGrid);
    root.append(section);
  }
}

function renderGlobalObjectProfileFields() {
  const root = $("#global-object-profile-fields");
  if (!root) return;
  root.replaceChildren();
  for (const sectionData of globalObjectProfileSections(store.assets)) {
    const material = store.assets.materials[sectionData.id];
    const section = document.createElement("section");
    section.className = "global-object-profile-group";
    const heading = document.createElement("div");
    heading.className = "section-label";
    const title = document.createElement("span");
    title.textContent = sectionData.title;
    const id = document.createElement("small");
    id.textContent = sectionData.id;
    heading.append(title, id);
    section.append(heading);
    const grid = document.createElement("div");
    grid.className = "global-object-field-grid field-grid field-grid--three";
    for (const field of sectionData.fields) {
      const wrapper = document.createElement("div");
      wrapper.className = "field";
      const label = document.createElement("label");
      label.textContent = field.label;
      const input = document.createElement(field.type === "boolean" ? "select" : "input");
      input.className = "control";
      input.dataset.materialId = sectionData.id;
      input.dataset.materialField = field.key;
      if (field.type === "boolean") {
        for (const [value, text] of [["true", "是"], ["false", "否"]]) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          input.append(option);
        }
        input.value = String(material[field.key]);
      } else {
        input.type = "number";
        input.step = field.step;
        input.value = String(material[field.key]);
      }
      input.disabled = !canMutate("material");
      const errorNode = document.createElement("small");
      errorNode.className = "field-error";
      input.onchange = () => {
        if (!canMutate("material")) return;
        const value = field.type === "boolean" ? input.value === "true" : Number(input.value);
        const result = applyGlobalObjectProfileChange({
          editorStore: store,
          materialId: sectionData.id,
          field: field.key,
          value,
          playing: mode === "play",
          rebuild: () => beginPlay({ preserveEditContext: true }),
        });
        setFieldError(input, result.ok ? null : result.error);
      };
      wrapper.append(label, input, errorNode);
      grid.append(wrapper);
    }
    section.append(grid);
    root.append(section);
  }
}

function renderPanels() {
  const config = store.config;
  const level = store.currentLevel;
  const difficulty = calculateDifficulty(level, store.assets);
  const selected = selectedObjects();
  const object = selected[0];
  const context = store.itemContext;
  const selectedAsset = context?.type === "asset" ? store.assets[context.kind]?.[context.id] : null;
  $("#project-name").value = config.projectName || "";
  $("#canvas-width").value = config.canvas.width;
  $("#canvas-height").value = config.canvas.height;
  $("#world-width").value = config.world.width;
  $("#world-height").value = config.world.height;
  $("#score-mode").value = config.scoreMode || "";
  $("#resource-theme").value = config.resourceTheme || "";
  $("#unlock-rule").value = config.unlockRule || "";
  renderGlobalObjectProfileFields();
  renderRuntimePhysicsFields();
  $("#level-file-name").textContent = level.fileName;
  $("#level-file-path").textContent = level.filePath;
  $("#level-name").value = levelName(level);
  $("#level-number").value = Number.isFinite(levelNumber(level)) ? levelNumber(level) : "";
  $("#level-difficulty").value = level.difficulty || "normal";
  $("#level-description").value = level.description ?? "";
  $("#level-normal-ammo").value = Number.isFinite(level.normalAmmo) ? level.normalAmmo : "";
  $("#level-explosive-ammo").value = Number.isFinite(level.explosiveAmmo) ? level.explosiveAmmo : "";
  $("#level-split-ammo").value = Number.isFinite(level.splitAmmo) ? level.splitAmmo : "";
  $("#level-black-hole-ammo").value = Number.isFinite(level.blackHoleAmmo) ? level.blackHoleAmmo : "";
  $("#level-platform-type").value = level.platformType || "single-3";
  $("#level-extensions").value = JSON.stringify(levelExtensionValues(level), null, 2);
  $("#difficulty-score").textContent = `${difficulty.score} 分`;
  $("#difficulty-level").textContent = difficulty.level;
  const factorLabels = { objectCount: "物品数量", destructibility: "可破坏比例", variety: "资源多样性" };
  const factorNodes = Object.entries(difficulty.factors).map(([key, value]) => {
    const row = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = factorLabels[key] || key;
    const meter = document.createElement("i");
    const bar = document.createElement("b");
    bar.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
    meter.append(bar);
    const score = document.createElement("strong");
    score.textContent = String(value);
    row.append(label, meter, score);
    return row;
  });
  $("#difficulty-factors").replaceChildren(...factorNodes);
  $("#element-coordinate").textContent = context?.type === "asset" ? `${context.id} · 全局资源` : selected.length > 1 ? `已选择 ${selected.length} 项` : object?.id || "未选择";
  $$('[data-item-context]').forEach(section => { section.hidden = section.dataset.itemContext !== context?.type; });
  const objectValues = selected.length > 1 ? sharedObjectValues(selected) : object || {};
  $("#element-x").value = selected.length > 1 ? "" : objectValues.x ?? "";
  $("#element-y").value = selected.length > 1 ? "" : objectValues.y ?? "";
  $("#element-angle").value = objectAngleDegrees(objectValues.angle);
  $("#element-value").value = object ? JSON.stringify(object, null, 2) : "";
  $("#element-shape").value = object ? JSON.stringify(object.shape, null, 2) : "";
  const materials = store.allAssets().filter(asset => asset.kind === "materials");
  const emptyMaterial = document.createElement("option");
  emptyMaterial.value = "";
  emptyMaterial.textContent = "—";
  const materialOptions = materials.map(asset => {
    const option = document.createElement("option");
    option.value = String(asset.id);
    option.textContent = asset.name;
    option.selected = objectValues.materialId === asset.id;
    return option;
  });
  $("#element-asset").replaceChildren(emptyMaterial, ...materialOptions);
  for (const field of ["mass", "friction", "restitution", "maxHp", "hitSpeedThreshold"]) $(`#element-${field}`).value = objectValues[field] ?? "";
  $("#element-destructible").value = objectValues.destructible === undefined ? "" : String(objectValues.destructible);
  const boltAllowed = !objectValues.specialType && ["wood", "glass"].includes(objectValues.materialId);
  $("#element-fixedBolt").value = boltAllowed && objectValues.fixedBolt === true ? "true" : "";
  const assetSection = $('[data-item-context="asset"]');
  const assetFields = context?.type === "asset" ? itemInspector.fields() : [];
  renderAssetItemSection(assetSection, {
    fields: assetFields,
    assets: store.assets,
    selectedAsset: Boolean(selectedAsset),
    readOnly: !canMutate(context?.kind === "materials" ? "material" : "asset-config"),
    allowFullEdit: canMutate("asset-config"),
    onPatch: patchAsset,
    onEdit: () => openAsset(store.allAssets().find(asset => asset.id === store.selectedAssetId && asset.kind === store.selectedAssetKind)),
    onError: (error, input) => setFieldError(input, error),
  });
  $$('[data-item-context="object"] input,[data-item-context="object"] select,[data-item-context="object"] textarea,[data-item-context="object"] button').forEach(node => node.disabled = !object || document.body.classList.contains("read-only"));
  $("#element-fixedBolt").disabled ||= !boltAllowed;
  for (const id of ["element-x", "element-y", "element-shape", "element-value"]) $(`#${id}`).disabled ||= selected.length > 1;
}

function render() {
  renderLevels();
  renderAssets();
  renderCanvas();
  renderPanels();
  setSaveState(store.dirty ? "有未保存的修改" : files ? "所有更改已保存" : "只读演示模式", store.dirty ? "dirty" : "");
  applyInteractionState();
}

function setTool(next) {
  tool = next;
  freeEditor.setTool(next);
  $$('[data-tool]').forEach(button => button.classList.toggle("active", button.dataset.tool === tool));
}

function patchSelected(patch, input = null) {
  if (!canMutate("object-config")) return false;
  const changed = runFieldMutation(input, () => itemInspector.patch(patch));
  if (changed) rebuildPlayForConfigChange();
  return changed;
}

function patchAsset(patch) {
  const scope = store.itemContext?.kind === "materials" ? "material" : "asset-config";
  if (!canMutate(scope)) return false;
  itemInspector.patch(patch);
  return true;
}

function rebuildPlayForAssetChange() {
  if (mode === "play") beginPlay({ preserveEditContext: true });
}

function rebuildPlayForConfigChange() {
  if (mode === "play") beginPlay({ preserveEditContext: true });
}

function runLiveFieldMutation(input, action) {
  const changed = runFieldMutation(input, action);
  if (changed) rebuildPlayForConfigChange();
  return changed;
}

function openAsset(asset) {
  if (!asset) return;
  if (!canMutate("asset-library") && !canMutate("asset-config")) return;
  $("#asset-form").reset();
  $("#asset-error").textContent = "";
  $("#asset-original-id").value = asset?.id || "";
  $("#asset-id").value = asset?.id || "";
  $("#asset-name").value = asset?.name || "";
  const kind = asset?.kind || "materials";
  const stored = asset ? store.assets[kind]?.[asset.id] : null;
  $("#asset-color").value = asset?.color || "#4f8cff";
  $("#asset-shape").value = asset?.shape?.kind || "box";
  $("#asset-type").value = kind;
  $("#asset-type").disabled = true;
  $("#asset-definition").value = stored ? JSON.stringify(stored, null, 2) : "";
  $("#asset-dialog-title").textContent = "修改资源";
  $("#delete-asset").hidden = false;
  $("#asset-dialog").showModal();
}

function activateTab(name) {
  $$(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.tab === name));
  $$(".tab-panel").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === name));
}

function addAssetObject(kind, id, point = null) {
  if (!files) { alert("只读演示模式不能修改关卡"); return; }
  if (mode !== "edit") { alert("请先进入编辑模式"); return; }
  const target = point || { x: Number(store.config.world?.width || 9) / 2, y: Number(store.config.world?.height || 16) / 2 };
  const preview = createAssetDragPreview({ level: store.currentLevel, assets: store.assets, kind, id, point: target });
  store.addObjectFromAsset(kind, id, { x: preview.x, y: preview.y });
  activateTab("element");
}

async function fileBase64(file) {
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return url.split(",")[1];
}

export function saveCompletionState(dirty) {
  return dirty
    ? { text: "保存完成，仍有未保存的修改", state: "dirty" }
    : { text: "所有更改已保存", state: "saved" };
}

export async function saveEditor({ files, store, levelNumberInput = null, setSaveState = () => {} }) {
  if (!files) { setSaveState("只读模式无法保存", "error"); return false; }
  if (levelNumberInput && store.currentLevel) {
    try {
      if (String(levelNumberInput.value).trim() === "") throw new Error("关卡编号必须是非负整数");
      const pendingNumber = parseLevelFieldValue("levelNumber", levelNumberInput.value);
      if (pendingNumber !== levelNumber(store.currentLevel)) store.updateLevel({ levelNumber: pendingNumber });
      setFieldError(levelNumberInput, null);
    } catch (error) {
      setFieldError(levelNumberInput, error);
      setSaveState(`保存失败：${error.code || "ERROR"} ${error.message}`, "error");
      return false;
    }
  }
  try {
    setSaveState("保存中…", "saving");
    await store.save();
    const completion = saveCompletionState(store.dirty);
    setSaveState(completion.text, completion.state);
    return true;
  } catch (error) {
    setSaveState(`保存失败：${error.code || "ERROR"} ${error.message}`, "error");
    return false;
  }
}

async function save() {
  return saveEditor({ files, store, levelNumberInput: $("#level-number"), setSaveState });
}

export function refreshWorkspace({
  dirty = false,
  confirmDiscard = globalThis.confirm,
  reload = () => globalThis.location.reload(),
} = {}) {
  if (dirty && !confirmDiscard("存在未保存的修改，确定刷新并放弃这些修改吗？")) return false;
  reload();
  return true;
}

/** 切换关卡前的未保存决策：同关卡 → 'same'；无修改 → 直接 onSwitch 返回 'switch'；有修改则询问。 */
export async function resolveLevelSwitch({
  targetId,
  currentId,
  dirty = false,
  confirmDialog = () => Promise.resolve("cancel"),
  onSave = () => Promise.resolve(true),
  onDiscard = () => {},
  onSwitch = () => {},
} = {}) {
  if (String(targetId) === String(currentId)) return "same";
  if (!dirty) { onSwitch(); return "switch"; }
  const decision = await confirmDialog();
  if (decision === "cancel") return "cancel";
  if (decision === "save" && !(await onSave())) return "save-failed";
  if (decision === "discard") onDiscard();
  onSwitch();
  return decision === "save" ? "save-and-switch" : "discard-and-switch";
}

/** 三选弹窗：保存并切换 / 不保存 / 取消。复用 asset-dialog 样式，动态构建，静态文案。 */
function confirmSaveBeforeSwitch() {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "asset-dialog";
    // 动态弹窗没有 form，而 .asset-dialog 的内边距挂在 .asset-dialog form 上，需手动补齐，否则内容贴边。
    dialog.style.padding = "16px";
    const head = document.createElement("div");
    head.className = "dialog-head";
    const title = document.createElement("strong");
    title.textContent = "未保存的修改";
    const closeButton = document.createElement("button");
    closeButton.value = "cancel";
    closeButton.setAttribute("aria-label", "关闭");
    closeButton.textContent = "×";
    head.append(title, closeButton);
    const body = document.createElement("p");
    body.style.margin = "11px 0 0";
    body.style.lineHeight = "1.6";
    body.style.color = "var(--text)";
    body.style.fontSize = "12px";
    body.textContent = "当前关卡有未保存的修改，切换关卡前要先保存吗？";
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const discardButton = document.createElement("button");
    discardButton.value = "discard";
    discardButton.className = "danger";
    discardButton.textContent = "不保存";
    const spacer = document.createElement("span");
    const cancelButton = document.createElement("button");
    cancelButton.value = "cancel";
    cancelButton.textContent = "取消";
    const saveButton = document.createElement("button");
    saveButton.value = "save";
    saveButton.className = "primary";
    saveButton.textContent = "保存并切换";
    actions.append(discardButton, spacer, cancelButton, saveButton);
    dialog.append(head, body, actions);
    const buttons = [...dialog.querySelectorAll("button")];
    const finish = decision => {
      buttons.forEach(button => button.removeEventListener("click", onClick));
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onBackdrop);
      dialog.close();
      dialog.remove();
      resolve(decision);
    };
    const onClick = event => { const value = event.currentTarget.value; if (value) finish(value); };
    const onCancel = event => { event.preventDefault(); finish("cancel"); };
    const onBackdrop = event => { if (event.target === dialog) finish("cancel"); };
    buttons.forEach(button => button.addEventListener("click", onClick));
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("click", onBackdrop);
    document.body.append(dialog);
    dialog.showModal();
    closeButton.focus?.();
  });
}

async function switchLevel(id) {
  return resolveLevelSwitch({
    targetId: id,
    currentId: store.currentLevelId,
    dirty: store.dirty && Boolean(files),
    confirmDialog: confirmSaveBeforeSwitch,
    onSave: save,
    onDiscard: () => store.discardLevelChanges(store.currentLevelId),
    onSwitch: () => { store.selectLevel(id); if (mode === "play") beginPlay({ preserveEditContext: true }); },
  });
}

function renderPlayResult() {
  const result = $("#play-result");
  if (!playSnapshot || !["won", "lost"].includes(playSnapshot.phase)) {
    result.hidden = true;
    return;
  }
  const actions = getEndActions(playSnapshot.phase, playSequence.index < store.levels.length - 1);
  $("#result-title").textContent = playSnapshot.phase === "won" ? "关卡完成" : "试玩失败";
  $("#result-message").textContent = playSnapshot.phase === "won" ? "原版物理运行时判定胜利" : "原版物理运行时判定失败";
  $("#next-level").disabled = !actions.next;
  result.hidden = false;
}

function stopAnimation() {
  if (playFrame !== null && typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(playFrame);
  playFrame = null;
}

function tickPlay(timestamp) {
  if (!playSequence || mode !== "play") return;
  const previous = tickPlay.previous ?? timestamp;
  tickPlay.previous = timestamp;
  const elapsed = Math.min(50, Math.max(0, timestamp - previous));
  playEffects.advance(elapsed);
  playSequence.step(elapsed);
  if (typeof globalThis.requestAnimationFrame === "function") playFrame = globalThis.requestAnimationFrame(tickPlay);
}

function beginPlay({ preserveEditContext = false } = {}) {
  try { validatePlayInput({ config: store.config, assets: store.assets, level: store.currentLevel }); }
  catch (error) {
    globalThis.alert?.(`无法进入试玩：${error.message}`);
    return false;
  }
  stopAnimation();
  playHudDispose?.();
  playHudDispose = null;
  playUnsubscribe?.();
  playSequence?.exit();
  resetPlayPresentation(playEffects);
  if (!preserveEditContext || !editContext) editContext = captureEditContext(store, freeEditor);
  const initialIndex = Math.max(0, store.levels.indexOf(store.currentLevel));
  playSequence = createPlaySequence({
    levels: store.levels,
    initialIndex,
    config: store.config,
    assets: store.assets,
    onLevelChange(index) { store.selectLevel(levelId(store.levels[index])); },
  });
  playSnapshot = playSequence.snapshot();
  playHudDispose = bindPlayHud(document, playSequence);
  playUnsubscribe = playSequence.subscribe(snapshot => {
    playSnapshot = snapshot;
    applyPlayDamageFeedback(playEffects, snapshot);
    applyPlayExplosionFeedback(playEffects, snapshot);
    renderCanvas();
    renderPlayResult();
  });
  mode = "play";
  freeEditor.setMode("play");
  Object.assign(freeEditor.viewport, { x: 0, y: 0, zoom: 1 });
  $(".canvas-area").classList.remove("editing");
  $("#edit-toggle").textContent = "进入编辑";
  tickPlay.previous = undefined;
  renderCanvas();
  renderPlayResult();
  renderPanels();
  applyInteractionState();
  if (typeof globalThis.requestAnimationFrame === "function") playFrame = globalThis.requestAnimationFrame(tickPlay);
}

function beginEdit() {
  if (!files) return;
  stopAnimation();
  playHudDispose?.();
  playHudDispose = null;
  playUnsubscribe?.();
  playUnsubscribe = null;
  const transition = enterCurrentLevelEdit({ mode, store, freeEditor, playSequence, editContext });
  mode = transition.mode;
  playSequence = transition.playSequence;
  editContext = transition.editContext;
  playSnapshot = null;
  resetPlayPresentation(playEffects);
  $(".canvas-area").classList.add("editing");
  $("#edit-toggle").textContent = "退出编辑";
  $("#play-result").hidden = true;
  activateTab(editorIntentTab("enter-edit"));
  renderCanvas();
  renderPanels();
  applyInteractionState();
}

function playWorldPoint(event) {
  const canvas = $("#game-canvas");
  const rectangle = canvas.getBoundingClientRect();
  return freeEditor.screenToWorld({
    x: (event.clientX - rectangle.left) * canvas.width / rectangle.width,
    y: (event.clientY - rectangle.top) * canvas.height / rectangle.height,
  });
}

function bind() {
  $("#refresh-button").onclick = () => refreshWorkspace({ dirty: store.dirty });
  store.subscribe(render);
  $("#save-button").onclick = () => { if (files) save(); };
  $("#undo-button").onclick = () => { if (canMutate("history")) freeEditor.undo(); };
  $("#redo-button").onclick = () => { if (canMutate("history")) freeEditor.redo(); };
  $("#add-level").onclick = () => {
    if (!canMutate("level-create")) return;
    createLevelForEditing({
      addLevel: () => store.addLevel(),
      currentMode: mode,
      enterEdit: beginEdit,
      showLevelTab: () => activateTab("level"),
    });
  };
  $("#asset-search").oninput = event => { search = event.target.value.trim().toLowerCase(); renderAssets(); };
  $(".level-list").onclick = event => {
    const card = event.target.closest(".level-card");
    if (!card) return;
    if (event.target.closest(".level-delete")) {
      if (!canMutate("level")) return;
      if (confirm("确定删除该关卡吗？")) try { store.deleteLevel(card.dataset.id); } catch (error) { alert(error.message); }
    } else {
      switchLevel(card.dataset.id);
    }
  };
  $(".level-list").ondblclick = async event => {
    const card = event.target.closest(".level-card");
    if (!card || event.target.closest(".level-delete") || !files) return;
    const result = await switchLevel(card.dataset.id);
    if (["cancel", "save-failed"].includes(result)) return;
    if (mode !== "edit") beginEdit();
    activateTab(editorIntentTab("double-click-level"));
  };
  $(".library").onclick = event => {
    const node = event.target.closest(".asset");
    if (!node) return;
    const command = assetCardCommand({ edit: Boolean(event.target.closest(".asset-edit")) });
    if (command === "add") addAssetObject(node.dataset.kind, node.dataset.id);
    else {
      itemInspector.selectAsset(node.dataset.kind, node.dataset.id);
      activateTab("element");
    }
  };
  $(".library").onkeydown = event => {
    const node = event.target.closest(".asset");
    if (!node || event.target.closest("button")) return;
    const command = assetCardCommand({ key: event.key });
    if (command !== "add") return;
    event.preventDefault();
    addAssetObject(node.dataset.kind, node.dataset.id);
  };
  $(".library").ondragstart = event => {
    const node = event.target.closest(".asset");
    if (!node || !event.dataTransfer) return;
    draggedAsset = { kind: node.dataset.kind, id: node.dataset.id };
    event.dataTransfer.setData("application/x-levelcraft-asset", JSON.stringify(draggedAsset));
    event.dataTransfer.effectAllowed = "copy";
    suppressNativeDragPreview(event.dataTransfer);
  };
  $(".library").ondragend = () => {
    draggedAsset = null;
    if (dragPreviewObject) {
      dragPreviewObject = null;
      renderCanvas();
    }
  };
  $$(".tab").forEach(tab => tab.onclick = () => {
    $$(".tab").forEach(candidate => candidate.classList.toggle("active", candidate === tab));
    $$(".tab-panel").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === tab.dataset.tab));
  });
  $$('[data-tool]').forEach(button => button.onclick = () => { if (canMutate("object")) setTool(button.dataset.tool); });
  $$('[data-command]').forEach(button => button.onclick = () => {
    if (!canMutate("object")) return;
    const commands = {
      "rotate-left": () => freeEditor.rotateSelection(-Math.PI / 2),
      "rotate-right": () => freeEditor.rotateSelection(Math.PI / 2),
      duplicate: () => freeEditor.duplicateSelection(),
      delete: () => freeEditor.deleteSelection(),
    };
    commands[button.dataset.command]?.();
  });
  $("#zoom-out").onclick = () => freeEditor.zoomBy(0.8);
  $("#zoom-in").onclick = () => freeEditor.zoomBy(1.25);
  $("#zoom-fit").onclick = () => freeEditor.resetViewport();
  $("#edit-toggle").onclick = () => {
    if (!files) return;
    if (mode === "play") beginEdit();
    else beginPlay();
  };
  $("#game-canvas").onpointermove = event => {
    if (mode === "play") playSequence.aimAt(playWorldPoint(event));
  };
  $("#game-canvas").onclick = event => {
    if (mode === "play") {
      applyPlayFireFeedback(playEffects, playSequence.fireAt(playWorldPoint(event)));
      renderCanvas();
    }
  };
  $("#game-canvas").ondragover = event => {
    if (mode !== "edit" || !files || !draggedAsset) return;
    event.preventDefault();
    dragPreviewObject = createAssetDragPreview({
      level: store.currentLevel,
      assets: store.assets,
      ...draggedAsset,
      point: playWorldPoint(event),
    });
    renderCanvas();
  };
  $("#game-canvas").ondragleave = () => {
    if (!dragPreviewObject) return;
    dragPreviewObject = null;
    renderCanvas();
  };
  $("#game-canvas").ondrop = event => {
    if (mode !== "edit" || !files) return;
    event.preventDefault();
    try {
      const asset = draggedAsset || JSON.parse(event.dataTransfer.getData("application/x-levelcraft-asset"));
      const point = dragPreviewObject ? { x: dragPreviewObject.x, y: dragPreviewObject.y } : playWorldPoint(event);
      dragPreviewObject = null;
      draggedAsset = null;
      addAssetObject(asset.kind, asset.id, point);
    } catch (error) { alert(error.message); }
  };
  $("#retry-level").onclick = () => {
    if (!playSequence) return;
    resetPlayPresentation(playEffects);
    playSnapshot = playSequence.retry();
    renderCanvas();
    renderPlayResult();
  };
  $("#next-level").onclick = () => {
    if (!playSequence?.next()) return;
    resetPlayPresentation(playEffects);
    playSnapshot = playSequence.snapshot();
    renderCanvas();
    renderPlayResult();
  };

  $("#project-name").onchange = event => { if (canMutate("global-project")) runLiveFieldMutation(event.target, () => store.updateConfig({ projectName: event.target.value })); };
  $("#canvas-width").onchange = event => { if (canMutate("global-project")) runLiveFieldMutation(event.target, () => store.updateConfig({ canvas: { ...store.config.canvas, width: Number(event.target.value) } })); };
  $("#canvas-height").onchange = event => { if (canMutate("global-project")) runLiveFieldMutation(event.target, () => store.updateConfig({ canvas: { ...store.config.canvas, height: Number(event.target.value) } })); };
  $("#world-width").onchange = event => { if (canMutate("global-project")) runLiveFieldMutation(event.target, () => store.updateConfig({ world: { ...store.config.world, width: Number(event.target.value) } })); };
  $("#world-height").onchange = event => { if (canMutate("global-project")) runLiveFieldMutation(event.target, () => store.updateConfig({ world: { ...store.config.world, height: Number(event.target.value) } })); };
  $("#score-mode").onchange = event => { if (canMutate("global-project")) runLiveFieldMutation(event.target, () => store.updateConfig({ scoreMode: event.target.value })); };
  $("#resource-theme").onchange = event => { if (canMutate("global-project")) runLiveFieldMutation(event.target, () => store.updateConfig({ resourceTheme: event.target.value })); };
  $("#unlock-rule").onchange = event => { if (canMutate("global-project")) runLiveFieldMutation(event.target, () => store.updateConfig({ unlockRule: event.target.value })); };
  $("#level-name").onchange = event => { if (canMutate("level-config")) runLiveFieldMutation(event.target, () => store.updateLevel({ levelName: event.target.value })); };
  $("#level-number").onchange = event => { if (canMutate("level-config")) runLiveFieldMutation(event.target, () => store.updateLevel({ levelNumber: Number(event.target.value) })); };
  $("#level-difficulty").onchange = event => { if (canMutate("level-config")) runLiveFieldMutation(event.target, () => store.updateLevel({ difficulty: event.target.value })); };
  for (const [selector, fieldId] of [
    ["#level-description", "description"],
    ["#level-normal-ammo", "normalAmmo"],
    ["#level-explosive-ammo", "explosiveAmmo"],
    ["#level-split-ammo", "splitAmmo"],
    ["#level-black-hole-ammo", "blackHoleAmmo"],
    ["#level-platform-type", "platformType"],
  ]) $(selector).onchange = event => {
    if (!canMutate("level-config")) return;
    const result = applyLevelFieldChange({ editorStore: store, fieldId, rawValue: event.target.value });
    setFieldError(event.target, result.ok ? null : result.error);
    if (result.ok) rebuildPlayForConfigChange();
  };
  $("#level-extensions").onchange = event => {
    if (!canMutate("level-config")) return;
    runLiveFieldMutation(event.target, () => {
      const extensions = parseJson(event.target.value, "扩展字段 JSON");
      store.replaceLevelExtensions(mergeLevelExtensionValues(store.currentLevel, extensions));
    });
  };
  $("#element-asset").onchange = event => {
    const materialId = event.target.value;
    if (["wood", "glass"].includes(materialId)) patchSelected({ materialId }, event.target);
    else runLiveFieldMutation(event.target, () => store.updateObjects(store.selectedObjectIds, object => {
      const next = { ...object, materialId };
      delete next.fixedBolt;
      return next;
    }));
  };
  $("#element-x").onchange = event => patchSelected({ x: Number(event.target.value) }, event.target);
  $("#element-y").onchange = event => patchSelected({ y: Number(event.target.value) }, event.target);
  $("#element-angle").onchange = event => {
    const angle = objectAngleRadians(event.target.value);
    if (angle === null) return render();
    patchSelected({ angle }, event.target);
  };
  $("#element-shape").onchange = event => {
    if (!canMutate("object-config")) return;
    runLiveFieldMutation(event.target, () => itemInspector.patch({ shape: parseJson(event.target.value, "形状 JSON") }));
  };
  for (const field of ["mass", "friction", "restitution", "maxHp", "hitSpeedThreshold"]) {
    $(`#element-${field}`).onchange = event => {
      if (!canMutate("object-config")) return;
      if (event.target.value === "") {
        runLiveFieldMutation(event.target, () => store.updateObjects(store.selectedObjectIds, object => { const next = { ...object }; delete next[field]; return next; }));
      } else patchSelected({ [field]: Number(event.target.value) }, event.target);
    };
  }
  $("#element-destructible").onchange = event => {
    if (!canMutate("object-config")) return;
    if (event.target.value === "") runLiveFieldMutation(event.target, () => store.updateObjects(store.selectedObjectIds, object => { const next = { ...object }; delete next.destructible; return next; }));
    else if (event.target.value === "true") patchSelected({ destructible: true }, event.target);
    else runLiveFieldMutation(event.target, () => store.updateObjects(store.selectedObjectIds, object => {
      const next = { ...object, destructible: false };
      delete next.fixedBolt;
      return next;
    }));
  };
  $("#element-fixedBolt").onchange = event => {
    if (!canMutate("object-config")) return;
    if (event.target.value === "true") patchSelected({ fixedBolt: true }, event.target);
    else runLiveFieldMutation(event.target, () => store.updateObjects(store.selectedObjectIds, object => {
      const next = { ...object };
      delete next.fixedBolt;
      return next;
    }));
  };
  $("#element-value").onchange = event => {
    if (!canMutate("object-config")) return;
    runLiveFieldMutation(event.target, () => {
      const replacement = parseJson(event.target.value, "物品 JSON");
      if (!replacement.id) throw new Error("物品 JSON 必须包含 id");
      store.updateObjects([selectedObjects()[0].id], () => replacement);
      store.selectObjects([replacement.id]);
    });
  };
  const frozenActions = createFrozenActionControls();
  $("#clear-element").before(frozenActions);
  $("#create-frozen-body").onclick = () => { if (canMutate("object")) try { store.createFrozenBody(store.selectedObjectIds); } catch (error) { alert(error.message); } };
  $("#remove-frozen-body").onclick = () => { if (canMutate("object")) store.removeFrozenBodies(store.selectedObjectIds); };
  $("#clear-element").onclick = () => { if (canMutate("object")) freeEditor.deleteSelection(); };
  $("#asset-form").onsubmit = async event => {
    event.preventDefault();
    if (!canMutate("asset-library") && !canMutate("asset-config")) return;
    try {
      const original = $("#asset-original-id").value;
      if (!original) throw new Error("只能修改已有资源");
      const id = $("#asset-id").value.trim();
      const kind = $("#asset-type").value;
      const file = $("#asset-image").files[0];
      const image = file ? `level/asset/${id}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}` : store.allAssets().find(asset => asset.id === original)?.image;
      const definitionText = $("#asset-definition").value.trim();
      if (!definitionText) throw new Error("资源 JSON 不能为空");
      const definition = parseJson(definitionText, "资源 JSON");
      const asset = { ...definition, id, name: $("#asset-name").value.trim(), color: $("#asset-color").value.trim() || definition.color, image };
      const base64 = file ? await fileBase64(file) : null;
      store.updateAsset(original, asset, base64);
      rebuildPlayForAssetChange();
      $("#asset-dialog").close();
    } catch (error) { $("#asset-error").textContent = error.message; }
  };
  $("#delete-asset").onclick = () => {
    if (!canMutate("asset-library")) return;
    try { store.deleteAsset($("#asset-original-id").value); $("#asset-dialog").close(); }
    catch (error) { $("#asset-error").textContent = error.message; }
  };
  window.onkeydown = event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && files) { event.preventDefault(); save(); }
    else if (event.key.toLowerCase() === "v" && canMutate("object")) setTool("select");
  };
}

async function boot(localFiles = null) {
  if (booted) return;
  if (booting) return booting;
  booting = (async () => {
    files = localFiles;
    try {
    const data = await loadProject(files);
    store = new EditorStore({ ...data, files });
    const assetStore = {
      get snapshot() {
        return { assets: store.assets, selection: store.selectedAssetId ? { kind: store.selectedAssetKind, id: store.selectedAssetId } : null, dirty: store.dirty, validation: { ok: true, errors: [] } };
      },
      select(kind, id) { store.selectAsset(id, kind); },
      patchSelected(updates) { store.updateAsset(store.selectedAssetId, { ...updates, id: store.selectedAssetId }); },
    };
    itemInspector = createItemInspector({ assetStore, editorStore: store, onAssetChange: rebuildPlayForAssetChange });
    const canvas = $("#game-canvas");
    freeEditor = createFreeWorldEditor(canvas, store, {
      render: renderCanvas,
      onObjectDoubleClick: () => activateTab(editorIntentTab("double-click-object")),
    });
    batchDialogDispose?.();
    batchDialogDispose = createBatchLevelDialog({ document, store, writable: Boolean(files), onAccepted: render });
    void loadPlayPresentationAssets({ document, onReady: () => renderCanvas() });
    bind();
    render();
    beginPlay();
      if (!files) { setReadOnly(); setSaveState("只读演示模式", "readonly"); }
      booted = true;
      return true;
    } catch (error) {
      files = null;
      setSaveState(`初始化失败：${error.message}`, "error");
      return false;
    } finally {
      booting = null;
    }
  })();
  return booting;
}

if (typeof window !== "undefined") {
  createEditorBootCoordinator({
    window,
    startDesktop: () => boot(new LocalFiles()),
    startBrowser: () => boot(null),
  }).start();
}

export { boot, loadProject };
