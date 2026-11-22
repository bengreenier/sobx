import type {
	Access,
	ClassObservable,
	DiagnosticCode,
	ObservableMember,
	SobxModule,
} from "@sobx/ast";
import { analyze } from "../native.js";

function codes(mod: SobxModule): DiagnosticCode[] {
	return mod.diagnostics.map((d) => d.code);
}

function describeAccess(a: Access): string {
	const ctx =
		a.context.kind === "untracked"
			? "untracked"
			: a.context.kind === "effect"
				? `effect:${a.context.reaction}`
				: a.context.kind === "action"
					? `action:${a.context.action}`
					: a.context.kind === "after-await"
						? `after-await:${a.context.in}`
						: `${a.context.kind}:${a.context.by}`;
	if (a.kind === "ComputedRead") return `ComputedRead ${a.computed} @${ctx}`;
	const key = a.key.kind === "static" ? a.key.name : "<dynamic>";
	const op = a.kind === "Write" ? `(${a.operator})` : "";
	const recv = a.receiver === "this" ? "this" : a.observable;
	return `${a.kind}${op} ${recv}.${key} @${ctx}`;
}

function classObservable(mod: SobxModule, i = 0): ClassObservable {
	const obs = mod.observables[i];
	if (obs?.target !== "class") throw new Error("expected a class observable");
	return obs;
}

function members(mod: SobxModule, i = 0): ObservableMember[] {
	const shape = mod.observables[i]?.shape;
	if (shape?.kind !== "object") throw new Error("expected an object shape");
	return shape.members;
}

function annotations(mod: SobxModule, i = 0): Array<[string, string | null]> {
	return members(mod, i).map((m) => {
		const a = m.annotation;
		let label: string | null = null;
		if (a) {
			label = a.kind;
			if (a.kind === "observable" || a.kind === "computed") {
				label += `.${a.modifier}`;
			}
			if (
				(a.kind === "action" || a.kind === "autoAction" || a.kind === "flow") &&
				a.bound
			) {
				label += ".bound";
			}
		}
		return [m.key, label];
	});
}

describe("autorun", () => {
	it("tracks reads in the body as dependencies", () => {
		const mod = analyze(`
			import { observable, autorun } from "@sobx/magic";
			const s = observable({ a: 1, b: 2 });
			const dispose = autorun(() => console.log(s.a, s.b), { delay: 5 });
		`);
		expect(mod.diagnostics).toEqual([]);
		const [r] = mod.reactions;
		expect(r?.api).toBe("autorun");
		expect(r?.dependencies).toEqual(["access:0", "access:1"]);
		expect(r?.disposerUsed).toBe(true);
		expect(r?.options).toEqual({
			kind: "object",
			open: false,
			entries: { delay: { kind: "literal", value: 5 } },
		});
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read observable:0.a @tracked:reaction:0",
			"Read observable:0.b @tracked:reaction:0",
		]);
	});

	it("reports opaque bodies and writes inside the body", () => {
		const mod = analyze(`
			import { observable, autorun } from "@sobx/magic";
			const s = observable({ a: 1 });
			autorun(run);
			autorun(() => { s.a = 2; });
		`);
		expect(codes(mod)).toEqual(["opaque-function", "write-in-derivation"]);
	});

	it("orders reaction ids across reaction() and autorun()", () => {
		const mod = analyze(`
			import { autorun, reaction } from "@sobx/magic";
			autorun(() => {});
			reaction(() => 1, () => {});
		`);
		expect(mod.reactions.map((r) => [r.id, r.api])).toEqual([
			["reaction:0", "autorun"],
			["reaction:1", "reaction"],
		]);
	});
});

describe("computed()", () => {
	it("creates a boxed computed whose .get() reads are dependencies", () => {
		const mod = analyze(`
			import { observable, computed, reaction } from "@sobx/magic";
			const s = observable({ a: 1, b: 2 });
			const sum = computed(() => s.a + s.b, { name: "sum" });
			reaction(() => sum.get(), (v) => console.log(v));
		`);
		expect(mod.diagnostics).toEqual([]);
		const [c] = mod.computeds;
		expect(c?.source).toEqual({
			kind: "call",
			binding: {
				name: "sum",
				scope: "module",
				declarationKind: "const",
				exported: false,
			},
		});
		expect(c?.options).toMatchObject({
			entries: { name: { kind: "literal", value: "sum" } },
		});
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read observable:0.a @tracked:computed:0",
			"Read observable:0.b @tracked:computed:0",
			"ComputedRead computed:0 @tracked:reaction:0",
		]);
		expect(c?.dependencies).toEqual(["access:0", "access:1"]);
		expect(mod.reactions[0]?.dependencies).toEqual(["access:2"]);
	});

	it("reports escapes and unsupported operations on computeds", () => {
		const mod = analyze(`
			import { computed } from "@sobx/magic";
			const c = computed(() => 1);
			fn(c);
			c.set(2);
			computed(() => 2);
		`);
		expect(codes(mod)).toEqual([
			"observable-escape",
			"unsupported-operation",
			"unbound-observable",
		]);
	});
});

