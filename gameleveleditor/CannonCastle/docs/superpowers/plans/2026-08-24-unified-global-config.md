# 单一全局配置迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 `config.json` 与 `asset.json`，让整个项目只从 `全局配置.json` 加载和保存项目参数、运行时参数与资产定义。

**Architecture:** 新增纯函数适配层，把唯一落盘文档转换成编辑器内部既有的 `{ config, assets }` 视图，并在保存边界重新合并。Canvas、试玩、关卡和资产编辑继续消费既有内存接口，文件加载与保存不再接触旧双文件。

**Tech Stack:** JavaScript ES modules、Node.js 24 test runner、JSON、PyWebView 文件桥

**Spec:** `docs/superpowers/specs/2026-08-24-unified-global-config-design.md`

## Global Constraints

- 唯一配置文件必须是根目录 `全局配置.json`，结构版本固定为 `version: 2`、`type: "global"`。
- 不修改 `level/*.json` v2 内容和 `level/导出清单.json` 格式。
- 不修改 `陨石城堡Demo.html` 与 `static/vendor/meteor-original-runtime.js`。
- 生产加载和保存路径不得读取或写入 `config.json`、`asset.json`。
- 所有生产代码变化必须先有失败测试，再实现最小通过代码。

---

### Task 1: 建立统一配置适配层

**Files:**
- Create: `static/js/global-config-document.js`
- Create: `tests/global-config-document.test.mjs`
- Read: `static/js/global-physics-store.js`
- Read: `static/js/asset-store.js`

**Interfaces:**
- Produces: `assertGlobalConfigDocument(document): true`
- Produces: `decodeGlobalConfig(document): { document, config, assets }`
- Produces: `encodeGlobalConfig({ document, config, assets }): object`
- Consumes: 规格中定义的统一 JSON 字段

- [ ] **Step 1: 写失败测试，锁定解码映射**

```js
test('decodes the unified global document into editor config and assets', () => {
  const result = decodeGlobalConfig(fixture);
  assert.equal(result.config.canvas.width, 750);
  assert.equal(result.config.runtime.environment.baseFriction, 0.5);
  assert.equal(result.config.runtime.launcher.totalArcDegrees, 150);
  assert.equal(result.assets.materials.wood.id, 'wood');
  assert.equal(result.assets.specialObjects['explosive-barrel'].explosion.propagationSpeed, 8);
});
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `node --test tests/global-config-document.test.mjs`
Expected: FAIL，提示找不到 `global-config-document.js` 或导出函数。

- [ ] **Step 3: 实现最小解码与结构校验**

实现严格检查 `version/type` 及必需对象；把 `globalEnvironment/globalProjectiles/globalObjectProfiles` 克隆为内部运行时与资产视图，不共享可变引用。

- [ ] **Step 4: 写失败测试，锁定编码和扩展字段保留**

```js
test('encodes edited views without duplicate runtime authority', () => {
  const decoded = decodeGlobalConfig({ ...fixture, extension: { keep: true } });
  decoded.config.runtime.global.gravity = 12;
  decoded.assets.materials.wood.mass = 3;
  const output = encodeGlobalConfig(decoded);
  assert.equal(output.runtime.global.gravity, 12);
  assert.equal(output.globalObjectProfiles.materials.wood.mass, 3);
  assert.deepEqual(output.extension, { keep: true });
  assert.equal(output.runtime.environment, undefined);
});
```

- [ ] **Step 5: 运行测试并确认编码行为缺失**

Run: `node --test tests/global-config-document.test.mjs`
Expected: FAIL 在编码断言。

- [ ] **Step 6: 实现编码函数并通过专项测试**

Run: `node --test tests/global-config-document.test.mjs`
Expected: PASS。

- [ ] **Step 7: 提交适配层**

```bash
git add static/js/global-config-document.js tests/global-config-document.test.mjs
git commit -m "feat: add unified global config adapter"
```

### Task 2: 合并权威数据并切换项目加载

**Files:**
- Modify: `全局配置.json`
- Modify: `static/js/editor.js`
- Modify: `static/js/editor-host.js`
- Modify: `tests/export-manifest.test.mjs`
- Modify: `tests/browser-smoke-fixture.js`
- Modify: `tests/browser-smoke-fixture.test.mjs`
- Modify: `tests/resource-loading.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `decodeGlobalConfig`
- Produces: `loadProject()` 返回现有 `{ config, assets, levels, reservedLevelNumbers }`

