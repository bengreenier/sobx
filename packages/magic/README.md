# @sobx/magic

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

The MobX-compatible API you write sobx code against. Its exports are placeholders: the [@sobx/compiler](../compiler) redirects these imports to [`@sobx/runtime`](../runtime), which implements them, and compiles local observable objects to a faster form. If a placeholder is ever called, the compiler wasn't enabled for that file, and it throws to say so. The types are the runtime's, so code type-checks exactly as it runs.

## Migrating from MobX

Switch your imports from `"mobx"` to `"@sobx/magic"` and add the compiler to your build. MobX code using observable objects, arrays, Maps, Sets and boxes (deep by default), classes (`makeObservable` / `makeAutoObservable` / standard decorators), `computed`, `reaction`, `autorun`, `when`, actions, `flow`, `toJS` and `configure` works unchanged.

Local observable objects whose every use the compiler can see are compiled to direct `get` / `set` calls, with no `Proxy`. Every other observable object or array is behind a `Proxy`, as in MobX, so any code using it is observed, compiled or not. `configure({ useProxies: "never" })` turns proxies off (see [what's supported](../../docs/support.md#without-proxies)).

A few MobX APIs aren't implemented (`extendObservable`, `observe` / `intercept`, `spy` / `trace`, legacy decorators, reaction schedulers). For React, switch `"mobx-react"` / `"mobx-react-lite"` imports to [`@sobx/react`](../react). The compiler fails the build on anything it doesn't support, so nothing breaks silently. See [what's supported](../../docs/support.md) for the full list.

## Install

```bash
pnpm add @sobx/magic @sobx/runtime
pnpm add -D @sobx/compiler
```

`@sobx/runtime` must be a direct dependency: compiled code imports it from your own files.

## Exports

- **`observable(value, overrides?, options?)`** for objects, arrays, Maps and Sets, **`observable.array`** / **`.map`** / **`.set`** / **`.box`**, plus the `observable.ref` / `.shallow` / `.struct` / `.deep` annotations
- **`computed(fn, options?)`**, plus `computed.struct`
- **`reaction(data, effect, options?)`**, **`autorun(fn)`**, **`when(predicate, effect?, options?)`**
- **`action(fn)`** / **`action(name, fn)`**, plus `action.bound`; **`runInAction(fn)`**; **`flow(generator)`**, plus `flow.bound`
- **`set`**, **`remove`**, **`has`**, **`get`**, **`keys`**, **`values`**, **`entries`**: MobX's object API
- **`comparer`** (`default`, `identity`, `structural`, `shallow`), **`toJS`**, **`configure`**, **`untracked`**
- **`isObservable`**, **`isObservableArray`**, **`isObservableObject`**, **`isObservableMap`**, **`isObservableSet`**, **`isBoxedObservable`**, **`isComputed`**, **`isAction`**, **`isFlowCancellationError`**
- **`makeObservable(target, annotations, options?)`**, **`makeAutoObservable(target, overrides?, options?)`**
- `observable`, `computed`, `action` and `flow` also work as standard decorators: `@observable accessor x`, `@computed get x()`, `@action m()`, `@flow *m()`.

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
| counter-increment | 368.1 | 69.4 | **5.3x faster** |
| observable-writes-only | 94.9 | 20.1 | **4.7x faster** |
| multiple-reactions | 372.7 | 82.4 | **4.5x faster** |
| combined-reaction-on-name | 376.9 | 90.1 | **4.2x faster** |
| sync-effect | 366.1 | 91.3 | **4.0x faster** |
| runtime-object-reaction | 417.6 | 153.7 | **2.7x faster** |
| runtime-list-render | 113.2 | 109.2 | about the same |
| runtime-dynamic-keys | 197.6 | 193.0 | about the same |

(Median of three runs.) The first five use the compiled fast path. The `runtime-*` fixtures use a store that is passed around, so it's behind a `Proxy` in both libraries: writes observed by a reaction, a list rendered by index inside a derivation, and an object used as a dictionary.

Plain data costs nothing: `plain-code-in-compiled-module` and `plain-code-in-derivation` run code with no observables, as it is and compiled (60.8 vs 61.9 ms and 61.6 vs 61.4 ms, i.e. noise: the compiler doesn't touch it).

Earlier versions of this table ran the fixtures with the APIs as `node:vm` globals, whose lookups are slow; the bench now passes them as local bindings, as a module's imports are. Part of the difference with older figures comes from that.

These numbers are with full MobX semantics: tracked dependencies, batching, equality checks. Earlier, faster figures came from an inlined reaction that didn't behave like MobX.
