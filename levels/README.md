# Jelly levels

Three material studies, linked by a level switcher. It sits beside the status pill on wide screens and floats at the bottom on phones. Keys `1` `2` `3` also switch levels.

| Page | Level | Source | Renderer |
| --- | --- | --- | --- |
| `slice.html` | 1 · Slice | `../melon-jelly` | WebGPU |
| `index.html` | 2 · Whole | `../whole-melon` | WebGPU |
| `fugu.html` | 3 · Fugu | `../fugu-jelly` | WebGL (three.js 0.170 from jsDelivr) |

The pages are generated, so don't edit them by hand. Change the sources or `switcher.html`, then run:

```sh
python3 levels/build.py
```

Serve the folder (`python3 -m http.server -d levels`) so the links between pages resolve.
