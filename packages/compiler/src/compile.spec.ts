import generate from "@babel/generator";
import { parse } from "@babel/parser";
import * as runtime from "@sobx/runtime";
import { resolveOptions, transform } from "unplugin-ast";
import type { CompileDiagnostic } from "./diagnostics.js";
import { analyze } from "./native.js";
import { type TransformSobxOptions, transformSobx } from "./transform.js";
import { PARSER_PLUGINS, SobxTransformer } from "./transformers/sobx.js";

const HEADER = `import { observable, computed, reaction, autorun, action, runInAction, makeObservable, makeAutoObservable } from "@sobx/magic";\n`;

function compileFull(
	body: string,
	options?: TransformSobxOptions,
): { code: string; diagnostics: CompileDiagnostic[] } {
	const source = HEADER + body;
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript", ...PARSER_PLUGINS],
	});
	const result = transformSobx(ast.program, source, options);
	return { code: generate(result.ast).code, diagnostics: result.diagnostics };
}

const compile = (body: string) => compileFull(body).code;
const codes = (body: string) =>
	compileFull(body).diagnostics.map((d) => [d.code, d.severity]);

/** Compile `body`, then run it against @sobx/runtime; returns what it passed to `log`. */
function run(body: string): unknown[] {
	const { code, diagnostics } = compileFull(body);
	const errors = diagnostics.filter((d) => d.severity === "error");
	if (errors.length) throw new Error(errors.map((d) => d.message).join("\n"));
	const script = code.replace(
		/import \{([^}]*)\} from "@sobx\/runtime";/g,
		(_, names: string) => `const {${names.replace(/ as /g, ": ")}} = runtime;`,
	);
	const logs: unknown[] = [];
	new Function("runtime", "log", script)(runtime, (v: unknown) => logs.push(v));
	return logs;
}

/** Run the bundler-plugin path (unplugin-ast + SobxTransformer) on a file. */
async function compileWithPlugin(
	source: string,
	warn: (m: string) => void = () => {},
): Promise<string> {
	const result = await transform(
		source,
		"/src/file.ts",
		resolveOptions({
			parserOptions: { plugins: [...PARSER_PLUGINS] },
			transformer: [SobxTransformer({ warn })],
		}),
	);
	return result?.code ?? source;
}

describe("native analyzer", () => {
	it("returns the IR for a module", () => {
		const mod = analyze(
			`import { observable } from "@sobx/magic"; const s = observable({ a: 1 }); s.a;`,
		);
		expect(mod.kind).toBe("Module");
		expect(mod.observables).toHaveLength(1);
		expect(mod.accesses).toHaveLength(1);
	});

	it("throws on syntax errors", () => {
		expect(() => analyze("const = ;")).toThrow(/failed to parse/);
	});
});

describe("fast path (ProxyLike)", () => {
	it("compiles reads, writes, compound writes, updates and deletes", () => {
		const out = compile(`const s = observable({ n: 0 });
s.n = 1;
s.n += 2;
s.n++;
const before = --s.n;
delete s.n;
log(s.n);`);
		expect(out).toContain("const s = new ProxyLike({");
		expect(out).toContain('s.set("n", 1);');
		expect(out).toContain('s.set("n", s.get("n") + 2);');
		expect(out).toContain('s.update("n", 1, false);');
		expect(out).toContain('const before = s.update("n", -1, true);');
		expect(out).toContain('s.delete("n");');
		expect(out).toContain('log(s.get("n"));');
	});

	it("compiles destructuring, optional chaining and method calls", () => {
		const out =
			compile(`const s = observable({ a: 1, b: 2, inc() { this.a++; } });
const { a, b: renamed = 3 } = s;
log(s?.a);
s.inc();
s.inc?.();`);
		expect(out).toContain('} = {\n  a: s.get("a"),\n  b: s.get("b")\n};');
		expect(out).toContain('log(s?.get("a"));');
		expect(out).toContain('s.get("inc").call(s);');
		expect(out).toContain('s.get("inc")?.call(s);');
		expect(out).toContain('this.update("a", 1, false);');
		expect(out).toContain('actions: ["inc"]');
	});

	it("does not rewrite a local variable that shadows an observable", () => {
		const out = compile(`const store = observable({ count: 0 });
function f(store) { return store.count; }
store.count;`);
		expect(out).toContain("return store.count;");
		expect(out).toContain('store.get("count");');
	});

	it("ignores a same-named function that is not imported from the API module", () => {
		const source = `import { reaction } from "@sobx/magic";
function observable(x) { return x; }
const s = observable({ a: 1 });
s.a;`;
		const ast = parse(source, { sourceType: "module" });
		const out = generate(transformSobx(ast.program, source).ast).code;
		expect(out).not.toContain("ProxyLike");
		expect(out).not.toContain(".get(");
	});

	it("leaves files that do not import the API module untouched", () => {
		const source = `const s = { a: 1 };\ns.a = 2;`;
		const ast = parse(source, { sourceType: "module" });
		expect(transformSobx(ast.program, source).ast).toBe(ast.program);
	});
});

