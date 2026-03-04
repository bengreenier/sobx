# sobx

Dual-licensed under **MIT** and **Apache-2.0**. See [LICENSE-MIT](./LICENSE-MIT) and [LICENSE-Apache-2.0](./LICENSE-Apache-2.0).

**Not production-ready.** These packages are in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release (version without the alpha suffix).

Packages in this repo:

| Package | Description |
|---------|-------------|
| [**@sobx/core**](./packages/core) | Observable proxy runtime (`ProxyLike`) |
| [**sobx**](./packages/sobx) | Virtual MobX-compatible API (compile-time; use with the compiler) |
| [**@sobx/compiler**](./packages/sobx-compiler) | Compiler and bundler plugins (Vite, Rollup, Webpack, esbuild, Rolldown, Rspack) |
| [example-esbuild](./packages/example-esbuild) | Example: sobx with esbuild |
| [example-rolldown](./packages/example-rolldown) | Example: sobx with Rolldown |
| [example-rollup](./packages/example-rollup) | Example: sobx with Rollup |
| [example-rspack](./packages/example-rspack) | Example: sobx with Rspack |
| [example-vite](./packages/example-vite) | Example: sobx with Vite |
| [example-webpack](./packages/example-webpack) | Example: sobx with Webpack |
| [@sobx/compiler-bench](./packages/sobx-compiler-bench) | Benchmarks: MobX vs sobx (compiled) |

Each package has its own README with more detail.
