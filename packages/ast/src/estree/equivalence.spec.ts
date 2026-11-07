/**
 * SPIKE: checks the TS-ESTree slice produces the same IR as the Babel analyzer, using both
 * typescript-estree and oxc-parser as the parser.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TSESTree } from "@typescript-eslint/types";
import { parse as tsParse } from "@typescript-eslint/typescript-estree";
import { parseSync } from "oxc-parser";
import { analyze } from "../analyze.js";
import type { SobxModule } from "../types.js";
import { analyzeEstree } from "./analyze.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "__fixtures__");

const PARSERS: Record<string, (src: string) => TSESTree.Program> = {
	"typescript-estree": (src) =>
		tsParse(src, { range: true, jsx: false }) as TSESTree.Program,
	oxc: (src) =>
		parseSync("input.ts", src, {
			range: true,
			preserveParens: false,
			lang: "ts",
		}).program as unknown as TSESTree.Program,
};

/** The parts of the IR the slice covers, with member links (computed/action) stripped. */
function project(mod: SobxModule) {
	return {
		imports: mod.imports,
		observables: mod.observables.map((o) => ({
			...o,
			shape:
				o.shape.kind === "object"
					? {
							...o.shape,
							members: o.shape.members.map(
								({ computed: _c, action: _a, ...m }) => m,
							),
						}
					: o.shape,
		})),
		accesses: mod.accesses,
		reactions: mod.reactions,
		unsupported: mod.unsupported,
		diagnostics: mod.diagnostics,
	};
}

const HARD: Record<string, string> = {
	shadowing: `
		import { observable, autorun } from "sobx";
		const store = observable({ count: 0 });
		function f(store) { return store.count; }
		function g() { const store = { count: 1 }; store.count = 2; }
		autorun(() => store.count);
	`,
	destructuring: `
		import { observable } from "sobx";
		const s = observable({ a: 1, b: 2, c: 3 });
		const { a, b: renamed = 0, ...rest } = s;
		({ c: x } = s);
	`,
	wrappers: `
		import { observable } from "sobx";
		const s = observable({ a: 1 }) as State;
		(s as any).a;
		s!.a;
		(s).a;
		(s satisfies object).a;
		s?.a;
		s?.["a"];
	`,
	writes: `
		import { observable } from "sobx";
		const s = observable({ a: 1, b: 2, list: [], obj: {} });
		s.a = 2; s.b += 1; s.a++; --s.b; s.c ??= 3; delete s.c;
		[s.a] = [1];
		for (s.b of [1]) {}
		s.obj.x = 1; s.list.push(1); s.list.map(f); delete s.obj.k;
	`,
	"dynamic-keys": `
		import { observable, reaction } from "sobx";
		const s = observable({ a: 1 });
		s[k];
		s[\`a\`];
		s[0];
		reaction(() => s[k], () => {});
	`,
	"type-positions": `
		import { observable, reaction } from "sobx";
		const s = observable({ a: 1 });
		type S = typeof s;
		type A = typeof s.a;
		let d: ReturnType<typeof reaction>;
		let o: typeof observable;
	`,
	exports: `
		import { observable } from "sobx";
		export const s = observable({ a: 1 });
		const t = observable({ b: 1 });
		export { t };
	`,
	operations: `
		import { observable } from "sobx";
		const s = observable({ a: 1 });
		"a" in s;
		Object.keys(s);
		for (const k in s) {}
		typeof s;
		s === other;
		fn(s);
		const alias = s;
		const copy = { ...s };
		const arr = [s];
	`,
	"local-object": `
		import { observable } from "sobx";
		const Object = { keys() {} };
		const s = observable({ a: 1 });
		Object.keys(s);
	`,
	"non-ascii": `// héllo wörld 🎉 — ünïcode
		import { observable, autorun } from "sobx";
		const s = observable({ naïve: "café", n: 1 }); // 😀
		autorun(() => console.log(s.naïve, s.n));
	`,
	reassignment: `
		import { observable } from "sobx";
		let s = observable({ a: 1 });
		s = observable({ a: 2 });
		let u = observable({ a: 1 });
		u = other;
		let w;
		w = observable({ a: 1 });
		w.a;
	`,
	"reactions-and-options": `
		import { observable, reaction, autorun } from "sobx";
		const s = observable({ a: 1, b: 2 }, {}, { deep: true });
		const d = reaction(
			() => s.a + s.b,
			(v) => console.log(v, s.a),
			{ fireImmediately: true, delay: 10, equals: cmp, name: null },
		);
		autorun(() => { s.a = 1; [1].map(() => s.b); });
		reaction(getData, effect);
		autorun(run, { ...opts });
	`,
	"imports-and-apis": `
		import * as m from "sobx";
		import d from "sobx";
		import { nope, flow, when, observable as obs } from "sobx";
		const make = obs;
		const b = obs.box(0);
		flow(function* () {});
		when(() => true);
		register(obs({ a: 1 }));
	`,
	shapes: `
		import { observable } from "sobx";
		const s = observable({
			n: 1, str: "x", t: \`y\`, neg: -1, big: 1n, re: /x/, u: undefined, nul: null,
			obj: {}, arr: [], fn: () => 1, gen: function* () {},
			method() {}, *genMethod() {}, set only(v) {},
			"quoted": 1, 2: 2, [k]: 3, ...rest,
			other: compute(),
		});
	`,
};

const INPUTS: Array<[string, string, string]> = [
	...readdirSync(FIXTURES)
		.filter((f) => f.endsWith(".input.ts"))
		.sort()
		.map(
			(f) =>
				[f, readFileSync(path.join(FIXTURES, f), "utf-8"), "mobx"] as [
					string,
					string,
					string,
				],
		),
	...Object.entries(HARD).map(
		([name, src]) => [name, src, "sobx"] as [string, string, string],
	),
];

describe.each(Object.keys(PARSERS))("TS-ESTree slice via %s", (parser) => {
	it.each(INPUTS)("%s matches the Babel analyzer", (_name, src, spec) => {
		const babel = analyze(src, { moduleSpecifier: spec });
		const program = PARSERS[parser]?.(src) as TSESTree.Program;
		const slice = analyzeEstree(program, src, { moduleSpecifier: spec });
		expect(project(slice)).toEqual(project(babel));
	});
});

// SPIKE: the Rust analyzer (packages/ast-native), loaded from its built napi addon.
const NATIVE = path.join(
	__dirname,
	"..",
	"..",
	"..",
	"ast-native",
	"sobx-ast-native.node",
);
const native = existsSync(NATIVE)
	? (createRequire(import.meta.url)(NATIVE) as {
			analyze(source: string, moduleSpecifier?: string): string;
		})
	: null;

describe.skipIf(!native)("Rust analyzer (oxc_semantic)", () => {
	it.each(INPUTS)("%s matches the Babel analyzer", (_name, src, spec) => {
		const babel = analyze(src, { moduleSpecifier: spec });
		const rust = JSON.parse(native?.analyze(src, spec) ?? "null") as SobxModule;
		expect(project(rust)).toEqual(project(babel));
	});
});
