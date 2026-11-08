# @sobx/compiler

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

Compiles sobx usage: rewrites `observable`, property access, `reaction`, and `runInAction` imported from a configurable module (default `"@sobx/magic"`) into code that uses `@sobx/runtime`. Plugins are provided for Vite, Rollup, Webpack, esbuild, Rolldown, and Rspack.

## Install

```bash
pnpm add @sobx/compiler
```

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

Each file is analyzed by the sobx analyzer, a native (Rust / [oxc](https://oxc.rs)) addon that produces the IR described by [`@sobx/ast`](../ast). The compiler rewrites exactly what the analysis identifies:

- **`observable({...})`** → `new ProxyLike({...})`, plus `import { ProxyLike } from "@sobx/runtime"`.
- **Reads** of those observables' properties (`store.count`) → `store.get("count")`.
- **Writes** (`store.count = v`, `store.count += v`, `store.count++`) → `store.set("count", ...)`.
- **`reaction(data, effect)`** → an `addObserver` per key the data function reads, including reads in local functions and observable methods it calls.
- **`runInAction(fn)`** → `fn()`.

Names are resolved through scopes, so a parameter or local variable that shadows an observable, or a function named `observable` that isn't imported from the API module, is left alone. Classes (`makeObservable` / `makeAutoObservable`) and the other APIs are analyzed but not compiled yet.

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

- **`analyze(source, options?)`**: run the native analyzer and return the module's IR (`SobxModule`). Options: `moduleSpecifier`, `filename`.
- **`transformSobx(program, source, options?)`**: compile a Babel `Program`. `source` must be the text it was parsed from, since nodes are matched to the analysis by offset. Returns `{ ast, needsProxyLike, needsReaction }`.
- **`planSource(source, options?)`** / **`planFromModule(ir)`**: what the compiler would rewrite, keyed by source span.
- **`SobxTransformer(moduleSpecifier?)`**: the unplugin-ast transformer used by the bundler plugins.
- **`buildReactionExpression`, `ensureImports`**: helpers used by the compiler.

## Development

The transform fixtures in `src/__fixtures__` import from `"mobx"` (and tests pass `moduleSpecifier: "mobx"`) to avoid a circular dependency on the `@sobx/magic` package. The tests need the native analyzer built (`pnpm --filter @sobx/compiler build:native`).