describe("action()", () => {
	it("models named and unnamed actions", () => {
		const mod = analyze(`
			import { observable, action } from "@sobx/magic";
			const s = observable({ a: 1 });
			const inc = action("increment", () => { s.a++; });
			const reset = action(() => { s.a = 0; });
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(mod.actions.map((a) => a.source)).toEqual([
			{
				kind: "action",
				name: "increment",
				binding: {
					name: "inc",
					scope: "module",
					declarationKind: "const",
					exported: false,
				},
			},
			{
				kind: "action",
				name: null,
				binding: {
					name: "reset",
					scope: "module",
					declarationKind: "const",
					exported: false,
				},
			},
		]);
		expect(mod.actions.map((a) => a.writes)).toEqual([
			["access:0"],
			["access:1"],
		]);
	});

	it("records boxes, Maps and Sets as opaque observables", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const b = observable.box(0, { equals: eq });
			const m = observable.map();
			const s = observable.set([1]);
			const m2 = observable(new Map(), {}, { name: "m" });
			const s2 = observable(new Set());
			b.set(1); m.set("k", 1); s.add(2);
		`);
		expect(
			mod.observables.map((o) => [
				o.shape.kind,
				o.target === "object" ? o.binding?.name : null,
				o.options?.kind === "object" ? Object.keys(o.options.entries) : null,
			]),
		).toEqual([
			["box", "b", ["equals"]],
			["map", "m", null],
			["set", "s", null],
			["map", "m2", ["name"]],
			["set", "s2", null],
		]);
		expect(codes(mod)).toEqual(Array(5).fill("opaque-observable"));
		expect(mod.diagnostics.every((d) => d.severity === "info")).toBe(true);
		expect(mod.accesses).toEqual([]);
	});

	it("reports other API members", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const a = observable.nope({});
		`);
		expect(codes(mod)).toEqual(["unsupported-api"]);
		expect(mod.diagnostics[0]?.message).toContain("observable.nope");
	});

	it("accepts comparer anywhere", () => {
		const mod = analyze(`
			import { observable, reaction, comparer } from "@sobx/magic";
			const s = observable({ a: 1 });
			reaction(() => s.a, () => {}, { equals: comparer.structural });
			const eq = comparer.default;
		`);
		expect(codes(mod)).toEqual([]);
		expect(mod.imports.map((i) => i.kind === "NamedImport" && i.api)).toEqual([
			"observable",
			"reaction",
			"comparer",
		]);
	});
});

describe("when()", () => {
	it("tracks the predicate and runs the effect untracked", () => {
		const mod = analyze(`
			import { observable, when } from "@sobx/magic";
			const s = observable({ ready: false, n: 0 });
			when(() => s.ready, () => { s.n = 1; }, { timeout: 100 });
		`);
		const [r] = mod.reactions;
		expect(r).toMatchObject({
			api: "when",
			predicate: { kind: "inline" },
			effect: { kind: "inline" },
			dependencies: ["access:0"],
		});
		expect(mod.accesses.map((a) => a.context.kind)).toEqual([
			"tracked",
			"effect",
		]);
		expect(r?.options).toMatchObject({ entries: { timeout: {} } });
	});

	it("supports the promise form", () => {
		const mod = analyze(`
			import { observable, when } from "@sobx/magic";
			const s = observable({ ready: false });
			await when(() => s.ready, { timeout: 5 });
		`);
		const [r] = mod.reactions;
		expect(r?.api).toBe("when");
		expect(r && "effect" in r ? r.effect : undefined).toBeUndefined();
		expect(r?.options).toMatchObject({ entries: { timeout: {} } });
		expect(mod.diagnostics).toEqual([]);
	});
});

describe("flow()", () => {
	it("is an action whose writes after yield stay inside it", () => {
		const mod = analyze(`
			import { observable, flow } from "@sobx/magic";
			const s = observable({ data: null, loading: false });
			const load = flow(function* () {
				s.loading = true;
				s.data = yield fetchData();
				s.loading = false;
			});
		`);
		expect(mod.actions).toMatchObject([
			{
				source: { kind: "flow", binding: { name: "load" } },
				writes: ["access:0", "access:1", "access:2"],
			},
		]);
		expect(mod.diagnostics).toEqual([]);
	});
});

describe("observable() objects", () => {
	it("links `this` in getters and methods, creating computeds and actions", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable({
				n: 1,
				get double() { return this.n * 2; },
				inc() { this.n++; },
			});
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read this.n @tracked:computed:0",
			"Write(++) this.n @action:action:0",
		]);
		expect(mod.computeds[0]?.source).toEqual({
			kind: "getter",
			observable: "observable:0",
			key: "double",
		});
		expect(mod.computeds[0]?.dependencies).toEqual(["access:0"]);
		expect(mod.actions[0]?.source).toEqual({
			kind: "member",
			observable: "observable:0",
			key: "inc",
			annotation: "autoAction",
			bound: false,
		});
		expect(members(mod).map((m) => [m.key, m.computed, m.action])).toEqual([
			["n", null, null],
			["double", "computed:0", null],
			["inc", null, "action:0"],
		]);
	});

	it("applies overrides", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable({ a: {}, b: 1, c: 2 }, { a: observable.ref, b: false });
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(annotations(mod)).toEqual([
			["a", "observable.ref"],
			["b", "excluded"],
			["c", "observable.deep"],
		]);
	});
});

describe("makeObservable / makeAutoObservable", () => {
	it("models a class with explicit annotations", () => {
		const mod = analyze(`
			import { makeObservable, observable, computed, action } from "@sobx/magic";
			class Store {
				count = 0;
				items = [];
				untracked = 1;
				static instances = 0;
				constructor() {
					makeObservable(this, {
						count: observable,
						items: observable.shallow,
						double: computed.struct,
						inc: action.bound,
						reset: action,
					});
				}
				get double() { return this.count * 2; }
				inc() { this.count++; }
				reset = () => { this.count = 0; };
				static create() { return this.instances; }
			}
			const store = new Store();
			store.inc();
		`);
		expect(mod.diagnostics).toEqual([]);
		const obs = classObservable(mod);
		expect(obs.source).toBe("makeObservable");
		expect(obs.className).toBe("Store");
		expect(obs.exported).toBe(false);
		expect(obs.instances.map((b) => b.name)).toEqual(["store"]);
		expect(annotations(mod)).toEqual([
			["count", "observable.deep"],
			["items", "observable.shallow"],
			["untracked", null],
			["instances", null],
			["double", "computed.struct"],
			["inc", "action.bound"],
			["reset", "action"],
			["create", null],
		]);
		expect(members(mod).find((m) => m.key === "instances")?.static).toBe(true);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read this.count @tracked:computed:0",
			"Write(++) this.count @action:action:0",
			"Write(=) this.count @action:action:1",
			"Read observable:0.inc @untracked",
		]);
		expect(mod.actions.map((a) => a.source)).toEqual([
			{
				kind: "member",
				observable: "observable:0",
				key: "inc",
				annotation: "action",
				bound: true,
			},
			{
				kind: "member",
				observable: "observable:0",
				key: "reset",
				annotation: "action",
				bound: false,
			},
		]);
	});

	it("infers annotations with makeAutoObservable, honoring overrides", () => {
		const mod = analyze(`
			import { makeAutoObservable } from "@sobx/magic";
			class Store {
				a = 1;
				fn = () => {};
				skip = 2;
				constructor() {
					this.assigned = "x";
					makeAutoObservable(this, { skip: false, b: true });
				}
				get b() { return this.a; }
				method() {}
			}
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(annotations(mod)).toEqual([
			["a", "observable.deep"],
			["fn", "autoAction"],
			["skip", "excluded"],
			["b", "computed.default"],
			["method", "autoAction"],
			["assigned", "observable.deep"],
		]);
		expect(members(mod).map((m) => m.annotationSource)).toEqual([
			"inferred",
			"inferred",
			"explicit",
			"inferred",
			"inferred",
			"inferred",
		]);
	});

	it("infers generators as flows", () => {
		const mod = analyze(`
			import { makeAutoObservable, makeObservable, flow } from "@sobx/magic";
			class Store {
				items = [];
				constructor() { makeAutoObservable(this); }
				*load() { this.items = yield fetchItems(); }
			}
			class Explicit {
				constructor() { makeObservable(this, { load: flow.bound, bad: flow }); }
				*load() {}
				bad() {}
			}
		`);
		expect(annotations(mod)).toEqual([
			["items", "observable.deep"],
			["load", "flow"],
		]);
		expect(annotations(mod, 1)).toEqual([
			["load", "flow.bound"],
			["bad", "flow"],
		]);
		expect(mod.actions.map((a) => a.source)).toMatchObject([
			{ kind: "member", key: "load", annotation: "flow", bound: false },
			{ kind: "member", key: "load", annotation: "flow", bound: true },
		]);
		expect(mod.actions[0]?.writes).toEqual(["access:0"]);
		expect(codes(mod)).toEqual(["invalid-annotation"]);
		expect(mod.diagnostics[0]?.message).toContain("must be a generator");
	});

	it("reads decorators when makeObservable has no annotations", () => {
		const mod = analyze(`
			import { makeObservable, observable, computed, action } from "@sobx/magic";
			class Store {
				@observable count = 0;
				@observable.ref ref = {};
				plain = 1;
				constructor() { makeObservable(this); }
				@computed get double() { return this.count * 2; }
				@action.bound inc() { this.count++; }
			}
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(annotations(mod)).toEqual([
			["count", "observable.deep"],
			["ref", "observable.ref"],
			["plain", null],
			["double", "computed.default"],
			["inc", "action.bound"],
		]);
		expect(
			members(mod)
				.filter((m) => m.annotation)
				.every((m) => m.annotationSource === "decorator"),
		).toBe(true);
	});

	it("models classes that use standard decorators without makeObservable", () => {
		const mod = analyze(`
			import { observable, computed, action, autorun } from "@sobx/magic";
			class Store {
				@observable accessor count = 0;
				plain = 1;
				@computed get double() { return this.count * 2; }
				@action inc() { this.count++; }
			}
			const store = new Store();
			autorun(() => store.double);
		`);
		expect(mod.diagnostics).toEqual([]);
		const obs = classObservable(mod);
		expect(obs.source).toBe("decorators");
		expect(obs.span).toEqual(obs.classSpan);
		expect(obs.instances.map((b) => b.name)).toEqual(["store"]);
		expect(annotations(mod)).toEqual([
			["count", "observable.deep"],
			["plain", null],
			["double", "computed.default"],
			["inc", "action"],
		]);
		expect(members(mod).map((m) => m.accessor)).toEqual([
			true,
			false,
			false,
			false,
		]);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read this.count @tracked:computed:0",
			"Write(++) this.count @action:action:0",
			"Read observable:0.double @tracked:reaction:0",
		]);
	});

	it("requires `accessor` for observable fields with standard decorators", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			class Store {
				@observable count = 0;
			}
		`);
		expect(codes(mod)).toEqual(["invalid-annotation"]);
		expect(mod.diagnostics[0]?.message).toContain("accessor");
	});

	it("applies autoBind and deep options to inferred annotations only", () => {
		const mod = analyze(`
			import { makeAutoObservable, observable, action } from "@sobx/magic";
			class Store {
				data = {};
				pinned = {};
				constructor() {
					makeAutoObservable(
						this,
						{ pinned: observable, explicit: action },
						{ autoBind: true, deep: false },
					);
				}
				method() {}
				explicit() {}
			}
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(annotations(mod)).toEqual([
			["data", "observable.ref"],
			["pinned", "observable.deep"],
			["method", "autoAction.bound"],
			["explicit", "action"],
		]);
		expect(mod.actions.map((a) => a.source)).toEqual([
			expect.objectContaining({ key: "method", bound: true }),
			expect.objectContaining({ key: "explicit", bound: false }),
		]);
	});

	it("applies options to observable() objects", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable({ a: {}, f() {} }, {}, { deep: false, autoBind: true });
		`);
		expect(annotations(mod)).toEqual([
			["a", "observable.ref"],
			["f", "autoAction.bound"],
		]);
	});

	it("warns when options cannot be resolved", () => {
		const mod = analyze(`
			import { makeAutoObservable } from "@sobx/magic";
			const s1 = makeAutoObservable({ a: 1 }, {}, opts);
			const s2 = makeAutoObservable({ a: 1 }, {}, { autoBind: flag });
			const s3 = makeAutoObservable({ a: 1 }, {}, { ...opts });
			const s4 = makeAutoObservable({ a: 1 }, {}, { name: "ok" });
		`);
		expect(codes(mod)).toEqual([
			"unresolved-arguments",
			"unresolved-arguments",
			"unresolved-arguments",
		]);
	});

	it("records the options argument", () => {
		const mod = analyze(`
			import { makeAutoObservable } from "@sobx/magic";
			class Store {
				constructor() { makeAutoObservable(this, {}, { autoBind: true }); }
			}
		`);
		expect(mod.observables[0]?.options).toEqual({
			kind: "object",
			open: false,
			entries: { autoBind: { kind: "literal", value: true } },
		});
	});

	it("reports makeObservable(this) without annotations or decorators", () => {
		const mod = analyze(`
			import { makeObservable } from "@sobx/magic";
			class Store {
				a = 1;
				constructor() { makeObservable(this); }
			}
		`);
		expect(codes(mod)).toEqual(["missing-annotations"]);
	});

	it("does not link `this` in nested functions or static members", () => {
		const mod = analyze(`
			import { makeAutoObservable } from "@sobx/magic";
			class Store {
				a = 1;
				static b = 2;
				constructor() { makeAutoObservable(this); }
				method() {
					setTimeout(function () { this.a; });
					setTimeout(() => { this.a; });
				}
				static s() { this.b; }
			}
		`);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read this.a @untracked",
		]);
		expect(mod.accesses[0]?.span.loc.start.line).toBe(9);
	});

	it("reports `this` escaping", () => {
		const mod = analyze(`
			import { makeAutoObservable } from "@sobx/magic";
			class Store {
				a = 1;
				constructor() {
					makeAutoObservable(this);
					const self = this;
					register(this);
				}
			}
		`);
		expect(codes(mod)).toEqual(["observable-escape", "observable-escape"]);
	});

	it("tracks instances, respecting shadowing", () => {
		const mod = analyze(`
			import { makeAutoObservable, autorun } from "@sobx/magic";
			class Store {
				a = 1;
				constructor() { makeAutoObservable(this); }
			}
			const store = new Store();
			autorun(() => store.a);
			function f() {
				const store = { a: 2 };
				store.a;
			}
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read observable:0.a @tracked:reaction:0",
		]);
	});

	it("reports exported classes and unbound / escaping instances", () => {
		const mod = analyze(`
			import { makeAutoObservable } from "@sobx/magic";
			export class Store {
				a = 1;
				constructor() { makeAutoObservable(this); }
			}
			register(new Store());
			class Sub extends Store {}
		`);
		expect(classObservable(mod).exported).toBe(true);
		expect(codes(mod)).toEqual([
			"observable-escape",
			"observable-escape",
			"observable-escape",
		]);
		expect(mod.diagnostics.map((d) => d.message)).toEqual([
			expect.stringContaining("exported"),
			expect.stringContaining("not stored in a variable"),
			expect.stringContaining("subclassed"),
		]);
	});

	it("reports calls outside a constructor and unsupported targets", () => {
		const mod = analyze(`
			import { makeObservable, makeAutoObservable } from "@sobx/magic";
			class Store {
				init() { makeAutoObservable(this); }
			}
			makeObservable(someObject, {});
		`);
		expect(codes(mod)).toEqual([
			"make-observable-outside-constructor",
			"unsupported-target",
		]);
	});

	it("models makeAutoObservable on an object literal", () => {
		const mod = analyze(`
			import { makeAutoObservable } from "@sobx/magic";
			const s = makeAutoObservable({ a: 1, inc() { this.a++; } });
			s.inc();
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(mod.observables[0]).toMatchObject({
			source: "makeAutoObservable",
			target: "object",
			binding: { name: "s" },
		});
		expect(annotations(mod)).toEqual([
			["a", "observable.deep"],
			["inc", "autoAction"],
		]);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Write(++) this.a @action:action:0",
			"Read observable:0.inc @untracked",
		]);
	});

	it("reports invalid and unknown annotations", () => {
		const mod = analyze(`
			import { makeObservable, observable, computed, action } from "@sobx/magic";
			class Store {
				a = 1;
				constructor() {
					makeObservable(this, {
						a: computed,
						m: observable,
						g: observable,
						missing: observable,
						weird: somethingElse,
					});
				}
				m() {}
				get g() { return 1; }
				weird = 1;
			}
		`);
		// Sorted by source position: member `a`, the `missing` key, members `g` and `weird`.
		expect(codes(mod)).toEqual([
			"invalid-annotation",
			"unknown-annotation-key",
			"invalid-annotation",
			"unresolved-arguments",
		]);
	});

	it("links action() calls held by class fields", () => {
		const mod = analyze(`
			import { makeAutoObservable, action } from "@sobx/magic";
			class Store {
				a = 1;
				inc = action(() => { this.a++; });
				constructor() { makeAutoObservable(this); }
			}
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(mod.actions).toHaveLength(1);
		expect(members(mod).find((m) => m.key === "inc")).toMatchObject({
			valueKind: "function",
			annotation: { kind: "autoAction" },
			action: "action:0",
		});
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Write(++) this.a @action:action:0",
		]);
	});
});

describe("ids", () => {
	it("assigns ids in source order and rewrites references", () => {
		const mod = analyze(`
			import { observable, computed, action, makeAutoObservable, reaction } from "@sobx/magic";
			const c = computed(() => 1);
			class Deco {
				@observable accessor x = 0;
			}
			class Store {
				a = 1;
				constructor() { makeAutoObservable(this); }
				get g() { return this.a; }
				m() { this.a++; }
			}
			const act = action(() => {});
			const o = observable({ y: 1, get h() { return this.y; } });
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(
			mod.observables.map((o) => [
				o.id,
				o.target === "class" ? o.className : o.source,
			]),
		).toEqual([
			["observable:0", "Deco"],
			["observable:1", "Store"],
			["observable:2", "observable"],
		]);
		expect(
			mod.computeds.map((c) => [
				c.id,
				c.source.kind === "getter"
					? `${c.source.observable}.${c.source.key}`
					: "call",
			]),
		).toEqual([
			["computed:0", "call"],
			["computed:1", "observable:1.g"],
			["computed:2", "observable:2.h"],
		]);
		expect(
			mod.actions.map((a) => [
				a.id,
				a.source.kind === "member"
					? `${a.source.observable}.${a.source.key}`
					: a.source.kind,
			]),
		).toEqual([
			["action:0", "observable:1.m"],
			["action:1", "action"],
		]);
		expect(members(mod, 1).map((m) => [m.key, m.computed, m.action])).toEqual([
			["a", null, null],
			["g", "computed:1", null],
			["m", null, "action:0"],
		]);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read this.a @tracked:computed:1",
			"Write(++) this.a @action:action:0",
			"Read this.y @tracked:computed:2",
		]);
		expect(
			mod.accesses.map((a) =>
				a.kind === "ComputedRead" ? null : a.observable,
			),
		).toEqual(["observable:1", "observable:1", "observable:2"]);
	});
});

