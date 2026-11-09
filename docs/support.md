# What sobx supports

sobx is MobX-compatible code (`import { ... } from "@sobx/magic"`), compiled at build time. Every
supported API is implemented by [`@sobx/runtime`](../packages/runtime), a MobX-style runtime
(dependency tracking, batching, computeds, reactions, deep observables). The compiler redirects
`@sobx/magic` imports to it, and on top of that compiles local observable objects to a faster
form.

**sobx never uses `Proxy`.** Operations that MobX observes through its proxies (adding or
deleting keys, `in`, `Object.keys`, dynamic keys, array index and `length` writes) are compiled
into explicit runtime calls where the compiler can see them, and are otherwise done with the
explicit API: `set`, `remove`, `has`, `get`, `keys`, `values`, `entries` (same names and semantics
as MobX's object API functions).

Each pattern below has one of these outcomes:

- **Fast path**: compiled to a `ProxyLike` with explicit `get` / `set` calls (no proxy, no accessors).
- **Runtime**: works, through `@sobx/runtime` (accessor-based observable objects and classes, `ObservableArray`, Maps, Sets).
- **Error**: fails the build with a diagnostic, because it would fail at runtime.
- **Warning**: compiled, with a warning (likely a mistake).

You can change any diagnostic's severity with the compiler's `diagnostics` option.

Setup: `pnpm add @sobx/magic @sobx/runtime` and `pnpm add -D @sobx/compiler`, then add the
compiler's plugin to your bundler. `@sobx/runtime` must be a direct dependency, since compiled
code imports it.

## APIs

| API | Supported | Notes |
|---|---|---|
| `observable({...}, overrides?, options?)` | Yes | Fast path when local and fully analyzable, otherwise runtime (accessor-based). Options: `autoBind`, `deep`, `name` (`proxy` is accepted and ignored). |
| `observable([...])`, `observable.array(values?, options?)` | Yes | An `ObservableArray` (a real `Array` subclass). Options: `deep`, `name`. |
| `observable(new Map())`, `observable.map()`, `observable(new Set())`, `observable.set()` | Yes | Runtime. Options: `deep`, `name`. |
| `observable.box(value, options?)` | Yes | `get()` / `set()`. Options: `equals`, `deep`, `name`. |
| `computed(fn, options?)` | Yes | Cached while observed. Options: `equals`, `name`, `keepAlive`. |
| `reaction(data, effect, options?)` | Yes | Effect gets `(value, previous, reaction)`. Options: `fireImmediately`, `equals`, `name`. |
| `autorun(fn, options?)` | Yes | Options: `name`. |
| `when(predicate, effect, options?)`, `when(predicate, options?)` (promise) | Yes | The promise has `cancel()`. Options: `timeout`, `name`. |
| `action(fn)`, `action(name, fn)`, `runInAction(fn)` | Yes | Batched and untracked. |
| `flow(function* () {...})` | Yes | Each step between `yield`s runs as an action; the returned promise has `cancel()`. Generator methods are inferred as flows. |
| `makeObservable(this, annotations, options?)`, `makeAutoObservable(this, overrides?, options?)` | Yes | Runtime. Options: `autoBind`, `deep`. |
| Annotations: `observable`, `observable.ref` / `.shallow` / `.struct` / `.deep`, `computed`, `computed.struct`, `action`, `action.bound`, `flow`, `flow.bound`, `false`, `true` | Yes | |
| Standard decorators: `@observable accessor x` (and `.ref` / `.shallow` / `.struct` / `.deep`), `@computed get x()`, `@action m()`, `@action.bound m()`, `@flow *m()`, `@flow.bound *m()` | Yes | Your toolchain must transform standard (2022.3) decorators, e.g. esbuild with `target: "es2022"`. |
| `comparer.default` / `.identity` / `.structural` / `.shallow` | Yes | For `equals` options. |
| `toJS(value)` | Yes | Deep conversion back to plain arrays, objects, Maps and Sets (computeds and functions are left out; cycles preserved). |
| `set`, `remove`, `has`, `get`, `keys`, `values`, `entries` | Yes | sobx's explicit API for observable objects, arrays, Maps and Sets. The compiler emits equivalent calls for the operations it can see. |
| `configure({ enforceActions })` | Yes | Other MobX options (including `useProxies`) are ignored, with a warning in development. |
| `isObservable`, `isObservableArray`, `isObservableObject`, `isObservableMap`, `isObservableSet`, `isBoxedObservable`, `isComputed`, `isAction`, `isFlowCancellationError`, `untracked` | Yes | |
| Legacy (`experimentalDecorators`) decorators, `@observable x` without `accessor` | No | Error (`invalid-annotation`). |
| `extendObservable`, `observe`, `intercept`, `spy`, `trace`, `reaction` options like `delay` / `scheduler` / `onError`, ... | No | Error (`unknown-import` / `unsupported-api` / `unsupported-option`). |

## React

[`@sobx/react`](../packages/react) has the same API as `mobx-react` (and `mobx-react-lite`):
switch `"mobx-react"` / `"mobx-react-lite"` imports to `"@sobx/react"`.

| API | Supported | Notes |
|---|---|---|
| `observer(component)` | Yes | Function, `forwardRef` and class components; standard class decorator. Function components are memoized. |
| `<Observer>` | Yes | `children` or `render` function. |
| `useLocalObservable(initializer, annotations?)` | Yes | A runtime (accessor-based) observable: add or delete keys with `set` / `remove`. |
| `Provider`, `inject`, `MobXProviderContext` | Yes | |
| `enableStaticRendering`, `isUsingStaticRendering` | Yes | For server-side rendering. |
| `useObserver`, `useLocalStore`, `useAsObservableSource`, `useStaticRendering`, `observerBatching`, `isObserverBatched` | Yes | Deprecated, as in mobx-react. |
| `disposeOnUnmount`, `PropTypes` | No | Deprecated / removed in recent mobx-react and React. |

Components in `.tsx` / `.jsx` files written against `@sobx/magic` are compiled like any other
code. Observables a component receives as props or through context are like any observable
passed to a function: their declared properties are tracked, other property operations use the
explicit API. Renders that React discards without mounting release their subscriptions (through
`FinalizationRegistry`), as in mobx-react.

## Values

Observables are **deep** by default, as in MobX: plain objects, arrays, Maps and Sets put into an
observable (object property, class field, array element, Map / Set value, box) become observable
themselves, recursively, when they are stored.

| Pattern | Outcome |
|---|---|
| Nested objects and arrays (`store.user.name = "x"`, `store.items.push(x)`, `store.items[0] = x`) | Tracked. Writes through a nested value are compiled to runtime calls. |
| Adding / deleting keys (`store.newKey = 1`, `delete store.k`), dynamic keys (`store[k]`), `"k" in store`, `Object.keys` / `values` / `entries(store)` | Compiled to runtime calls (`setProperty`, `deleteProperty`, `getProperty`, `hasProperty`, `keysOf`, ...) where the compiler can see the observable; otherwise use `set` / `remove` / `get` / `has` / `keys`. `Object.assign(store, ...)` and similar are build errors. |
| Arrays: methods, iteration, `Array.isArray`, `JSON.stringify`, `structuredClone` | Real arrays. Methods and iteration are tracked as a whole; a mutating method notifies once. |
| Array `length` / `[i]` reads | Tracked when the array is reached through an observable property (`store.items.length`: the array notifies the property holding it) or when the compiler sees the array (`items[0]` on an `observable([...])` variable is compiled to `getProperty`). Otherwise use `array.get(i)` or a method. |
| Array `[i] = v` / `length = n` writes | Compiled to `array.set(i, v)` / `array.setLength(n)` (through `setProperty`) where the compiler can follow the array. Otherwise use `set` / `setLength` / `splice`. |
| `observable.ref` | Values are stored as they are (not converted). Mutating such a value is not tracked: warning `deep-mutation`. |
| `observable.shallow` | Collections and objects become observable, their contents are not converted. |
| `observable.struct` | Not converted; a new value that is structurally equal is not a change. |
| `{ deep: false }` (on `observable()`, `makeObservable()`, `observable.array()`, ...) | Inferred members are `observable.ref`. |
| Class instances, `Date`, functions, ... | Stored as they are (as in MobX). |
| Cyclic and shared plain values | Converted once: references to the same value point to the same observable. |
| A converted value's identity | A copy: `store.user = u` stores an observable copy of `u` (as in MobX). Use `observable.ref` to keep the original. |

## Using an observable object

For a local `const s = observable({...})`:

| Pattern | Outcome |
|---|---|
| `s.a`, `s?.a`, `s["a"]` | Fast path: `s.get("a")` |
| `s.a = v`, `s.a += v`, `s.a ||= v` | Fast path: `s.set("a", ...)` |
| `s.a++`, `--s.a` | Fast path: `s.update("a", ±1, prefix)` |
| `delete s.a` | Fast path: `s.delete("a")` |
| `const { a, b: x = 1 } = s`, `({ a } = s)` | Fast path: `= { a: s.get("a"), b: s.get("b") }` |
| `s.method()`, `s.method?.()` | Fast path: `s.get("method").call(s)`; `this.x` inside the method is compiled too. Methods are batched. |
| Getters (`get total() {...}`) | Fast path: run with the `ProxyLike` as `this` (tracked, not cached). |
| Nested values (`s.user.name = "x"`, `s.items.push(1)`) | Fast path for `s`; the nested values are deep observables. |
| Exported, passed to a function, aliased (`const t = s`), returned, spread, `Object.keys(s)`, `"a" in s`, dynamic keys (`s[k]`), writes in destructuring patterns, `observable()` not stored in a variable, reassigned bindings | Runtime (with the property operations above compiled to runtime calls) |
| Setters, `observable.ref` / `.shallow` / `.struct` / bound / excluded members, annotation overrides, options | Runtime |
| `...rest` in a destructuring of `s` | Runtime |

Why an observable went to the runtime is reported as an info diagnostic (`runtime-observable`),
returned by `transformSobx` and not printed by the bundler plugins.

## Reactivity

| Pattern | Outcome |
|---|---|
| Reads in reactions, autoruns and computeds, including in functions they call and conditional reads | Tracked dynamically, like MobX. |
| Observables shared across modules | Runtime: exported observables are accessor-based, so other modules' reads and writes of declared properties are tracked; the compiler rewrites the other operations in each module that imports `@sobx/magic`. |
| Changing observed observables outside actions | Warning at runtime in development builds, as in MobX (`configure({ enforceActions })`: `"observed"` by default, `"always"`, `"never"`). Reactions and effects may change state. |
| Writes inside a reaction's data function, autorun or computed | Warning (`write-in-derivation`). |
| Accesses after `await` in an action or tracked function | Warning (`after-await`): they run outside the action / tracking, as in MobX. |
| A reaction that keeps changing what it depends on | Throws after 100 iterations. |
| Errors thrown in reactions | Logged with `console.error`; other reactions keep running. |

## Differences from MobX

`packages/runtime/src/parity.spec.ts` runs the same scenarios against `mobx` (its default mode)
and `@sobx/runtime` (arrays, objects, Maps, Sets, boxes, reactions, computeds, `when`, classes,
`enforceActions` warnings), using the explicit API on the sobx side where MobX relies on its
proxies; the compiler's parity tests run the same source as is against MobX and compiled against
sobx (added / deleted keys, `in`, `Object.keys`, dynamic keys, array index / `length` writes,
nested writes). Both check that the logged values match. Known differences:

- No `Proxy`: an operation the compiler can't see is not observed by itself. That is: adding or
  deleting keys, `in` / `Object.keys`, and array index / `length` writes in code that receives an
  observable without the compiler knowing (a function parameter, an alias such as
  `const t = store`, a module not compiled by sobx). Use the explicit API there (`set`, `remove`,
  `has`, `keys`, `array.set(i, v)`, `array.setLength(n)`). Reading an array's `length` / `[i]`
  from a variable captured outside a derivation isn't tracked either; use `array.get(i)` or
  a method.

- Cyclic plain data (`x.self = x`) converts to an observable with the same cycle; MobX
  overflows the stack.
- Arrays are tracked as a whole (as in MobX), and Maps per key; there is no finer-grained
  tracking of individual array indexes.
- `when` without an effect rejects with `Error("WHEN_TIMEOUT")` / `Error("WHEN_CANCELLED")`;
  a cancelled flow rejects with a `FlowCancellationError` (`isFlowCancellationError(e)`).
- Getters on fast-path objects are not cached (they are re-run when read); computeds created
  with `computed()`, `observable()` (runtime), `makeObservable` / `makeAutoObservable` or
  `@computed` are cached.
- `autoAction` members are batched but not untracked.
- An array mutation notifies every observable property that held the array since it was
  stored (owners are released when a property is overwritten; an element removed from an array
  with `copyWithin` / `fill` may keep notifying it, which can only cause an extra re-run).
- Development checks other than `enforceActions` (`computedRequiresReaction`,
  `observableRequiresReaction`, ...) are not implemented.
- Not implemented: `extendObservable`, `observe` / `intercept`, `spy` / `trace`, `onBecomeObserved`,
  reaction schedulers / `delay`, legacy decorators.
- React: [`@sobx/react`](../packages/react) has mobx-react's API, except `disposeOnUnmount`,
  `PropTypes` and mobx-react's development check of class components' `this.props` /
  `this.state` read from other derivations.
