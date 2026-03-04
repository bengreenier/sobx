# example-esbuild

Minimal example using `@sobx/compiler` with [esbuild](https://esbuild.github.io/).

## Setup

From repo root, build core and compiler first:

```bash
pnpm --filter @sobx/core build && pnpm --filter @sobx/compiler build
```

## Run

```bash
pnpm build
node dist/index.js
```

## Integration

See `build.mjs`: pass `sobxCompiler()` from `@sobx/compiler/esbuild` in the `plugins` array to `esbuild.build()`.
