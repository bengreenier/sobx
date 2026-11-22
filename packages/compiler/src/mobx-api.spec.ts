/**
 * All of MobX's API can be used in compiled code: everything MobX exports can be imported from
 * "@sobx/magic", valid MobX code is never a build error, and it runs as it does with MobX.
 */
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import * as runtime from "@sobx/runtime";
import { transformSync } from "esbuild";
import * as mobx from "mobx";
import * as magic from "../../magic/src/index.js";
import { transformSobx } from "./transform.js";
import { PARSER_PLUGINS } from "./transformers/sobx.js";

const INTERNAL = ["__esModule", "default", "module.exports", "_interceptReads"];
const exported = Object.keys(mobx).filter((name) => !INTERNAL.includes(name));

// biome-ignore lint/suspicious/noExplicitAny: looked up by name
type Api = Record<string, any>;
const theirApi: Api = { ...mobx };
const magicApi: Api = { ...magic };
const runtimeApi: Api = { ...runtime };

function compile(source: string) {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript", "jsx", ...PARSER_PLUGINS],
	});
	const result = transformSobx(ast.program, source);
	const errors = result.diagnostics.filter((d) => d.severity === "error");
	expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
	return generate(result.ast).code;
}

function javascript(source: string, useDefineForClassFields: boolean) {
	return transformSync(source, {
		loader: "ts",
		tsconfigRaw: {
			compilerOptions: {
				experimentalDecorators: true,
				useDefineForClassFields,
			},
		},
	}).code;
}

const IMPORT = /import \{([^}]*)\} from "[^"]*";/g;

async function run(code: string, api: unknown): Promise<unknown[]> {
	const logs: unknown[] = [];
	const script = code.replace(
		IMPORT,
		(_, names: string) => `const {${names.replace(/ as /g, ": ")}} = api;`,
	);
	await new Function(
		"api",
		"log",
		`"use strict";return (async()=>{${script}})()`,
	)(api, (...values: unknown[]) => {
		for (const v of values) logs.push(JSON.parse(JSON.stringify(v ?? null)));
	});
	return logs;
}

/** `body` behaves the same compiled for sobx as with MobX, however class fields are emitted. */
function parity(name: string, body: string) {
	const names = exported.filter((n) =>
		new RegExp(`(?<![\\w.$])${n.replace("$", "\\$")}\\b`).test(body),
	);
	for (const define of [true, false]) {
		it(`${name} (useDefineForClassFields: ${define})`, async () => {
			const source = `import { ${names.join(", ")} } from "@sobx/magic";\n${body}`;
			const ours = await run(javascript(compile(source), define), runtime);
			const theirs = await run(javascript(source, define), mobx);
			expect(theirs.length).toBeGreaterThan(0);
			expect(ours).toEqual(theirs);
		});
	}
}

describe("exports", () => {
	it.each(exported)("%s can be imported and used as a value", (name) => {
		expect(name in magic).toBe(true);
		const code = compile(
			`import { ${name} } from "@sobx/magic";\nconst value = ${name};\nfoo(value);`,
		);
		expect(code).toContain('from "@sobx/runtime"');
	});

	it.each(["observable", "computed", "action", "flow", "comparer"] as const)(
		"%s has MobX's members",
		(name) => {
			const members = Object.keys(theirApi[name]).filter(
				(m) => !/^(annotationType_|options_|make_|extend_|decorate_)/.test(m),
			);
			const ours = Object.getOwnPropertyNames(magicApi[name]);
			for (const member of members) {
				// Annotation internals, which MobX puts on the functions themselves.
				if (member.endsWith("_")) continue;
				expect(ours, `${name}.${member}`).toContain(member);
				expect(runtimeApi[name]).toHaveProperty(member);
			}
		},
	);

	it("types needn't be imported with `import type`", () => {
		compile(
			`import { observable, IReactionDisposer, IObservableArray } from "@sobx/magic";
const list: IObservableArray<number> = observable([1]);
let stop: IReactionDisposer | undefined;`,
		);
	});

	it("magic says so when not compiled", () => {
		expect(() => magic.extendObservable({}, {})).toThrow(/not compiled/);
		expect(() => magic.observable.object({})).toThrow(/not compiled/);
	});
});

