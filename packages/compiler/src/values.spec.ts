/**
 * Compiled code behaves as the same source with MobX, for every way of reading and writing a
 * key that doesn't exist yet, however the observable is reached (including how often reactions
 * run), and none of it is a build error.
 */
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import * as runtime from "@sobx/runtime";
import * as mobx from "mobx";
import { transformSobx } from "./transform.js";
import { PARSER_PLUGINS } from "./transformers/sobx.js";

const HEADER = `import { observable, autorun, runInAction, toJS } from "@sobx/magic";\n`;

function compile(body: string, header = HEADER) {
	const source = header + body;
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript", "jsx", ...PARSER_PLUGINS],
	});
	const result = transformSobx(ast.program, source);
	const errors = result.diagnostics.filter((d) => d.severity === "error");
	expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
	return generate(result.ast).code;
}

const copy = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));

/** Compile `body` and run it against @sobx/runtime; returns what it logged. */
function run(body: string): unknown[] {
	const script = compile(body).replace(
		/import \{([^}]*)\} from "@sobx\/runtime";/g,
		(_, names: string) => `const {${names.replace(/ as /g, ": ")}} = runtime;`,
	);
	const logs: unknown[] = [];
	new Function("runtime", "log", `"use strict";\n${script}`)(
		runtime,
		(v: unknown) => logs.push(copy(v)),
	);
	return logs;
}

/** Run `body` as is against MobX. */
function runMobx(body: string): unknown[] {
	const logs: unknown[] = [];
	new Function(
		"mobx",
		"log",
		`"use strict";\nconst { observable, autorun, runInAction, toJS } = mobx;\n${body}`,
	)(mobx, (v: unknown) => logs.push(copy(v)));
	return logs;
}

function parity(name: string, body: string) {
	it(name, () => {
		expect(run(body)).toEqual(runMobx(body));
	});
}

beforeAll(() => {
	mobx.configure({ enforceActions: "never" });
	runtime.configure({ enforceActions: "never" });
});
afterAll(() => {
	mobx.configure({ enforceActions: "observed" });
	runtime.configure({ enforceActions: "observed" });
});

/** `$` is the observable, `k` is `"later"`. */
const READS: Record<string, string> = {
	"o.later": "$.later",
	"o?.later": "$?.later",
	"o[k]": "$[k]",
	"o?.[k]": "$?.[k]",
	"o.later?.x": "$.later?.x",
	destructuring: "(() => { const { later } = $; return later; })()",
	"destructuring with a default":
		'(() => { const { later = "none" } = $; return later; })()',
	"destructured parameter": "(({ later }) => later)($)",
	rest: "(() => { const { a, ...rest } = $; return [a, rest]; })()",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: source code
	template: "`${$.later}`",
	in: '"later" in $',
	spread: "({ ...$ })",
	"for...in":
		"(() => { const r = []; for (const key in $) r.push(key); return r; })()",
	"Object.keys": "Object.keys($)",
	"Object.keys (aliased)":
		"(() => { const { keys } = Object; return keys($); })()",
	"Object.values": "Object.values($)",
	"Object.entries": "Object.entries($)",
	"Object.assign": "Object.assign({}, $)",
	"Object.getOwnPropertyNames": "Object.getOwnPropertyNames($)",
	"Reflect.has": 'Reflect.has($, "later")',
	"Reflect.get": 'Reflect.get($, "later")',
	"JSON.stringify": "JSON.stringify($)",
	toJS: "toJS($)",
};

const WRITES: Record<string, string> = {
	"o.later = v": "$.later = 1",
	"o[k] = v": "$[k] = 1",
	"o[f()] += v": "$[(() => k)()] += 1",
	"o.later ??= v": "$.later ??= 1",
	"o.later ||= v": "$.later ||= 1",
	"o.later++": "$.later++",
	"array destructuring target": "[$.later] = [1]",
	"object destructuring target": "({ x: $.later } = { x: 1 })",
	"for...of target": "for ($.later of [1]);",
	"Object.assign": "Object.assign($, { later: 1 })",
	"Reflect.set": 'Reflect.set($, "later", 1)',
	"Object.defineProperty":
		'Object.defineProperty($, "later", { value: 1, enumerable: true, configurable: true, writable: true })',
};

/** How the code reaches the observable. */
const CONTEXTS: Record<
	string,
	(
		read: string,
		write: string,
	) => { setup: string; read: string; write: string }
