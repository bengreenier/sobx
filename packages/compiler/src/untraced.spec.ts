/**
 * Values whose origin the analyzer can't trace (parameters such as React props, imports, call
 * results such as `useContext()`): property operations only a Proxy would observe are rewritten
 * to runtime helpers, which observe them on observables and behave as plain JavaScript on
 * anything else.
 */
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import * as runtime from "@sobx/runtime";
import * as mobx from "mobx";
import type { CompileDiagnostic } from "./diagnostics.js";
import { analyze } from "./native.js";
import { transformSobx } from "./transform.js";
import { PARSER_PLUGINS } from "./transformers/sobx.js";

const HEADER = `import { observable, autorun, runInAction, computed } from "@sobx/magic";\n`;

function compileFull(body: string, header = HEADER) {
	const source = header + body;
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript", "jsx", ...PARSER_PLUGINS],
	});
	const result = transformSobx(ast.program, source);
	return { code: generate(result.ast).code, diagnostics: result.diagnostics };
}

const compile = (body: string, header?: string) =>
	compileFull(body, header).code;

const errors = (diagnostics: CompileDiagnostic[]) =>
	diagnostics.filter((d) => d.severity === "error");

/** Compile `body` and run it against @sobx/runtime; returns what it logged. */
function run(body: string): unknown[] {
	const { code, diagnostics } = compileFull(body);
	const failed = errors(diagnostics);
	if (failed.length) throw new Error(failed.map((d) => d.message).join("\n"));
	const script = code.replace(
		/import \{([^}]*)\} from "@sobx\/runtime";/g,
		(_, names: string) => `const {${names.replace(/ as /g, ": ")}} = runtime;`,
	);
	const logs: unknown[] = [];
	// Modules are strict, as compiled code (and the runtime) is.
	new Function(
		"runtime",
		"log",
		`"use strict";
${script}`,
	)(runtime, (v: unknown) => logs.push(JSON.parse(JSON.stringify(v ?? null))));
	return logs;
}

/** Run `body` as is against MobX (with its proxies). */
function runMobx(body: string): unknown[] {
	const logs: unknown[] = [];
	new Function(
		"mobx",
		"log",
		`"use strict";\nconst { observable, autorun, runInAction, computed } = mobx;\n${body}`,
	)(mobx, (v: unknown) => logs.push(JSON.parse(JSON.stringify(v ?? null))));
	return logs;
}

/** Run `body` as plain JavaScript (no observables involved). */
function runPlain(body: string): unknown[] {
	const logs: unknown[] = [];
	new Function(
		"log",
		`"use strict";
${body}`,
	)((v: unknown) => logs.push(JSON.parse(JSON.stringify(v ?? null))));
	return logs;
}

/** The untraced operations the analyzer reports, as source text. */
function untraced(body: string, header = HEADER): string[] {
	const source = header + body;
	return analyze(source).untracedOperations.map(
		(op) => `${op.kind} ${source.slice(op.span.start, op.span.end)}`,
	);
}

