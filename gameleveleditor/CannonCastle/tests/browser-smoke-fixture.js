export const SMOKE_LEVEL_NAMES = Object.freeze(['关卡-001-烟测编辑关.json', '关卡-002-烟测下一关.json']);

export function createSmokeWorkspaceFixture({ globalText, levelText }) {
  const firstLevel = JSON.parse(levelText);
  if (firstLevel?.type === 'level' && firstLevel.level) {
    firstLevel.levelId = 'smoke-level-1';
    firstLevel.level.number = 1;
    firstLevel.level.name = '烟测编辑关';
  } else {
    firstLevel.levelNumber = 1;
    firstLevel.levelName = '烟测编辑关';
  }
  const secondLevel = structuredClone(firstLevel);
  if (secondLevel?.type === 'level' && secondLevel.level) {
    secondLevel.levelId = 'smoke-level-2';
    secondLevel.level.number = 2;
    secondLevel.level.name = '烟测下一关';
  } else {
    secondLevel.levelNumber = 2;
    secondLevel.levelName = '烟测下一关';
  }
  return {
    levelNames: [...SMOKE_LEVEL_NAMES],
    documents: {
      '全局配置.json': globalText,
      'level/导出清单.json': JSON.stringify({ version: 1, type: 'manifest', levels: [
        { id: 'smoke-level-1', number: 1, name: '烟测编辑关', difficulty: firstLevel.level?.difficulty ?? 'normal' },
        { id: 'smoke-level-2', number: 2, name: '烟测下一关', difficulty: secondLevel.level?.difficulty ?? 'normal' },
      ] }),
      [`level/${SMOKE_LEVEL_NAMES[0]}`]: JSON.stringify(firstLevel),
      [`level/${SMOKE_LEVEL_NAMES[1]}`]: JSON.stringify(secondLevel),
    },
  };
}

export function createMemoryFileApi(fixture) {
  const files = new Map(Object.entries(fixture.documents));
  const ok = data => ({ ok: true, data });
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  const api = {
    async list_dir(path) {
      return path === 'level'
        ? ok({ entries: fixture.levelNames.map(name => ({ name, type: 'file' })) })
        : ok({ entries: [] });
    },
    async read_text(path) { return files.has(path) ? ok({ content: files.get(path) }) : fail('NOT_FOUND', path); },
    async read_base64(path) { return files.has(path) ? ok({ content: files.get(path) }) : fail('NOT_FOUND', path); },
    async write_text(path, content, overwrite) {
      if (!overwrite && files.has(path)) return fail('ALREADY_EXISTS', path);
      files.set(path, content);
      return ok({ path });
    },
    async write_base64(path, content, overwrite) {
      if (!overwrite && files.has(path)) return fail('ALREADY_EXISTS', path);
      files.set(path, content);
      return ok({ path });
    },
    async mkdir(path) { return ok({ path }); },
    async delete(path) { return files.delete(path) ? ok({ path }) : fail('NOT_FOUND', path); },
  };
  Object.defineProperty(api, 'files', { value: files });
  return api;
}

export function memoryWebViewPreloadSource(fixture) {
  return `(() => {
    const fixture = ${JSON.stringify(fixture)};
    const files = new Map(Object.entries(fixture.documents));
    const ok = data => ({ ok: true, data });
    const fail = (code, message) => ({ ok: false, error: { code, message } });
    const api = {
      async list_dir(path) {
        return path === 'level'
          ? ok({ entries: fixture.levelNames.map(name => ({ name, type: 'file' })) })
          : ok({ entries: [] });
      },
      async read_text(path) { return files.has(path) ? ok({ content: files.get(path) }) : fail('NOT_FOUND', path); },
      async read_base64(path) { return files.has(path) ? ok({ content: files.get(path) }) : fail('NOT_FOUND', path); },
      async write_text(path, content, overwrite) {
        if (!overwrite && files.has(path)) return fail('ALREADY_EXISTS', path);
        files.set(path, content);
        return ok({ path });
      },
      async write_base64(path, content, overwrite) {
        if (!overwrite && files.has(path)) return fail('ALREADY_EXISTS', path);
        files.set(path, content);
        return ok({ path });
      },
      async mkdir(path) { return ok({ path }); },
      async delete(path) { return files.delete(path) ? ok({ path }) : fail('NOT_FOUND', path); },
    };
    globalThis.pywebview = { api: { files: api } };
    globalThis.__smokeFiles = files;
    addEventListener('DOMContentLoaded', () => setTimeout(() => dispatchEvent(new Event('pywebviewready')), 0), { once: true });
  })();`;
}