- [ ] **Step 1: 扩展加载测试，要求只请求统一文件**

```js
assert.ok(requested.includes('全局配置.json'));
assert.ok(!requested.includes('config.json'));
assert.ok(!requested.includes('asset.json'));
```

- [ ] **Step 2: 运行测试并确认仍请求旧双文件**

Run: `node --test tests/export-manifest.test.mjs tests/resource-loading.test.mjs`
Expected: FAIL，实际请求包含 `config.json` 或 `asset.json`。

- [ ] **Step 3: 把现有双文件数据无损合并进 `全局配置.json`**

补入 `projectName/canvas/world/runtime.global/scoreMode/resourceTheme/unlockRule`、`globalEnvironment.baseWidth`、完整 `shapes`、`specialObjects`，并保证爆炸炮弹与爆炸桶传播速度均为 `8`。

- [ ] **Step 4: 修改浏览器与 WebView 加载边界**

两个加载入口只读取 `全局配置.json`，调用 `decodeGlobalConfig` 后继续复用现有关卡解码和验证流程。

- [ ] **Step 5: 更新浏览器 smoke fixture 的文档集合**

fixture 只提供 `全局配置.json`、清单和关卡文件，不提供旧双文件。

- [ ] **Step 6: 运行加载专项测试**

Run: `node --test tests/global-config-document.test.mjs tests/export-manifest.test.mjs tests/resource-loading.test.mjs tests/browser-smoke-fixture.test.mjs`
Expected: PASS。

- [ ] **Step 7: 提交加载迁移**

```bash
git add 全局配置.json static/js/editor.js static/js/editor-host.js tests/export-manifest.test.mjs tests/browser-smoke-fixture.js tests/browser-smoke-fixture.test.mjs tests/resource-loading.test.mjs
git commit -m "feat: load project from unified global config"
```

### Task 3: 切换统一保存事务

