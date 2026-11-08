# example-rolldown

Example app using the sobx compiler with **Rolldown**. Run `pnpm build` from the repo root or from this package.

The source imports from `@sobx/magic`, so the build output is compiled to `@sobx/runtime` (no MobX). Building needs the native analyzer: run `pnpm --filter @sobx/compiler build:native` first (requires a Rust toolchain).
