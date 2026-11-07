# @sobx/ast

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

sobx's intermediate representation (IR) of a program's MobX-style usages, plus an analyzer that builds it from TypeScript / JavaScript source.

The IR is **plain, JSON-serializable data**: string kinds, character spans, and cross-references by stable id (`observable:0`, `reaction:0`, `access:3`, ...). No parser nodes leak into it, so any front-end can produce it and any back-end (the compiler, linters, tooling) can consume it.

The analyzer is **sound or loud**: anything it cannot model precisely (aliasing, escaping references, dynamic keys, nested mutation, opaque functions, unsupported APIs, ...) is reported as a `Diagnostic` instead of being silently dropped.

## Install

```bash
pnpm add @sobx/ast
```

## API

- **`analyze(source, options?)`** — Parse a module and return its `SobxModule`.
- **`analyzeAst(file, options?)`** — Same, from an already-parsed Babel `File` (not mutated).

### Options

- **`moduleSpecifier`** — Module whose imports are analyzed. Default: `"sobx"`.
- **`filename`** — Recorded on the resulting module.

## The IR

Modeled APIs: `observable`, `makeObservable`, `makeAutoObservable`, `computed`, `reaction`, `autorun`, `action`, `runInAction`. Recognized but not yet modeled: `flow`, `when`.

A `SobxModule` contains:

| Field | Contents |
|-------|----------|
| `imports` | Named / namespace / default imports from `moduleSpecifier`, each resolved to a known API (or `null`). |
| `observables` | Observable objects (`observable({...})`, `makeAutoObservable({...})`) with their binding, and observable classes (`makeObservable(this, ...)` / `makeAutoObservable(this)` in a constructor, or standard decorators alone) with their instances. Each has a shape whose members carry their effective annotation (explicit, decorator, or inferred, with `autoBind` / `deep` options applied) and links to backing computeds / actions. |
| `computeds` | `computed(...)` boxes and `computed` getters, with their body, direct dependency access ids, and indirect dependencies (reads in functions the body calls). |
| `accesses` | Every `Read` / `Write` / `Delete` of an observable property (via a binding or `this`), and every `ComputedRead` (`c.get()`), with its tracking context (`untracked`, `tracked`, `tracked-nested`, `effect`, `action`, `after-await`). Reads also record the nested property path (`store.user.name` → `["name"]`) and whether the value is called. |
| `reactions` | Each `reaction(...)` (data / effect functions) and `autorun(...)` (body), with options, direct and indirect dependency access ids, and whether the disposer is used. |
| `actions` | `runInAction(...)`, `action(...)`, and annotated members, with the write access ids they contain (writes after an `await` are excluded). |
| `unsupported` | Usages of recognized-but-unmodeled APIs. |
| `diagnostics` | Everything that could not be modeled precisely, with a code, severity, and span. |

Names are resolved through scope bindings, so a local variable that shadows an observable is never mistaken for it. `this` is resolved to its owning object literal or class (arrow functions are transparent; plain functions and static members are not linked). Ids (`observable:0`, `computed:1`, ...) are assigned in source order within each kind.

## Example

```ts
import { analyze } from "@sobx/ast";

const mod = analyze(`
  import { observable, reaction } from "sobx";
  const store = observable({ a: 1, b: 2 });
  reaction(() => store.a + store.b, (sum) => console.log(sum));
`);

mod.reactions[0]?.dependencies; // ["access:0", "access:1"]
mod.accesses.map((a) => a.kind); // ["Read", "Read"]
mod.diagnostics; // []
```

## Scope

Analysis is currently per-module, using Babel as the front-end. Cross-module observables are surfaced as diagnostics: `observable-escape` when exported, and `unresolved-import` when an import is used inside a tracked function.
