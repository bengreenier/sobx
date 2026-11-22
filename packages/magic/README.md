# @sobx/magic

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

The MobX-compatible API you write sobx code against. Its exports are placeholders: the [@sobx/compiler](../compiler) redirects these imports to [`@sobx/runtime`](../runtime), which implements them, and compiles local observable objects to a faster form. If a placeholder is ever called, the compiler wasn't enabled for that file, and it throws to say so. The types are the runtime's, so code type-checks exactly as it runs.

## Migrating from MobX

Switch your imports from `"mobx"` to `"@sobx/magic"` and add the compiler to your build. MobX code using observable objects, arrays, Maps, Sets and boxes (deep by default), classes (`makeObservable` / `makeAutoObservable` / standard decorators), `computed`, `reaction`, `autorun`, `when`, actions, `flow`, `toJS` and `configure` works unchanged.

sobx never uses `Proxy`. The compiler turns the operations MobX observes through proxies (adding / deleting keys, `in`, `Object.keys`, dynamic keys, array index and `length` reads and writes) into runtime calls: on the observables it sees created, and on values whose origin it can't trace (parameters, imports, call results), which may be observables (the runtime calls behave as plain JavaScript otherwise). In modules the compiler doesn't process (those that import neither `@sobx/magic` nor `@sobx/react`), and to read a key that doesn't exist yet through a value the compiler can't trace, use the explicit API: **`set`**, **`remove`**, **`has`**, **`get`**, **`keys`**, **`values`**, **`entries`**, and `array.set(i, v)` / `array.setLength(n)`.

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

Runtime comparison (MobX vs the same code compiled by sobx), same workload in `node:vm` (with the APIs passed as local bindings, like a module's imports), 500k iterations, 5 rounds (median), `NODE_ENV=production`, MobX `enforceActions: "always"`. Run via [`packages/bench`](../bench).

| Fixture | MobX (ms) | sobx (ms) | sobx vs MobX |
|---|---|---|---|
| combined-reaction-on-name | 347.45 | 99.57 | **248.9% faster** |
| counter-increment | 340.48 | 72.99 | **366.5% faster** |
| multiple-reactions | 348.06 | 88.10 | **295.1% faster** |
| observable-writes-only | 82.76 | 22.66 | **265.3% faster** |
| sync-effect | 348.79 | 96.21 | **262.5% faster** |
| plain-code-in-compiled-module | 59.36 | 64.71 | 9.0% slower |
| plain-code-in-derivation | 60.58 | 66.31 | 9.5% slower |

The last two measure what the compiler's rewrites cost on plain values: a loop of index / `length` reads, dynamic-key writes and `Object.keys` on plain arrays and objects reached through parameters (which could be observables, so they're rewritten), outside any reaction and inside an `autorun` (as in an observer render). The MobX column runs the same code uncompiled.

Earlier versions of this table (MobX 460–513 ms, sobx 108–197 ms) ran the fixtures with the APIs as `node:vm` globals, whose lookups are slow; the bench now passes them as local bindings, as a module's imports are. The bigger ratios come from that harness change, not from a faster runtime.

These numbers are with full MobX semantics: tracked dependencies, batching, equality checks. Earlier, faster figures came from an inlined reaction that didn't behave like MobX.
