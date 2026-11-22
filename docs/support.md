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
- **Error**: fails the build with a diagnostic, because it would fail at runtime (unknown imports and
  options, annotations that don't fit their member, missing arguments...).
- **Warning**: compiled, with a warning (likely a mistake).

You can change any diagnostic's severity with the compiler's `diagnostics` option.

Setup: `pnpm add @sobx/magic @sobx/runtime` and `pnpm add -D @sobx/compiler`, then add the
compiler's plugin to your bundler. `@sobx/runtime` must be a direct dependency, since compiled
code imports it.

## APIs

| API | Supported | Notes |
|---|---|---|
| `observable({...}, overrides?, options?)` | Yes | Fast path when local and fully analyzable, otherwise runtime (a `Proxy`). Options: `autoBind`, `deep`, `defaultDecorator`, `name`, `proxy` (`false`: no `Proxy` for this object). |
| `observable.object({...}, overrides?, options?)`, `extendObservable(target, {...}, overrides?, options?)` | Yes | Runtime. |
| `observable([...])`, `observable.array(values?, options?)` | Yes | An `ObservableArray` (a real `Array` subclass), with MobX's `clear`, `replace`, `remove`, `spliceWithArray`. Options: `deep`, `defaultDecorator`, `name`, `proxy`. |
| `observable(new Map())`, `observable.map()`, `observable(new Set())`, `observable.set()` | Yes | Runtime, with MobX's `merge`, `replace`, `toJSON`... Options: `deep`, `defaultDecorator`, `name`. |
| `observable.box(value, options?)`, `observable(primitive or function)` | Yes | `get()` / `set()`. Options: `equals`, `deep`, `defaultDecorator`, `name`. |
| `observable(classInstance)`, `observable(date)`, ... | Yes | Returned as they are, as in MobX. |
| `computed(fn, options?)` | Yes | Cached while observed, and within a batch. Options: `equals`, `name`, `keepAlive`, `set`, `context`, `requiresReaction`, `compareStructural` / `struct`. |
| `reaction(data, effect, options?)` | Yes | Effect gets `(value, previous, reaction)`. Options: `fireImmediately`, `equals`, `name`, `delay`, `scheduler`, `onError`, `requiresObservable`, `signal`. |
| `autorun(fn, options?)` | Yes | Options: `name`, `delay`, `scheduler`, `onError`, `requiresObservable`, `signal`. |
| `when(predicate, effect, options?)`, `when(predicate, options?)` (promise) | Yes | The promise has `cancel()`. Options: `timeout`, `name`, `onError`, `requiresObservable`, `signal`. |
| `action(fn)`, `action(name, fn)`, `runInAction(fn)`, `transaction(fn)` | Yes | Actions are batched and untracked. |
| `flow(function* () {...})` | Yes | Each step between `yield`s runs as an action; the returned promise has `cancel()`. Async generators too. Generator methods are inferred as flows. `isFlow`, `flowResult`, `FlowCancellationError`. |
| `makeObservable(this, annotations, options?)`, `makeAutoObservable(this, overrides?, options?)` | Yes | Runtime. Subclasses, `override`. Annotations and options may come from anywhere (a variable, a spread...). Options: `autoBind`, `deep`, `name`, `defaultDecorator`. |
| Annotations: `observable`, `observable.ref` / `.shallow` / `.struct` / `.deep`, `computed`, `computed.struct`, `computed({ ... })`, `action`, `action("name")`, `action.bound`, `override`, `flow`, `flow.bound`, `false`, `true` | Yes | |
| Standard decorators: `@observable accessor x` (and `.ref` / `.shallow` / `.struct` / `.deep`), `@computed get x()`, `@action m()` / `@action("name") m()` / `@action.bound m()` (and fields), `@computed({ ... }) get x()`, `@flow *m()`, `@flow.bound *m()` | Yes | Your toolchain must transform standard (2022.3) decorators, e.g. esbuild with `target: "es2022"`. |
| `comparer.default` / `.identity` / `.structural` / `.shallow` | Yes | For `equals` options. |
| `toJS(value)` | Yes | Converts an observable, and the observables in it, to plain arrays, objects, Maps and Sets (without computed properties; cycles preserved). What isn't observable stays as it is, as in MobX. |
| `set`, `remove`, `has`, `get`, `keys`, `values`, `entries`, `ownKeys`, `defineProperty` | Yes | MobX's object API, for observable objects, arrays, Maps and Sets. |
| `configure({...})` | Yes | `enforceActions`, `useProxies` (`"always"` by default; `"ifavailable"`: development builds also throw for what needs proxies; `"never"`: see [Without proxies](#without-proxies)), `computedRequiresReaction`, `reactionRequiresObservable`, `observableRequiresReaction`, `disableErrorBoundaries`, `safeDescriptors`, `reactionScheduler`, `isolateGlobalState`. |
| `observe`, `intercept`, `onBecomeObserved`, `onBecomeUnobserved`, `onReactionError` | Yes | Also as methods, where MobX has them (`array.observe(...)`, `box.intercept(...)`). |
| `spy`, `trace`, `getDebugName`, `getDependencyTree`, `getObserverTree`, `getAtom`, `createAtom`, `Reaction`, `$mobx` | Yes | `spy` is for development builds, as in MobX. |
| `isObservable`, `isObservableArray`, `isObservableObject`, `isObservableMap`, `isObservableSet`, `isBoxedObservable`, `isObservableProp`, `isComputed`, `isComputedProp`, `isAction`, `isFlow`, `isFlowCancellationError`, `untracked` | Yes | |
| Legacy (`experimentalDecorators`) decorators: `@observable x`, `@computed get x()`, `@action m()`, `@action("name")`, `@flow *m()`, `@override`... | Yes | With `makeObservable(this)` in the constructor, as in MobX. Without it: error (`invalid-annotation`). With either setting of `useDefineForClassFields`. |
| `_allowStateChanges`, `_autoAction`, `_interceptReads`, `_startAction`, ... (MobX's exports for other libraries) | Yes | |
| Types: `IObservableArray`, `IReactionDisposer`, `IObjectDidChange`, `IObservableFactory`, ... | Yes | All of those MobX exports, by the same names. They don't need `import type`. |

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
| `observable.struct` | Not converted; a new value that is structurally equal is not a change. Throws for observable values, as in MobX. |
| `{ deep: false }` (on `observable()`, `makeObservable()`, `observable.array()`, ...) | Inferred members are `observable.ref`. |
| Class instances, `Date`, ... | Stored as they are (as in MobX). |
| Functions | Auto-actions (generator functions: flows), as in MobX; as they are with `observable.ref`. |
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
| Getters (`get total() {...}`) | Fast path: computeds, run with the `ProxyLike` as `this`. |
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
| A reaction that keeps changing what it depends on | Stopped after 100 iterations, with `console.error`, as in MobX. |
| Errors thrown in reactions | Logged with `console.error` (or given to `onError` / `onReactionError`); other reactions keep running. |
| Errors thrown in computeds | Cached and rethrown to every reader, as in MobX; readers still depend on the computed and on what it read before throwing. |

## Differences from MobX

The runtime and the compiler are tested against MobX itself: the same code runs with MobX 6.16.1
and with sobx, and what it logs is compared, including how often reactions run.

- In `packages/runtime/src`: `plain-js.spec.ts` runs plain JavaScript on observables (24 ways of reading
  and 10 ways of writing a key that doesn't exist yet, array operations, `this`, identity...);
  `parity.spec.ts` covers the API, and `features.spec.ts` its less common parts (change objects, spy
  events, names, the order of notifications, which warnings...); `conformance.spec.ts` what MobX's own
  tests found (below); `completeness.spec.ts` checks that every MobX export, and every public member
  of what they return, exists.
- In `packages/compiler/src`: `values.spec.ts` compiles the same source for six ways of reaching an
  observable (directly, as a parameter, through an alias, nested, in a plain local, as a class
  field); `compile.spec.ts` covers the API; `mobx-api.spec.ts` checks that every MobX export can be
  imported from `@sobx/magic`, and that valid MobX code (including legacy and standard decorators)
  compiles without errors and behaves the same.
- In `packages/magic/type-tests`: the types, with both kinds of decorators.

MobX's own test suite was also run against the runtime (not part of this repo). Of the 825 tests
MobX itself passes in the same setup, 803 pass as they are, and 809 if the wording of messages isn't
compared. To run it, the setup maps the private names the tests use (`observers_`, `values_`...) and
the prefixes of messages to sobx's. The other 16 check more of MobX's internals (11), numbers in debug
names (3), or the `toString` tag of iterators (2).

Known differences:

- `"i" in array` and `Object.keys(array)` are tracked (MobX doesn't track them).
- `set.has(value)` depends on that value only (in MobX, on the whole Set).
- Cyclic plain data (`x.self = x`) converts to an observable with the same cycle; MobX
  overflows the stack.
- The results of `ObservableSet`'s `union`, `intersection`... are in JavaScript's order, and iterators
  of Maps and Sets are JavaScript's own.
- Messages of errors and warnings start with `sobx`, and some are worded differently. The numbers in
  debug names (`ObservableObject@3`) may differ.
- MobX's private fields (`observers_`, `values_`...) don't exist.
- Members with standard decorators are set up when the instance is created (MobX 6.16 does it when
  they're first used).
- Each copy of the runtime has its own state (as with MobX's `isolateGlobalState`, which is accepted
  but does nothing more).
- `configure({ useProxies: "ifavailable" })` can be undone; MobX keeps checking.
- React: [`@sobx/react`](../packages/react) has mobx-react's API; `observerBatching` does
  nothing (React 18+ batches updates itself).
- Plain object literals from another realm (an iframe, `node:vm`) are accepted by `observable()`,
  as in MobX; Maps and Sets from another realm are stored as they are.
