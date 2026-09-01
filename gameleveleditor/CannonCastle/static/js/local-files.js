function invalidPath(path) {
  const error = new Error(`路径必须位于可执行文件目录内：${path}`);
  error.code = "INVALID_PATH";
  return error;
}

function relativePath(path) {
  if (typeof path !== "string" || !path || path.includes("\\")) throw invalidPath(path);
  if (path.startsWith("/") || /^[a-zA-Z]:\//.test(path)) throw invalidPath(path);
  if (path.split("/").some(part => part === "..")) throw invalidPath(path);
  return path;
}

export class LocalFiles {
  constructor(api = globalThis.window?.pywebview?.api?.files) {
    if (!api) throw new Error("本地文件 API 尚未就绪");
    this.api = api;
  }
  async call(method, ...args) {
    const result = await this.api[method](...args);
    if (!result.ok) { const error = new Error(result.error.message); error.code = result.error.code; throw error; }
    return result.data;
  }
  list(path = ".") { return this.call("list_dir", relativePath(path)); }
  readText(path) { return this.call("read_text", relativePath(path)); }
  readBase64(path) { return this.call("read_base64", relativePath(path)); }
  writeText(path, content, overwrite = true) { return this.call("write_text", relativePath(path), content, overwrite); }
  writeBase64(path, content, overwrite = true) { return this.call("write_base64", relativePath(path), content, overwrite); }
  mkdir(path, parents = false) { return this.call("mkdir", relativePath(path), parents); }
  remove(path, recursive = false) { return this.call("delete", relativePath(path), recursive); }
}

export function waitForLocalFiles(target = globalThis.window) {
  if (!target?.addEventListener) throw new Error("当前环境不支持 pywebviewready");
  return new Promise(resolve => target.addEventListener("pywebviewready", () => resolve(new LocalFiles(target.pywebview?.api?.files)), { once: true }));
}