describe("untraced values: what is rewritten", () => {
	it("parameters, imports, call results, `this` and values reached through them", () => {
		expect(
			untraced(`import { store } from "./store";
function f(o, k, items) {
  o[k] = 1;
  o.newKey = 2;
  o.nested.deep = 3;
  delete o[k];
  k in o;
  Object.keys(o);
  items[0];
  items.length;
  o.items[k];
  store.list[k];
  getStore()[k];
}
class Plain { m(k) { return this.map[k]; } }`),
		).toEqual([
			"write o[k]",
			"write o.newKey",
			"write o.nested.deep",
			"delete o[k]",
			"in k in o",
			"enumerate Object.keys(o)",
			"read items[0]",
			"read items.length",
			"read o.items[k]",
			"read store.list[k]",
			"read getStore()[k]",
			"read this.map[k]",
		]);
	});

	it("leaves plain locals, globals, known observables and static reads alone", () => {
		expect(
			untraced(`const local = { a: 1 };
const list = [1, 2];
const map = new Map();
const s = observable({ a: 1 });
function f(k, o) {
  local[k] = 1;
  list[0];
  list.length;
  delete local.a;
  k in local;
  Object.keys(local);
  map.size;
  window.x = 1;
  globalThis[k];
  s.a = 2;
  o.a;
  o.nested.name;
}`),
		).toEqual([]);
	});

	it("leaves method calls, optional chains and destructuring targets alone", () => {
		expect(
			untraced(`function f(o, k, xs) {
  o[k]();
  xs[0](1);
  new o[k]();
  o?.[k];
  o.a?.[k];
  [o[k]] = xs;
  ({ a: o[k] } = xs);
  for (o[k] of xs);
  for (o.x in xs);
}`),
		).toEqual([]);
	});

	it("reassigned or untraceably initialized locals are untraced", () => {
		expect(
			untraced(`function f(p, k) {
  let a = {};
  a = p;
  a[k];
  const b = p.child;
  b[k];
  const { c } = p;
  c[k];
}`),
		).toEqual(["read a[k]", "read b[k]", "read c[k]"]);
	});
});

describe("untraced values: output", () => {
	it("compiles to helpers, never to errors", () => {
		const { code, diagnostics } = compileFull(`function f(o, k, i) {
  o[k] = 1;
  o.count += 1;
  o[k]++;
  delete o[k];
  if (k in o) Object.entries(o);
  o.items[i];
  o.items.length;
  // A compound write with side effects can't be rewritten safely: left as is, no error.
  o[next()] += 1;
}`);
		expect(errors(diagnostics)).toEqual([]);
		expect(code).toContain("__sobx_setProperty(o, k, 1)");
		expect(code).toContain(
			'__sobx_setProperty(o, "count", __sobx_getProperty(o, "count") + 1)',
		);
		expect(code).toContain("__sobx_updateProperty(o, k, 1, false)");
		expect(code).toContain("__sobx_deleteProperty(o, k)");
		expect(code).toContain("__sobx_hasProperty(o, k)");
		expect(code).toContain("__sobx_entriesOf(o)");
		expect(code).toContain("__sobx_getProperty(o.items, i)");
		expect(code).toContain('__sobx_getProperty(o.items, "length")');
		expect(code).toContain("o[next()] += 1;");
	});

	it("compiles logical assignment so that it only assigns when it has to", () => {
		const code = compile(`const s = observable({ a: 0 });
s.a ||= 1;
function f(o, k) { o[k] ??= 2; }`);
		expect(code).toContain('s.get("a") || s.set("a", 1)');
		expect(code).toContain(
			"__sobx_getProperty(o, k) ?? __sobx_setProperty(o, k, 2)",
		);
	});

	it("compiles files that only import @sobx/react", () => {
		const code = compile(
			`function Row({ row, k }) { return row.cells[k]; }`,
			`import { observer } from "@sobx/react";\n`,
		);
		expect(code).toContain('import { observer } from "@sobx/react";');
		expect(code).toContain("__sobx_getProperty(row.cells, k)");
	});

	it("leaves files that import neither @sobx/magic nor @sobx/react alone", () => {
		expect(compile(`function f(o, k) { o[k] = 1; }`, "")).not.toContain(
			"__sobx_",
		);
	});
});

