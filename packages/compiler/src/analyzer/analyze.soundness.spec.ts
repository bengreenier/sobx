import type { Access, DiagnosticCode, SobxModule } from "@sobx/ast";
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
	return `${a.kind}${op} ${a.receiver === "this" ? "this" : a.observable}.${key} @${ctx}`;
}

describe("imports used in tracked functions", () => {
	it("reports member reads and calls on imports, once per derivation", () => {
		const mod = analyze(`
			import { autorun, computed } from "@sobx/magic";
			import { store } from "./store";
			import getCount from "./count";
			import type { Shape } from "./types";
			autorun(() => {
				console.log(store.a, store.b, getCount());
			});
			const c = computed(() => store.a);
		`);
		expect(
			mod.diagnostics.map((d) => [d.code, d.message.split('"')[1]]),
		).toEqual([
			["unresolved-import", "store"],
			["unresolved-import", "getCount"],
			["unresolved-import", "store"],
		]);
		expect(mod.diagnostics.map((d) => d.related)).toEqual([
			["reaction:0"],
			["reaction:0"],
			["computed:0"],
		]);
	});

	it("ignores imports used outside tracked functions and the API module itself", () => {
		const mod = analyze(`
			import { autorun, observable } from "@sobx/magic";
			import { store } from "./store";
			store.a;
			autorun(() => { const o = observable; });
		`);
		expect(codes(mod)).not.toContain("unresolved-import");
	});

	it("reports imports reached through called local functions", () => {
		const mod = analyze(`
			import { autorun } from "@sobx/magic";
			import { store } from "./store";
			function read() { return store.a; }
			autorun(() => read());
		`);
		expect(codes(mod)).toEqual(["unresolved-import"]);
	});
});

describe("nested reads", () => {
	it("records the property path read through a member", () => {
		const mod = analyze(`
			import { observable, reaction } from "@sobx/magic";
			const s = observable({ user: { name: "", address: { city: "" } }, items: [] });
			reaction(
				() => [s.user.name, s.user.address.city, s.items.length, s.items[i].x, s.items.map(f)],
				() => {},
			);
		`);
		expect(
			mod.accesses.map((a) =>
				a.kind === "Read"
					? [
							a.key.kind === "static" ? a.key.name : "?",
							a.path.map((k) => (k.kind === "static" ? k.name : "<dynamic>")),
							a.called,
						]
					: null,
			),
		).toEqual([
			["user", ["name"], false],
			["user", ["address", "city"], false],
			["items", ["length"], false],
			["items", ["<dynamic>"], false],
			["items", ["map"], false],
		]);
	});

	it("does not treat read-only array methods as mutations", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable({ items: [] });
			s.items.map(f);
			s.items.filter(f).length;
			s.items.reduce(f, 0);
			s.items.sort();
		`);
		expect(mod.diagnostics.map((d) => [d.code, d.span.loc.start.line])).toEqual(
			[["deep-mutation", 7]],
		);
	});

	it("marks method calls", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable({ inc() {} });
			s.inc();
		`);
		const [read] = mod.accesses;
		expect(read?.kind === "Read" && read.called).toBe(true);
	});
});

