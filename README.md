# 图片差异化生成与人工审核平台（首版）

无需安装第三方依赖，需要 Python 3.9+ 和 Chrome。

- Windows：双击 `start-windows.bat`
- macOS：首次执行 `chmod +x start-macos.command`，之后双击它
- 通用：`python start.py`（也可加 `--project "项目数据路径"`）

服务固定运行在 `http://127.0.0.1:4173`。首次打开后输入项目数据目录的绝对路径。

导入原图：

```text
python import_images.py "散乱原图目录" "项目数据目录"
```

运行测试：

```text
python -m unittest discover -s tests -v
```
