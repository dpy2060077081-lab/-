# JavaScript 本地文件 API 接口文档

应用通过 pywebview 向 `index.html` 暴露异步本地文件接口：

```js
window.pywebview.api.files
```

所有方法都返回 `Promise`，必须等待 `pywebviewready` 事件后调用：

```js
window.addEventListener('pywebviewready', async () => {
  const files = window.pywebview.api.files;
  const result = await files.list_dir('.');
  console.log(result);
});
```

## 安全范围

所有路径均以 exe 所在目录为根目录，只接受相对路径。

允许：

```text
.
levels
levels/level-1.json
assets/images/tile.png
```

禁止：

```text
C:\Windows\system.ini
D:\data\file.json
/absolute/path
../outside
```

路径解析后的实际位置也必须位于 exe 同级目录内，不能利用符号链接、junction 或 `..` 访问外部文件。

## 统一返回结构

成功：

```json
{
  "ok": true,
  "data": {}
}
```

失败：

```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "文件或目录不存在"
  }
}
```

推荐始终检查 `ok`：

```js
const result = await window.pywebview.api.files.read_text('levels/level-1.json');

if (result.ok) {
  console.log(result.data.content);
} else {
  console.error(result.error.code, result.error.message);
}
```

## 1. 获取目录列表

```js
files.list_dir(path = '.')
```

参数：

- `path`：相对目录路径，默认为 `.`，表示 exe 同级目录。

示例：

```js
const result = await files.list_dir('levels');
```

成功返回：

```json
{
  "ok": true,
  "data": {
    "path": "levels",
    "entries": [
      {
        "name": "level-1.json",
        "type": "file",
        "size": 1024
      },
      {
        "name": "images",
        "type": "directory",
        "size": 0
      }
    ]
  }
}
```

`type` 可能是 `file` 或 `directory`。目录项按名称排序。

## 2. 获取文件或目录信息

```js
files.stat(path)
```

示例：

```js
const result = await files.stat('levels/level-1.json');
```

成功返回：

```json
{
  "ok": true,
  "data": {
    "path": "levels/level-1.json",
    "type": "file",
    "size": 1024,
    "modified": 1786612345.123
  }
}
```

字段：

- `type`：`file` 或 `directory`。
- `size`：字节数。
- `modified`：Unix 修改时间戳，单位为秒。

转换为 JavaScript 日期：

```js
const date = new Date(result.data.modified * 1000);
```

## 3. 读取 UTF-8 文本

```js
files.read_text(path)
```

示例：

```js
const result = await files.read_text('levels/level-1.json');

if (result.ok) {
  const level = JSON.parse(result.data.content);
}
```

成功返回：

```json
{
  "ok": true,
  "data": {
    "path": "levels/level-1.json",
    "content": "{\"name\":\"第一关\"}"
  }
}
```

限制：

- 文件必须是有效的 UTF-8 文本。
- 单次读取上限为 32 MiB。
- 二进制文件应使用 `read_base64()`。

## 4. 读取二进制文件

```js
files.read_base64(path)
```

示例：

```js
const result = await files.read_base64('assets/tile.png');

if (result.ok) {
  const imageUrl = `data:image/png;base64,${result.data.content}`;
  document.querySelector('img').src = imageUrl;
}
```

成功返回：

```json
{
  "ok": true,
  "data": {
    "path": "assets/tile.png",
    "content": "iVBORw0KGgoAAA..."
  }
}
```

单次读取上限为 32 MiB。

Base64 转换为 `Uint8Array`：

```js
function base64ToBytes(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
```

## 5. 写入 UTF-8 文本

```js
files.write_text(path, content, overwrite = true)
```

参数：

- `path`：目标相对路径。
- `content`：字符串内容。
- `overwrite`：目标存在时是否覆盖，默认为 `true`。

示例：

```js
const level = {
  name: '第一关',
  width: 20,
  height: 12
};

const result = await files.write_text(
  'levels/level-1.json',
  JSON.stringify(level, null, 2),
  true
);
```

成功返回：

```json
{
  "ok": true,
  "data": {
    "path": "levels/level-1.json",
    "size": 58
  }
}
```

注意：

- 父目录必须已经存在。
- 写入采用同目录临时文件和原子替换。
- `overwrite=false` 且目标已存在时返回 `ALREADY_EXISTS`。

