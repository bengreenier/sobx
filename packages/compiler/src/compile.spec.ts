import generate from "@babel/generator";
import { parse } from "@babel/parser";
import * as runtime from "@sobx/runtime";
import * as mobx from "mobx";
import { resolveOptions, transform } from "unplugin-ast";
import type { CompileDiagnostic } from "./diagnostics.js";
import { analyze } from "./native.js";
import { type TransformSobxOptions, transformSobx } from "./transform.js";
import { PARSER_PLUGINS, SobxTransformer } from "./transformers/sobx.js";

const HEADER = `import { observable, computed, reaction, autorun, action, runInAction, makeObservable, makeAutoObservable, when, flow, comparer, toJS, configure, isObservableArray } from "@sobx/magic";\n`;

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

/** Run `body` as is against MobX (default mode, with its proxies); returns what it logged. */
function runMobx(body: string): unknown[] {
	const names = (HEADER.match(/\{([^}]*)\}/) as RegExpMatchArray)[1];
	const logs: unknown[] = [];
	new Function("mobx", "log", `const {${names}} = mobx;\n${body}`)(
		mobx,
		(v: unknown) => logs.push(v),
	);
	return logs;
}

/** Plain, comparable copies of logged values. */
const plain = (logs: unknown[]) => JSON.parse(JSON.stringify(logs));

/**
 * The same source run against MobX (as is) and compiled with sobx (no Proxy): they must log the
 * same values.
 */
function parity(name: string, body: string) {
	it(name, () => {
		expect(plain(run(body))).toEqual(plain(runMobx(body)));
	});
}