describe("runtime fallback", () => {
	it.each([
		["exported", `export const s = observable({ a: 1 });`],
		["passed along", `const s = observable({ a: 1 }); log(s);`],
		["dynamic key", `const s = observable({ a: 1 }); s[k];`],
		["Object.keys", `const s = observable({ a: 1 }); Object.keys(s);`],
		["unbound", `log(observable({ a: 1 }));`],
		["pattern write", `const s = observable({ a: 1 }); [s.a] = [2];`],
		["struct", `const s = observable({ a: 1 }, { a: observable.struct });`],
		["setter", `const s = observable({ a: 1, set b(v) { this.a = v; } });`],
	])(
		"leaves %s observables to the runtime, with an info diagnostic",
		(_, body) => {
			const { code, diagnostics } = compileFull(body);
			expect(code).not.toContain("ProxyLike");
			expect(code).not.toContain(".get(");
			expect(code).toContain('from "@sobx/runtime"');
			expect(diagnostics.map((d) => [d.code, d.severity])).toContainEqual([
				"runtime-observable",
				"info",
			]);
		},
	);
});

describe("runtime behaviour of compiled code", () => {
	it("reaction: re-runs data, passes (next, previous), skips equal results", () => {
		expect(
			run(`const s = observable({ a: 1, b: 2 });
reaction(() => s.a + s.b, (sum, prev) => log([sum, prev]));
s.b = 3;
s.a = 0; s.b = 4;
runInAction(() => { s.a = 2; s.b = 2; });`),
		).toEqual([
			[4, 3],
			[3, 4],
			[4, 3],
		]);
	});

	it("reaction: honours fireImmediately and equals", () => {
		expect(
			run(`const s = observable({ a: 1 });
reaction(() => s.a % 2, (v) => log(v), { fireImmediately: true, equals: (x, y) => x === y });
s.a = 3;
s.a = 4;`),
		).toEqual([1, 0]);
	});

	it("autorun and computed", () => {
		expect(
			run(`const s = observable({ a: 1 });
const double = computed(() => s.a * 2);
autorun(() => log(double.get()));
s.a = 2;`),
		).toEqual([2, 4]);
	});

	it("getters, methods and this on fast-path objects", () => {
		expect(
			run(`const s = observable({ n: 1, get double() { return this.n * 2; }, inc() { this.n++; this.n++; } });
autorun(() => log(s.double));
s.inc();`),
		).toEqual([2, 6]);
	});

	it("exported (runtime) observables work too", () => {
		expect(
			run(`const s = observable({ a: 1 });
const t = s;
autorun(() => log(t.a));
t.a = 5;`),
		).toEqual([1, 5]);
	});

	it("classes with makeObservable and makeAutoObservable", () => {
		expect(
			run(`class Cart {
  items = 0;
  constructor() { makeAutoObservable(this); }
  get total() { return this.items * 10; }
  add() { this.items++; }
}
class Named {
  name = "a";
  constructor() { makeObservable(this, { name: observable, rename: action }); }
  rename(n) { this.name = n; }
}
const cart = new Cart();
const named = new Named();
autorun(() => log(cart.total + ":" + named.name));
cart.add();
named.rename("b");`),
		).toEqual(["0:a", "10:a", "10:b"]);
	});

	it("action batches writes", () => {
		expect(
			run(`const s = observable({ a: 1, b: 1 });
autorun(() => log(s.a + s.b));
const both = action((n) => { s.a = n; s.b = n; });
both(5);`),
		).toEqual([2, 10]);
	});
});

