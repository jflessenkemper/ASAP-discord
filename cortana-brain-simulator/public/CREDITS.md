# Asset credits

## cortex.glb

- **Source:** https://github.com/Losses/open-brain (file: `surface/pialCortex.stl`)
- **License:** MIT + Creative Commons Public Domain (dual). Owner explicitly waives rights and grants free use, modification, and redistribution.
- **Origin:** MRI scan of a real human brain, surface extracted via BrainSuite, exported as ASCII STL.
- **Modifications applied here:**
  - Converted ASCII STL → binary GLB via `assimp export`.
  - Decimated from ~540k triangles to ~108k triangles (≈80% reduction) using `@gltf-transform/cli simplify` with meshoptimizer (ratio 0.2, error 0.005).
  - Translated/scaled at runtime to fit the simulator scene's coordinate frame.
- **Credit (not required):** "MRI by Losses Don, open-brain project."
