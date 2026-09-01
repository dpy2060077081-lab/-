import { validateLevel } from '../../gamelogic.js';
import { createLevelRepository, EXPORT_MANIFEST_FILE, exportManifestLevelEntries, LocalFiles } from '../../levellist.js';
import { cloneLevel } from './level-config.js';
import { decodeGlobalConfig } from './global-config-document.js';

async function fetchJson(path, fetcher) {
  const response = await fetcher(path);
  if (!response?.ok) throw new Error(`${path} 返回 HTTP ${response?.status ?? '错误'}`);
  return response.json();
}

function watchDesktopRepository(browser) {
  if (!browser || typeof browser.addEventListener !== 'function') {
    return { desktopReady: Promise.resolve(null), dispose() {}, isActive: () => false };
  }
  const controller = new AbortController();
  const desktopReady = LocalFiles.whenPywebviewReady(browser, { signal: controller.signal })
    .then((result) => result.ok && !controller.signal.aborted ? createLevelRepository(result.data) : null);

  return {
    desktopReady,
    dispose() { controller.abort(); },
    isActive: () => !controller.signal.aborted,
  };
}

/**
 * Owns browser resources and the optional desktop bridge lifecycle. Browser
 * mode mounts immediately; a delayed pywebview bridge upgrades the same root.
 */
export async function bootEditorHost({ browser, fetcher, root, mount, onError }) {
  const bridge = watchDesktopRepository(browser);
  try {
    const [globalDocument, manifest] = await Promise.all([
      fetchJson('./全局配置.json', fetcher),
      fetchJson(`./level/${EXPORT_MANIFEST_FILE}`, fetcher),
    ]);
    const { config, assets } = decodeGlobalConfig(globalDocument);
    const builtInLevels = await Promise.all(exportManifestLevelEntries(manifest).map(async (entry) => ({
      path: entry.path,
      level: await fetchJson(`./${entry.path}`, fetcher),
    })));
    const dependencies = { config, assets, validateLevel, cloneLevel };
    const browserEditor = mount(root, {
      ...dependencies,
      repository: createLevelRepository(undefined, builtInLevels),
    });
    let desktopEditor = null;
    let disposed = false;
    const desktopReady = bridge.desktopReady.then(async (repository) => {
      if (!repository || !bridge.isActive() || disposed) return null;
      desktopEditor = mount(root, { ...dependencies, repository });
      await desktopEditor.ready;
      if (disposed) {
        desktopEditor.dispose?.();
        return null;
      }
      return desktopEditor;
    });
    return Object.freeze({
      ready: browserEditor.ready,
      desktopReady,
      dispose() {
        if (disposed) return;
        disposed = true;
        bridge.dispose();
        desktopEditor?.dispose?.();
        browserEditor.dispose?.();
      },
    });
  } catch (error) {
    bridge.dispose();
    onError(root, error);
    throw error;
  }
}
