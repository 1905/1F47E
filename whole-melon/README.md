# Whole Melon

A whole watermelon made of glossy jelly. Grab it, wobble it, and cut it into as many as 24 pieces with a knife.
It's one self-contained HTML file with raw WebGPU (WGSL) and CPU physics. There are no libraries and no build step to run it.

Open `index.html` in a browser with WebGPU (current Chrome, Edge or Safari, or Firefox on Windows).
Without WebGPU, the page shows a fallback card.

## Controls

- **Hand**: drag the melon or any piece. While holding, scroll or add a second finger to twist it. Drag the empty table to orbit. Scroll or pinch to zoom. Double-click resets the view.
- **Knife**: draw a line across the melon and release. The knife lines up over the stroke, presses a groove into the jelly, breaks through and wedges the pieces apart.
- Keys: `Space` pause · `N` nudge · `R` reset · `K` toggle knife · `H` hand.

## How it works

- **Shape**: the melon is a signed distance field, an ellipsoid 32 cm long with a softly flattened belly. Skin, pith and flesh are bands of depth under the surface. Stripes run pole to pole, and there's a field spot, a stem scar and a blossom end.
- **Pieces**: each piece is the melon clipped by its cut half-spaces, with fresh edges rounded by a smooth max. Every piece keeps the original rest frame.
- **Per-piece meshes**: a surface-nets render skin, a hex lattice in the piece's principal frame with boundary nodes snapped to the surface, and a barycentric embedding. Seeds are meshed only near cut faces. A seed the blade passes through stays with one side and settles under a thin film of jelly.
- **Physics**: XPBD at 60 Hz with 6 substeps. 8-node co-rotational shape-matching cells, tet volume constraints, edge damping and damping relative to rigid motion. Rolling resistance, sleeping, SDF contact between pieces, and floor friction.
- **Cutting**: the new pieces are built in a generator with a per-frame time budget while the knife animates. They're swapped in at break-through and inherit the parent's positions and velocities.
- **Rendering**: refraction by view-ray thickness (nearest back face), Beer–Lambert absorption, pith scattering, back-lit edges, sugar glints, a procedural studio with GGX highlights, a key shadow tinted by what the light crosses first, contact occlusion, 4× MSAA and PBR Neutral tone mapping.

## Source

`index.html` is generated. Edit the files in `src/`, then rebuild:

```sh
python3 build.py
```

| File | Contents |
| --- | --- |
| `src/sdf.js` | Melon SDF, piece SDF, seed and bubble layout, sampling |
| `src/build.js` | Lattice, surface nets, seed placement, embedding (generators) |
| `src/physics.js` | `Body` and `World`: the XPBD solver |
| `src/knife.js` | Procedural knife mesh |
| `src/shaders.js` | All WGSL |
| `src/renderer.js` | WebGPU passes |
| `src/main.js` | Camera, picking, cutting, knife choreography, UI |

`?cpu` renders into a texture and copies frames to a 2D canvas. Headless Chromium loses the WebGPU device as soon as a WebGPU canvas context exists, so this is only for automated screenshots.
