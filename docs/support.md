# What sobx supports

sobx is MobX-compatible code (`import { ... } from "@sobx/magic"`), compiled at build time. Every
supported API is implemented by [`@sobx/runtime`](../packages/runtime), a small MobX-style runtime
(dependency tracking, batching, computeds, reactions). The compiler redirects `@sobx/magic`
imports to it, and on top of that compiles local observable objects to a faster form.

Each pattern below has one of these outcomes:

- **Fast path**: compiled to a `ProxyLike` with explicit `get` / `set` calls (no accessors).
- **Runtime**: works, through `@sobx/runtime`'s accessor-based observables.
- **Error**: fails the build with a diagnostic, because it would not behave like MobX.
- **Warning**: compiled, with a warning (likely a mistake, as MobX would also warn).

You can change any diagnostic's severity with the compiler's `diagnostics` option.

Setup: `pnpm add @sobx/magic @sobx/runtime` and `pnpm add -D @sobx/compiler`, then add the
compiler's plugin to your bundler. `@sobx/runtime` must be a direct dependency, since compiled
code imports it.

## APIs

| API | Supported | Notes |
|---|---|---|
| `observable({...}, overrides?, options?)` | Yes | Fast path when local and fully analyzable, otherwise runtime. Options: `autoBind`, `deep`, `name`, `proxy`. |
| `computed(fn, options?)` | Yes | Cached while observed. Options: `equals`, `name`, `keepAlive`. |
| `reaction(data, effect, options?)` | Yes | Effect gets `(value, previous, reaction)`. Options: `fireImmediately`, `equals`, `name`. |
| `autorun(fn, options?)` | Yes | Options: `name`. |
| `action(fn)`, `action(name, fn)` | Yes | Batched and untracked. |
| `runInAction(fn)` | Yes | |
| `makeObservable(this, annotations, options?)` | Yes | Runtime. |
| `makeAutoObservable(this, overrides?, options?)` | Yes | Runtime. Getters become computeds, functions become auto-actions. |
| `when(predicate, effect, options?)`, `when(predicate, options?)` (promise) | Yes | The promise has `cancel()`. Options: `timeout`, `name`. |
| `flow(function* () {...})` | Yes | Each step between `yield`s runs as an action; the returned promise has `cancel()`. Generator methods are inferred as flows by `makeAutoObservable` / `observable()`. |
| `observable.box(value, options?)` | Yes | `get()` / `set()`. Options: `equals`, `deep`, `name`. Runtime (reads and writes are not analyzed). |
| `observable.map()`, `observable(new Map())`, `observable.set()`, `observable(new Set())` | Yes | Runtime (reads and writes are not analyzed). Options: `deep`, `name`. |
| `comparer.default` / `.identity` / `.structural` / `.shallow` | Yes | For `equals` options. |
| Annotations: `observable`, `observable.ref` / `.shallow` / `.struct` / `.deep`, `computed`, `computed.struct`, `action`, `action.bound`, `flow`, `flow.bound`, `false` | Yes | |
| Standard decorators: `@observable accessor x`, `@computed get x()`, `@action m()`, `@action.bound m()`, `@flow *m()` | Yes | Your toolchain must transform standard (2022.3) decorators, e.g. esbuild with `target: "es2022"`. |
| Legacy (`experimentalDecorators`) decorators, `@observable x` without `accessor` | No | Error (`invalid-annotation`). |
| `observable.array`, `extendObservable`, `toJS`, `untracked`, `configure`, `observe`, `intercept`, ... | No | Error (`unsupported-api` / `unknown-import`). |
| Other options (e.g. `delay`, `scheduler`, `onError`) | No | Error (`unsupported-option`). |

## Values

| Pattern | Outcome |
|---|---|
| Plain objects | Supported. |
| Maps and Sets | Supported, including as property values: like MobX, a plain Map or Set stored in an observable property (or box, Map, Set) becomes observable, unless the property is `observable.ref` / `.struct`. |
| Observable arrays (`observable([])`) | Error (`observable-collection`); also thrown by the runtime. |
| Nested plain objects and arrays (`store.user.name = "x"`, `store.items.push(x)`) | Error (`deep-mutation`). They are not made observable: replace the value instead (`store.items = [...store.items, x]`), or use a Map / Set. Reads of nested values are fine. |

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
| Exported, passed to a function, aliased (`const t = s`), returned, spread, `Object.keys(s)`, `"a" in s`, dynamic keys (`s[k]`), writes in destructuring patterns, `observable()` not stored in a variable, reassigned bindings | Runtime |
| Setters, `observable.ref` / `.shallow` / `.struct` / bound / excluded members, annotation overrides, options | Runtime |
| `...rest` in a destructuring of `s` | Runtime |

Why an observable went to the runtime is reported as an info diagnostic (`runtime-observable`),
returned by `transformSobx` and not printed by the bundler plugins.

## Reactivity

| Pattern | Outcome |
|---|---|
| Reads in reactions, autoruns and computeds, including in functions they call and conditional reads | Tracked dynamically, like MobX. |
| Observables shared across modules | Runtime (exported observables are accessor-based, so other modules' reads are tracked). |
| Writes inside a reaction's data function, autorun or computed | Warning (`write-in-derivation`). |
| Accesses after `await` in an action or tracked function | Warning (`after-await`): they run outside the action / tracking, as in MobX. |
| A reaction that keeps changing what it depends on | Throws after 100 iterations. |
| Errors thrown in reactions | Logged with `console.error`; other reactions keep running. |

## Differences from MobX

- Nested plain objects and arrays are not made observable (see above); Maps and Sets are.
- No observable arrays.
- `when` without an effect rejects with `Error("WHEN_TIMEOUT")` / `Error("WHEN_CANCELLED")`;
  a cancelled flow rejects with a `FlowCancellationError` (`isFlowCancellationError(e)`).
- Getters on fast-path objects are not cached (they are re-run when read); computeds created
  with `computed()`, `makeObservable` / `makeAutoObservable` or `@computed` are cached.
- `autoAction` members are batched but not untracked.
- MobX's development-time checks (e.g. `enforceActions`) are not implemented.
