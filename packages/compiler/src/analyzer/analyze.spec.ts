import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	Access,
	DiagnosticCode,
	ObjectObservable,
	SobxModule,
} from "@sobx/ast";
import { type AnalyzeOptions, analyze } from "../native.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "__fixtures__");
const MOBX: AnalyzeOptions = { moduleSpecifier: "mobx" };

/** Replace span objects with compact `line:col-line:col` strings for readable snapshots. */
function compact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(compact);
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		if ("start" in obj && "end" in obj && "loc" in obj) {
			const { start, end } = obj.loc as {
				start: { line: number; column: number };
				end: { line: number; column: number };
			};
			return `${start.line}:${start.column}-${end.line}:${end.column}`;
		}
		return Object.fromEntries(
			Object.entries(obj).map(([k, v]) => [k, compact(v)]),
		);
	}
	return value;
}

function objectObservable(mod: SobxModule, i = 0): ObjectObservable {
	const obs = mod.observables[i];
	if (obs?.target !== "object")
		throw new Error("expected an object observable");
	return obs;
}

function codes(mod: SobxModule): DiagnosticCode[] {
	return mod.diagnostics.map((d) => d.code);
}

function describeAccess(a: Access): string {
	if (a.kind === "ComputedRead") {
		return `ComputedRead ${a.computed} @${a.context.kind}`;
	}
	const key = a.key.kind === "static" ? a.key.name : "<dynamic>";
	const op = a.kind === "Write" ? a.operator : "";
	return `${a.kind}${op ? `(${op})` : ""} ${a.observable}.${key} @${a.context.kind}`;
}

describe("analyze: fixtures", () => {
	const fixtures = readdirSync(FIXTURES_DIR)
		.filter((f) => f.endsWith(".input.ts"))
		.sort();

	it.each(fixtures)("%s", (fixture) => {
		const source = readFileSync(path.join(FIXTURES_DIR, fixture), "utf-8");
		const mod = analyze(source, { ...MOBX, filename: fixture });
		expect(mod.diagnostics).toEqual([]);
		expect(compact(mod)).toMatchSnapshot();
	});
});

describe("analyze: imports", () => {
	it("ignores modules other than the configured specifier", () => {
		const mod = analyze(
			`import { observable } from "mobx"; const s = observable({ a: 1 });`,
		);
		expect(mod.imports).toEqual([]);
		expect(mod.observables).toEqual([]);
	});

	it("resolves aliased imports", () => {
		const mod = analyze(
			`import { observable as obs } from "@sobx/magic"; const s = obs({ a: 1 }); s.a;`,
		);
		expect(mod.observables).toHaveLength(1);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read observable:0.a @untracked",
		]);
	});

	it("reports namespace, default, and unknown imports", () => {
		const mod = analyze(
			`import * as m from "@sobx/magic"; import d from "@sobx/magic"; import { nope } from "@sobx/magic";`,
		);
		expect(codes(mod)).toEqual([
			"namespace-import",
			"default-import",
			"unknown-import",
		]);
	});

	it("models flow and when", () => {
		const mod = analyze(
			`import { flow, when } from "@sobx/magic"; flow(function* () {}); when(() => true);`,
		);
		expect(mod.unsupported).toEqual([]);
		expect(mod.actions.map((a) => a.source.kind)).toEqual(["flow"]);
		expect(mod.reactions.map((r) => r.api)).toEqual(["when"]);
		expect(codes(mod)).toEqual([]);
	});

	it("reports APIs used other than as a direct call", () => {
		const mod = analyze(
			`import { observable } from "@sobx/magic"; const make = observable; make({});`,
		);
		expect(codes(mod)).toEqual(["api-not-called"]);
		expect(mod.observables).toEqual([]);
	});
});

