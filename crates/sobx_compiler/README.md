# sobx_compiler

**Experimental.** The native half of [`@sobx/compiler`](../../packages/compiler), which uses it to decide what to compile: the sobx analyzer, written in Rust on [oxc](https://oxc.rs) (`oxc_parser` + `oxc_semantic`) and exposed to Node through [napi-rs](https://napi.rs). It produces the IR described by [`@sobx/ast`](../../packages/ast), as JSON.

Prebuilt binaries will be distributed as `@sobx/compiler-<platform>` (for example `@sobx/compiler-darwin-arm64` or `@sobx/compiler-win32-x64-msvc`). They are not packaged yet; for now you build the addon locally with a Rust toolchain.

## Status

- **Tested from JavaScript** by `@sobx/compiler` (`pnpm --filter @sobx/compiler test`):
  - `src/analyzer/analyze*.spec.ts`: the analyzer specs, asserting on the IR for each pattern.
  - `src/analyzer/fuzz.spec.ts`: an invariant fuzz. It generates random programs mixing every modeled feature and checks that the analyzer doesn't throw, that the IR is consistent (sequential ids in source order, every cross-reference resolves, spans and line/column positions match the source), and that the compiled output parses. It runs 400 seeds by default; set `SOBX_FUZZ_SEEDS` to search longer.
- **Speed.** It was ported from a Babel-based analyzer (since removed) and measured at about 10x faster on a typical file and about 4x faster on MobX-heavy code, including `JSON.parse` on the JS side.

## Building

Requires a Rust toolchain (`cargo`).

```bash
pnpm --filter @sobx/compiler build:native   # cargo build --release + copy to packages/compiler/sobx-compiler.node
```

After building, `pnpm --filter @sobx/compiler test` runs the tests. A new MobX export must be added to the lists at the top of `src/analyzer.rs` (and to `@sobx/magic`); `packages/compiler/src/mobx-api.spec.ts` fails otherwise.

## API

```js
const { analyze } = require("./sobx-compiler.node");
const ir = JSON.parse(analyze(source, moduleSpecifier /* default "@sobx/magic" */, filename));
```

## Layout

- `src/analyzer.rs`: the analyzer.
- `src/ir.rs`: the IR types, serialized with serde to match `packages/ast/src/types.ts`.
- `src/lib.rs`: the napi entry point.
- `examples/profile.rs`: per-phase timings (`cargo run --release --example profile -- <file>`).
