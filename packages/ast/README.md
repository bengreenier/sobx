# @sobx/ast

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

The types of sobx's intermediate representation (IR) of a program's MobX-style usages. The analyzer that builds the IR ships with [`@sobx/compiler`](../compiler), as a native (Rust / oxc) binary.

The IR is **plain, JSON-serializable data**: string kinds, character spans, and cross-references by stable id (`observable:0`, `reaction:0`, `access:3`, ...). No parser nodes leak into it, so any front-end can produce it and any back-end (the compiler, linters, tooling) can consume it.

The analyzer is **sound or loud**: anything it cannot model precisely (aliasing, escaping references, dynamic keys, nested mutation, opaque functions, unsupported APIs, ...) is reported as a `Diagnostic` instead of being silently dropped.

## Install

```bash
pnpm add @sobx/ast
```

## Exports

- **`SobxModule`** and the rest of the IR types (`Observable`, `Computed`, `Access`, `Reaction`, `Action`, `Diagnostic`, ...).
- **`IR_VERSION`**: the IR's version number, bumped on breaking changes.

## The IR

Modeled APIs: `observable`, `makeObservable`, `makeAutoObservable`, `computed`, `reaction`, `autorun`, `when`, `action`, `runInAction`, `flow`. Utilities (`comparer`, `toJS`, `configure`, `untracked`, the `isObservable*` checks, the explicit API `set` / `remove` / `has` / `get` / `keys` / `values` / `entries`) are recognized and not analyzed. Observable arrays, boxes, Maps and Sets (`observable([])`, `observable.box()`, `observable.map()`, `observable(new Map())`, ...) are recorded as observables with an `array` / `box` / `map` / `set` shape (`opaque-observable`, info); accesses of arrays stored in a variable are recorded (index, `length`, methods), those of boxes, Maps and Sets are left to the runtime. Mutating the value of an `observable.ref` / `observable.struct` property (which is not observable) is reported as `deep-mutation`.

A `SobxModule` contains:

| Field | Contents |
|-------|----------|
| `imports` | Named / namespace / default imports from `moduleSpecifier`, each resolved to a known API (or `null`). |
| `observables` | Observable objects (`observable({...})`, `makeAutoObservable({...})`) with their binding, and observable classes (`makeObservable(this, ...)` / `makeAutoObservable(this)` in a constructor, or standard decorators alone) with their instances. Each has a shape whose members carry their effective annotation (explicit, decorator, or inferred, with `autoBind` / `deep` options applied) and links to backing computeds / actions. |
| `computeds` | `computed(...)` boxes and `computed` getters, with their body, direct dependency access ids, and indirect dependencies (reads in functions the body calls). |
| `accesses` | Every `Read` / `Write` / `Delete` of an observable property (via a binding or `this`), and every `ComputedRead` (`c.get()`), with its tracking context (`untracked`, `tracked`, `tracked-nested`, `effect`, `action`, `after-await`). Reads also record the nested property path (`store.user.name` → `["name"]`) and whether the value is called. |
| `reactions` | Each `reaction(...)` (data / effect functions), `autorun(...)` (body) and `when(...)` (predicate / optional effect), with options, direct and indirect dependency access ids, and whether the disposer is used. |
| `actions` | `runInAction(...)`, `action(...)`, `flow(...)`, and annotated members (including flows), with the write access ids they contain (writes after an `await` are excluded). |
| `unsupported` | Usages of recognized-but-unmodeled APIs. |
| `diagnostics` | Everything that could not be modeled precisely, with a code, severity, and span. |

Names are resolved through scope bindings, so a local variable that shadows an observable is never mistaken for it. `this` is resolved to its owning object literal or class (arrow functions are transparent; plain functions and static members are not linked). Ids (`observable:0`, `computed:1`, ...) are assigned in source order within each kind.

## Example

For this module:

```ts
import { observable, reaction } from "@sobx/magic";
const store = observable({ a: 1, b: 2 });
reaction(() => store.a + store.b, (sum) => console.log(sum));
```

the analyzer produces a `SobxModule` where:

```ts
mod.reactions[0]?.dependencies; // ["access:0", "access:1"]
mod.accesses.map((a) => a.kind); // ["Read", "Read"]
mod.diagnostics; // []
```

## Scope

Analysis is per-module. Cross-module observables are surfaced as diagnostics: `observable-escape` when exported, and `unresolved-import` when an import is used inside a tracked function.
