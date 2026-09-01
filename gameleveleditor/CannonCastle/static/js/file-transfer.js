import { cloneLevel, serializeLevel, validateLevelShape } from './level-config.js';

function failure(code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}

function stripExtension(name) {
  return String(name ?? '').trim().replace(/\.json$/i, '');
}

export function safeLevelFilename(filename) {
  const leaf = stripExtension(filename).replace(/\\/g, '/').split('/').at(-1) ?? '';
  const stem = leaf
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  const safeStem = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? `level-${stem}` : stem;
  return `${safeStem || 'level'}.json`;
}

export function levelPath(filename) {
  return `level/${safeLevelFilename(filename)}`;
}

/**
 * Reads user-selected JSON files without mutating or normalising their level
 * payloads. The normalized filename is the import identity used to prevent an
 * ambiguous overwrite when several selected names collapse to one safe name.
 */
export async function parseImportedFiles(files) {
  let selected;
  try {
    selected = [...(files ?? [])];
  } catch {
    return failure('INVALID_IMPORT', '请选择一个或多个 JSON 关卡文件。');
  }
  if (selected.length === 0) return failure('INVALID_IMPORT', '请选择一个或多个 JSON 关卡文件。');

  const identities = new Set();
  const imported = [];
  for (const file of selected) {
    const sourceName = typeof file?.name === 'string' && file.name.trim() ? file.name.trim() : 'level.json';
    const filename = safeLevelFilename(sourceName);
    if (identities.has(filename)) {
      return failure('DUPLICATE_IMPORT', `导入文件存在重复关卡标识“${filename}”，请重命名后重试。`, { filename });
    }
    identities.add(filename);

    let text;
    try {
      if (typeof file?.text !== 'function') throw new TypeError('File.text is unavailable');
      text = await file.text();
    } catch (error) {
      return failure('READ_IMPORT_FAILED', `无法读取“${sourceName}”，请确认文件可访问后重试。`, {
        filename: sourceName,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    let level;
    try {
      level = JSON.parse(text);
    } catch (error) {
      return failure('MALFORMED_IMPORT', `“${sourceName}”不是有效 JSON，请修正格式后重试。`, {
        filename: sourceName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const validation = validateLevelShape(level);
    if (!validation.valid) {
      return failure('INVALID_LEVEL', `“${sourceName}”不是有效关卡，请检查缺失或错误字段。`, {
        filename: sourceName,
        errors: validation.errors,
      });
    }
    imported.push({ filename, level: cloneLevel(level) });
  }
  return { ok: true, data: imported };
}

/** Downloads one level in browser mode using a stable, path-free JSON name. */
export function downloadLevel(level, filename = 'level.json') {
  const validation = validateLevelShape(level);
  if (!validation.valid) {
    return failure('INVALID_LEVEL', '关卡校验未通过，修正问题后才能导出。', { errors: validation.errors });
  }
  if (!globalThis.document?.createElement || typeof globalThis.URL?.createObjectURL !== 'function') {
    return failure('DOWNLOAD_UNAVAILABLE', '当前环境不支持下载，请在浏览器中重试。');
  }

  const stableFilename = safeLevelFilename(filename);
  let url;
  try {
    const blob = new Blob([serializeLevel(level)], { type: 'application/json;charset=utf-8' });
    url = globalThis.URL.createObjectURL(blob);
    const anchor = globalThis.document.createElement('a');
    anchor.href = url;
    anchor.download = stableFilename;
    anchor.hidden = true;
    globalThis.document.body?.append?.(anchor);
    anchor.click();
    anchor.remove?.();
    return { ok: true, data: { filename: stableFilename } };
  } catch (error) {
    return failure('DOWNLOAD_FAILED', '关卡下载失败，请重试或检查浏览器下载权限。', {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (url) globalThis.URL.revokeObjectURL?.(url);
  }
}