**Files:**
- Modify: `static/js/editor-store.js`
- Modify: `static/js/editor.js`
- Modify: `tests/unified-save.test.mjs`
- Modify: `tests/editor-state.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `encodeGlobalConfig`
- Modify: `saveWorkspace({ files, globalDocument, dirtyLevels, newImages, deletions })`
- Modify: `EditorStore` 构造参数增加 `globalDocument`

- [ ] **Step 1: 写失败测试，要求配置和资产编辑只写统一文件**

```js
assert.deepEqual(
  operations.filter(([method]) => method === 'writeText').map(([, path]) => path),
  ['全局配置.json', 'level/关卡-001-直射引导.json'],
);
assert.equal(operations.some(([, path]) => path === 'config.json' || path === 'asset.json'), false);
```

- [ ] **Step 2: 运行保存测试并确认旧文件仍被写入**

Run: `node --test tests/unified-save.test.mjs`
Expected: FAIL，写入日志包含 `config.json` 与 `asset.json`。

- [ ] **Step 3: 修改保存边界生成单一文档**

`EditorStore.performSave()` 使用事务快照中的 `globalDocument/config/assets` 调用 `encodeGlobalConfig`；`saveWorkspace()` 只写 `全局配置.json`，并在日志中记录该路径。

- [ ] **Step 4: 保留失败恢复与并发编辑语义**

统一文件写入失败时不清除 `configDirty/assetsDirty`；保存期间产生的新修改仍保持 dirty；图片和关卡的部分成功日志继续用于重试。

- [ ] **Step 5: 运行保存与状态测试**

Run: `node --test tests/unified-save.test.mjs tests/editor-state.test.mjs tests/asset-store.test.mjs`
Expected: PASS。

- [ ] **Step 6: 提交保存迁移**

```bash
git add static/js/editor-store.js static/js/editor.js tests/unified-save.test.mjs tests/editor-state.test.mjs
git commit -m "feat: save configuration as one global document"
```

### Task 4: 删除旧文件和清理全仓引用

**Files:**
- Delete: `config.json`
- Delete: `asset.json`
- Modify: `scripts/verify.mjs`
- Modify: `scripts/template-provenance.json`
- Modify: `tests/legacy-catalog.test.mjs`
- Modify: `tests/template-integration.test.mjs`
- Modify: `tests/browser-smoke-runner.mjs`
- Modify: 其他实际引用旧文件的 `tests/*.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 适配层及 Task 2/3 新加载保存边界
- Produces: 全仓不存在旧文件的生产依赖

- [ ] **Step 1: 写失败的源码与文件存在性测试**

```js
await assert.rejects(() => stat(new URL('../config.json', import.meta.url)));
await assert.rejects(() => stat(new URL('../asset.json', import.meta.url)));
assert.doesNotMatch(productionSources, /["'`]\.\/?(?:config|asset)\.json["'`]/);
```

- [ ] **Step 2: 运行测试并确认旧文件仍存在或仍被引用**

Run: `node --test tests/global-config-document.test.mjs`
Expected: FAIL 在旧文件存在性或源码扫描断言。

- [ ] **Step 3: 删除两个旧 JSON 并更新验证脚本**

验证脚本读取并解码 `全局配置.json`，使用派生的 `config/assets` 校验 99 个清单关卡；JSON 文件统计排除清单但包含统一配置。

- [ ] **Step 4: 机械更新测试夹具与文档引用**

所有需要配置或资产的测试从 `decodeGlobalConfig(JSON.parse(readFile('全局配置.json')))` 取得视图；README 只描述统一文件，不再将旧双文件作为当前架构。

- [ ] **Step 5: 扫描残留生产依赖**

Run: `rg -n 'config\.json|asset\.json' --glob '!docs/superpowers/**' --glob '!陨石城堡Demo.html' --glob '!static/vendor/**'`
Expected: 只允许历史测试说明或迁移断言；生产代码零匹配。

- [ ] **Step 6: 运行静态验证与全部可执行测试**

Run: `node scripts/verify.mjs --skip-browser`
Expected: exit 0，99 个关卡通过统一配置派生资产校验。

Run: `npm test`
Expected: exit 0；如果现有工作区已删除的旧原版关卡造成与本迁移无关的失败，逐项记录并确保本次相关测试全绿。

- [ ] **Step 7: 运行 JavaScript 语法检查**

Run: `node --check static/js/global-config-document.js && node --check static/js/editor.js && node --check static/js/editor-host.js && node --check static/js/editor-store.js && node --check scripts/verify.mjs`
Expected: exit 0。

- [ ] **Step 8: 提交清理**

```bash
git add -A -- config.json asset.json scripts tests README.md
git commit -m "refactor: remove legacy split configuration files"
```

### Task 5: 最终验收

**Files:**
- Verify: `全局配置.json`
- Verify: `level/导出清单.json`
- Verify: `level/关卡-*.json`

**Interfaces:**
- Consumes: 所有前序任务产物
- Produces: 可交付的单文件配置项目

- [ ] **Step 1: 验证统一配置能往返且扩展字段保留**

Run: `node --test tests/global-config-document.test.mjs`
Expected: PASS。

- [ ] **Step 2: 验证清单与全部关卡**

Run: `node scripts/import-exported-levels.mjs level --check`
Expected: `Validated 99 exported v2 levels from level`。

- [ ] **Step 3: 运行最终相关测试集合**

Run: `node --test tests/global-config-document.test.mjs tests/export-manifest.test.mjs tests/unified-save.test.mjs tests/resource-loading.test.mjs tests/browser-smoke-fixture.test.mjs`
Expected: 全部 PASS、0 failures。

- [ ] **Step 4: 检查工作区差异只包含本迁移及用户已有改动**

Run: `git status --short` 与 `git diff --check`
Expected: 无空白错误；不回退或覆盖用户已有改动。
