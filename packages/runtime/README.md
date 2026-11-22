# @sobx/runtime

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

The runtime that sobx-compiled code runs on: a MobX-compatible reactive core, with everything MobX 6 exports. The [compiler](../compiler) redirects `@sobx/magic` imports here, and compiles local observable objects to `ProxyLike` instances.

You normally don't import it yourself; write against [`@sobx/magic`](../magic) and let the compiler point your code here. See [what's supported](../../docs/support.md).

## Install

```bash
pnpm add @sobx/runtime
```

## How it works

- **Dependency tracking.** While a computed or reaction runs, every observable read is recorded; afterwards it depends on exactly those (re-tracked on every run, so conditional reads work).
- **Batching.** Actions (`action`, `runInAction`, and methods of observables) batch their writes: reactions run once, when the outermost action ends.
- **Computeds** are cached while observed (and within a batch; always with `keepAlive`), and only propagate when their value changes.
- **Deep observables.** As in MobX, plain objects, arrays, Maps and Sets put into an observable become observable themselves, and functions auto-actions (unless the property is `observable.ref` / `.struct`). Cyclic and shared values convert to the same observable.
- **Proxies.** Observable objects and arrays are behind a `Proxy`, as in MobX, so any code using them is observed. Observable properties are read and written straight in the object's store, and array methods run on the array itself (a real `Array` subclass); the traps do the rest. `configure({ useProxies: "never" })` (or `proxy: false` for one object) turns them off: what's left is accessors, array methods, and *owners* (a held value tells the property holding it when it changes, so `store.items.length` is tracked), with `set`, `remove`, `has`, `get`, `keys`... for the rest.
- **enforceActions.** In development builds, changing observed observables outside actions logs a warning, as in MobX (`configure({ enforceActions })`).

Behaviour is checked against MobX itself: the specs run the same scenarios with `mobx` and `@sobx/runtime` and compare what they log, with proxies and without. See [differences from MobX](../../docs/support.md#differences-from-mobx) for how it was tested and what differs.

## API

Everything MobX 6 exports ([its API reference](https://mobx.js.org/api.html) applies), with its options and types. In short:

- **Observables**: **`observable(value, overrides?, options?)`** (objects, arrays, Maps, Sets; primitives and functions make a box; class instances are returned as they are), **`observable.object`** / **`.array`** / **`.map`** / **`.set`** / **`.box`**, **`extendObservable`**. Options: `autoBind`, `deep`, `defaultDecorator`, `name`, `proxy`, and `equals` for boxes.
- **Classes**: **`makeObservable(this, annotations?, options?)`**, **`makeAutoObservable(this, overrides?, options?)`**, subclasses with **`override`**.
- **Annotations**: `observable`, `observable.ref` / `.shallow` / `.deep` / `.struct`, `computed`, `computed.struct`, `computed({ ... })`, `action`, `action.bound`, `action("name")`, `flow`, `flow.bound`, `override`, `false` (excluded), `true` (inferred). They are also decorators, standard (`@observable accessor x`) and legacy (`@observable x`, with `makeObservable(this)`).
- **Collections**: **`ObservableArray`** (a real `Array`, with `clear`, `replace`, `remove`, `spliceWithArray`; mutating methods notify once), **`ObservableMap`** and **`ObservableSet`** (subclasses of `Map` / `Set`, with `merge`, `replace`, `toJSON`...). Map and Set reads track the key or value; iteration tracks the whole collection. Arrays also have `get(i)`, `set(i, v)` and `setLength(n)`, for when proxies are off.
- **`computed(fn, options?)`**: read with `.get()`. Options: `equals`, `name`, `set`, `keepAlive`, `context`, `requiresReaction`, `compareStructural`.
- **Reactions**: **`autorun(fn, options?)`**, **`reaction(data, effect, options?)`**, **`when(predicate, effect?, options?)`** (without an effect: a promise with `cancel()`), **`Reaction`**, **`onReactionError`**. Options: `name`, `delay`, `scheduler`, `onError`, `requiresObservable`, `signal`, `equals`, `fireImmediately`, `timeout`.
- **Actions**: **`action`**, **`runInAction`**, **`transaction`**, **`untracked`**, **`flow`** (generators and async generators; the promise has `cancel()`), `flowResult`, `FlowCancellationError`.
- **Object API**: **`set`**, **`remove`**, **`has`**, **`get`**, **`keys`**, **`values`**, **`entries`**, **`ownKeys`**, **`defineProperty`**: tracked, including keys that don't exist yet.
- **Listening**: **`observe`**, **`intercept`**, **`onBecomeObserved`**, **`onBecomeUnobserved`**, **`createAtom`**.
- **Debugging**: **`spy`**, **`trace`**, **`getDebugName`**, **`getDependencyTree`**, **`getObserverTree`**, **`getAtom`**.
- **`toJS`**, **`comparer`** (`default`, `identity`, `structural`, `shallow`), **`configure`** (every MobX option), and the **`is...`** checks.
- **For other libraries**: `$mobx`, and MobX's `_` exports (`_allowStateChanges`, `_interceptReads`, `_startAction`, `_getGlobalState`...).

Not in MobX:

- **`batch(fn)`**: the same as `transaction`.
- **`currentTracking()`**: an opaque object identifying the derivation run in progress (or `null`), for bindings such as `@sobx/react`.
- Compiler helpers (emitted by `@sobx/compiler`; plain JavaScript semantics for non-observables): `getProperty`, `setProperty`, `updateProperty`, `deleteProperty`, `hasProperty`, `keysOf`, `valuesOf`, `entriesOf`.
- **`ProxyLike`**: see below.

## Source

| File | Contents |
|---|---|
| `core.ts` | Dependencies, derivations, batching, global state, `deepEqual` |
| `action.ts`, `async.ts` | Actions; `when` and `flow` |
| `computed.ts`, `reaction.ts` | Computeds; `Reaction`, `autorun`, `reaction` |
| `value.ts`, `object.ts`, `collections.ts` | Boxes and properties; objects; arrays, Maps and Sets |
| `enhance.ts`, `proxies.ts` | How values are made observable; the `Proxy` handlers |
| `observable.ts` | `observable`, `makeObservable`, annotations and decorators |
| `api.ts`, `extras.ts`, `utils.ts`, `spy.ts` | The object API and compiler helpers; `observe`, `trace`, `createAtom`...; `toJS`, `configure`, checks; spies, listeners and interceptors |
| `proxy-like.ts` | `ProxyLike` |
| `types.ts` | The types MobX exports |

## `ProxyLike`

The compiled form of a local observable object: a wrapper with explicit `get` / `set` calls, faster than a `Proxy`. Reads inside computeds and reactions are tracked; writes that change a value re-run them.

- **`new ProxyLike(target, options?)`**: wrap an object. Options (emitted by the compiler): `getters` (cached as computeds, run with the `ProxyLike` as `this`), `actions` (function keys to batch), `deep` (make values observable: plain objects, arrays, Maps, Sets; default `true`).
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