describe("accesses after await", () => {
	it("excludes writes after await from async actions", () => {
		const mod = analyze(`
			import { observable, runInAction } from "@sobx/magic";
			const s = observable({ a: 0, b: 0, c: 0 });
			runInAction(async () => {
				s.a = 1;
				await save();
				s.b = 2;
			});
		`);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Write(=) observable:0.a @action:action:0",
			"Write(=) observable:0.b @after-await:action:0",
		]);
		expect(mod.actions[0]?.writes).toEqual(["access:0"]);
		expect(codes(mod)).toEqual(["after-await"]);
	});

	it("treats awaited assignments and loops containing await as after-await", () => {
		const mod = analyze(`
			import { observable, action } from "@sobx/magic";
			const s = observable({ a: 0, b: 0 });
			const load = action(async () => {
				s.a = await fetchA();
				while (more) {
					s.b++;
					await tick();
				}
			});
		`);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Write(=) observable:0.a @after-await:action:0",
			"Write(++) observable:0.b @after-await:action:0",
		]);
		expect(mod.actions[0]?.writes).toEqual([]);
	});

	it("applies to async class methods and to reads in async tracked functions", () => {
		const mod = analyze(`
			import { makeAutoObservable, autorun } from "@sobx/magic";
			class Store {
				a = 0;
				constructor() { makeAutoObservable(this); }
				async load() {
					const x = await fetch();
					this.a = x;
				}
			}
			const store = new Store();
			autorun(async () => {
				store.a;
				await tick();
				store.a;
			});
		`);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Write(=) this.a @after-await:action:0",
			"Read observable:0.a @tracked:reaction:0",
			"Read observable:0.a @after-await:reaction:0",
		]);
		expect(mod.reactions[0]?.dependencies).toEqual(["access:1"]);
		expect(mod.diagnostics.map((d) => d.message)).toEqual([
			expect.stringContaining("wrap it in runInAction"),
			expect.stringContaining("not tracked"),
		]);
	});

	it("leaves synchronous actions alone", () => {
		const mod = analyze(`
			import { observable, runInAction } from "@sobx/magic";
			const s = observable({ a: 0 });
			runInAction(() => { s.a = 1; });
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(mod.actions[0]?.writes).toEqual(["access:0"]);
	});
});

describe("indirect dependencies", () => {
	it("follows calls to methods from computed getters", () => {
		const mod = analyze(`
			import { makeAutoObservable } from "@sobx/magic";
			class Cart {
				items = [];
				tax = 0;
				constructor() { makeAutoObservable(this); }
				get total() { return this.sum() + this.tax; }
				sum() { return this.items.reduce((a, b) => a + b, 0); }
			}
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read this.sum @tracked:computed:0",
			"Read this.tax @tracked:computed:0",
			"Read this.items @action:action:0",
		]);
		expect(mod.computeds[0]?.dependencies).toEqual(["access:0", "access:1"]);
		expect(mod.computeds[0]?.indirectDependencies).toEqual(["access:2"]);
	});

	it("follows local functions transitively, through observable bindings", () => {
		const mod = analyze(`
			import { observable, reaction } from "@sobx/magic";
			const s = observable({ a: 1, b: 2, read() { return this.b; } });
			function outer() { return inner() + s.read(); }
			const inner = () => s.a;
			reaction(() => outer(), () => {});
		`);
		expect(mod.diagnostics).toEqual([]);
		const [r] = mod.reactions;
		expect(r?.dependencies).toEqual([]);
		expect(
			r?.indirectDependencies.map((id) => {
				const a = mod.accesses.find((x) => x.id === id);
				return a ? describeAccess(a) : id;
			}),
		).toEqual([
			"Read this.b @action:action:0",
			"Read observable:0.read @untracked",
			"Read observable:0.a @untracked",
		]);
	});

	it("does not follow explicit actions (they run untracked)", () => {
		const mod = analyze(`
			import { makeObservable, observable, action, computed } from "@sobx/magic";
			class Store {
				a = 1;
				constructor() {
					makeObservable(this, { a: observable, bump: action, value: computed });
				}
				bump() { return this.a; }
				get value() { return this.bump(); }
			}
		`);
		expect(mod.computeds[0]?.indirectDependencies).toEqual([]);
	});

	it("follows optional calls", () => {
		const mod = analyze(`
			import { observable, autorun } from "@sobx/magic";
			const s = observable({ a: 1, read() { return this.a; } });
			autorun(() => s.read?.());
			autorun(() => s?.read());
		`);
		expect(mod.reactions.map((r) => r.indirectDependencies.length)).toEqual([
			1, 1,
		]);
	});

	it("does not count a TypeScript this parameter", () => {
		const mod = analyze(`
			import { makeAutoObservable } from "@sobx/magic";
			class S {
				a = 1;
				constructor() { makeAutoObservable(this); }
				method(this: S, x: number) { this.a = x; }
			}
		`);
		expect(mod.actions[0]?.body).toMatchObject({ kind: "inline", params: 1 });
	});

	it("handles recursion", () => {
		const mod = analyze(`
			import { observable, autorun } from "@sobx/magic";
			const s = observable({ n: 1 });
			function f(x) { return x > 0 ? f(x - 1) + s.n : 0; }
			autorun(() => f(3));
		`);
		expect(mod.reactions[0]?.indirectDependencies).toEqual(["access:0"]);
	});
});

describe("collections", () => {
	it("reports observable arrays", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const a = observable([1, 2]);
			const ok = observable({ list: [] });
			const unknown = observable(value);
		`);
		expect(mod.diagnostics.map((d) => [d.code, d.related])).toEqual([
			["observable-collection", ["observable:0"]],
		]);
	});
});
