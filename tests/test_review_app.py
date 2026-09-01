import json
import tempfile
import time
import unittest
from pathlib import Path

from import_images import import_images
from review_app.server import apply_action, backup_db, connect, export_accepted, init_project, list_items, undo


class WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.source = self.base / "source"
        self.project = self.base / "project"
        self.source.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_import_dedup_review_redo_version_and_export(self):
        for name, data in [("a2.png", b"png-two"), ("a10.jpg", b"jpg-ten"), ("copy.png", b"png-two")]:
            (self.source / name).write_bytes(data)
        self.assertEqual(import_images(self.source, self.project), {"新增": 2, "跳过重复": 1, "无法读取": 0})
        self.assertEqual(import_images(self.source, self.project), {"新增": 0, "跳过重复": 3, "无法读取": 0})
        manifest = json.loads((self.project / ".review/import_manifest.json").read_text(encoding="utf-8"))
        self.assertEqual([x["image_id"] for x in manifest["items"]], ["000001", "000002"])

        modified = self.project / "修改图/000001/000001_v001.png"
        modified.write_bytes(b"version-one")
        time.sleep(1.05)
        self.assertEqual(len(list_items(self.project)), 1)
        apply_action(self.project, {"op_id": "op-redo", "image_id": "000001", "action": "redo", "reason": "构图不佳"})
        apply_action(self.project, {"op_id": "op-redo", "image_id": "000001", "action": "redo", "reason": "重复提交"})
        self.assertEqual(len(list_items(self.project, "redo")), 1)
        queue = json.loads((self.project / ".review/redo_queue.json").read_text(encoding="utf-8"))
        self.assertEqual(queue[0]["reason"], "构图不佳")

        time.sleep(1.05)
        (self.project / "修改图/000001/000001_v002.png").write_bytes(b"version-two")
        time.sleep(1.05)
        pending = list_items(self.project)
        self.assertEqual((pending[0]["current_version"], pending[0]["status"]), (2, "pending"))
        apply_action(self.project, {"op_id": "op-ok", "image_id": "000001", "action": "accept"})
        self.assertTrue(undo(self.project)["ok"])
        apply_action(self.project, {"op_id": "op-ok-2", "image_id": "000001", "action": "accept"})
        stale = self.project / "审核通过的成品/000001/000001.jpg"
        stale.write_bytes(b"stale")
        self.assertEqual(export_accepted(self.project)["exported"], 1)
        self.assertEqual((self.project / "审核通过的成品/000001/000001.png").read_bytes(), b"version-two")
        self.assertFalse(stale.exists())
        self.assertEqual(export_accepted(self.project)["exported"], 0)

        backup_db(self.project)
        self.assertTrue(any((self.project / ".review/backups").glob("review-*.db")))
        with connect(self.project) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM operations").fetchone()[0], 3)

    def test_numbering_more_than_one_hundred_images(self):
        for number in range(103):
            (self.source / f"image-{number}.png").write_bytes(f"image-{number}".encode())
        self.assertEqual(import_images(self.source, self.project)["新增"], 103)
        self.assertTrue((self.project / "原图/000001/000001.png").is_file())
        self.assertTrue((self.project / "原图/000011/000103.png").is_file())
        self.assertTrue((self.project / "修改图/000011").is_dir())
        self.assertTrue((self.project / "审核通过的成品/000011").is_dir())


if __name__ == "__main__":
    unittest.main()
