# sobx

Dual-licensed under **MIT** and **Apache-2.0**. See [LICENSE-MIT](./LICENSE-MIT) and [LICENSE-Apache-2.0](./LICENSE-Apache-2.0).

**Not production-ready.** These packages are in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release (version without the alpha suffix).

Packages in this repo:

| Package | Description |
|---------|-------------|
| [**@sobx/magic**](./packages/magic) | Virtual MobX-compatible API (compile-time; use with the compiler) |
| [**@sobx/runtime**](./packages/runtime) | Observable proxy runtime (`ProxyLike`) that compiled code imports |
| [**@sobx/compiler**](./packages/compiler) | Compiler and bundler plugins (Vite, Rollup, Webpack, esbuild, Rolldown, Rspack) |
| `@sobx/compiler-<platform>` | Native analyzer `@sobx/compiler` runs on (source in [crates/sobx_compiler](./crates/sobx_compiler); prebuilt binaries not published yet) |
| [**@sobx/ast**](./packages/ast) | Types of the IR of a program's MobX-style usages |
| [example-esbuild](./packages/example-esbuild) | Example: sobx with esbuild |
| [example-rolldown](./packages/example-rolldown) | Example: sobx with Rolldown |
| [example-rollup](./packages/example-rollup) | Example: sobx with Rollup |
| [example-rspack](./packages/example-rspack) | Example: sobx with Rspack |
| [example-vite](./packages/example-vite) | Example: sobx with Vite |
| [example-webpack](./packages/example-webpack) | Example: sobx with Webpack |
| [@sobx/bench](./packages/bench) | Benchmarks: MobX vs sobx (compiled) |

Each package has its own README with more detail.

## How it fits together

You write MobX-style code against `@sobx/magic`. At build time, `@sobx/compiler` (through its bundler plugin) analyzes each file with the native analyzer in [`crates/sobx_compiler`](./crates/sobx_compiler) (Rust, on [oxc](https://oxc.rs)), which produces the IR typed by `@sobx/ast`. The compiler then rewrites the code to use `@sobx/runtime`. `packages/ast/test` keeps an independent TypeScript (Babel) analyzer that the Rust one is checked against; it is not published.

## Development

Requires Node.js 22.18+, pnpm, and a Rust toolchain (prebuilt analyzer binaries are not published yet).

```bash
pnpm install
pnpm --filter @sobx/compiler build:native   # build the native analyzer
pnpm build
pnpm test
```