describe("renumbering", () => {
	// Regression: accesses in one function used to share a context object, which renumbering
	// then remapped once per access (found by differential fuzzing during the Rust port).
	it("remaps each access's context exactly once", () => {
		const mod = analyze(`
			import { makeAutoObservable, action } from "@sobx/magic";
			class S {
				a = 1;
				fn = () => { this.a; this.a; };
				act = action(() => {});
				constructor() { makeAutoObservable(this); }
			}
		`);
		const fnAction = mod.actions.find(
			(a) => a.source.kind === "member" && a.source.key === "fn",
		)?.id;
		expect(fnAction).toBe("action:0");
		expect(mod.accesses.map((a) => a.context)).toEqual([
			{ kind: "action", action: "action:0" },
			{ kind: "action", action: "action:0" },
		]);
	});
});

describe("reassignment", () => {
	it("reports a second observable assignment once", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			let s = observable({ a: 1 });
			s = observable({ a: 2 });
		`);
		expect(codes(mod)).toEqual(["observable-reassigned"]);
	});

	it("reports once regardless of processing order", () => {
		const mod = analyze(`
			import { observable, makeAutoObservable } from "@sobx/magic";
			class Store {
				constructor() { makeAutoObservable(this); }
			}
			let s = new Store();
			s = observable({ a: 1 });
		`);
		expect(codes(mod)).toEqual(["observable-reassigned"]);
	});
});
