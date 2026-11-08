# sobx_compiler

**Experimental.** The native half of [`@sobx/compiler`](../../packages/compiler), which uses it to decide what to compile: the sobx analyzer, written in Rust on [oxc](https://oxc.rs) (`oxc_parser` + `oxc_semantic`) and exposed to Node through [napi-rs](https://napi.rs). It produces the IR described by [`@sobx/ast`](../../packages/ast), as JSON.

Prebuilt binaries will be distributed as `@sobx/compiler-<platform>` (for example `@sobx/compiler-darwin-arm64` or `@sobx/compiler-win32-x64-msvc`). They are not packaged yet; for now you build the addon locally with a Rust toolchain.

## Status

- **Full parity with the Babel reference analyzer** in `packages/ast/test`. Checked by:
  - the `@sobx/ast` analyzer specs, run against this addon by the `native` vitest project. The test shim also compares the complete IR from both analyzers on every input.
  - a differential fuzz test (`packages/ast/test/native/differential.spec.ts`) that generates random programs mixing every modeled feature and compares the full IR. It runs 400 seeds by default; set `SOBX_FUZZ_SEEDS` to search longer.
- **Speed.** About 10x faster than the Babel analyzer on a typical file, and about 4x faster on MobX-heavy code. Both figures include `JSON.parse` on the JS side.

## Building

Requires a Rust toolchain (`cargo`).

```bash
pnpm --filter @sobx/compiler build:native   # cargo build --release + copy to packages/compiler/sobx-compiler.node
```

After building, `pnpm --filter @sobx/ast test` also runs the `native` project. It is skipped when the addon is missing.

## API

```js
const { analyze } = require("./sobx-compiler.node");
const ir = JSON.parse(analyze(source, moduleSpecifier /* default "@sobx/magic" */, filename));
```

## Layout

- `src/analyzer.rs`: the analyzer (a port of `packages/ast/test/analyze.ts`).
- `src/ir.rs`: the IR types, serialized with serde to match `packages/ast/src/types.ts`.
- `src/lib.rs`: the napi entry point.
- `examples/profile.rs`: per-phase timings (`cargo run --release --example profile -- <file>`).
- Benchmark against the Babel analyzer: `pnpm --filter @sobx/ast bench` (after building the addon).
