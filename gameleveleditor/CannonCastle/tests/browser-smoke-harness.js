import { createMemoryFileApi, createSmokeWorkspaceFixture } from './browser-smoke-fixture.js';

async function text(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.text();
}

async function main() {
  const [globalText, levelText] = await Promise.all([
    text('../全局配置.json'),
    text('../level/关卡-001-直射引导.json'),
  ]);
  const fixture = createSmokeWorkspaceFixture({ globalText, levelText });
  const fileApi = createMemoryFileApi(fixture);
  globalThis.pywebview = { api: { files: fileApi } };
  globalThis.__smokeFiles = fileApi.files;
  await import('../static/js/editor.js');
  dispatchEvent(new Event('pywebviewready'));
}

main().catch(error => {
  console.error(error);
  document.body.textContent = `Smoke harness failed: ${error.message}`;
});
