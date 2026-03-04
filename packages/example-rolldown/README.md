# example-rolldown

Minimal example using `@sobx/compiler` with [Rolldown](https://rolldown.rs/).

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

See `rolldown.config.js`: add `sobxCompiler()` from `@sobx/compiler/rolldown` to the `plugins` array.
