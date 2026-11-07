/**
 * Differential fuzz: random (valid) programs mixing every modeled feature, analyzed by both
 * the Rust and Babel analyzers. `analyze` here is the native shim, which throws if the full
 * IRs differ. Runs only in the `native` vitest project.
 */
import { analyze } from "./analyze.js";

/** Small deterministic PRNG (mulberry32), so failures reproduce from the seed. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function program(seed: number): string {
	const r = rng(seed);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
	const chance = (p: number) => r() < p;
	const keys = ["a", "b", "count", "items", "user", "naïve"] as const;
	const key = () => pick(keys);
	const stores: string[] = [];
	const reassignable = new Set<string>();
	const exported = new Set<string>();
	let uid = 0;
	const fresh = (prefix: string) => `${prefix}${uid++}`;
	const lines: string[] = [
		'import { observable, reaction, autorun, computed, action, runInAction, makeObservable, makeAutoObservable } from "sobx";',
		'import { external } from "./external";',
	];

	const access = (s: string): string =>
		pick([
			`${s}.${key()}`,
			`${s}.${key()}.x`,
			`${s}[k]`,
			`${s}["${key()}"]`,
			`${s}?.${key()}`,
			`(${s} as any).${key()}`,
			`${s}.items.map(f)`,
			`${s}.method()`,
			`${s}.method?.()`,
		]);
	const write = (s: string): string =>
		pick([
			`${s}.${key()} = 1`,
			`${s}.${key()} += 1`,
			`${s}.count++`,
			`delete ${s}.${key()}`,
			`${s}.items.push(1)`,
			`${s}.user.name = "x"`,
			`[${s}.a] = [1]`,
		]);
	const misc = (s: string): string =>
		pick([
			`const { ${key()}: ${fresh("v")}, b: ${fresh("v")} = 0 } = ${s}`,
			`const { a: ${fresh("v")}, ...${fresh("rest")} } = ${s}`,
			`fn(${s})`,
			`const ${fresh("alias")} = ${s}`,
			`"a" in ${s}`,
			`Object.keys(${s})`,
			`typeof ${s}`,
			`external.read(${s}.a)`,
		]);
	/** `await` is only emitted directly in async bodies, never in nested arrows. */
	const body = (s: string, depth = 0, isAsync = false): string => {
		const parts: string[] = [];
		const n = 1 + Math.floor(r() * 3);
		for (let i = 0; i < n; i++) {
			const choice = r();
			if (choice < 0.4) parts.push(`${access(s)};`);
			else if (choice < 0.65) parts.push(`${write(s)};`);
			else if (choice < 0.75) parts.push(`${misc(s)};`);
			else if (choice < 0.85) {
				parts.push(
					isAsync && depth === 0
						? pick([
								"await tick();",
								`for await (const x of xs) { ${access(s)}; }`,
								`while (more) { await tick(); ${write(s)}; }`,
								`do { ${write(s)}; await tick(); } while (more);`,
							])
						: "tick();",
				);
			} else if (choice < 0.93 && depth < 2) {
				parts.push(`[1].forEach(() => { ${body(s, depth + 1)} });`);
			} else parts.push(`helper${Math.floor(r() * 3)}();`);
		}
		return parts.join(" ");
	};

	const count = 1 + Math.floor(r() * 3);
	for (let i = 0; i < count; i++) {
		const name = `s${i}`;
		stores.push(name);
		const decl = pick(["const", "let"]);
		if (decl === "let") reassignable.add(name);
		const shape = `{ a: 1, b: "x", count: 0, items: [], user: { name: "" }, naïve: null, get double() { return this.count * 2; }, method() { ${body("this")} }, *gen() {} }`;
		const kind = r();
		if (kind < 0.5) {
			const opts = chance(0.3)
				? `, {}, { deep: ${chance(0.5)}, autoBind: true }`
				: "";
			lines.push(`${decl} ${name} = observable(${shape}${opts});`);
		} else if (kind < 0.7) {
			lines.push(`${decl} ${name} = makeAutoObservable(${shape});`);
		} else {
			const cls = `S${i}`;
			const variant = r();
			let expression = false;
			if (variant < 0.2) {
				lines.push(
					`${chance(0.2) ? "export " : ""}class ${cls} { a = 1; count = 0; items = []; user = { name: "" }; static total = 0; constructor() { this.b = "x"; makeObservable(this, { a: observable, count: observable.ref, items: observable.shallow, double: computed, method: action.bound, missing: observable }); } get double() { return this.count * this.sum(); } sum() { return this.a; } async method() { ${body("this", 0, true)} } }`,
				);
			} else if (variant < 0.4) {
				lines.push(
					`class ${cls} { a = 1; count = 0; items = []; user = { name: "" }; fn = () => { ${body("this")} }; act = action(() => { this.count++; }); constructor() { makeAutoObservable(this, { items: false }, { autoBind: true }); } get double() { return this.count; } method() { ${body("this")} } *load() {} }`,
				);
			} else if (variant < 0.6) {
				// Shapes where Babel's and oxc's ASTs differ: `this:` params, private and computed
				// members, `this` in plain functions / object literals / statics, async loops.
				lines.push(
					`class ${cls} { #secret = 1; #priv() { return this.#secret; } [key]() {} a = 1; count = 0; items = []; user = { name: "" }; static total = 0; constructor() { makeAutoObservable(this); } method(this: ${cls}, x: number) { ${body("this")} } nested() { const plain = function () { return this.a; }; const obj = { fn: function () { return this.a; }, arrow: () => this.count }; return obj; } static create() { return this.total; } async load() { ${body("this", 0, true)} } }`,
				);
			} else if (variant < 0.8) {
				expression = true;
				const named = chance(0.5) ? ` Named${i}` : "";
				lines.push(
					`const ${cls} = class${named} { a = 1; count = 0; items = []; user = { name: "" }; constructor() { makeAutoObservable(this); } method() { ${body("this")} } };`,
				);
			} else {
				lines.push(
					`class ${cls} { @observable accessor a = 1; @observable count = 0; items = []; @computed get double() { return this.a * 2; } @action.bound method() { ${body("this")} } }`,
				);
			}
			if (decl === "let" && chance(0.4)) {
				// Instance created by assignment.
				lines.push(`let ${name};`, `${name} = new ${cls}();`);
			} else {
				lines.push(`${decl} ${name} = new ${cls}();`);
			}
			if (chance(0.2) && !expression) lines.push(`register(new ${cls}());`);
		}
	}
	lines.push(
		"function helper0() { return s0.a; }",
		"const helper1 = () => s0.count;",
		"const helper2 = function () { return external.value; };",
	);

	const ops = 2 + Math.floor(r() * 6);
	for (let i = 0; i < ops; i++) {
		const s = pick(stores);
		const choice = r();
		const isAsync = chance(0.3);
		const asyncKw = isAsync ? "async " : "";
		if (choice < 0.2) {
			const store = chance(0.5) ? `const ${fresh("d")} = ` : "";
			const opts = chance(0.3) ? ", { fireImmediately: true, delay: 10 }" : "";
			lines.push(
				`${store}reaction(${asyncKw}() => ${access(s)}, (v) => { ${body(s)} }${opts});`,
			);
		} else if (choice < 0.35) {
			lines.push(`autorun(${asyncKw}() => { ${body(s, 0, isAsync)} });`);
		} else if (choice < 0.45) {
			const c = fresh("c");
			lines.push(
				`const ${c} = computed(() => ${access(s)} + helper${Math.floor(r() * 3)}());`,
				`autorun(() => ${c}.get());`,
			);
		} else if (choice < 0.55) {
			lines.push(`runInAction(${asyncKw}() => { ${body(s, 0, isAsync)} });`);
		} else if (choice < 0.65) {
			const name = chance(0.5) ? `"n${i}", ` : "";
			lines.push(
				`const ${fresh("act")} = action(${name}${asyncKw}() => { ${body(s, 0, isAsync)} });`,
			);
		} else if (choice < 0.75) {
			lines.push(`function ${fresh("f")}(${s}) { return ${access(s)}; }`);
		} else if (choice < 0.8 && reassignable.has(s)) {
			lines.push(`${s} = other;`);
		} else if (choice < 0.85 && !exported.has(s)) {
			exported.add(s);
			lines.push(`export { ${s} };`);
		} else {
			lines.push(body(s));
		}
	}
	if (chance(0.1)) {
		lines.push(
			"export default class { a = 1; constructor() { makeAutoObservable(this); } };",
		);
	}
	return lines.join("\n");
}

// Override with SOBX_FUZZ_SEEDS for a longer search.
const SEEDS = Array.from(
	{ length: Number(process.env.SOBX_FUZZ_SEEDS ?? 400) },
	(_, i) => i + 1,
);

describe("differential: invalid sources", () => {
	it.each([
		"const x = ;",
		"function f() { await x; }",
		'import { observable } from "sobx"; const s = observable({ a: 1 }',
		"class { }",
	])("both analyzers reject %j", (source) => {
		// The shim rethrows Babel's error when both throw, and reports a mismatch otherwise.
		let message = "";
		try {
			analyze(source);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).not.toBe("");
		expect(message).not.toMatch(/analyzer threw but/);
	});
});

describe("differential: Rust vs Babel analyzer on random programs", () => {
	it.each(SEEDS)("seed %i", (seed) => {
		const source = program(seed);
		try {
			analyze(source, { filename: `seed-${seed}.ts` });
		} catch (error) {
			throw new Error(
				`${(error as Error).message}\n\nsource (seed ${seed}):\n${source}`,
			);
		}
	});
});
