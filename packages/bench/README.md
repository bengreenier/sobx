# @sobx/bench

Runtime benchmarks: MobX vs the same code compiled by `@sobx/compiler` (running on `@sobx/runtime`'s `ProxyLike`), in `node:vm`. Each fixture runs in a function that receives the APIs as parameters (local bindings, as a module's imports are; a vm context's globals are much slower to read). `plain-code-in-compiled-module` and `plain-code-in-derivation` have no observables: both columns are plain JavaScript (the compiler must not slow it down). The `runtime-*` fixtures use a store that is passed around (behind a `Proxy` in both libraries). `SOBX_NO_PROXIES=1` runs sobx with `configure({ useProxies: "never" })`. Run with:

```bash
pnpm bench
```

from this package or from the repo root. It needs the compiler built (`pnpm build`) and its native analyzer (`pnpm --filter @sobx/compiler build:native`). The script sets `NODE_ENV` POSIX-style, which doesn't work in pnpm's default Windows shell; there, run `NODE_ENV=production npx tsx scripts/bench.ts` from a POSIX shell such as Git Bash.

For per-phase timings of the analyzer itself, see `cargo run --release --example profile -- <file>` in `crates/sobx_compiler`.
