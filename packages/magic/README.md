# @sobx/magic

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

Virtual MobX-compatible API for use with the sobx compiler. **Do not call these at runtime**—they throw. The [@sobx/compiler](https://github.com/bengreenier/sobx/tree/main/packages/compiler) rewrites your code so that `observable`, `reaction`, and `runInAction` are replaced with compiled output.

Use this package when migrating from MobX: keep the same API surface and switch your imports from `"mobx"` to `"@sobx/magic"`, then add the compiler to your build.

### What the compiler does

The compiler runs at build time and only transforms files that import from the configured module (default `"@sobx/magic"`). It analyzes each file with the sobx analyzer (native, scope-aware), then rewrites what the analysis identifies to use the minimal runtime in `@sobx/runtime`:

- **`observable(value)`** → `new ProxyLike(value)` and injects `import { ProxyLike } from "@sobx/runtime"`.
- **Property reads** on those observables (e.g. `store.count`) → `store.get("count")`.
- **Property writes** (`store.count = 1`, `store.count += 1`, `store.count++`) → `store.set("count", ...)`.
- **`reaction(dataFn, effectFn)`** → an `addObserver` on each key `dataFn` reads (including in functions it calls), plus one initial run of the effect. Options (such as `fireImmediately`) are not compiled yet.
- **`runInAction(fn)`** → `fn()` (there is no separate action runtime).

So your source stays MobX-style (observable, reaction, direct property access), and the published bundle uses explicit get/set and observers instead of a heavy runtime.

## Install

```bash
pnpm add @sobx/magic
```

## Exports

- **`observable(value)`** — Marks a value as observable. Compiler replaces with proxy-backed code.
- **`reaction(dataFn, effectFn, options?)`** — Runs `effectFn` when `dataFn`’s result changes. Compiler replaces with explicit tracking.
- **`runInAction(fn)`** — Runs `fn` in an action. Compiler replaces it with `fn()`.

If any of these are ever executed without being compiled, they throw with a message telling you to enable the sobx compiler for that file.

## Usage

1. Import from `"@sobx/magic"` instead of `"mobx"`.
2. Add the sobx compiler to your bundler (Vite, Rollup, Webpack, esbuild, Rolldown, or Rspack). See `packages/compiler` in this repo.

```ts
import { observable, reaction, runInAction } from "@sobx/magic";

const store = observable({ count: 0 });

reaction(
  () => store.count,
  (count) => console.log("count:", count),
  { fireImmediately: true },
);

runInAction(() => {
  store.count += 1;
});
```

## Benchmarks

Runtime comparison (MobX vs sobx compiled with `@sobx/runtime` ProxyLike), same workload in `node:vm`, 500k iterations, 5 rounds (median), `NODE_ENV=production`, MobX `enforceActions: "always"`. Run via `packages/bench` (`pnpm bench`).

| Fixture                      | MobX (ms) | sobx (ms) | sobx vs MobX   |
|-----------------------------|-----------|-----------|----------------|
| combined-reaction-on-name   | 293.88    | 81.29     | **261.5% faster** |
| counter-increment           | 280.98    | 52.30     | **437.3% faster** |
| multiple-reactions          | 260.10    | 44.43     | **485.4% faster** |
| observable-writes-only      | 138.13    | 52.75     | **161.8% faster** |
| sync-effect                 | 294.76    | 81.37     | **262.3% faster** |

