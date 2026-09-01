#!/usr/bin/env python3
import argparse
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from contextlib import contextmanager
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

HOST, PORT = "127.0.0.1", 4173
APP_DIR = Path(__file__).resolve().parent
APP_SETTINGS = APP_DIR / ".last-project.json"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
ORIGINAL_RE = re.compile(r"^(\d{6})$")
MODIFIED_RE = re.compile(r"^(\d{6})_v(\d{3,})$")
DEFAULT_REASONS = ["主体或结构不合理", "风格不符", "文字或 Logo 错误", "构图不佳", "明显生成瑕疵", "与原图差异不足"]


def now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


def project_dirs(root):
    return {name: root / name for name in ("原图", "修改图", "审核通过的成品")}


def init_project(root):
    root = root.expanduser().resolve()
    for path in project_dirs(root).values():
        path.mkdir(parents=True, exist_ok=True)
    review = root / ".review"
    (review / "backups").mkdir(parents=True, exist_ok=True)
    settings = review / "settings.json"
    if not settings.exists():
        atomic_json(settings, {"redo_reasons": DEFAULT_REASONS})
    try:
        init_db(review / "review.db")
    except sqlite3.DatabaseError:
        backups = sorted((review / "backups").glob("review-*.db"))
        if not backups:
            raise
        broken = review / ("review.corrupt-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".db")
        os.replace(review / "review.db", broken)
        temp = review / "review.db.restore-tmp"
        shutil.copy2(backups[-1], temp)
        os.replace(temp, review / "review.db")
        init_db(review / "review.db")
    return root


@contextmanager
def connect(root):
    db = sqlite3.connect(root / ".review" / "review.db", timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    try:
        yield db
    finally:
        db.close()


def init_db(path):
    with sqlite3.connect(path) as db:
        db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS items (
          image_id TEXT PRIMARY KEY, folder TEXT NOT NULL, original_path TEXT NOT NULL,
          current_path TEXT NOT NULL, current_version INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', reason TEXT, exported INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS operations (
          op_id TEXT PRIMARY KEY, image_id TEXT NOT NULL, action TEXT NOT NULL,
          previous_status TEXT NOT NULL, previous_reason TEXT, previous_exported INTEGER NOT NULL,
          undone INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
        """)
    # sqlite3.Connection's context manager commits but does not close on every Python version.
    db.close()


def backup_db(root):
    source = root / ".review" / "review.db"
    if not source.exists():
        return
    backups = root / ".review" / "backups"
    target = backups / (datetime.now().strftime("review-%Y%m%d-%H%M%S-%f") + ".db")
    src, dst = sqlite3.connect(source), sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    for old in sorted(backups.glob("review-*.db"))[:-10]:
        old.unlink()


def safe_rel(path, base):
    path = path.resolve()
    base = base.resolve()
    try:
        return path.relative_to(base).as_posix()
    except ValueError:
        raise ValueError("路径越界")


def scan_project(root, stable_seconds=1.0):
    originals, modified = {}, {}
    dirs = project_dirs(root)
    for file in dirs["原图"].glob("*/*"):
        if not file.is_file() or file.suffix.lower() not in IMAGE_EXTS:
            continue
        if not re.fullmatch(r"\d{6}", file.parent.name) or not ORIGINAL_RE.fullmatch(file.stem):
            continue
        originals[(file.parent.name, file.stem)] = file
    threshold = time.time() - stable_seconds
    for file in dirs["修改图"].glob("*/*"):
        match = MODIFIED_RE.fullmatch(file.stem)
        if (not file.is_file() or file.suffix.lower() not in IMAGE_EXTS or not match
                or not re.fullmatch(r"\d{6}", file.parent.name) or file.stat().st_mtime > threshold):
            continue
        key = (file.parent.name, match.group(1))
        version = int(match.group(2))
        if key not in modified or version > modified[key][0]:
            modified[key] = (version, file)
    with connect(root) as db:
        for key, (version, current) in modified.items():
            original = originals.get(key)
            if not original:
                continue
            image_id = key[1]
            row = db.execute("SELECT current_version,status FROM items WHERE image_id=?", (image_id,)).fetchone()
            original_rel = safe_rel(original, root)
            current_rel = safe_rel(current, root)
            if row is None:
                db.execute("INSERT INTO items VALUES(?,?,?,?,?,'pending',NULL,0,?)",
                           (image_id, key[0], original_rel, current_rel, version, now()))
            elif version > row["current_version"]:
                status = "pending" if row["status"] == "redo" else row["status"]
                reason = None if status == "pending" else db.execute(
                    "SELECT reason FROM items WHERE image_id=?", (image_id,)).fetchone()[0]
                db.execute("UPDATE items SET current_path=?,current_version=?,status=?,reason=?,updated_at=? WHERE image_id=?",
                           (current_rel, version, status, reason, now(), image_id))
        db.commit()
    write_redo_queue(root)


def write_redo_queue(root):
    with connect(root) as db:
        rows = db.execute("SELECT image_id,folder,original_path,current_path,current_version,reason,updated_at "
                          "FROM items WHERE status='redo' ORDER BY image_id").fetchall()
    atomic_json(root / ".review" / "redo_queue.json", [dict(row) for row in rows])


def list_items(root, status="pending"):
    scan_project(root)
    with connect(root) as db:
        rows = db.execute("SELECT * FROM items WHERE status=? AND exported=0 ORDER BY image_id", (status,)).fetchall()
    return [dict(row) for row in rows]


def apply_action(root, payload):
    op_id = str(payload.get("op_id", ""))
    image_id = str(payload.get("image_id", ""))
    action = payload.get("action")
    if not op_id or action not in {"accept", "redo", "reject"}:
        raise ValueError("无效操作")
    status = {"accept": "accepted", "redo": "redo", "reject": "rejected"}[action]
    with connect(root) as db:
        if db.execute("SELECT 1 FROM operations WHERE op_id=?", (op_id,)).fetchone():
            return {"duplicate": True}
        row = db.execute("SELECT status,reason,exported FROM items WHERE image_id=?", (image_id,)).fetchone()
        if not row:
            raise ValueError("图片不存在")
        db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?,0,?)",
                   (op_id, image_id, action, row["status"], row["reason"], row["exported"], now()))
        db.execute("UPDATE items SET status=?,reason=?,exported=0,updated_at=? WHERE image_id=?",
                   (status, payload.get("reason") if status == "redo" else None, now(), image_id))
        db.commit()
    write_redo_queue(root)
    return {"ok": True}


def undo(root):
    with connect(root) as db:
        row = db.execute("SELECT * FROM operations WHERE undone=0 ORDER BY rowid DESC LIMIT 1").fetchone()
        if not row:
            return {"ok": False, "message": "没有可撤销的操作"}
        db.execute("UPDATE items SET status=?,reason=?,exported=?,updated_at=? WHERE image_id=?",
                   (row["previous_status"], row["previous_reason"], row["previous_exported"], now(), row["image_id"]))
        db.execute("UPDATE operations SET undone=1 WHERE op_id=?", (row["op_id"],))
        db.commit()
    write_redo_queue(root)
    return {"ok": True, "image_id": row["image_id"]}


def export_accepted(root):
    dirs = project_dirs(root)
    with connect(root) as db:
        rows = db.execute("SELECT image_id,folder,current_path FROM items WHERE status='accepted' AND exported=0 ORDER BY image_id").fetchall()
        staged = []
        try:
            for row in rows:
                source = (root / row["current_path"]).resolve()
                safe_rel(source, dirs["修改图"])
                target_dir = dirs["审核通过的成品"] / row["folder"]
                target_dir.mkdir(parents=True, exist_ok=True)
                target = target_dir / (row["image_id"] + source.suffix.lower())
                temp = target.with_name(target.name + ".tmp-" + uuid.uuid4().hex)
                shutil.copy2(source, temp)
                staged.append((temp, target, row["image_id"]))
            for temp, target, _ in staged:
                displaced = []
                for old in target.parent.glob(target.stem + ".*"):
                    if old != temp and old != target and old.suffix.lower() in IMAGE_EXTS:
                        saved = old.with_name(old.name + ".replace-backup-" + uuid.uuid4().hex)
                        os.replace(old, saved)
                        displaced.append((saved, old))
                try:
                    os.replace(temp, target)
                except Exception:
                    for saved, old in displaced:
                        os.replace(saved, old)
                    raise
                for saved, _ in displaced:
                    saved.unlink(missing_ok=True)
            db.executemany("UPDATE items SET exported=1,updated_at=? WHERE image_id=?", [(now(), x[2]) for x in staged])
            db.commit()
        except Exception:
            for temp, _, _ in staged:
                temp.unlink(missing_ok=True)
            raise
    return {"exported": len(staged)}


class App:
    def __init__(self, project=None):
        self.lock = threading.RLock()
        self.project = None
        if project:
            self.set_project(project)
        elif APP_SETTINGS.exists():
            try:
                candidate = Path(json.loads(APP_SETTINGS.read_text(encoding="utf-8"))["project"])
                if candidate.exists():
                    self.set_project(candidate)
            except Exception:
                pass

    def set_project(self, path):
        with self.lock:
            self.project = init_project(Path(path))
            backup_db(self.project)
            scan_project(self.project, 0)
            atomic_json(APP_SETTINGS, {"project": str(self.project)})


APP = App()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def json_body(self):
        size = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(size) or b"{}")

    def send_json(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path):
        if not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def require_project(self):
        if not APP.project:
            raise ValueError("请先选择项目数据目录")
        return APP.project

    def do_GET(self):
        try:
            path = urlparse(self.path).path
            if path == "/api/project":
                self.send_json({"project": str(APP.project) if APP.project else None})
            elif path == "/api/items":
                self.send_json({"items": list_items(self.require_project(), "pending")})
            elif path == "/api/redo":
                self.send_json({"items": list_items(self.require_project(), "redo")})
            elif path == "/api/settings":
                root = self.require_project()
                self.send_json(json.loads((root / ".review" / "settings.json").read_text(encoding="utf-8")))
            elif path.startswith("/image/"):
                root = self.require_project()
                rel = unquote(path[len("/image/"):])
                target = (root / rel).resolve()
                safe_rel(target, root)
                self.send_file(target)
            else:
                name = "index.html" if path in {"/", ""} else path.lstrip("/")
                target = (APP_DIR / "web" / name).resolve()
                safe_rel(target, APP_DIR / "web")
                self.send_file(target)
        except (ValueError, OSError, sqlite3.Error, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)

    def do_POST(self):
        try:
            path, payload = urlparse(self.path).path, self.json_body()
            if path == "/api/project":
                APP.set_project(payload["path"])
                result = {"project": str(APP.project)}
            elif path == "/api/action":
                result = apply_action(self.require_project(), payload)
            elif path == "/api/undo":
                result = undo(self.require_project())
            elif path == "/api/export":
                result = export_accepted(self.require_project())
            elif path == "/api/settings":
                reasons = payload.get("redo_reasons")
                if not isinstance(reasons, list) or not all(isinstance(x, str) and x.strip() for x in reasons):
                    raise ValueError("原因列表无效")
                atomic_json(self.require_project() / ".review" / "settings.json", {"redo_reasons": reasons})
                result = {"ok": True}
            else:
                self.send_error(404)
                return
            self.send_json(result)
        except (KeyError, ValueError, OSError, sqlite3.Error, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)


def open_chrome(url):
    candidates = []
    if sys.platform == "win32":
        candidates = [Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe",
                      Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe",
                      Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe"]
    elif sys.platform == "darwin":
        candidates = [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
    for chrome in candidates:
        if chrome.is_file():
            subprocess.Popen([str(chrome), url])
            return
    webbrowser.open(url)


def main():
    parser = argparse.ArgumentParser(description="图片审核平台")
    parser.add_argument("--project", help="项目数据目录")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if args.project:
        APP.set_project(args.project)
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as exc:
        print(f"无法启动：{HOST}:{PORT} 已被占用或不可用（{exc}）", file=sys.stderr)
        raise SystemExit(2)
    url = f"http://{HOST}:{PORT}"
    print(f"图片审核平台已启动：{url}")
    if not args.no_browser:
        threading.Timer(.4, open_chrome, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