describe("diagnostics", () => {
	it("reports what the runtime can't do as errors", () => {
		expect(
			codes(`const s = observable({ user: { name: "" } }); s.user.name = "x";`),
		).toContainEqual(["deep-mutation", "error"]);
		expect(codes(`const a = observable([1]);`)).toContainEqual([
			"observable-collection",
			"error",
		]);
		expect(
			codes(
				`const s = observable({ a: 1 }); reaction(() => s.a, () => {}, { delay: 10 });`,
			),
		).toContainEqual(["unsupported-option", "error"]);
	});

	it("reports likely mistakes as warnings", () => {
		expect(
			codes(`const s = observable({ a: 1 }); autorun(() => { s.a = 2; });`),
		).toContainEqual(["write-in-derivation", "warning"]);
	});

	it("can be re-graded per code", () => {
		const { diagnostics } = compileFull(
			`const s = observable({ items: [] }); s.items.push(1);`,
			{ diagnostics: { "deep-mutation": "off" } },
		);
		expect(diagnostics.map((d) => d.code)).not.toContain("deep-mutation");
	});
});

describe("bundler plugin (unplugin-ast)", () => {
	it("compiles a module, redirects imports and injects the ProxyLike import", async () => {
		const out =
			await compileWithPlugin(`import { observable, reaction } from "@sobx/magic";
const store = observable({ count: 0 });
reaction(() => store.count, (n) => console.log(n));
store.count = store.count + 1;
store.count += 1;`);
		expect(out).toMatch(/^import \{ ProxyLike \} from "@sobx\/runtime";/);
		expect(out).toContain(
			'import { observable, reaction } from "@sobx/runtime";',
		);
		expect(out).toMatch(/new ProxyLike\(\{\s*count: 0\s*\}\)/);
		expect(out).toContain('reaction(() => (store.get("count"))');
		expect(out).toContain('store.set("count", store.get("count") + 1)');
		expect(out).not.toMatch(/store\.count/);
	});

	it("parses standard decorators", async () => {
		const out =
			await compileWithPlugin(`import { observable, computed, action } from "@sobx/magic";
class Store {
  @observable accessor count = 0;
  @computed get double() { return this.count * 2; }
  @action.bound inc() { this.count++; }
}`);
		expect(out).toContain('from "@sobx/runtime"');
		expect(out).toContain("@observable accessor count = 0;");
	});

	it("still parses parameter decorators in files that don't use sobx", async () => {
		const source = `class Service { constructor(@Inject() private dep: string) {} }`;
		expect(await compileWithPlugin(source)).toBe(source);
	});

	it("fails on errors and logs warnings", async () => {
		await expect(
			compileWithPlugin(`import { observable } from "@sobx/magic";
const a = observable([1]);`),
		).rejects.toThrow(/observable-collection/);
		const warnings: string[] = [];
		await compileWithPlugin(
			`import { observable, autorun } from "@sobx/magic";
const s = observable({ a: 1 });
autorun(() => { s.a = 2; });`,
			(m) => warnings.push(m),
		);
		expect(warnings).toEqual([
			expect.stringMatching(/file\.ts:3:\d+ - warning write-in-derivation/),
		]);
	});

	it("skips files without sobx usages", async () => {
		const source = `import { observable } from "mobx";\nconst s = observable({ a: 1 });\ns.a;`;
		expect(await compileWithPlugin(source)).toBe(source);
	});
});
