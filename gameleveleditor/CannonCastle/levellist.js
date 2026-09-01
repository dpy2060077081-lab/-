// Level discovery stays data-driven: the filesystem/catalog owns the names.
export const EDITABLE_LEVEL_FILE_PATTERN = /^level-.*\.json$/i;
export const ORIGINAL_LEVEL_FILE_PATTERN = /^original-(\d+)-.*\.json$/i;
export const LEVEL_FILE_PATTERN = /^(?:level-.*|original-\d+-.*)\.json$/i;
export const EXPORT_MANIFEST_FILE = '导出清单.json';
export const EXPORTED_LEVEL_FILE_PATTERN = /^关卡-(\d{3})-(.+)\.json$/u;

export function exportedLevelFilename(entry) {
  if (!entry || !Number.isInteger(entry.number) || entry.number < 1 || entry.number > 999) {
    throw new TypeError('导出清单包含无效关卡编号');
  }
  if (typeof entry.name !== 'string' || !entry.name.trim() || /[\\/:*?"<>|]/u.test(entry.name)) {
    throw new TypeError(`导出清单中的关卡 ${entry.number} 名称无效`);
  }
  return `关卡-${String(entry.number).padStart(3, '0')}-${entry.name}.json`;
}

export function exportManifestLevelEntries(manifest, availableNames = null) {
  if (manifest?.version !== 1 || manifest?.type !== 'manifest' || !Array.isArray(manifest.levels)) {
    throw new TypeError('导出清单.json 格式无效');
  }
  const available = availableNames ? new Set(availableNames) : null;
  const numbers = new Set();
  const ids = new Set();
  return manifest.levels.map((entry, index) => {
    if (!entry || typeof entry.id !== 'string' || !entry.id) throw new TypeError(`导出清单第 ${index + 1} 项缺少 id`);
    if (ids.has(entry.id)) throw new Error(`导出清单包含重复 id：${entry.id}`);
    if (numbers.has(entry.number)) throw new Error(`导出清单包含重复编号：${entry.number}`);
    ids.add(entry.id);
    numbers.add(entry.number);
    const fileName = exportedLevelFilename(entry);
    if (available && !available.has(fileName)) throw new Error(`缺少关卡文件：level/${fileName}`);
    return {
      ...entry,
      path: `level/${fileName}`,
      workspaceId: `exported:${entry.id}`,
      workspaceKind: 'exported',
      numberConflict: null,
    };
  });
}

function levelNumber(name) {
  const original = ORIGINAL_LEVEL_FILE_PATTERN.exec(name);
  if (original) return Number(original[1]);
  const editable = /^level-(\d+)/i.exec(name);
  return editable ? Number(editable[1]) : Number.POSITIVE_INFINITY;
}

export function sortLevelFiles(names = []) {
  return [...names].filter(name => LEVEL_FILE_PATTERN.test(name)).sort((left, right) =>
    levelNumber(left) - levelNumber(right)
      || left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  );
}

export function editableLevelEntries(availableNames = [], reservedNumbers = []) {
  const reserved = new Set(reservedNumbers);
  const numbers = new Set();
  return sortLevelFiles(availableNames)
    .filter(name => EDITABLE_LEVEL_FILE_PATTERN.test(name))
    .map(name => {
      const number = levelNumber(name);
      if (Number.isInteger(number) && numbers.has(number)) {
        throw new Error(`Workspace contains duplicate editable level number: ${number}`);
      }
      if (Number.isInteger(number)) numbers.add(number);
      const normalizedName = name.normalize('NFC').toLocaleLowerCase('en-US');
      return {
        id: `editable:${normalizedName}`,
        workspaceId: `editable:${normalizedName}`,
        workspaceKind: 'editable',
        number: Number.isInteger(number) ? number : null,
        numberConflict: Number.isInteger(number) && reserved.has(number) ? { type: 'manifest-number', number } : null,
        path: `level/${name}`,
      };
    });
}

export function catalogLevelEntries(catalog, availableNames = null) {
  if (!catalog || !Array.isArray(catalog.levels)) throw new TypeError('Invalid original level catalog');
  const available = availableNames ? new Set(availableNames) : null;
  const numbers = new Set();
  const paths = new Set();
  const entries = catalog.levels.map((entry, index) => {
    if (!entry || typeof entry.path !== 'string' || !entry.path.startsWith('level/')) {
      throw new TypeError(`Invalid catalog entry at index ${index}`);
    }
    if (!Number.isInteger(entry.number) || entry.number < 1) throw new TypeError(`Invalid catalog level number at index ${index}`);
    if (numbers.has(entry.number)) throw new Error(`Original level catalog contains duplicate number: ${entry.number}`);
    if (paths.has(entry.path)) throw new Error(`Original level catalog contains duplicate path: ${entry.path}`);
    numbers.add(entry.number);
    paths.add(entry.path);
    const name = entry.path.slice('level/'.length);
    if (!ORIGINAL_LEVEL_FILE_PATTERN.test(name)) throw new TypeError(`Invalid original level path: ${entry.path}`);
    if (available && !available.has(name)) throw new Error(`Catalog level is missing: ${entry.path}`);
    return entry;
  });
  return entries.sort((left, right) => left.number - right.number);
}

export function catalogLevelFiles(catalog, availableNames = null) {
  return catalogLevelEntries(catalog, availableNames).map(entry => entry.path.slice('level/'.length));
}

export function workspaceLevelEntries(catalog, availableNames = []) {
  const catalogEntries = catalogLevelEntries(catalog);
  const canonicalNames = new Map();
  for (const name of availableNames) {
    const canonical = String(name).normalize('NFC').toLocaleLowerCase('en-US');
    if (canonicalNames.has(canonical)) throw new Error(`Workspace contains conflicting level paths: ${canonicalNames.get(canonical)} and ${name}`);
    canonicalNames.set(canonical, name);
  }
  const available = new Set(availableNames);
  const originals = catalogEntries
    .filter(entry => available.has(entry.path.slice('level/'.length)))
    .map(entry => ({ ...entry, workspaceId: `original:${entry.id ?? entry.path}`, workspaceKind: 'original', numberConflict: null }));
  const originalPaths = new Set(catalogEntries.map(entry => entry.path));
  const usedNumbers = new Set(catalogEntries.map(entry => entry.number));
  const editableNumbers = new Set();
  const editable = [];

  for (const name of sortLevelFiles(availableNames)) {
    const path = `level/${name}`;
    if (ORIGINAL_LEVEL_FILE_PATTERN.test(name) && !originalPaths.has(path)) {
      throw new Error(`Original-looking level is absent from the catalog: ${path}`);
    }
    if (!EDITABLE_LEVEL_FILE_PATTERN.test(name)) continue;
    const number = levelNumber(name);
    if (originalPaths.has(path)) continue;
    if (Number.isInteger(number) && editableNumbers.has(number)) throw new Error(`Workspace contains duplicate editable level number: ${number}`);
    if (Number.isInteger(number)) editableNumbers.add(number);
    const normalizedName = name.normalize('NFC').toLocaleLowerCase('en-US');
    editable.push({
      id: `editable:${normalizedName}`,
      workspaceId: `editable:${normalizedName}`,
      workspaceKind: 'editable',
      number: Number.isInteger(number) ? number : null,
      numberConflict: Number.isInteger(number) && usedNumbers.has(number) ? { type: 'catalog-number', number } : null,
      path,
    });
  }

  return [...originals, ...editable];
}
