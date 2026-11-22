# @sobx/magic

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

The MobX-compatible API you write sobx code against. Its exports are placeholders: the [@sobx/compiler](../compiler) redirects these imports to [`@sobx/runtime`](../runtime), which implements them, and compiles local observable objects to a faster form. If a placeholder is ever called, the compiler wasn't enabled for that file, and it throws to say so. The types are the runtime's, so code type-checks exactly as it runs.

## Migrating from MobX

Switch your imports from `"mobx"` to `"@sobx/magic"` and add the compiler to your build. Everything MobX 6 exports is here, types included, so MobX code works unchanged: observables, classes with `makeObservable` / `makeAutoObservable` or decorators (standard or legacy), computeds, reactions, actions, flows, `observe` / `intercept`, `spy`...

Local observable objects whose every use the compiler can see are compiled to direct `get` / `set` calls, with no `Proxy`. Every other observable object or array is behind a `Proxy`, as in MobX, so any code using it is observed, compiled or not. `configure({ useProxies: "never" })` turns proxies off (see [what's supported](../../docs/support.md#without-proxies)).

For React, switch `"mobx-react"` / `"mobx-react-lite"` imports to [`@sobx/react`](../react). See [what's supported](../../docs/support.md), and the [differences from MobX](../../docs/support.md#differences-from-mobx).

## Install

```bash
pnpm add @sobx/magic @sobx/runtime
pnpm add -D @sobx/compiler
```

`@sobx/runtime` must be a direct dependency: compiled code imports it from your own files.

## Exports

The exports, options and types are [MobX's](https://mobx.js.org/api.html); [`@sobx/runtime`](../runtime#api) lists them. `observable`, `computed`, `action`, `flow` and `override` also work as decorators: standard (`@observable accessor x`, `@computed get x()`, `@action m()`, `@flow *m()`), or legacy (`experimentalDecorators`: `@observable x`, with `makeObservable(this)` in the constructor).

Types can be imported with or without `import type`:

```ts
import { observable, type IObservableArray, IReactionDisposer } from "@sobx/magic";
```

## What the compiler does

For a local object like the one below, the compiler produces explicit `get` / `set` calls on a `ProxyLike` instead of accessors, and imports everything else from `@sobx/runtime`:

```ts
import { observable, reaction, runInAction } from "@sobx/magic";

const store = observable({ count: 0 });
reaction(
  () => store.count,
  (count) => console.log("count:", count),
);
runInAction(() => {
  store.count += 1;
});
```

compiles to:

```js
import { observable, reaction, runInAction } from "@sobx/runtime";
import { ProxyLike } from "@sobx/runtime";
const store = new ProxyLike({ count: 0 });
reaction(
  () => store.get("count"),
  (count) => console.log("count:", count),
);
runInAction(() => {
  store.set("count", store.get("count") + 1);
});
```

## Benchmarks

Runtime comparison (MobX vs the same code compiled by sobx), same workload in `node:vm` (with the APIs passed as local bindings, like a module's imports), 500k iterations, 5 rounds (median), `NODE_ENV=production`, MobX `enforceActions: "always"`. Run via [`packages/bench`](../bench).

| Fixture | MobX (ms) | sobx (ms) | |
|---|---|---|---|
| counter-increment | 379.2 | 68.0 | **5.6x faster** |
| multiple-reactions | 377.3 | 80.0 | **4.7x faster** |
| observable-writes-only | 90.9 | 20.0 | **4.5x faster** |
| combined-reaction-on-name | 375.6 | 85.4 | **4.4x faster** |
| sync-effect | 368.8 | 84.7 | **4.4x faster** |
| runtime-object-reaction | 425.9 | 122.0 | **3.5x faster** |
| runtime-list-render | 113.1 | 93.8 | **1.2x faster** |
| runtime-dynamic-keys | 191.8 | 175.4 | **1.1x faster** |

(Median of three runs.) The first five use the compiled fast path. The `runtime-*` fixtures use a store that is passed around, so it's behind a `Proxy` in both libraries: writes observed by a reaction, a list rendered by index inside a derivation, and an object used as a dictionary.

Plain data costs nothing: `plain-code-in-compiled-module` and `plain-code-in-derivation` run code with no observables, as it is and compiled (60.6 vs 60.1 ms and 61.1 vs 61.1 ms, i.e. noise: the compiler doesn't touch it).

Earlier versions of this table ran the fixtures with the APIs as `node:vm` globals, whose lookups are slow; the bench now passes them as local bindings, as a module's imports are. Part of the difference with older figures comes from that.

These numbers are with full MobX semantics: tracked dependencies, batching, equality checks. Earlier, faster figures came from an inlined reaction that didn't behave like MobX.

## Development

`pnpm test` type-checks `type-tests`: the API and its types, with legacy and with standard decorators.
