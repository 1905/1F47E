# Melon Jelly

An interactive, soft-body watermelon jelly slice you can grab, stretch and cut with a knife.
Rendered with WebGPU, simulated on the CPU with XPBD tetrahedral physics.

Recreated from the "Melon Jelly Knife" artifact: https://claude.ai/artifact/RiTbBMEqgfNwgMHMTAhf5P

## Run

ES modules don't load from `file://`, so serve the folder:

```sh
cd melon-jelly
python3 -m http.server 8000
# open http://localhost:8000
```

Needs a browser with WebGPU (current Chrome / Edge / Safari, or Firefox on Windows).

## Controls

- **Hand**: drag the slice to stretch it. Scroll (or add a second finger) while holding to twist it. Drag empty space to orbit, scroll to zoom, double-click to reset the view.
- **Knife**: draw a line across the slice and release to cut. Pieces can be cut again (up to 14).
- Keys: `Space` pause · `N` nudge · `R` reset · `K` toggle knife · `H` hand.

## Layout

| File | What it does |
| --- | --- |
| `src/geometry.js` | Wedge shape SDF, Delaunay, tetrahedral sim mesh, barycentric embedding |
| `src/pieces.js` | Convex piece outlines, splitting along a cut, per-piece sim/render meshes |
| `src/physics.js` | `SoftBody`: XPBD co-rotational tets, volume constraints, grab, floor friction, edge damping, piece collisions |
| `src/knife.js` | Procedural nakiri knife mesh |
| `src/shaders.js` | WGSL: studio environment, PCSS shadows, contact AO, refractive Beer–Lambert jelly, tone mapping |
| `src/renderer.js` | WebGPU passes: shadow map, height map, scene, back-face depth, jelly, post |
| `src/main.js` | Camera, picking, cut choreography, UI wiring, main loop |
