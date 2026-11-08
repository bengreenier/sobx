# @sobx/runtime

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

The runtime that sobx-compiled code runs on: a small, MobX-compatible reactive core. The [compiler](../compiler) redirects `@sobx/magic` imports here, and compiles local observable objects to `ProxyLike` instances.

You normally don't import it yourself; write against [`@sobx/magic`](../magic) and let the compiler point your code here. See [what's supported](../../docs/support.md).

## Install

```bash
pnpm add @sobx/runtime
```

## How it works

- **Dependency tracking.** While a computed or reaction runs, every observable read is recorded; afterwards it depends on exactly those (re-tracked on every run, so conditional reads work).
- **Batching.** Actions (`action`, `runInAction`, and methods of observables) batch their writes: reactions run once, when the outermost action ends.
- **Computeds** are cached while observed, and only propagate when their value changes.
- **Observable objects** are shallow: plain property values are observed, nested objects and arrays are not.

## API

MobX-compatible:

- **`observable(object, overrides?, options?)`**: an observable copy of a plain object (getters become computeds, functions auto-actions). Throws for arrays, Maps, Sets and class instances.
- **`computed(fn, options?)`**: a computed value; read it with `.get()`. Options: `equals`.
- **`reaction(data, effect, options?)`**: runs `effect(value, previous, reaction)` when `data`'s result changes. Options: `fireImmediately`, `equals`. Returns a disposer.
- **`autorun(fn)`**: runs `fn` now and whenever what it read changes. Returns a disposer.
- **`action(fn)`** / **`action(name, fn)`**, **`runInAction(fn)`**: batched, untracked.
- **`makeObservable(target, annotations, options?)`**, **`makeAutoObservable(target, overrides?, options?)`**: for classes (call them in the constructor) and objects. Options: `autoBind`.
- **Annotations**: `observable`, `observable.ref` / `.shallow` / `.deep` / `.struct` (structural comparison), `computed`, `computed.struct`, `action`, `action.bound`, `false` (excluded), `true` (inferred).
- **Standard decorators**: `@observable accessor x`, `@computed get x()`, `@action m()`, `@action.bound m()`.

Also:

- **`untracked(fn)`**, **`batch(fn)`**.
- **`ProxyLike`**: see below.

## `ProxyLike`

The compiled form of a local observable object: a wrapper with explicit `get` / `set` calls, faster than accessors or a native `Proxy`. Reads inside computeds and reactions are tracked; writes that change a value re-run them.

- **`new ProxyLike(target, options?)`**: wrap an object. Options (emitted by the compiler): `getters` (run with the `ProxyLike` as `this`), `actions` (function keys to batch).
- **`get(key)`**, **`set(key, value)`** (returns `value`), **`update(key, ±1, prefix)`** (for `++` / `--`), **`delete(key)`**.
- **`addObserver(observer)`** / **`addObserver(key, observer)`**: low-level change callbacks, `(key, previous, current) => void`, called on every `set` (even with an equal value). Returns a handle with `dispose()`.

```ts
import { ProxyLike, reaction } from "@sobx/runtime";

const state = new ProxyLike({ count: 0 });
reaction(
  () => state.get("count"),
  (count) => console.log("count:", count),
);
state.set("count", 1); // logs: count: 1
```
