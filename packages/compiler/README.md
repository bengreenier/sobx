# @sobx/compiler

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

Compiles sobx usage: rewrites `observable`, `reaction`, and `runInAction` imported from a configurable module (default `"sobx"`) into code that uses `@sobx/core`. Plugins are provided for Vite, Rollup, Webpack, esbuild, Rolldown, and Rspack.

## Install

```bash
pnpm add @sobx/compiler
```

## Bundler plugins

Each entry exports a `sobxCompiler(options?)` function. Only files that import from the configured module (default `"sobx"`) are transformed.

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
- **`moduleSpecifier`** — Module to treat as sobx (only transform imports from here). Default: `"sobx"`

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

## Programmatic API

For custom pipelines you can use the transform and transformer APIs:

- **`transformSobx(code, options?)`** — Transform source code. Options include `moduleSpecifier` and filename.
- **`collectObservableBindings(program, moduleSpecifier?)`** — Collect observable bindings from an AST.
- **`getSobxImportLocalNames(program, moduleSpecifier?)`** — Get local names for sobx imports.
- **`buildReactionExpression`, `ensureImports`, `getMemberKey`** — Helpers used by the compiler.
- Individual transformers: `ObservableTransformer`, `ReactionTransformer`, `MemberExpressionTransformer`, `AssignmentExpressionTransformer`, `ImportInjectionTransformer`.

See type definitions in the package for details.

## Development

The transform fixtures in `src/__fixtures__` import from `"mobx"` (and tests pass `moduleSpecifier: "mobx"`) to avoid a circular dependency on the `sobx` package.

