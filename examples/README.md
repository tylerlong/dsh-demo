# examples — archived DSH-harness demos

This directory holds pre-product DSH-harness experiments. Each demo is
self-contained: it ships its own frozen copy of a generic DSH-harness boot
(`boot.ts`) and shares no code with the `harness-workflow` product in `src/`,
so editing or deleting product code can never touch these, and vice versa.
They remain on disk and greppable as the in-repo reference for the harness
agent/streaming API.

Run them with the re-pointed package scripts:

- `pnpm demo` — the first standalone demo (`examples/index.ts`)
- `pnpm enhanced` — the enhanced dev-flow demo (`examples/enhanced-flow.ts`)

Both resolve their demo-only configuration (`dsh-demo.config.json`,
`settings.yaml`) from the repository root, which are untracked and gitignored;
with neither present, every location falls back to the shared harness home.

These are archived reference snippets, not maintained for `harness-workflow`
use. Keep them frozen and out of the product surface.
