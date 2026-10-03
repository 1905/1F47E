#!/usr/bin/env python3
"""Assemble the three levels into linked single-file pages, each with the level switcher.

  slice.html  Level 1  Melon Jelly (melon-jelly/, WebGPU)
  index.html  Level 2  Whole Melon (whole-melon/, WebGPU)
  fugu.html   Level 3  Fugu Jelly  (fugu-jelly/, WebGL via three.js)
"""
import re
import runpy
from pathlib import Path

HERE = Path(__file__).parent
REPO = HERE.parent
SWITCHER = (HERE / "switcher.html").read_text()


def with_switcher(html: str, level: int) -> str:
    nav = SWITCHER.replace('id="levels"', f'id="levels" data-current="{level}"', 1)
    i = html.rindex("</body>")
    return html[:i] + nav + html[i:]


def slice_page() -> str:
    """melon-jelly is ES modules; inline them into one module script (imports dropped, exports unwrapped)."""
    src = REPO / "melon-jelly"
    order = ["geometry", "knife", "pieces", "physics", "shaders", "renderer", "main"]
    parts = []
    for name in order:
        js = (src / "src" / f"{name}.js").read_text()
        js = re.sub(r"^import \{[^}]*\} from '\./[a-z]+\.js';\n", "", js, flags=re.M)
        js = re.sub(r"^export (?=(async\s+)?(function|const|let|class)\b)", "", js, flags=re.M)
        parts.append(f"// ===== {name}.js =====\n{js}")
    html = (src / "index.html").read_text()
    css = (src / "style.css").read_text()
    html = html.replace('<link rel="stylesheet" href="style.css">', f"<style>\n{css}</style>")
    html = html.replace('<script type="module" src="src/main.js"></script>', '<script type="module">\n' + "\n".join(parts) + "</script>")
    assert "src/main.js" not in html and "style.css" not in html
    return html


def main():
    runpy.run_path(str(REPO / "whole-melon" / "build.py"), run_name="__main__")
    pages = {
        "slice.html": (slice_page(), 1),
        "index.html": ((REPO / "whole-melon" / "index.html").read_text(), 2),
        "fugu.html": ((REPO / "fugu-jelly" / "index.html").read_text(), 3),
    }
    for name, (html, level) in pages.items():
        out = with_switcher(html, level)
        (HERE / name).write_text(out)
        print(f"{name}: level {level}, {len(out.encode()) // 1024} KB")


if __name__ == "__main__":
    main()
