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
- **Deep observables.** As in MobX, plain objects, arrays, Maps and Sets put into an observable become observable themselves (unless the property is `observable.ref` / `.struct`). Cyclic and shared values convert to the same observable.
- **No `Proxy`.** Observable objects and classes use accessors; observable arrays are `ObservableArray`, a real `Array` subclass. Operations that only a `Proxy` could observe (adding / deleting keys, `in`, `Object.keys`, array index and `length` writes) go through the explicit API (`set`, `remove`, `has`, `get`, `keys`, `values`, `entries`, `array.set(i, v)`, `array.setLength(n)`), which the compiler emits for the code it can see.
- **Owners.** A held value tells the property holding it when it changes, so `store.items.length` or `store.items[0]` in a derivation re-run when `store.items` is mutated, even though `length` and `[i]` are plain properties.
- **enforceActions.** In development builds, changing observed observables outside actions logs a warning, as in MobX (`configure({ enforceActions })`).

Behaviour is checked against MobX itself: `src/parity.spec.ts` runs the same scenarios with `mobx` (its default mode) and `@sobx/runtime` (with the explicit API where MobX relies on proxies) and compares what they log.

## API

MobX-compatible:

- **`observable(object, overrides?, options?)`**: an observable copy of a plain object, with accessor properties (getters become computeds, functions auto-actions, generator functions flows). Options: `autoBind`, `deep` (`proxy` is accepted and ignored). Add keys with `set()`. `observable([...])`, `observable(new Map())` and `observable(new Set())` make an observable array, Map or Set. Throws for class instances.
- **`observable.array(values?, options?)`**: an `ObservableArray`: every method and iteration is tracked, mutating methods notify once; `get(i)`, `set(i, v)` and `setLength(n)` read and write elements in a tracked way. Options: `deep`.
- **`set(target, key, value)`**, **`remove(target, key)`**, **`has(target, key)`**, **`get(target, key)`**, **`keys(target)`**, **`values(target)`**, **`entries(target)`**: sobx's explicit API for observable objects (adding / removing observable properties), arrays, Maps and Sets; tracked, including keys that don't exist yet.
- **`observable.box(value, options?)`**: a single observable value (`get()` / `set()`). Options: `equals`, `deep`.
- **`observable.map(entries?, options?)`**, **`observable.set(values?, options?)`**: observable Map / Set (`ObservableMap` / `ObservableSet`, subclasses of `Map` / `Set`). `get` / `has` track the key; `size` and iteration track the whole collection.
- **`computed(fn, options?)`**: a computed value; read it with `.get()`. Options: `equals`.
- **`reaction(data, effect, options?)`**: runs `effect(value, previous, reaction)` when `data`'s result changes. Options: `fireImmediately`, `equals`. Returns a disposer.
- **`autorun(fn)`**: runs `fn` now and whenever what it read changes. Returns a disposer.
- **`when(predicate, effect, options?)`**: runs `effect` once, when `predicate` becomes true. **`when(predicate, options?)`** returns a promise with `cancel()`. Options: `timeout`.
- **`flow(function* () {...})`**: an async action; each step between `yield`s runs as an action, `yield promise` waits for it. The result returns a promise with `cancel()` (rejects with `FlowCancellationError`).
- **`comparer`**: `default`, `identity`, `structural`, `shallow`, for `equals` options.
- **`toJS(value)`**: deep conversion back to plain arrays, objects, Maps and Sets (without computeds and functions; cycles preserved).
- **`configure({ enforceActions })`**: `"observed"` (default), `"always"`, `"never"`. Other MobX options are ignored (with a warning in development).
- **`isObservable`**, **`isObservableArray`**, **`isObservableObject`**, **`isObservableMap`**, **`isObservableSet`**, **`isBoxedObservable`**, **`isComputed`**, **`isAction`**, **`isFlowCancellationError`**.
- **`action(fn)`** / **`action(name, fn)`**, **`runInAction(fn)`**: batched, untracked.
- **`makeObservable(target, annotations, options?)`**, **`makeAutoObservable(target, overrides?, options?)`**: for classes (call them in the constructor) and objects. Options: `autoBind`, `deep`.
- **Annotations**: `observable`, `observable.ref` / `.shallow` / `.deep` / `.struct` (structural comparison), `computed`, `computed.struct`, `action`, `action.bound`, `flow`, `flow.bound`, `false` (excluded), `true` (inferred).
- **Standard decorators**: `@observable accessor x`, `@computed get x()`, `@action m()`, `@action.bound m()`, `@flow *m()`, `@flow.bound *m()`.

Also:

- **`untracked(fn)`**, **`batch(fn)`**.
- **`currentTracking()`**: an opaque object identifying the derivation run in progress (or `null`), for bindings such as `@sobx/react`.
- Compiler helpers (emitted by `@sobx/compiler`; plain JavaScript semantics for non-observables): `getProperty`, `setProperty`, `updateProperty`, `deleteProperty`, `hasProperty`, `keysOf`, `valuesOf`, `entriesOf`.
- **`ProxyLike`**: see below.

## `ProxyLike`

The compiled form of a local observable object: a wrapper with explicit `get` / `set` calls, faster than accessors (sobx never uses `Proxy`). Reads inside computeds and reactions are tracked; writes that change a value re-run them.

- **`new ProxyLike(target, options?)`**: wrap an object. Options (emitted by the compiler): `getters` (run with the `ProxyLike` as `this`), `actions` (function keys to batch), `deep` (make values observable: plain objects, arrays, Maps, Sets; default `true`).
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