describe("valid MobX code", () => {
	parity(
		"legacy decorators",
		`
class Store {
	@observable x = 1;
	@observable.ref ref = { a: 1 };
	@observable deep = { a: 1 };
	@observable.shallow list = [{ a: 1 }];
	@observable uninitialized;
	constructor() { makeObservable(this); }
	@computed get double() { return this.x * 2; }
	@computed({ keepAlive: true }) get kept() { return { x: this.x }; }
	@computed.struct get struct() { return { odd: this.x % 2 }; }
	@action inc() { this.x++; }
	@action.bound bound() { this.x += 10; }
	@action("custom") named() { this.x += 100; }
	@action field = () => { this.x += 1000; };
	@flow *load() { this.x = yield Promise.resolve(5); }
}
const s = new Store();
let structs = 0;
autorun(() => log(s.x, s.double));
autorun(() => { void s.struct; structs++; });
s.inc();
const { bound } = s;
bound();
s.named();
s.field();
await s.load();
log(structs, s.kept === s.kept, s.named.name);
log(isObservable(s.deep), isObservable(s.ref), isObservable(s.list[0]));
log(isObservableProp(s, "uninitialized"), isComputedProp(s, "double"), isAction(s.inc), isAction(s.field));
const other = new Store();
other.inc();
log(other.x, s.x);
`,
	);

	parity(
		"legacy decorators: inheritance",
		`
class Base {
	@observable x = 1;
	constructor() { makeObservable(this); }
	@computed get v() { return this.x; }
	@action act() { this.x++; }
}
class Sub extends Base {
	@observable y = 10;
	constructor() { super(); makeObservable(this); }
	@override get v() { return super.v + this.y; }
	@override act() { super.act(); this.y++; }
}
class Plain extends Base {
	constructor() { super(); makeObservable(this); }
}
const s = new Sub();
autorun(() => log(s.v));
s.act();
s.y = 20;
const p = new Plain();
p.act();
log(p.x);
`,
	);

	parity(
		"annotations and options from elsewhere",
		`
const annotations = { a: observable.ref, inc: action };
const options = { deep: false, name: "named" };
const named = action("custom");
const kept = computed({ keepAlive: true });
const o = observable({ a: {}, b: {}, inc() { this.b = { n: 1 }; } }, annotations, options);
autorun(() => log(isObservable(o.a), isObservable(o.b), o.b));
o.inc();
const extra = { x: observable };
class C {
	x = 1;
	y = 2;
	constructor() { makeObservable(this, { ...extra, y: observable, act: named, c: kept }); }
	act() { this.x++; }
	get c() { return [this.x]; }
}
const c = new C();
autorun(() => log(c.x));
c.act();
log(c.c === c.c, c.act.name);
const target = observable.object({ v: 1 }, { v: false });
log(isObservableProp(target, "v"));
const other = makeObservable(Object.assign({}, { q: 1 }), { q: observable });
log(isObservableProp(other, "q"));
const values = observable([{ a: 1 }], { deep: false });
log(isObservable(values[0]));
`,
	);

	parity(
		"override and inheritance with makeObservable",
		`
class Base {
	x = 1;
	constructor() { makeObservable(this, { x: observable, d: computed, act: action }); }
	get d() { return this.x * 2; }
	act() { this.x++; }
}
class Sub extends Base {
	constructor() { super(); makeObservable(this, { d: override, act: override, extra: computed }); }
	get d() { return super.d + 1; }
	act() { super.act(); this.x++; }
	get extra() { return this.d + 1; }
}
const s = new Sub();
autorun(() => log(s.d, s.extra));
s.act();
`,
	);

	parity(
		"extendObservable, observe, intercept, spy",
		`
class Store {
	constructor() {
		extendObservable(this, { x: 1, get d() { return this.x * 2; }, inc() { this.x++; } }, { inc: action.bound });
	}
}
const s = new Store();
const stop = observe(s, (change) => log(change.type, change.name, change.newValue, change.oldValue));
intercept(s, "x", (change) => { if (change.newValue > 10) return null; return change; });
autorun(() => log(s.x, s.d));
const { inc } = s;
inc();
s.x = 50;
s.x = 5;
stop();
s.x = 6;
const events = [];
const unspy = spy((e) => events.push(e.type));
s.x = 7;
unspy();
log(events);
const local = observable({ a: 1, nested: { b: 1 } });
observe(local, "a", (change) => log("a", change.newValue));
observe(local, (change) => log("local", change.name, change.newValue));
intercept(local, (change) => (change.newValue === "no" ? null : change));
local.a = 2;
local.a = "no";
local.b = 3;
delete local.b;
log(local.a, getDebugName(local, "a").includes("a"));
log(getDependencyTree(autorun(() => local.a)).dependencies.length);
log(getObserverTree(local, "a").observers.length);
`,
	);

	parity(
		"options of reactions and computeds",
		`
const s = observable({ a: 1, b: 1 });
const errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
autorun(() => { if (s.a > 2) throw new Error("x"); }, { onError: (e) => errors.push(e.message) });
autorun(() => log("delayed", s.a), { delay: 1 });
reaction(() => s.a, (a) => log("scheduled", a), { scheduler: (run) => Promise.resolve().then(run) });
const controller = new AbortController();
reaction(() => s.b, (b) => log("b", b), { signal: controller.signal, name: "r", fireImmediately: true });
s.a = 2;
s.b = 2;
controller.abort();
s.b = 3;
await wait(20);
s.a = 3;
await wait(20);
log(errors);
const c = computed(() => s.a * 2, { set: (v) => { s.a = v / 2; }, keepAlive: true, requiresReaction: false, name: "c" });
c.set(20);
log(s.a, c.get());
await when(() => s.a > 100, { timeout: 5 }).catch((e) => log(e.message));
const observedLog = [];
onBecomeObserved(s, "b", () => log("observed"));
onBecomeUnobserved(s, "b", () => log("unobserved"));
autorun(() => s.b)();
`,
	);

	parity(
		"getters of local objects are cached computeds",
		`
let runs = 0;
const s = observable({ n: 1, get big() { runs++; return this.n > 10; }, get twice() { return [this.big, this.big]; } });
autorun(() => log("run", s.big));
autorun(() => { s.twice; });
s.n = 2;
s.n = 11;
s.n = 12;
log(runs, s.big, runs);
runInAction(() => { s.n = 1; log(s.big, s.big, runs); });
`,
	);

	parity(
		"spying on local objects",
		`
const s = observable({ a: 1, get d() { return this.a * 2; }, inc() { this.a++; } });
autorun(() => s.d, { name: "run" });
const events = [];
const stop = spy((e) => {
	events.push([e.type, String(e.name).replace(/@\\d+/, "@N"), e.newValue, e.oldValue, e.arguments, e.spyReportStart, e.spyReportEnd]);
});
s.inc();
s.a = 5;
s.a = 5;
s.b = 1;
delete s.b;
runInAction(() => { s.a += 1; });
stop();
s.a = 7;
log(events);
`,
	);

	parity(
		"custom atoms and reactions, transactions",
		`
const atom = createAtom("time", () => log("start"), () => log("stop"));
const r = new Reaction("r", () => log("invalidated"));
r.track(() => atom.reportObserved());
atom.reportChanged();
r.dispose();
const s = observable({ a: 1 });
autorun(() => log(s.a));
transaction(() => { s.a = 2; s.a = 3; });
log(s[$mobx] !== undefined);
const result = flowResult(flow(function* () { return yield Promise.resolve(1); })());
log(await result);
const m = new ObservableMap([["a", 1]]);
autorun(() => log(m.get("a")));
m.set("a", 2);
m.merge({ a: 3 });
m.replace({ b: 1 });
log(m instanceof ObservableMap, isObservableMap(m), keys(m));
onReactionError((e) => log("handled", e.message));
const error = console.error;
console.error = () => {};
autorun(() => { throw new Error("y"); });
console.error = error;
`,
	);
});
