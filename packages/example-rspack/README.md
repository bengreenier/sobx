# example-rspack

Minimal example using `@sobx/compiler` with [Rspack](https://rspack.dev/).

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

See `rspack.config.js`: add `sobxCompiler()` from `@sobx/compiler/rspack` to the `plugins` array. Uses `builtin:swc-loader` for TypeScript.
