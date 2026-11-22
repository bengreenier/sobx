# example-esbuild

Example app using the sobx compiler with **esbuild**. Besides a local store (compiled to a `ProxyLike`), it has an exported, decorator-based class store in another module (`src/todos.ts`), handled by `@sobx/runtime`; `build.mjs` sets `target: "es2022"` so esbuild lowers the standard decorators. Run `pnpm build` from the repo root or from this package.

The source imports from `@sobx/magic`, so the build output is compiled to `@sobx/runtime` (no MobX). Building needs the native analyzer: run `pnpm --filter @sobx/compiler build:native` first (requires a Rust toolchain).
