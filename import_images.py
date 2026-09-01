#!/usr/bin/env python3
"""将散乱图片复制并编号到项目数据/原图；不移动、不覆盖源文件。"""
import argparse
import hashlib
import json
import os
import re
import shutil
import uuid
from pathlib import Path

from review_app.server import IMAGE_EXTS, atomic_json, init_project


def natural_key(path, base):
    text = path.relative_to(base).as_posix().casefold()
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", text)]


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def import_images(source, project):
    source, project = Path(source).expanduser().resolve(), init_project(Path(project))
    if not source.is_dir():
        raise ValueError(f"源目录不存在：{source}")
    manifest_path = project / ".review" / "import_manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        manifest = {"version": 1, "items": []}
    known = {x["sha256"] for x in manifest["items"]}
    max_id = max((int(x["image_id"]) for x in manifest["items"]), default=0)
    for existing in (project / "原图").glob("*/*"):
        if existing.is_file() and re.fullmatch(r"\d{6}", existing.stem) and existing.suffix.lower() in IMAGE_EXTS:
            max_id = max(max_id, int(existing.stem))
            try:
                known.add(digest(existing))
            except OSError:
                pass
    files = []
    for path in source.rglob("*"):
        if path.is_file() and path.suffix.lower() in IMAGE_EXTS:
            try:
                path.resolve().relative_to(project)
            except ValueError:
                files.append(path)
    files.sort(key=lambda p: natural_key(p, source))
    report = {"新增": 0, "跳过重复": 0, "无法读取": 0}
    for path in files:
        try:
            fingerprint = digest(path)
            if fingerprint in known:
                report["跳过重复"] += 1
                continue
            max_id += 1
            image_id = f"{max_id:06d}"
            folder = f"{(max_id - 1) // 10 + 1:06d}"
            target_dir = project / "原图" / folder
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / (image_id + path.suffix.lower())
            if target.exists():
                raise FileExistsError(f"拒绝覆盖已有原图：{target}")
            temp = target.with_name(target.name + ".tmp-" + uuid.uuid4().hex)
            shutil.copy2(path, temp)
            os.replace(temp, target)
            manifest["items"].append({"source": str(path), "source_relative": path.relative_to(source).as_posix(),
                                      "sha256": fingerprint, "image_id": image_id, "folder": folder,
                                      "format": path.suffix.lower().lstrip("."), "target": target.relative_to(project).as_posix()})
            known.add(fingerprint)
            report["新增"] += 1
        except (OSError, ValueError):
            report["无法读取"] += 1
    atomic_json(manifest_path, manifest)
    for name in ("修改图", "审核通过的成品"):
        for item in manifest["items"]:
            (project / name / item["folder"]).mkdir(parents=True, exist_ok=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="原始图片所在目录")
    parser.add_argument("project", help="项目数据目录")
    args = parser.parse_args()
    print(json.dumps(import_images(args.source, args.project), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