/** Run the bundler-plugin path (unplugin-ast + SobxTransformer) on a file. */
async function compileWithPlugin(
	source: string,
	warn: (m: string) => void = () => {},
	modules?: "all" | "sobx",
): Promise<string> {
	const result = await transform(
		source,
		"/src/file.ts",
		resolveOptions({
			parserOptions: { plugins: [...PARSER_PLUGINS] },
			transformer: [SobxTransformer({ warn, modules })],
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
		// The parameter isn't the ProxyLike: it's a value whose origin can't be traced.
		expect(out).toContain(
			'return store[__sobx_$sobx] !== void 0 ? __sobx_getProperty(store, "count") : store.count;',
		);
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

describe("compiled code: arrays and deep observables", () => {
	beforeAll(() => runtime.configure({ enforceActions: "never" }));
	afterAll(() => runtime.configure({ enforceActions: "observed" }));

	it("observable arrays", () => {
		expect(
			run(`const todos = observable([]);
autorun(() => log(todos.map((t) => t.title).join(",")));
todos.push({ title: "a" });
todos[0].title = "b";
todos.splice(0, 1, { title: "c" }, { title: "d" });
todos.length = 1;`),
		).toEqual(["", "a", "b", "c,d", "c"]);
	});

	it("nested objects and arrays inside fast-path objects", () => {
		const body = `const store = observable({ user: { name: "a" }, items: [] });
autorun(() => log(store.user.name + ":" + store.items.length));
store.user.name = "b";
store.items.push(1);
store.user = { name: "c" };
store.user.name = "d";`;
		expect(compileFull(body).code).toContain("new ProxyLike(");
		expect(run(body)).toEqual(["a:0", "b:0", "b:1", "c:1", "d:1"]);
	});

	it("runtime objects: added keys, delete, in, Object.keys / values / entries (no Proxy)", () => {
		const body = `const store = observable({ a: 1 });
log(store); // escapes: made observable at runtime
autorun(() => log([Object.keys(store).join(","), "b" in store, store.b ?? null, Object.values(store).join(",")]));
store.b = 2;
delete store.a;
store.c = 3;
log(Object.entries(store));`;
		const { code } = compileFull(body);
		expect(code).not.toContain("ProxyLike");
		expect(code).toContain("__sobx_keysOf(store)");
		expect(code).toContain('__sobx_hasProperty(store, "b")');
		expect(code).toContain('__sobx_getProperty(store, "b")');
		expect(code).toContain('__sobx_setProperty(store, "b", 2)');
		expect(code).toContain('__sobx_deleteProperty(store, "a")');
		expect(run(body).slice(1)).toEqual([
			["a", false, null, "1"],
			["a,b", true, 2, "1,2"],
			["b", true, 2, "2"],
			["b,c", true, 2, "2,3"],
			[
				["b", 2],
				["c", 3],
			],
		]);
	});

	it("runtime objects: dynamic keys", () => {
		expect(
			run(`const store = observable({});
const key = "x";
autorun(() => log(store[key] ?? null));
store[key] = 1;
store[key] += 1;
store[key]++;
delete store[key];`),
		).toEqual([null, 1, 2, 3, null]);
	});

	it("observable arrays: index and length writes are compiled", () => {
		const body = `const a = observable([1, 2, 3]);
autorun(() => log(a[0] + ":" + a.length));
a[0] = 10;
a.length = 2;
a[0]++;
a[1] += 5;
delete a[1];
log(a.slice());`;
		const { code } = compileFull(body);
		expect(code).toContain("__sobx_setProperty(a, 0, 10)");
		expect(code).toContain('__sobx_setProperty(a, "length", 2)');
		expect(code).toContain('__sobx_getProperty(a, "length")');
		expect(run(body)).toEqual([
			"1:3",
			"10:3",
			"10:2",
			"11:2",
			"11:2", // a[1] += 5 changes the array, not a[0] / length; reads are whole-array
			"11:2",
			[11, undefined],
		]);
	});

	it("writes through nested values are compiled (fast path, runtime objects, classes)", () => {
		expect(
			run(`const store = observable({ items: [1], user: { name: "a" } });
autorun(() => log([store.items[0], store.items.length, store.user.nickname ?? null].join()));
store.items[0] = 5;
store.items.length = 0;
store.user.nickname = "b";
delete store.user.nickname;
class Todos {
  list = [{ done: false }];
  constructor() { makeAutoObservable(this); }
  finish(i) { this.list[i].done = true; }
  reset() { this.list.length = 0; }
}
const todos = new Todos();
autorun(() => log("open " + todos.list.filter((t) => !t.done).length + "/" + todos.list.length));
todos.finish(0);
todos.reset();`),
		).toEqual([
			"1,1,",
			"5,1,",
			",0,",
			",0,b",
			",0,",
			"open 1/1",
			"open 0/1",
			"open 0/0",
		]);
	});

	it("reports what it can't compile", () => {
		expect(
			codes(
				`const s = observable({ a: 1 }); log(s); Object.assign(s, { b: 1 });`,
			),
		).toContainEqual(["unsupported-operation", "error"]);
		expect(
			codes(`const s = observable({ items: [1] }); s.items[next()] += 1;`),
		).toContainEqual(["uncompiled-write", "error"]);
		// Rewritten operations are not reported.
		expect(
			codes(
				`const s = observable({ a: 1 }); log(s); log("a" in s, Object.keys(s), s[k]);`,
			).filter(([, severity]) => severity !== "info"),
		).toEqual([]);
	});

	it("classes with array fields", () => {
		expect(
			run(`class Todos {
  items = [];
  constructor() { makeAutoObservable(this); }
  get open() { return this.items.filter((t) => !t.done).length; }
  add(title) { this.items.push({ title, done: false }); }
  finish(i) { this.items[i].done = true; }
}
const todos = new Todos();
autorun(() => log(todos.open));
todos.add("a"); todos.add("b"); todos.finish(0);
log(isObservableArray(todos.items));`),
		).toEqual([0, 1, 2, 1, true]);
	});

	it("toJS", () => {
		expect(
			run(`const store = observable({ items: [{ n: 1 }], get count() { return this.items.length; } });
log(JSON.stringify(toJS(store)));
log(isObservableArray(toJS(store).items));`),
		).toEqual(['{"items":[{"n":1}]}', false]);
	});

	it("configure is redirected to the runtime", () => {
		expect(run(`configure({ enforceActions: "never" }); log("ok");`)).toEqual([
			"ok",
		]);
	});
});

describe("parity with MobX (compiled sobx vs MobX's default, Proxy-based mode)", () => {
	beforeAll(() => {
		runtime.configure({ enforceActions: "never" });
		mobx.configure({ enforceActions: "never" });
	});
	afterAll(() => {
		runtime.configure({ enforceActions: "observed" });
		mobx.configure({ enforceActions: "observed" });
	});

	parity(
		"adding and deleting keys, in, Object.keys / values / entries",
		`const s = observable({ a: 1 });
log(s === s);
autorun(() => log([Object.keys(s), "b" in s, s.b ?? null, Object.values(s), Object.entries(s)]));
s.b = 2;
s.c = 3;
delete s.a;
delete s.b;
log({ ...s });`,
	);

	parity(
		"dynamic keys",
		`const s = observable({});
const k = "x";
autorun(() => log([s[k] ?? null, Object.keys(s)]));
s[k] = 1;
s[k] += 2;
s[k]--;
delete s[k];`,
	);

	parity(
		"array index and length writes",
		`const a = observable([1, 2, 3]);
autorun(() => log([a[0], a[2] ?? null, a.length]));
a[0] = 10;
a[3] = 4;
a.length = 2;
a[0]++;
a[1] *= 3;
log(a.slice());`,
	);

	parity(
		"writes through nested values",
		`const store = observable({ items: [1, 2], user: { name: "a" }, grid: [[1]] });
autorun(() => log([store.items[1], store.items.length, store.user.nickname ?? null, Object.keys(store.user), store.grid[0][1] ?? null]));
store.items[1] = 5;
store.items.length = 1;
store.user.nickname = "b";
delete store.user.name;
store.grid[0][1] = 2;
store.items.push(7);`,
	);

	parity(
		"local fast-path objects with nested arrays",
		`const store = observable({ todos: [] });
autorun(() => log(store.todos.map((t) => t.title + (t.done ? "!" : "")).join()));
store.todos.push({ title: "a", done: false });
store.todos[0].done = true;
store.todos[1] = { title: "b", done: false };
store.todos.length = 1;`,
	);

	parity(
		"classes with array and object fields",
		`class Store {
  items = [];
  meta = {};
  constructor() { makeAutoObservable(this); }
  add(x) { this.items[this.items.length] = x; }
  tag(k, v) { this.meta[k] = v; }
}
const s = new Store();
autorun(() => log([s.items.length, Object.keys(s.meta)]));
s.add(1);
s.add(2);
s.tag("x", 1);`,
	);
});

describe("compiled code: when, flow, collections, comparer", () => {
	it("when runs its effect once", () => {
		expect(
			run(`const s = observable({ n: 0 });
when(() => s.n > 1, () => log("ready at " + s.n));
s.n = 1; s.n = 2; s.n = 3;`),
		).toEqual(["ready at 2"]);
	});

	it("flow runs its steps as actions", async () => {
		const logs = run(`const s = observable({ a: 0, b: 0 });
autorun(() => log(s.a + s.b));
const load = flow(function* () {
  s.a = 1; s.b = 1;
  yield Promise.resolve();
  s.a = 2; s.b = 2;
});
load().then(() => log("done"));`);
		await new Promise((r) => setTimeout(r, 0));
		expect(logs).toEqual([0, 2, 4, "done"]);
	});

	it("observable Maps, Sets and boxes", () => {
		expect(
			run(`const m = observable.map();
const tags = observable(new Set());
const count = observable.box(0);
autorun(() => log(m.size + tags.size + count.get()));
m.set("a", 1);
tags.add("x");
count.set(5);`),
		).toEqual([0, 1, 2, 7]);
	});

	it("Maps inside fast-path objects are observable", () => {
		const { code } = compileFull(`const s = observable({ byId: new Map() });
autorun(() => log(s.byId.size));
s.byId.set("a", 1);`);
		expect(code).toContain("new ProxyLike(");
		expect(
			run(`const s = observable({ byId: new Map() });
autorun(() => log(s.byId.size));
s.byId.set("a", 1);`),
		).toEqual([0, 1]);
	});

	it("comparer in options", () => {
		expect(
			run(`const s = observable({ p: { x: 1 } });
reaction(() => s.p, (p) => log(p.x), { equals: comparer.structural });
s.p = { x: 1 };
s.p = { x: 2 };`),
		).toEqual([2]);
	});

	it("unsupported options are still errors", () => {
		expect(
			codes(
				`const s = observable({ a: 1 }); when(() => s.a, () => {}, { onError: () => {} });`,
			),
		).toContainEqual(["unsupported-option", "error"]);
	});
});

describe("diagnostics", () => {
	it("reports what the runtime can't do as errors", () => {
		expect(codes(`const o = observable.object({});`)).toContainEqual([
			"unsupported-api",
			"error",
		]);
		expect(
			codes(
				`const s = observable({ a: 1 }); reaction(() => s.a, () => {}, { delay: 10 });`,
			),
		).toContainEqual(["unsupported-option", "error"]);
	});

	it("reports unknown imports as errors", () => {
		const source = `import { extendObservable } from "@sobx/magic";`;
		const ast = parse(source, { sourceType: "module" });
		expect(
			transformSobx(ast.program, source).diagnostics.map((d) => [
				d.code,
				d.severity,
			]),
		).toEqual([["unknown-import", "error"]]);
	});

	it("reports mutation of ref values as warnings", () => {
		expect(
			codes(
				`const s = observable({ list: [] }, { list: observable.ref }); s.list.push(1);`,
			),
		).toContainEqual(["deep-mutation", "warning"]);
		expect(
			codes(`const s = observable({ user: { name: "" } }); s.user.name = "x";`),
		).toEqual([]);
	});

	it("reports likely mistakes as warnings", () => {
		expect(
			codes(`const s = observable({ a: 1 }); autorun(() => { s.a = 2; });`),
		).toContainEqual(["write-in-derivation", "warning"]);
	});

	it("can be re-graded per code", () => {
		const body = `const s = observable({ a: 1 }); autorun(() => { s.a = 2; });`;
		const off = compileFull(body, {
			diagnostics: { "write-in-derivation": "off" },
		}).diagnostics;
		expect(off.map((d) => d.code)).not.toContain("write-in-derivation");
		const error = compileFull(body, {
			diagnostics: { "write-in-derivation": "error" },
		}).diagnostics;
		expect(error.map((d) => [d.code, d.severity])).toContainEqual([
			"write-in-derivation",
			"error",
		]);
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

	it("rewrites `in` (binary expressions are visited)", async () => {
		const out =
			await compileWithPlugin(`import { observable } from "@sobx/magic";
export const s = observable({ a: 1 });
function f(o, k) { return k in o; }
log("b" in s);`);
		expect(out).toContain("__sobx_hasProperty(o, k)");
		expect(out).toContain('__sobx_hasProperty(s, "b")');
	});

	it("keeps comments around rewritten nodes once", async () => {
		const out = await compileWithPlugin(`/** header */
import { observable } from "@sobx/magic";
// before store
const s = observable({ a: 1 }); // after store
/* before read */ console.log(s.a /* in read */);
s.a = 2; // after write`);
		for (const comment of [
			"/** header */",
			"// before store",
			"// after store",
			"/* before read */",
			"/* in read */",
			"// after write",
		]) {
			expect(out.split(comment).length - 1, comment).toBe(1);
		}
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
const o = observable.object({});`),
		).rejects.toThrow(/unsupported-api/);
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

	it('skips files without sobx usages with modules: "sobx"', async () => {
		const source = `import { observable } from "mobx";\nconst s = observable({ a: 1 });\ns.a;`;
		expect(await compileWithPlugin(source, undefined, "sobx")).toBe(source);
	});

	it("compiles every module by default", async () => {
		const out = await compileWithPlugin(
			"export function count(o) { return Object.keys(o).length; }",
		);
		expect(out).toContain("__sobx_keysOf(o)");
	});
});
