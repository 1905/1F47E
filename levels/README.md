# Jelly Studio

Three jelly studies in one studio bar. The bar has the level links, a render preset picker and a live frame rate. It sits beside the status pill on wide screens and floats at the bottom on phones. Keys `1` `2` `3` switch levels, and the chosen preset carries over between levels.

| Preset | Resolution | Melon levels (WebGPU) | Fugu (WebGL) |
| --- | --- | --- | --- |
| Studio | up to 2× | 4× MSAA, 16 shadow taps, 3 AO rings, 7 refraction taps | soft VSM shadows, transmission, dispersion |
| Balanced | 1× | 4× MSAA, 8 / 2 / 4 taps, 1024 shadow map | soft shadows (fewer samples), transmission |
| Lite | 0.75× | no MSAA, 4 / 1 / 2 taps, 768 shadow map | plain PCF shadows, transmission |
| Minimal | 0.5× | no MSAA, 1 / 0 / 1 taps, 512 shadow map | plain shadows, no transmission |

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
