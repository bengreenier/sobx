# example-webpack

Minimal example using `@sobx/compiler` with [Webpack](https://webpack.js.org/).

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

See `webpack.config.js`: add `sobxCompiler()` from `@sobx/compiler/webpack` to the `plugins` array. Use `ts-loader` with `compilerOptions: { noEmit: false }` so TypeScript emits when used as a loader.
