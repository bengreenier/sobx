# @sobx/magic

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

The MobX-compatible API you write sobx code against. Its exports are placeholders: the [@sobx/compiler](../compiler) redirects these imports to [`@sobx/runtime`](../runtime), which implements them, and compiles local observable objects to a faster form. If a placeholder is ever called, the compiler wasn't enabled for that file, and it throws to say so. The types are the runtime's, so code type-checks exactly as it runs.

## Migrating from MobX

Switch your imports from `"mobx"` to `"@sobx/magic"` and add the compiler to your build. MobX code using observable objects, arrays, Maps, Sets and boxes (deep by default), classes (`makeObservable` / `makeAutoObservable` / standard decorators), `computed`, `reaction`, `autorun`, `when`, actions, `flow`, `toJS` and `configure` works unchanged.

sobx never uses `Proxy`. The compiler turns the operations MobX observes through proxies (adding / deleting keys, `in`, `Object.keys`, dynamic keys, array index and `length` writes) into explicit runtime calls where it can see the observable; elsewhere (a function receiving an observable, an alias), use the explicit API: **`set`**, **`remove`**, **`has`**, **`get`**, **`keys`**, **`values`**, **`entries`**, and `array.set(i, v)` / `array.setLength(n)`.

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
- **`set`**, **`remove`**, **`has`**, **`get`**, **`keys`**, **`values`**, **`entries`**: the explicit API (same names and semantics as MobX's object API functions)
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

Runtime comparison (MobX vs the same code compiled by sobx), same workload in `node:vm`, 500k iterations, 5 rounds (median), `NODE_ENV=production`, MobX `enforceActions: "always"`. Run via [`packages/bench`](../bench).

| Fixture | MobX (ms) | sobx (ms) | sobx vs MobX |
|---|---|---|---|
| combined-reaction-on-name | 460.37 | 179.19 | **156.9% faster** |
| counter-increment | 497.97 | 164.01 | **203.6% faster** |
| multiple-reactions | 469.38 | 152.09 | **208.6% faster** |
| observable-writes-only | 228.08 | 107.96 | **111.3% faster** |
| sync-effect | 512.73 | 196.81 | **160.5% faster** |

These numbers are with full MobX semantics: tracked dependencies, batching, equality checks. Earlier, faster figures came from an inlined reaction that didn't behave like MobX.
