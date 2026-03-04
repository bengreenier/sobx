# example-vite

Minimal example using `@sobx/compiler` with [Vite](https://vitejs.dev/).

## Setup

From repo root, build core and compiler first:

```bash
pnpm --filter @sobx/core build && pnpm --filter @sobx/compiler build
```

## Run

```bash
pnpm dev    # dev server
pnpm build  # production build
```

## Integration

See `vite.config.ts`: add `sobxCompiler()` from `@sobx/compiler/vite` to the `plugins` array.