describe("analyze: observables", () => {
	it("captures object shape", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			export const s = observable({
				n: 1, str: "x", obj: {}, arr: [], fn: () => 1,
				get double() { return this.n * 2 },
				set double(v) {},
				method() {},
				other: compute(),
			});
		`);
		const obs = objectObservable(mod);
		expect(obs.source).toBe("observable");
		expect(obs.binding).toEqual({
			name: "s",
			scope: "module",
			declarationKind: "const",
			exported: true,
		});
		expect(codes(mod)).toEqual(["observable-escape"]);
		expect(obs.shape.kind).toBe("object");
		if (obs.shape.kind !== "object") return;
		expect(obs.shape.open).toBe(false);
		expect(
			obs.shape.members.map((m) => [
				m.key,
				m.memberKind,
				m.valueKind,
				m.annotation?.kind,
			]),
		).toEqual([
			["n", "field", "primitive", "observable"],
			["str", "field", "primitive", "observable"],
			["obj", "field", "object", "observable"],
			["arr", "field", "array", "observable"],
			["fn", "field", "function", "autoAction"],
			["double", "getter", "getter", "computed"],
			["method", "method", "function", "autoAction"],
			["other", "field", "unknown", "observable"],
		]);
		expect(
			obs.shape.members.every((m) => m.annotationSource === "inferred"),
		).toBe(true);
	});

	it("marks shapes with spreads or computed keys as open", () => {
		const mod = analyze(
			`import { observable } from "@sobx/magic"; const s = observable({ ...base, [k]: 1, a: 1 });`,
		);
		expect(mod.observables[0]?.shape).toMatchObject({
			kind: "object",
			open: true,
		});
	});

	it("reports unbound observables", () => {
		const mod = analyze(
			`import { observable } from "@sobx/magic"; register(observable({ a: 1 }));`,
		);
		expect(objectObservable(mod).binding).toBeNull();
		expect(codes(mod)).toEqual(["unbound-observable"]);
	});

	it("reports reassignment of an observable binding", () => {
		const mod = analyze(
			`import { observable } from "@sobx/magic"; let s = observable({ a: 1 }); s = other;`,
		);
		expect(codes(mod)).toContain("observable-reassigned");
	});

	it("handles TS wrappers around observable()", () => {
		const mod = analyze(
			`import { observable } from "@sobx/magic"; const s = observable({ a: 1 }) as State; s!.a;`,
		);
		expect(mod.diagnostics).toEqual([]);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read observable:0.a @untracked",
		]);
	});
});

describe("analyze: accesses", () => {
	it("classifies reads, writes, compound writes, updates, and deletes", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable({ a: 1, b: 2 });
			s.a;
			s.a = 2;
			s.b += 1;
			s.a++;
			--s.b;
			s.c ??= 3;
			delete s.c;
			s["b"];
			s?.a;
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read observable:0.a @untracked",
			"Write(=) observable:0.a @untracked",
			"Write(+=) observable:0.b @untracked",
			"Write(++) observable:0.a @untracked",
			"Write(--) observable:0.b @untracked",
			"Write(??=) observable:0.c @untracked",
			"Delete observable:0.c @untracked",
			"Read observable:0.b @untracked",
			"Read observable:0.a @untracked",
		]);
		const writes = mod.accesses.filter((a) => a.kind === "Write");
		expect(writes.map((w) => w.readsPrevious)).toEqual([
			false,
			true,
			true,
			true,
			true,
		]);
	});

	it("records destructuring as reads", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable({ a: 1, b: 2 });
			const { a, b: renamed = 0 } = s;
		`);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read observable:0.a @untracked",
			"Read observable:0.b @untracked",
		]);
		expect(
			mod.accesses.every((a) => a.kind === "Read" && a.via === "destructure"),
		).toBe(true);
	});

	it("reports rest destructuring as an escape", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable({ a: 1, b: 2 });
			const { a, ...rest } = s;
		`);
		expect(codes(mod)).toEqual(["observable-escape"]);
	});

	it("does not link a shadowing binding with the same name", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const store = observable({ count: 0 });
			function f(store) {
				return store.count;
			}
			function g() {
				const store = { count: 1 };
				store.count = 2;
			}
			store.count;
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(mod.accesses).toHaveLength(1);
		expect(mod.accesses[0]?.span.loc.start.line).toBe(11);
	});

	it("reports aliasing, passing, returning, exporting, and spreading", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable({ a: 1 });
			const alias = s;
			fn(s);
			const get = () => s;
			const copy = { ...s };
			export { s };
		`);
		expect(codes(mod)).toEqual([
			"observable-escape",
			"observable-escape",
			"observable-escape",
			"observable-escape",
			"observable-escape",
		]);
		expect(mod.diagnostics.map((d) => d.message)).toEqual([
			expect.stringContaining("aliased"),
			expect.stringContaining("passed as an argument"),
			expect.stringContaining("returned"),
			expect.stringContaining("spread"),
			expect.stringContaining("exported"),
		]);
		expect(objectObservable(mod).binding?.exported).toBe(true);
	});

	it("reports unsupported operations", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable({ a: 1 });
			"a" in s;
			Object.keys(s);
			for (const k in s) {}
		`);
		expect(codes(mod)).toEqual([
			"unsupported-operation",
			"unsupported-operation",
			"unsupported-operation",
		]);
	});

	it("allows harmless identity uses", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable({ a: 1 });
			typeof s;
			s === other;
		`);
		expect(mod.diagnostics).toEqual([]);
	});

	it("ignores references in type positions", () => {
		const mod = analyze(`
			import { observable, reaction } from "@sobx/magic";
			const s = observable({ a: 1 });
			type S = typeof s;
			type A = typeof s.a;
			let d: ReturnType<typeof reaction>;
			let o: typeof observable;
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(mod.accesses).toEqual([]);
	});

	it("reports mutation through the values of ref / struct properties", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable(
				{ obj: {}, list: [], name: "" },
				{ obj: observable.ref, list: observable.struct },
			);
			s.obj.x = 1;
			s.list[0] = 2;
			delete s.obj.k;
			s.obj.n++;
			s.list.push(1);
			s.name.toUpperCase();
			s.obj.x;
		`);
		expect(mod.diagnostics.map((d) => [d.code, d.span.loc.start.line])).toEqual(
			[
				["deep-mutation", 7],
				["deep-mutation", 8],
				["deep-mutation", 9],
				["deep-mutation", 10],
				["deep-mutation", 11],
			],
		);
		expect(mod.diagnostics[0]?.message).toContain("observable.ref");
		expect(mod.accesses.every((a) => a.kind === "Read")).toBe(true);
	});

	it("does not report mutation through deep (default) properties", () => {
		const mod = analyze(`
			import { observable } from "@sobx/magic";
			const s = observable({ obj: {}, list: [] });
			s.obj.x = 1;
			s.list.push(1);
			s.list[0] = 2;
		`);
		expect(mod.diagnostics).toEqual([]);
	});

	it("reports dynamic keys, as errors only when tracked", () => {
		const mod = analyze(`
			import { observable, reaction } from "@sobx/magic";
			const s = observable({ a: 1 });
			s[k];
			reaction(() => s[k], () => {});
		`);
		expect(mod.diagnostics.map((d) => [d.code, d.severity])).toEqual([
			["dynamic-key", "warning"],
			["dynamic-key", "error"],
		]);
	});
});