## 6. 写入二进制文件

```js
files.write_base64(path, content, overwrite = true)
```

`content` 必须是有效的 Base64 字符串。

示例：

```js
const response = await fetch(imageUrl);
const blob = await response.blob();

const base64 = await new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.split(',')[1]);
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

const result = await files.write_base64(
  'assets/tile.png',
  base64,
  true
);
```

成功返回：

```json
{
  "ok": true,
  "data": {
    "path": "assets/tile.png",
    "size": 4096
  }
}
```

## 7. 创建目录

```js
files.mkdir(path, parents = false)
```

参数：

- `path`：目标目录。
- `parents`：是否自动创建缺失的父目录。

创建单层目录：

```js
await files.mkdir('levels', false);
```

递归创建：

```js
await files.mkdir('project/assets/images', true);
```

成功返回：

```json
{
  "ok": true,
  "data": {
    "path": "project/assets/images"
  }
}
```

目标已存在时返回 `ALREADY_EXISTS`。

## 8. 移动或重命名

```js
files.move(source, destination, overwrite = false)
```

参数：

- `source`：源相对路径。
- `destination`：目标相对路径。
- `overwrite`：目标存在时是否覆盖，默认为 `false`。

重命名：

```js
await files.move(
  'levels/level-1.json',
  'levels/tutorial.json',
  false
);
```

移动：

```js
await files.move(
  'draft.json',
  'levels/draft.json',
  false
);
```

成功返回：

```json
{
  "ok": true,
  "data": {
    "source": "draft.json",
    "destination": "levels/draft.json"
  }
}
```

源路径和目标路径都会执行相同的安全检查。

## 9. 删除文件或目录

```js
files.delete(path, recursive = false)
```

删除文件：

```js
await files.delete('levels/old.json', false);
```

删除空目录：

```js
await files.delete('levels/empty', false);
```

递归删除非空目录：

```js
await files.delete('cache', true);
```

成功返回：

```json
{
  "ok": true,
  "data": {
    "path": "cache"
  }
}
```

注意：

- 非空目录必须明确传入 `recursive=true`。
- 不允许删除应用根目录。
- 递归删除不可撤销，调用前应向用户确认。

## 常见错误代码

| 错误代码 | 含义 |
|---|---|
| `INVALID_ARGUMENT` | 参数类型或内容无效 |
| `PATH_OUTSIDE_ROOT` | 路径为绝对路径、盘符路径或超出 exe 目录 |
| `NOT_FOUND` | 文件或目录不存在 |
| `ALREADY_EXISTS` | 目标已经存在 |
| `PERMISSION_DENIED` | Windows 拒绝文件操作 |
| `INVALID_ENCODING` | 文件不是有效的 UTF-8 文本 |
| `INVALID_BASE64` | Base64 数据格式无效 |
| `FILE_TOO_LARGE` | 文件超过 32 MiB 读取上限 |
| `DIRECTORY_NOT_EMPTY` | 删除非空目录时未指定递归 |
| `IO_ERROR` | 其他本地文件系统错误 |

## 推荐封装

```js
class LocalFiles {
  constructor() {
    this.api = window.pywebview.api.files;
  }

  async call(method, ...args) {
    const result = await this.api[method](...args);

    if (!result.ok) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      throw error;
    }

    return result.data;
  }

  list(path = '.') {
    return this.call('list_dir', path);
  }

  stat(path) {
    return this.call('stat', path);
  }

  readText(path) {
    return this.call('read_text', path);
  }

  readBase64(path) {
    return this.call('read_base64', path);
  }

  writeText(path, content, overwrite = true) {
    return this.call('write_text', path, content, overwrite);
  }

  writeBase64(path, content, overwrite = true) {
    return this.call('write_base64', path, content, overwrite);
  }

  mkdir(path, parents = false) {
    return this.call('mkdir', path, parents);
  }

  move(source, destination, overwrite = false) {
    return this.call('move', source, destination, overwrite);
  }

  remove(path, recursive = false) {
    return this.call('delete', path, recursive);
  }
}

window.addEventListener('pywebviewready', async () => {
  const files = new LocalFiles();

  try {
    const { entries } = await files.list('levels');
    console.log(entries);
  } catch (error) {
    console.error(error.code, error.message);
  }
});
```