> = {
	directly: (read, write) => ({
		setup: "const o = observable({ a: 1 });",
		read: read.replaceAll("$", "o"),
		write: write.replaceAll("$", "o"),
	}),
	"as a parameter": (read, write) => ({
		setup: `const store = observable({ a: 1 });
function read(o) { return ${read.replaceAll("$", "o")}; }
function write(o) { ${write.replaceAll("$", "o")}; }`,
		read: "read(store)",
		write: "write(store)",
	}),
	"through an alias": (read, write) => ({
		setup: "const store = observable({ a: 1 }); const o = store;",
		read: read.replaceAll("$", "o"),
		write: write.replaceAll("$", "o"),
	}),
	nested: (read, write) => ({
		setup: "const store = observable({ o: { a: 1 } });",
		read: read.replaceAll("$", "store.o"),
		write: write.replaceAll("$", "store.o"),
	}),
	"in a plain local": (read, write) => ({
		setup: "const store = observable({ a: 1 }); const box = {}; box.o = store;",
		read: read.replaceAll("$", "box.o"),
		write: write.replaceAll("$", "box.o"),
	}),
	"as a class field": (read, write) => ({
		setup: `const store = observable({ a: 1 });
class Holder { o = store; read() { return ${read.replaceAll("$", "this.o")}; } write() { ${write.replaceAll("$", "this.o")}; } }
const holder = new Holder();`,
		read: "holder.read()",
		write: "holder.write()",
	}),
};

describe("keys that don't exist yet", () => {
	for (const [context, make] of Object.entries(CONTEXTS)) {
		const test = (name: string, read: string, write: string) => {
			const code = make(read, write);
			parity(
				`${name} ${context}`,
				`const k = "later";
${code.setup}
let runs = 0;
autorun(() => { log([++runs, ${code.read}]); });
runInAction(() => { ${code.write}; });
log(runs);`,
			);
		};
		for (const [name, read] of Object.entries(READS)) {
			test(`read: ${name}`, read, "$.later = 1");
		}
		for (const [name, write] of Object.entries(WRITES)) {
			test(`write: ${name}`, "$.later", write);
			test(`write: ${name}, seen by Object.keys,`, "Object.keys($)", write);
		}
	}
});

describe("arrays", () => {
	const reads = [
		"$[1] ?? null",
		"$.length",
		"$.at(1) ?? null",
		"(() => { const [, b = 0] = $; return b; })()",
		"[...$]",
		"Array.from($)",
		"JSON.stringify($)",
		"$.map((x) => x)",
	];
	const writes = [
		"$[1] = 9",
		"$.push(9)",
		"$.length = 0",
		"[$[0], $[1]] = [8, $[0]]",
		"$.splice(0, 1, 7, 6)",
		"$[0]++",
		"$[0] += 5",
		"Object.assign($, [4, 5])",
	];
	const contexts: Record<string, [setup: string, name: string]> = {
		directly: ["const a = observable([1]);", "a"],
		nested: ["const s = observable({ a: [1] });", "s.a"],
		aliased: ["const s = observable({ a: [1] }); const a = s.a;", "a"],
	};
	for (const [context, [setup, name]] of Object.entries(contexts)) {
		for (const read of reads) {
			for (const write of writes) {
				parity(
					`${read} after ${write} ${context}`,
					`${setup}
autorun(() => log(${read.replaceAll("$", name)}));
runInAction(() => { ${write.replaceAll("$", name)}; });
log(${name});`,
				);
			}
		}
	}
});

describe("writes through fast-path objects", () => {
	parity(
		"compound writes through nested values",
		`const store = observable({ user: { n: 1 }, keys: { k: "n" } });
autorun(() => log(store.user.n));
runInAction(() => { store.user.n += 1; });
runInAction(() => { store.user[store.keys.k] *= 10; });
runInAction(() => { store.user.n ||= 5; store.user.n ??= 7; });
log(store.user);`,
	);

	parity(
		"logical assignment only assigns when it has to",
		`const s = observable({ a: 1, b: 0, c: null });
let runs = 0;
autorun(() => { runs++; log([s.a, s.b, s.c]); });
runInAction(() => { s.a ||= 5; s.b ||= 5; s.c ??= 7; s.a &&= 9; });
runInAction(() => { s.a ||= 1; s.c ??= 1; });
log(runs);`,
	);

	it("emits short-circuiting logical assignment", () => {
		expect(compile("const s = observable({ a: 0 });\ns.a ||= 1;")).toContain(
			's.get("a") || s.set("a", 1)',
		);
	});
});

describe("code that doesn't use an observable the compiler sees", () => {
	it("is left exactly as it is", () => {
		const body = `function f(o, k, list) {
  o[k] = 1;
  o.later += o.nested.deep[k];
  delete o[k];
  return k in o && Object.keys(o).length + list[0] + list.length;
}
const g = ({ store, ...rest }) => ({ ...rest, ...store.items[0] });`;
		const plain = generate(parse(body).program).code;
		expect(compile(body)).toContain(plain);
		expect(compile(body)).not.toContain("__sobx_");
	});
});
