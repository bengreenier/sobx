# @sobx/compiler

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

Compiles MobX-style code written against `@sobx/magic` (or another configured module) to run on `@sobx/runtime`, with local observable objects compiled to explicit `get` / `set` calls. Plugins are provided for Vite, Rollup, Webpack, esbuild, Rolldown, and Rspack. See [what's supported](../../docs/support.md).

## Install

```bash
pnpm add -D @sobx/compiler
pnpm add @sobx/magic @sobx/runtime
```

Compiled code imports `@sobx/runtime`, so it must be a (non-dev) dependency of your app.

## Bundler plugins

Each entry exports a `sobxCompiler(options?)` function. Only files that import from the configured module (default `"@sobx/magic"`) are transformed.

| Package subpath   | Use with   |
|-------------------|------------|
| `@sobx/compiler`  | unplugin-ast (generic) |
| `@sobx/compiler/vite`   | Vite   |
| `@sobx/compiler/rollup` | Rollup |
| `@sobx/compiler/webpack`| Webpack |
| `@sobx/compiler/esbuild`| esbuild |
| `@sobx/compiler/rolldown` | Rolldown |
| `@sobx/compiler/rspack` | Rspack |

### Options

- **`include`** — Pattern(s) for files to transform. Default: `/\.[jt]sx?$/`
- **`exclude`** — Pattern(s) to skip. Always merged with `/node_modules/` (parsing deps via Babel is very slow).
- **`moduleSpecifier`** — Module to treat as sobx (only transform imports from here). Default: `"@sobx/magic"`
- **`diagnostics`** — Per-code severity overrides, e.g. `{ "deep-mutation": "warning" }`. `"error"` fails the build, `"warning"` is logged, `"info"` and `"off"` are silent. Defaults are in `DEFAULT_SEVERITY`.

Standard decorators (`@observable accessor x`) are parsed; your bundler must also transform them for your target (for example esbuild with `target: "es2022"`).

### Vite

```ts
import { defineConfig } from "vite";
import { sobxCompiler } from "@sobx/compiler/vite";

export default defineConfig({
  plugins: [sobxCompiler()],
});
```

### Rollup

```ts
import { sobxCompiler } from "@sobx/compiler/rollup";

export default {
  plugins: [sobxCompiler()],
};
```

### Webpack

```ts
import { sobxCompiler } from "@sobx/compiler/webpack";

export default {
  plugins: [sobxCompiler()],
};
```

### esbuild

```ts
import { build } from "esbuild";
import { sobxCompiler } from "@sobx/compiler/esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  plugins: [sobxCompiler()],
});
```

### Rolldown

```ts
import { sobxCompiler } from "@sobx/compiler/rolldown";

export default {
  plugins: [sobxCompiler()],
};
```

### Rspack

```ts
import { sobxCompiler } from "@sobx/compiler/rspack";

export default {
  plugins: [sobxCompiler()],
};
```

## How it works

1. **Analyze.** Each file that mentions the module specifier is analyzed by the sobx analyzer, a native (Rust / [oxc](https://oxc.rs)) addon that produces the IR described by [`@sobx/ast`](../ast).
2. **Report.** The analyzer's diagnostics are re-graded for compiling, and the compiler adds its own (unsupported options, observables left to the runtime). Errors fail the build, with every error listed (`file:line:col - error code: message`); warnings are logged.
3. **Rewrite.**
   - Imports from the module specifier are redirected to `@sobx/runtime`, which implements the whole supported API (`observable`, `computed`, `reaction`, `autorun`, `action`, `runInAction`, `makeObservable`, `makeAutoObservable`, annotations and decorators).
   - Local `observable({...})` objects whose every use can be rewritten (the fast path) become a `ProxyLike`: reads become `s.get("k")`, writes `s.set("k", v)`, `++` / `--` `s.update(...)`, `delete` `s.delete(...)`, destructuring and method calls (`s.get("m").call(s)`) too, and `this.k` inside their methods. Everything else (exported or escaping objects, dynamic keys, classes, ...) is left to the runtime, which puts it behind a `Proxy`.
   - On the observables it sees created that aren't on the fast path, undeclared and dynamic keys, `delete`, `in`, `Object.keys` / `values` / `entries`, array index and `length`, and writes through nested values become direct runtime calls (`getProperty`, `setProperty`, `deleteProperty`, `hasProperty`, `keysOf`...). Their `Proxy` observes them anyway; with `configure({ useProxies: "never" })`, these calls do. What can't be rewritten is an info diagnostic (`unsupported-operation`, `uncompiled-write`).
   - Nothing else is touched: code that only uses parameters, imports, plain data... is output as it is.

Names are resolved through scopes, so a parameter or local variable that shadows an observable, or a function named `observable` that isn't imported from the API module, is left alone.

### Native analyzer

The analyzer is loaded from, in order:

1. the path in `SOBX_NATIVE_PATH`, if set;
2. `sobx-compiler.node` in the package root (a local build);
3. the prebuilt `@sobx/compiler-<platform>` package. These aren't published yet.

To build it from source (requires a Rust toolchain):

```bash
pnpm --filter @sobx/compiler build:native   # writes sobx-compiler.node (git-ignored, not published)
```

## Programmatic API

- **`transformSobx(program, source, options?)`**: compile a Babel `Program`. `source` must be the text it was parsed from, since nodes are matched to the analysis by offset. Returns `{ ast, diagnostics, needsProxyLike }`; it doesn't throw on error diagnostics. Options: `moduleSpecifier`, `filename`, `diagnostics`.
- **`analyze(source, options?)`**: run the native analyzer and return the module's IR (`SobxModule`).
- **`compileUnit(program, source, options?)`**: the plan and diagnostics for a module, without rewriting.
- **`compileDiagnostics`**, **`formatDiagnostic`**, **`DEFAULT_SEVERITY`**, **`SobxCompileError`**: diagnostics helpers.
- **`SobxTransformer(options?)`** and **`PARSER_PLUGINS`**: the unplugin-ast transformer used by the bundler plugins, and the Babel parser plugins it needs.

## Development

The transform fixtures in `src/__fixtures__` import from `"mobx"` (and tests pass `moduleSpecifier: "mobx"`) to avoid a circular dependency on the `@sobx/magic` package. The tests need the native analyzer built (`pnpm --filter @sobx/compiler build:native`).

The analyzer's own tests are in `src/analyzer`: specs that assert on the IR for each pattern, and an invariant fuzz (`fuzz.spec.ts`; `SOBX_FUZZ_SEEDS` sets the number of generated programs, 400 by default).
