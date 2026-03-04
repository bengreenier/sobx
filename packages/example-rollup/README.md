# example-rollup

Minimal example using `@sobx/compiler` with [Rollup](https://rollupjs.org/).

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

See `rollup.config.js`: add `sobxCompiler()` from `@sobx/compiler/rollup` to the `plugins` array.
