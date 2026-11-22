# What sobx supports

sobx is MobX-compatible code (`import { ... } from "@sobx/magic"`), compiled at build time. Every
supported API is implemented by [`@sobx/runtime`](../packages/runtime), a MobX-style runtime
(dependency tracking, batching, computeds, reactions, deep observables). The compiler redirects
`@sobx/magic` imports to it, and on top of that compiles local observable objects to a faster
form.

**How observables work.** Local observable objects whose every use the compiler can see are
compiled to a `ProxyLike`, with no `Proxy` involved (the fast path). Every other observable object
or array is behind a `Proxy`, as in MobX, so any code that uses it (compiled or not: components
receiving it as props, other modules, libraries) is observed. Code that doesn't use an observable
the compiler sees is left exactly as it is, so plain data costs nothing.

Each pattern below has one of these outcomes:

- **Fast path**: compiled to a `ProxyLike` with explicit `get` / `set` calls (no proxy, no accessors).
- **Runtime**: works, through `@sobx/runtime` (proxied observable objects and arrays, classes, Maps, Sets).
- **Error**: fails the build with a diagnostic, because it would fail at runtime.
- **Warning**: compiled, with a warning (likely a mistake).

You can change any diagnostic's severity with the compiler's `diagnostics` option.

Setup: `pnpm add @sobx/magic @sobx/runtime` and `pnpm add -D @sobx/compiler`, then add the
compiler's plugin to your bundler. `@sobx/runtime` must be a direct dependency, since compiled
code imports it.

## APIs

| API | Supported | Notes |
|---|---|---|
| `observable({...}, overrides?, options?)` | Yes | Fast path when local and fully analyzable, otherwise runtime (a `Proxy`). Options: `autoBind`, `deep`, `name`, `proxy` (`false`: no `Proxy` for this object). |
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
| `set`, `remove`, `has`, `get`, `keys`, `values`, `entries` | Yes | MobX's object API, for observable objects, arrays, Maps and Sets. |
| `configure({ enforceActions, useProxies })` | Yes | `useProxies`: `"always"` (default) / `"ifavailable"`, or `"never"` (see [Without proxies](#without-proxies)). Other MobX options are ignored, with a warning in development. |
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
| `useLocalObservable(initializer, annotations?)` | Yes | A runtime observable. |
| `Provider`, `inject`, `MobXProviderContext` | Yes | |
| `enableStaticRendering`, `isUsingStaticRendering` | Yes | For server-side rendering. |
| `useObserver`, `useLocalStore`, `useAsObservableSource`, `useStaticRendering`, `observerBatching`, `isObserverBatched` | Yes | Deprecated, as in mobx-react. |
| `disposeOnUnmount`, `PropTypes` | Yes | `disposeOnUnmount` is deprecated, as in mobx-react. |

Components don't need to be compiled: observables they receive as props, through context, from a
hook or from another module are proxied, so they're observed however the component uses them
(`store?.later`, `const { later } = store`, `{ ...store }`...). Renders that React discards without mounting release their subscriptions (through
`FinalizationRegistry`), as in mobx-react. Tested against React 18 and 19.

## Values

Observables are **deep** by default, as in MobX: plain objects, arrays, Maps and Sets put into an
observable (object property, class field, array element, Map / Set value, box) become observable
themselves, recursively, when they are stored.

| Pattern | Outcome |
|---|---|
| Nested objects and arrays (`store.user.name = "x"`, `store.items.push(x)`, `store.items[0] = x`) | Tracked. |
| Adding / deleting keys (`store.newKey = 1`, `delete store.k`), dynamic keys (`store[k]`), `"k" in store`, `Object.keys` / `values` / `entries(store)`, keys that don't exist yet, destructuring, spreads, `for...in`, `Object.assign`, `Reflect.*`, `Object.defineProperty`, `JSON.stringify` | Tracked. On observables the compiler sees, some are compiled to runtime calls. `Object.hasOwn` isn't tracked, as in MobX. |
| Arrays: methods, iteration, `Array.isArray`, `JSON.stringify` | Real arrays (behind a `Proxy`). Methods and iteration are tracked as a whole; a mutating method notifies once. |
| Array `length` / `[i]` reads | Tracked. |
| Array `[i] = v` / `length = n` writes | Tracked. |
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

## Without proxies

`configure({ useProxies: "never" })` (before creating observables) turns proxies off, for
environments without `Proxy`. Observable objects and arrays then only observe what accessors and
array methods can: reads and writes of their declared properties, methods and iteration, and
reads of an array or object through the property holding it. The compiler rewrites adding /
deleting keys, dynamic keys, `in`, `Object.keys` and array index / `length` on observables it sees
created; everywhere else, use `set`, `remove`, `has`, `get`, `keys`, `array.set(i, v)`,
`array.setLength(n)`. Operations it can't rewrite are reported as `unsupported-operation` /
`uncompiled-write`, which are info diagnostics by default: make them errors with the compiler's
`diagnostics` option if you turn proxies off.

## Reactivity

| Pattern | Outcome |
|---|---|
| Reads in reactions, autoruns and computeds, including in functions they call and conditional reads | Tracked dynamically, like MobX. |
| Observables shared across modules | Runtime: proxied, so every module's use of them is observed. |
| Changing observed observables outside actions | Warning at runtime in development builds, as in MobX (`configure({ enforceActions })`: `"observed"` by default, `"always"`, `"never"`). Reactions and effects may change state. |
| Writes inside a reaction's data function, autorun or computed | Warning (`write-in-derivation`). |
| Accesses after `await` in an action or tracked function | Warning (`after-await`): they run outside the action / tracking, as in MobX. |
| A reaction that keeps changing what it depends on | Throws after 100 iterations. |
| Errors thrown in reactions | Logged with `console.error`; other reactions keep running. |
| Errors thrown in computeds | Cached and rethrown to every reader, as in MobX; readers still depend on the computed and on what it read before throwing. |

## Differences from MobX

The runtime and the compiler are tested against MobX itself:

- `packages/runtime/src/plain-js.spec.ts` runs plain JavaScript (24 ways of reading and 10 ways of
  writing a key that doesn't exist yet, array operations, `this`, identity...) as is against `mobx`
  and `@sobx/runtime`; `parity.spec.ts` covers the API.
- `packages/compiler/src/values.spec.ts` runs the same source as is against MobX and compiled
  against sobx, for the same patterns and six ways of reaching the observable (directly, as a
  parameter, through an alias, nested, in a plain local, as a class field); `compile.spec.ts`
  covers the API.

They compare what is logged, including how often reactions run. Known differences:

- `"i" in array` and `Object.keys(array)` are tracked (MobX doesn't track them).
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
- Development checks other than `enforceActions` (`computedRequiresReaction`,
  `observableRequiresReaction`, ...) are not implemented.
- Not implemented: `extendObservable`, `observe` / `intercept`, `spy` / `trace`, `onBecomeObserved`,
  reaction schedulers / `delay`, legacy decorators.
- React: [`@sobx/react`](../packages/react) has mobx-react's API; `observerBatching` does
  nothing (React 18+ batches updates itself).
- Plain object literals from another realm (an iframe, `node:vm`) are accepted by `observable()`,
  as in MobX; Maps and Sets from another realm are stored as they are.
