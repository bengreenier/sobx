# What sobx supports

sobx is MobX-compatible code (`import { ... } from "@sobx/magic"`), compiled at build time. Every
supported API is implemented by [`@sobx/runtime`](../packages/runtime), a MobX-style runtime
(dependency tracking, batching, computeds, reactions, deep observables). The compiler redirects
`@sobx/magic` imports to it, and on top of that compiles local observable objects to a faster
form.

**sobx doesn't need `Proxy`.** Operations that MobX observes through its proxies (adding or
deleting keys, keys that don't exist yet, `in`, `Object.keys`, spreads, `for...in`,
`JSON.stringify`, dynamic keys, array index and `length` reads and writes) are compiled into
runtime calls: precisely on the observables the compiler sees created, and on any value whose
origin it can't trace (a parameter such as React props, an import, a call result such as
`useContext()`), which may be an observable. Those runtime calls behave as plain JavaScript on
other values. The compiler processes every module of your app by default.

For code the compiler doesn't process (libraries in `node_modules`, or modules excluded from
compilation), `configure({ useProxies: "always" })` puts observable objects and arrays behind a
`Proxy`, as MobX does, so that code is observed too. It's opt-in: compiled code doesn't need it
and is faster without it (see [Proxies](#proxies-for-code-the-compiler-doesnt-process)).

sobx also has an explicit API: `set`, `remove`, `has`, `get`, `keys`, `values`, `entries` (same
names and semantics as MobX's object API functions).

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
| `configure({ enforceActions, useProxies })` | Yes | `useProxies: "always"` puts new observable objects and arrays behind a `Proxy`, for code the compiler doesn't process. Other MobX options are ignored, with a warning in development. |
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
| `useLocalObservable(initializer, annotations?)` | Yes | A runtime (accessor-based) observable, analyzed from the object literal the initializer returns: adding / deleting keys, dynamic keys, `in` and `Object.keys` on it are compiled to runtime calls. |
| `Provider`, `inject`, `MobXProviderContext` | Yes | |
| `enableStaticRendering`, `isUsingStaticRendering` | Yes | For server-side rendering. |
| `useObserver`, `useLocalStore`, `useAsObservableSource`, `useStaticRendering`, `observerBatching`, `isObserverBatched` | Yes | Deprecated, as in mobx-react. |
| `disposeOnUnmount`, `PropTypes` | Yes | `disposeOnUnmount` is deprecated, as in mobx-react. |

Modules that import `@sobx/magic` or `@sobx/react` are compiled, `.tsx` / `.jsx` included.
Observables a component receives as props, through context, from a hook or from another module
are values the compiler can't trace: their property operations are compiled to runtime calls
(see [Values whose origin can't be traced](#values-whose-origin-cant-be-traced)), so they behave
as with MobX. Renders that React discards without mounting release their subscriptions (through
`FinalizationRegistry`), as in mobx-react. Tested against React 18 and 19.

## Values

Observables are **deep** by default, as in MobX: plain objects, arrays, Maps and Sets put into an
observable (object property, class field, array element, Map / Set value, box) become observable
themselves, recursively, when they are stored.

| Pattern | Outcome |
|---|---|
| Nested objects and arrays (`store.user.name = "x"`, `store.items.push(x)`, `store.items[0] = x`) | Tracked. Writes through a nested value are compiled to runtime calls. |
| Adding / deleting keys (`store.newKey = 1`, `delete store.k`), dynamic keys (`store[k]`), `"k" in store`, `Object.keys` / `values` / `entries(store)` | Compiled to runtime calls (`setProperty`, `deleteProperty`, `getProperty`, `hasProperty`, `keysOf`, ...). `Object.assign(store, ...)` and similar on an observable the compiler sees are build errors. |
| Arrays: methods, iteration, `Array.isArray`, `JSON.stringify`, `structuredClone` | Real arrays. Methods and iteration are tracked as a whole; a mutating method notifies once. |
| Array `length` / `[i]` reads | Tracked: through the observable property holding the array (`store.items.length`: the array notifies the property), or compiled to `getProperty` (`items[0]` on an `observable([...])` variable, or on an array the compiler can't trace, such as a parameter). |
| Array `[i] = v` / `length = n` writes | Compiled to `array.set(i, v)` / `array.setLength(n)` (through `setProperty`). |
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

## Values whose origin can't be traced

A value may be an observable the compiler can't see created: a parameter (React props), an
import from another module, a call result (`useContext(...)`, a hook, a getter function), a
variable initialized from one of these or reassigned, a local object or array that holds one or
lets one in (passed to a function, written with such a value, aliased...), `this` outside an
observable class or object, and anything reached through them (`props.store.items`). On those,
the operations only a `Proxy` would observe are compiled to runtime calls:

| Pattern | Compiled to |
|---|---|
| `o.k` (any key: it may not exist yet), `o[k]`, `o[0]`, `o.length` | `getProperty(o, k)` |
| `k in o`, `Object.keys` / `values` / `entries(o)` | `hasProperty`, `keysOf`, `valuesOf`, `entriesOf` |
| `o.k = v`, `o[k] = v`, `o.k += v`, `o[k]++`, `o.k ||= v`, `delete o[k]` | `setProperty`, `updateProperty`, `deleteProperty` |
| `{ ...o }`, `<C {...o} />`, `for (k in o)`, `Object.getOwnPropertyNames(o)`, `Reflect.ownKeys(o)` | the value goes through `trackKeys(o)` |
| `JSON.stringify(o)`, `structuredClone(o)` | the value goes through `trackDeep(o)` (everything reachable) |
| `Object.assign(o, ...)`, `Object.assign(x, o)` | `assignProperties` (new keys of an observable target become observable) |
| `Object.hasOwn(o, k)`, `o.hasOwnProperty(k)`, `Object.prototype.hasOwnProperty.call(o, k)` | `hasOwnKey(o, k)` |

The helpers are only called for observables: when the object is a name or a static property
chain (`items`, `props.items`), the compiled code checks the mark the runtime puts on observables
inline (`o[$sobx] !== void 0 ? <helper> : <the original operation>`); otherwise, reads take the
helper only inside reactions, computeds and observer renders
(`__sobx_globalState.tracking !== null ? ... : ...`), and the helpers' first check is the same
mark. The runtime calls behave exactly as the plain operations on values that aren't observables
(checked by a differential fuzz test, in and outside derivations).

Cost on plain values (`packages/bench`, a loop of nothing but property and index / `length`
reads, dynamic-key writes and `Object.keys` on plain data reached through parameters): 4% slower
outside derivations, 14% slower inside one (as in an observer render). Output size grows with the
number of such operations (the React example spec, dense with them, grew 26% minified and 15%
gzipped before property reads were rewritten too).

Values known to be plain (literals, local objects and arrays that only ever hold plain values,
`new Map()`, ...), globals, and observables the compiler sees created are left alone or compiled
precisely. Method calls (`o[k]()`), optional chains (`o?.[k]`), destructuring targets and compound
writes whose object or key has side effects are left as they are (no error).

The compiler processes every module by default (`modules: "all"`, an option of the bundler
plugins); `modules: "sobx"` only compiles modules that import `@sobx/magic` or `@sobx/react`, for
faster builds. `node_modules` aren't compiled unless `include`d.

## Proxies for code the compiler doesn't process

Code the compiler never sees (libraries in `node_modules`, `eval`, modules excluded from
compilation) operates on observables as plain JavaScript. To observe it anyway, call
`configure({ useProxies: "always" })` (MobX's option; `"ifavailable"` does the same, `"never"` is
the default) before creating observables. Observable objects and arrays created from then on are
behind a `Proxy`:

- reads of keys that don't exist yet, new keys, `delete`, `in`, `Object.keys` / spreads /
  `for...in` and anything else that lists keys are observed (through the same runtime helpers
  compiled code uses);
- existing keys still go through the observable's accessors, and array methods run on the array
  itself, so the proxy only does what the accessors can't;
- compiled code keeps its fast paths (`ProxyLike` objects aren't proxied).

It costs: on a runtime (accessor-based) observable, a reaction / write loop runs about 70% slower
with proxies (`packages/bench`, `runtime-object-reaction`: 142 ms → 240 ms; MobX: 401 ms).
Class instances (`makeObservable(this)`) aren't proxied, as in MobX.

## Reactivity

| Pattern | Outcome |
|---|---|
| Reads in reactions, autoruns and computeds, including in functions they call and conditional reads | Tracked dynamically, like MobX. |
| Observables shared across modules | Runtime: exported observables are accessor-based, so other modules' reads and writes of declared properties are tracked; the other property operations on an imported value are compiled like those on any value whose origin can't be traced. |
| Changing observed observables outside actions | Warning at runtime in development builds, as in MobX (`configure({ enforceActions })`: `"observed"` by default, `"always"`, `"never"`). Reactions and effects may change state. |
| Writes inside a reaction's data function, autorun or computed | Warning (`write-in-derivation`). |
| Accesses after `await` in an action or tracked function | Warning (`after-await`): they run outside the action / tracking, as in MobX. |
| A reaction that keeps changing what it depends on | Throws after 100 iterations. |
| Errors thrown in reactions | Logged with `console.error`; other reactions keep running. |
| Errors thrown in computeds | Cached and rethrown to every reader, as in MobX; readers still depend on the computed and on what it read before throwing. |

## Differences from MobX

`packages/runtime/src/parity.spec.ts` runs the same scenarios against `mobx` (its default mode)
and `@sobx/runtime` (arrays, objects, Maps, Sets, boxes, reactions, computeds, `when`, classes,
`enforceActions` warnings), using the explicit API on the sobx side where MobX relies on its
proxies; the compiler's parity tests run the same source as is against MobX and compiled against
sobx (added / deleted keys, `in`, `Object.keys`, dynamic keys, array index / `length` writes,
nested writes). Both check that the logged values match. Known differences:

- Without `useProxies`, code the compiler doesn't process (`node_modules` unless included,
  `eval` / `new Function`) only observes the declared properties of observables (through their
  accessors) and array methods / iteration. Turn on `configure({ useProxies: "always" })` to
  observe everything there, or pass it `toJS(store)`.
- `structuredClone` works on sobx observables (MobX's proxies can't be cloned).

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
- Adding or removing a key notifies whatever read the property holding the object
  (`store.tags`), so a derivation that read `store.tags.a` re-runs when `store.tags.b` is added,
  where MobX wouldn't. This can only cause an extra re-run.
- An array mutation notifies every observable property that held the array since it was
  stored (owners are released when a property is overwritten; an element removed from an array
  with `copyWithin` / `fill` may keep notifying it, which can only cause an extra re-run).
- Development checks other than `enforceActions` (`computedRequiresReaction`,
  `observableRequiresReaction`, ...) are not implemented.
- Not implemented: `extendObservable`, `observe` / `intercept`, `spy` / `trace`, `onBecomeObserved`,
  reaction schedulers / `delay`, legacy decorators.
- React: [`@sobx/react`](../packages/react) has mobx-react's API; `observerBatching` does
  nothing (React 18+ batches updates itself).
- Plain object literals from another realm (an iframe, `node:vm`) are accepted by `observable()`,
  as in MobX; Maps and Sets from another realm are stored as they are.
