#!/usr/bin/env python3
"""Assemble src/ into the single self-contained index.html."""
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "src"
JS = ["sdf.js", "build.js", "physics.js", "knife.js", "shaders.js", "renderer.js", "main.js"]

css = (SRC / "style.css").read_text()
body = (SRC / "body.html").read_text()
js = "\n".join((SRC / f).read_text() for f in JS)
html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Whole Melon</title>
<style>
{css}</style>
</head>
<body>
{body}
<script type="module">
{js}
</script>
</body>
</html>
"""
(ROOT / "index.html").write_text(html)
print(f"index.html: {len(html.encode()) // 1024} KB")
