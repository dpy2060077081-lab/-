# 陨石城堡关卡编辑器

这是基于当前 `building-game-level-editors` 技能模板适配的陨石城堡关卡工作台。

## 模板溯源

模板版本以 SHA-256 而不是易变的本机时间戳标识。`scripts/template-provenance.json` 记录当前技能 `SKILL.md` 哈希、完整 `assets/template` 树哈希，以及每个模板文件的模板哈希和项目哈希。`node scripts/verify.mjs` 会同时核对本机当前技能模板和项目文件。

项目中的模板文件分为两类：

- 原样保留：`start.exe`、`static/img/.gitkeep`，必须与当前技能模板逐字节一致。
- 有文档的玩法或视觉适配：`全局配置.json`、`gamelogic.js`、`index.html`、`levellist.js`、清单首关、`static/css/editor.css`、`static/js/editor-store.js`、`static/js/editor.js`、`static/js/local-files.js`。每项适配目的写在 provenance manifest 中；未同步更新 manifest 的内容漂移会使验证失败。

## 启动

需要 Node.js 22.0.0 或更高版本。真实浏览器 runner 直接使用 Node 的全局 `WebSocket` 连接 Chrome DevTools Protocol；不提供该能力的旧版 Node 会明确报告 `ENVIRONMENT_BLOCKED`。必须通过 HTTP 提供仓库文件，不能直接双击 `index.html`，因为浏览器会限制 `file:` 页面加载 ES modules 和 JSON。

```powershell
npx --yes http-server . -a 127.0.0.1 -p 8000 -c-1
```

然后打开 `http://127.0.0.1:8000/`。所有模块与数据引用均为相对路径，也支持部署到站点子路径。

## 三个属性 Tab

- “全局”：编辑 `全局配置.json` 中的项目名称、Canvas/世界尺寸，以及环境、炮台、普通炮弹、爆炸炮弹和爆炸传播的共享 runtime 物理参数；弹药不在此处编辑。项目与画布字段仅在编辑模式可改，runtime 物理参数在试玩中仍可修改，并会在通过范围校验后标脏配置、重建原版 runtime。
- “关卡”：编辑当前关卡的名称、编号、难度、描述、普通/爆炸弹药、平台类型及未知扩展字段；修改只标脏当前关卡文件。短数字字段尽量每行展示三个，普通字段每行两个，长文本独占一行，并随检查器宽度自动降列。
- “物品”：资源卡选中时编辑全局资源定义；Canvas 对象选中时编辑实例位置、弧度角、形状、材质引用及显式覆盖。多选只开放安全的共享字段。

左侧是动态关卡列表和资源库，中间 Canvas 支持资源拖放、选择、框选、移动、旋转与试玩。右上角“刷新”和“保存”只在 WebView 文件桥就绪时可写；“进入编辑/退出编辑”在普通浏览器中禁用。

## 浏览器只读与 WebView 桌面模式

普通浏览器是明确的只读演示模式：关卡、资源和配置可查看，原版试玩可运行，但新增、复制、编辑、删除、导入、保存及进入编辑模式均不可用。禁用状态和事件处理器同时执行该边界；浏览器模式不会创建内存可写工作区，也不会声称具有磁盘持久化。可写 WebView 的试玩模式同样锁定关卡和物品草稿，只允许通过校验的全局物理参数和材料修改，并立即重建试玩。

收到 `pywebviewready` 后，编辑器才读取 `window.pywebview.api.files` 并切换到可写桌面模式。宿主文件桥必须提供下列异步方法，返回 `{ ok: true, data }` 或 `{ ok: false, error: { code, message, details? } }`：

- `list_dir(path)`
- `read_text(path)` / `read_base64(path)`
- `write_text(path, content, overwrite)` / `write_base64(path, content, overwrite)`
- `mkdir(path, parents)`
- `delete(path, recursive)`

所有路径必须相对可执行文件工作区，使用 `/`，且不能包含 `..`。项目只使用根目录 `全局配置.json` 保存项目、运行时与资产数据。关卡目录统一使用 `level/导出清单.json` 作为索引，并按清单顺序加载 `关卡-XXX-名称.json`；清单中的 `id`、编号必须唯一，名称必须与文件名对应，缺失文件会拒绝加载。统一保存依次写图片、`全局配置.json`、脏关卡和确认删除项；新文件使用 `overwrite: false`，现有文件使用 `overwrite: true`。任一步失败都会保留未保存状态和重试所需队列。

浏览器与 WebView 的系统文件选择器、下载策略、真实磁盘权限及触摸/触控板体验仍由目标环境决定。自动化使用内存文件桥覆盖桌面 UI 行为，但不能替代目标 WebView 宿主的权限和系统对话框验收。

## 数据与试玩权威

生产 `play-session.js` 默认只能通过 `original-runtime-adapter.js` 使用固化在 `static/vendor/meteor-original-runtime.js` 的正式 runtime，不存在近似 `createGame` 回退。关卡包统一包含 `导出清单.json` 与对应的 `关卡-XXX-名称.json` 文件。

正式关卡落盘结构为 `{ version: 2, type: "level", levelId, level }`。`level` 保存编号、名称、难度、描述、普通/爆炸弹药、平台类型和 `castle`；物件保存位置、弧度角以及 `shapePresetId`、`materialId`、可选 `specialType`/`fixedBolt`。编辑与试玩时才从 `全局配置.json` 的 `globalObjectProfiles` 补全 box、circle、polygon 形状和材质物理参数，保存不会把运行时展开字段写回关卡。

全部 84 个导出关卡必须通过 v2 结构校验、玩法校验、资源解析和无损 JSON 往返，并与 catalog 哈希一致。

## 验证

唯一权威的完整验证命令是：

```powershell
node scripts/verify.mjs
```

它会核对模板 provenance，解析全部 JSON，对全部 JS/MJS 执行 `node --check`，导入无副作用模块，检查本地引用，校验全部关卡，逐一往返 84 个 ZIP 关卡，重新提取原始 runtime，校验原 Demo Git blob/源码哈希，守卫生产 runtime、无组合模板、三 Tab 和 Canvas 配置来源，然后调用真实浏览器 runner。最终结果明确为 `PASS`、`FAIL` 或 `ENVIRONMENT_BLOCKED`；后两者均返回非零退出码，环境阻断不会被描述为完整通过。

仅排查静态/数据问题时可以运行：

```powershell
node scripts/verify.mjs --skip-browser
```

该模式会明确输出 `static diagnostics only`，不是完整验收结果。

默认自动测试和单独的真实浏览器烟测分别运行：

```powershell
node scripts/test.mjs
node tests/browser-smoke-runner.mjs
```

浏览器烟测从真实 HTTP 子路径覆盖生产浏览器只读启动，以及内存 WebView 桥下的资源选择、材料编辑、拖放、移动、旋转、进入试玩、普通/爆炸炮弹、重试、下一关和退出编辑；两条路径都要求控制台零错误。内存文件桥使用真实 84 关 catalog，并由首关派生两个隔离的烟测关卡。可通过 `SMOKE_BROWSER_PATH` 指定 Edge/Chrome 可执行文件。
