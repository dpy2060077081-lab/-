# 单一全局配置迁移设计

## 目标

项目只保留根目录 `全局配置.json` 作为配置与资产数据源。删除 `config.json` 和 `asset.json` 后，浏览器只读模式、WebView 编辑模式、试玩、资源库、关卡校验和统一保存均保持可用。

## 权威文件结构

`全局配置.json` 保持 `version: 2`、`type: "global"`，并包含：

- `projectName`、`canvas`、`world`、`scoreMode`、`resourceTheme`、`unlockRule`：项目与编辑器参数。
- `runtime.global`：重力、默认弹药与静止判定参数。
- `globalEnvironment`：平台和山体的全局物理参数，并补充 `baseWidth`。
- `globalProjectiles`：`launcher`、`meteor`、`explosive`。
- `globalObjectProfiles.materials`：材质定义。
- `globalObjectProfiles.shapes`：形状预设。
- `globalObjectProfiles.specialObjects`：特殊物品定义，包括 `explosive-barrel`。

不保留重复的 `runtime.environment`、`runtime.meteor`、`runtime.explosive` 和 `runtime.launcher`。这些运行时视图由适配层从 `globalEnvironment` 与 `globalProjectiles` 派生，避免同一参数出现两个权威值。

## 配置适配边界

新增一个独立的全局配置适配模块，提供以下纯函数：

- `decodeGlobalConfig(document)`：校验统一文档，返回 `{ document, config, assets }`。`config.runtime.environment` 和炮弹配置由统一字段派生；`assets` 由 `globalObjectProfiles` 派生。
- `encodeGlobalConfig({ document, config, assets })`：把编辑器内存状态合并回统一文档，写回唯一权威字段。
- `assertGlobalConfigDocument(document)`：拒绝错误版本、错误类型、缺失分区或无效结构。

现有游戏逻辑和编辑器内部仍使用 `{ config, assets }`，避免把存储格式变化扩散到 Canvas、碰撞、试玩等模块。文件边界负责拆分和合并。

## 加载流程

浏览器模式读取：

1. `全局配置.json`
2. `level/导出清单.json`
3. 清单列出的 `level/关卡-XXX-名称.json`

WebView 模式读取同一组文件，并从 `level/` 列表校验清单中的文件确实存在。任何生产加载路径均不得请求 `config.json` 或 `asset.json`。

## 保存流程

编辑期间继续在内存中分别维护 `config` 和 `assets`，以保留现有控件与状态管理接口。点击统一保存时：

1. 校验项目配置、资产关系和全部关卡。
2. 调用 `encodeGlobalConfig` 生成完整统一文档。
3. 写入 `全局配置.json`。
4. 写入新增图片与脏关卡，执行确认过的删除项。

保存事务不再写 `config.json` 或 `asset.json`。失败时沿用现有保存日志和脏状态恢复机制。

## 数据迁移

首次迁移把当前 `config.json` 中独有的项目、画布、世界、重力、弹药和静止判定字段补入 `全局配置.json`；把当前 `asset.json` 的材质、形状和特殊物品合并到 `globalObjectProfiles`。重叠物理参数以现有 `全局配置.json` 为准；缺少的 `baseWidth` 和爆炸炮弹 `propagationSpeed` 使用当前 `config.json` 的值。

完成迁移并验证后删除 `config.json` 和 `asset.json`。不修改任何 `level/*.json` 内容。

## 兼容性与错误处理

- 只支持迁移后的 `version: 2`、`type: "global"` 完整文档，不在生产加载路径静默回退旧双文件结构。
- 配置缺失或结构错误时，初始化状态显示带字段路径的错误信息。
- 材质、形状或特殊物品引用不存在时，沿用现有关卡与资产图校验错误。
- `全局配置.json` 是唯一落盘权威；内存中的 `config/assets` 只是适配视图。

## 测试与验收

- 适配层纯函数往返测试：统一文档解码后再编码，不丢失扩展字段。
- 浏览器与 WebView 项目加载测试：只读取 `全局配置.json`。
- 统一保存测试：配置和资产修改只写 `全局配置.json`。
- 生产源码扫描：不存在对 `config.json`、`asset.json` 的读取或写入。
- 解析统一配置和全部关卡，运行资产图与关卡校验。
- 对所有修改的 JavaScript 执行 `node --check`，运行可执行的项目测试集合。

## 非目标

- 不改变关卡 JSON v2 格式。
- 不改变 `level/导出清单.json` 格式。
- 不重写 Canvas、碰撞或试玩内部接口。
- 不修改 `陨石城堡Demo.html` 和提取出的原版运行时代码。