describe("@sobx/react's local observables", () => {
	const REACT = `import { observer, useLocalObservable, useLocalStore } from "@sobx/react";
`;

	it("are runtime observables shaped like the initializer's result", () => {
		const source = `${REACT}function C() {
  const store = useLocalObservable(() => ({ count: 0, tags: {}, inc() { this.count++; this.tags[this.count] = true; } }));
  const legacy = useLocalStore(function () { const n = 1; return { n }; });
  return null;
}`;
		const mod = analyze(source);
		expect(
			mod.observables.map((o) => [
				o.source,
				o.shape.kind === "object"
					? o.shape.members.map((m) => m.key)
					: o.shape.kind,
			]),
		).toEqual([
			["useLocalObservable", ["count", "tags", "inc"]],
			["useLocalStore", ["n"]],
		]);
		expect(errors(compileFull(source, "").diagnostics)).toEqual([]);
	});

	it("rewrite only what accessors can't observe", () => {
		const code = compile(
			`function C(props) {
  const store = useLocalObservable(() => ({ count: 0, tags: {}, add(k) { this.tags[k] = true; this.extra = 1; } }));
  store.count++;
  store.added = 1;
  delete store.count;
  Object.keys(store);
  store.tags[props.k] = 1;
  return null;
}`,
			REACT,
		);
		expect(code).toContain("store.count++;");
		expect(code).toContain('__sobx_setProperty(store, "added", 1)');
		expect(code).toContain('__sobx_deleteProperty(store, "count")');
		expect(code).toContain("__sobx_keysOf(store)");
		expect(code).toContain("__sobx_setProperty(store.tags, props.k, 1)");
		expect(code).toContain("__sobx_setProperty(this.tags, k, true)");
		expect(code).toContain('__sobx_setProperty(this, "extra", 1)');
		expect(code).not.toContain("ProxyLike");
	});

	it("initializers that don't return an object literal are untraced", () => {
		const code = compile(
			`function C() {
  const store = useLocalObservable(makeStore);
  store.count++;
  store[key] = 1;
  return null;
}`,
			REACT,
		);
		expect(code).toContain('__sobx_updateProperty(store, "count", 1, false)');
		expect(code).toContain("__sobx_setProperty(store, key, 1)");
	});
});

describe("untraced values: behave like MobX", () => {
	/** The same source, run as is against MobX and compiled against sobx. */
	function parity(name: string, body: string) {
		it(name, () => {
			expect(run(body)).toEqual(runMobx(body));
		});
	}

	parity(
		"observables passed to functions (as React props are)",
		`const store = observable({ tags: {}, items: [1, 2] });
function count(o) { return Object.keys(o).length; }
function has(o, k) { return k in o; }
function add(o, k, v) { o[k] = v; }
function remove(o, k) { delete o[k]; }
function first(a) { return a[0]; }
function size(a) { return a.length; }
function setAt(a, i, v) { a[i] = v; }
function truncate(a, n) { a.length = n; }
function bump(o, k) { o[k]++; }
autorun(() => log([count(store.tags), has(store.tags, "a"), first(store.items), size(store.items)]));
runInAction(() => add(store.tags, "a", 1));
runInAction(() => bump(store.tags, "a"));
runInAction(() => setAt(store.items, 0, 10));
runInAction(() => setAt(store.items, 2, 3));
runInAction(() => truncate(store.items, 1));
runInAction(() => remove(store.tags, "a"));
log(store.tags);
log(store.items);`,
	);

	parity(
		"observables returned from functions (as context and hooks are)",
		`const store = observable({ byId: {} });
const useStore = () => store;
autorun(() => log(Object.values(useStore().byId)));
runInAction(() => { useStore().byId["x"] = { name: "x" }; });
runInAction(() => { useStore().byId.x.name = "y"; });
runInAction(() => { delete useStore().byId.x; });`,
	);

	parity(
		"compound writes through nested values of fast-path objects",
		`const store = observable({ user: { n: 1 }, keys: { k: "n" } });
autorun(() => log(store.user.n));
runInAction(() => { store.user.n += 1; });
runInAction(() => { store.user[store.keys.k] *= 10; });
runInAction(() => { store.user.n ||= 5; store.user.n ??= 7; });
log(store.user);`,
	);

	parity(
		"logical assignment only assigns when it has to",
		`const s = observable({ a: 1, b: 0, c: null, list: [0, 1] });
const t = observable({ a: 1, b: 0, c: null });
function f(o) { o.a ||= 5; o.b ||= 5; o.c ??= 7; o.a &&= 9; }
let runs = 0;
autorun(() => { runs++; log([s.a, s.b, s.c, t.a, t.b, t.c]); });
runInAction(() => { s.a ||= 5; s.b ||= 5; s.c ??= 7; s.a &&= 9; f(t); });
runInAction(() => { s.a ||= 1; s.c ??= 1; t.a ||= 1; t.c ??= 1; });
log(runs);`,
	);

	parity(
		"computeds over a parameter",
		`const store = observable({ counts: {} });
function total(counts) { let t = 0; for (const k of Object.keys(counts)) t += counts[k]; return t; }
const sum = computed(() => total(store.counts));
autorun(() => log(sum.get()));
runInAction(() => { store.counts.a = 1; });
runInAction(() => { store.counts.b = 2; });
runInAction(() => { store.counts.a = 5; });`,
	);
});

