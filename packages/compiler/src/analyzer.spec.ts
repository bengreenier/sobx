import generate from "@babel/generator";
import { parse } from "@babel/parser";
import { resolveOptions, transform } from "unplugin-ast";
import { analyze } from "./native.js";
import { transformSobx } from "./transform.js";
import { SobxTransformer } from "./transformers/sobx.js";

function compile(source: string): string {
	const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
	return generate(transformSobx(ast.program, source).ast).code;
}

/** Run the bundler-plugin path (unplugin-ast + SobxTransformer) on a file. */
async function compileWithPlugin(source: string): Promise<string> {
	const result = await transform(
		source,
		"/src/file.ts",
		resolveOptions({ transformer: [SobxTransformer()] }),
	);
	return result?.code ?? source;
}

describe("native analyzer", () => {
	it("returns the IR for a module", () => {
		const mod = analyze(
			`import { observable } from "@sobx/magic"; const s = observable({ a: 1 }); s.a;`,
		);
		expect(mod.kind).toBe("Module");
		expect(mod.moduleSpecifier).toBe("@sobx/magic");
		expect(mod.observables).toHaveLength(1);
		expect(mod.accesses).toHaveLength(1);
	});

	it("throws on syntax errors", () => {
		expect(() => analyze("const = ;")).toThrow(/failed to parse/);
	});
});

describe("transformSobx, driven by the analyzer", () => {
	it("does not rewrite a local variable that shadows an observable", () => {
		const out = compile(`import { observable } from "@sobx/magic";
const store = observable({ count: 0 });
function f(store) { return store.count; }
store.count;`);
		expect(out).toContain("return store.count;");
		expect(out).toContain('store.get("count");');
	});

	it("follows aliased imports", () => {
		const out = compile(`import { observable as o } from "@sobx/magic";
const s = o({ a: 1 });
s.a = 2;`);
		expect(out).toContain("new ProxyLike({");
		expect(out).toContain('s.set("a", 2);');
	});

	it("ignores a same-named function that is not imported from the API module", () => {
		const out = compile(`import { reaction } from "@sobx/magic";
function observable(x) { return x; }
const s = observable({ a: 1 });
s.a;`);
		expect(out).not.toContain("ProxyLike");
		expect(out).not.toContain(".get(");
	});

	it("compiles compound assignments and updates", () => {
		const out = compile(`import { observable } from "@sobx/magic";
const s = observable({ n: 0 });
s.n += 2;
s.n++;
const before = s.n--;`);
		expect(out).toContain('s.set("n", s.get("n") + 2);');
		expect(out).toContain('s.set("n", s.get("n") + 1), s.get("n") - 1;');
		expect(out).toContain(
			'const before = (s.set("n", s.get("n") - 1), s.get("n") + 1);',
		);
	});

	it("observes reads made through functions the data function calls", () => {
		const out = compile(`import { observable, reaction } from "@sobx/magic";
const s = observable({ a: 1, b: 2 });
const total = () => s.a + s.b;
reaction(() => total(), (v) => console.log(v));`);
		expect(out).toContain('s.addObserver("a"');
		expect(out).toContain('s.addObserver("b"');
	});

	it("compiles runInAction(fn) to fn()", () => {
		const out = compile(`import { observable, runInAction } from "@sobx/magic";
const s = observable({ a: 1 });
runInAction(() => { s.a = 2; });
const result = runInAction(compute);`);
		expect(out).toMatch(/\(\(\) => \{\s*s\.set\("a", 2\);\s*\}\)\(\);/);
		expect(out).toContain("const result = compute();");
	});

	it("observes each key once", () => {
		const out = compile(`import { observable, reaction } from "@sobx/magic";
const s = observable({ a: 1 });
reaction(() => s.a + s.a, (v) => console.log(v));`);
		expect(out.match(/addObserver/g)).toHaveLength(1);
	});

	it("leaves files that do not import the API module untouched", () => {
		const source = `const s = { a: 1 };\ns.a = 2;`;
		const ast = parse(source, { sourceType: "module" });
		expect(transformSobx(ast.program, source).ast).toBe(ast.program);
	});
});

describe("bundler plugin (unplugin-ast)", () => {
	it("compiles a module and injects the runtime import", async () => {
		const out =
			await compileWithPlugin(`import { observable, reaction } from "@sobx/magic";
const store = observable({ count: 0 });
reaction(() => store.count, (n) => console.log(n));
store.count = store.count + 1;
store.count += 1;`);
		expect(out).toMatch(/^import \{ ProxyLike \} from "@sobx\/runtime";/);
		expect(out).toMatch(/new ProxyLike\(\{\s*count: 0\s*\}\)/);
		expect(out).toContain('store.addObserver("count"');
		expect(out).toContain('store.set("count", store.get("count") + 1)');
		expect(out).not.toMatch(/store\.count/);
	});

	it("skips files without sobx usages", async () => {
		const source = `import { observable } from "mobx";\nconst s = observable({ a: 1 });\ns.a;`;
		expect(await compileWithPlugin(source)).toBe(source);
	});
});