describe("analyze: reactions", () => {
	it("attributes reads to the data function as dependencies", () => {
		const mod = analyze(`
			import { observable, reaction } from "@sobx/magic";
			const s = observable({ a: 1, b: 2, c: 3 });
			const dispose = reaction(
				() => s.a + s.b,
				(sum) => console.log(sum, s.c),
				{ fireImmediately: true, delay: 10, equals: cmp },
			);
		`);
		expect(mod.diagnostics).toEqual([]);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read observable:0.a @tracked",
			"Read observable:0.b @tracked",
			"Read observable:0.c @effect",
		]);
		const [r] = mod.reactions;
		if (r?.api !== "reaction") throw new Error("expected reaction()");
		expect(r.dependencies).toEqual(["access:0", "access:1"]);
		expect(r?.disposerUsed).toBe(true);
		expect(r?.data).toMatchObject({ kind: "inline", params: 0 });
		expect(r?.effect).toMatchObject({ kind: "inline", params: 1 });
		expect(r?.options).toEqual({
			kind: "object",
			open: false,
			entries: {
				fireImmediately: { kind: "literal", value: true },
				delay: { kind: "literal", value: 10 },
				equals: { kind: "unknown" },
			},
		});
	});

	it("flags reads in functions nested inside the data function", () => {
		const mod = analyze(`
			import { observable, reaction } from "@sobx/magic";
			const s = observable({ a: 1 });
			reaction(() => [1].map(() => s.a), () => {});
		`);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Read observable:0.a @tracked-nested",
		]);
		expect(mod.reactions[0]?.dependencies).toEqual([]);
		expect(codes(mod)).toEqual(["untracked-nested-read"]);
	});

	it("reports opaque data functions", () => {
		const mod = analyze(`
			import { reaction } from "@sobx/magic";
			reaction(getData, effect);
		`);
		const [r] = mod.reactions;
		if (r?.api !== "reaction") throw new Error("expected reaction()");
		expect(r.data.kind).toBe("opaque");
		expect(r.effect.kind).toBe("opaque");
		expect(mod.reactions[0]?.disposerUsed).toBe(false);
		expect(codes(mod)).toEqual(["opaque-function"]);
	});

	it("reports missing arguments", () => {
		const mod = analyze(
			`import { reaction } from "@sobx/magic"; reaction(() => 1);`,
		);
		expect(mod.reactions).toEqual([]);
		expect(codes(mod)).toEqual(["invalid-arguments"]);
	});
});

describe("analyze: actions", () => {
	it("attributes writes to runInAction bodies", () => {
		const mod = analyze(`
			import { observable, runInAction } from "@sobx/magic";
			const s = observable({ a: 1, b: 2 });
			runInAction(() => {
				s.a = s.b;
				s.b++;
				setTimeout(() => { s.a = 0; });
			});
		`);
		expect(mod.accesses.map(describeAccess)).toEqual([
			"Write(=) observable:0.a @action",
			"Read observable:0.b @action",
			"Write(++) observable:0.b @action",
			"Write(=) observable:0.a @untracked",
		]);
		expect(mod.actions[0]?.writes).toEqual(["access:0", "access:2"]);
	});
});

describe("analyze: serialization", () => {
	it("produces JSON-serializable output", () => {
		const source = readFileSync(
			path.join(FIXTURES_DIR, "combined.input.ts"),
			"utf-8",
		);
		const mod = analyze(source, MOBX);
		expect(JSON.parse(JSON.stringify(mod))).toEqual(mod);
	});
});