describe("untraced values: plain values behave as without the compiler", () => {
	const VALUES = [
		"{ a: 1, b: { c: 2 } }",
		"[1, , 3]",
		"[]",
		'"abc"',
		"{ get g() { return 7; }, set s(v) { log(['set', v]); } }",
		"Object.create({ inherited: 1 })",
		"new Map([['a', 1]])",
		"Object.freeze({ a: 1 })",
		"{ length: 2, 0: 'x' }",
	];
	const KEYS = [
		'"a"',
		'"b"',
		'"g"',
		'"s"',
		'"length"',
		"0",
		"1",
		"5",
		'"inherited"',
		'"size"',
	];
	const OPS = [
		(k: string) => `log(o[${k}]);`,
		(k: string) => `log(o[${k}] = 9);`,
		(k: string) => `log(o[${k}] += 1);`,
		(k: string) => `log(o[${k}] ||= 4);`,
		(k: string) => `log(o[${k}] &&= 5);`,
		(k: string) => `log(o[${k}] ??= 6);`,
		(k: string) => `log(o[${k}]++);`,
		(k: string) => `log(--o[${k}]);`,
		(k: string) => `log(delete o[${k}]);`,
		(k: string) => `log(${k} in o);`,
		() => "log(o.length);",
		() => "log(o.length = 1);",
		() => "log(o.b && o.b.c);",
		() => "log(Object.keys(o));",
		() => "log(Object.values(o));",
		() => "log(Object.entries(o));",
		() => "log(o.x = 1);",
		() => "log(o.b ? (o.b.c = 3) : 0);",
	];
	const pick = <T>(xs: readonly T[]): T =>
		xs[Math.floor(Math.random() * xs.length)] as T;

	it("on random programs", () => {
		for (let i = 0; i < Number(process.env.SOBX_FUZZ_RUNS ?? 400); i++) {
			const ops = Array.from(
				{ length: 1 + Math.floor(Math.random() * 5) },
				() => pick(OPS)(pick(KEYS)),
			);
			// Half the time inside a derivation, where compiled tracking reads take the helper
			// branch (the plain run has no autorun, and just calls f).
			const value = pick(VALUES);
			const call =
				Math.random() < 0.5
					? `f(${value});`
					: `(typeof autorun === "function" ? autorun : (fn) => fn())(() => f(${value}));`;
			const body = `function f(o) {\n${ops.map((op) => `  try { ${op} } catch (e) { log(e.constructor.name); }`).join("\n")}\n  log(Array.isArray(o) ? o : typeof o === "object" ? { ...o } : o);\n}\n${call}`;
			const plain = runPlain(body);
			const compiled = run(body);
			if (JSON.stringify(compiled) !== JSON.stringify(plain)) {
				throw new Error(
					`Compiled code behaves differently:\n${body}\n---\n${compile(body)}\n---\nplain: ${JSON.stringify(plain)}\ncompiled: ${JSON.stringify(compiled)}`,
				);
			}
		}
	});
});
