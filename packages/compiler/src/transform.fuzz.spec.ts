import generate from "@babel/generator";
import { parse } from "@babel/parser";
import { transformSobx } from "./transform.js";

/**
 * Parse source to a Program; returns null if invalid.
 */
function tryParse(source: string): ReturnType<typeof parse> | null {
	try {
		return parse(source, {
			sourceType: "module",
			plugins: ["typescript"],
		});
	} catch {
		return null;
	}
}

/**
 * Full compile pipeline: parse -> transform -> generate.
 * Used to assert the transform never throws on valid input.
 */
function compileNoThrow(
	source: string,
): { ok: true; code: string } | { ok: false; error: unknown } {
	const ast = tryParse(source);
	if (!ast) return { ok: false, error: new Error("Parse failed") };
	try {
		const { ast: transformed } = transformSobx(ast.program);
		const code = generate(transformed).code;
		return { ok: true, code };
	} catch (e) {
		return { ok: false, error: e };
	}
}

const IDS = ["a", "b", "state", "store", "s", "x", "y", "obj", "m"];
const KEYS = ["x", "y", "count", "name", "value", "n", "id"];
const LITERALS = ["0", "1", '""', '"x"', "true", "false", "null"];

function pick<T>(arr: readonly T[]): T {
	const i = Math.floor(Math.random() * arr.length);
	const v = arr[i];
	if (v === undefined) return arr[0] as T;
	return v;
}

describe("transformSobx fuzz", () => {
	it("does not throw on random valid programs using observable/reaction/member", () => {
		const NUM_RUNS = 500;
		for (let i = 0; i < NUM_RUNS; i++) {
			const obsId = pick(IDS);
			const obsKey = pick(KEYS);
			const obsLiteral = pick(LITERALS);
			const head = `const ${obsId} = observable({ ${obsKey}: ${obsLiteral} });`;
			const tailStmts: string[] = [];
			const n = Math.floor(Math.random() * 6);
			for (let j = 0; j < n; j++) {
				const key = pick(KEYS);
				const literal = pick(LITERALS);
				switch (Math.floor(Math.random() * 4)) {
					case 0:
						tailStmts.push(
							`reaction(() => ${obsId}.${key}, (v) => console.log(v));`,
						);
						break;
					case 1:
						tailStmts.push(`void ${obsId}.${key};`);
						break;
					case 2:
						tailStmts.push(`${obsId}.${key} = ${literal};`);
						break;
					default:
						tailStmts.push(
							`reaction(() => ${obsId}.${key}, (val) => console.log(val));`,
						);
				}
			}
			const source = tailStmts.length
				? `${head}\n${tailStmts.join("\n")}`
				: head;
			const result = compileNoThrow(source);
			if (result.ok) {
				const reparse = tryParse(result.code);
				if (!reparse) {
					throw new Error(
						`Generated code did not parse:\n---\n${result.code}\n---`,
					);
				}
			} else {
				const err = result.error as Error;
				if (err?.message !== "Parse failed") {
					throw new Error(
						`Transform threw on input:\n---\n${source}\n---\n${err}`,
					);
				}
			}
		}
	});

	it("does not throw on programs with only observable()", () => {
		const NUM_RUNS = 200;
		for (let i = 0; i < NUM_RUNS; i++) {
			const id = pick(IDS);
			const literal = pick(LITERALS);
			const source = `const ${id} = observable({ x: ${literal} });`;
			const result = compileNoThrow(source);
			if (!result.ok) {
				throw new Error(
					`Transform threw on input:\n---\n${source}\n---\n${result.error}`,
				);
			}
		}
	});

	it("does not throw on programs with only reaction()", () => {
		const NUM_RUNS = 200;
		for (let i = 0; i < NUM_RUNS; i++) {
			const id = pick(IDS);
			const key = pick(KEYS);
			const source = `const ${id} = observable({ ${key}: 0 });\nreaction(() => ${id}.${key}, (v) => {});`;
			const result = compileNoThrow(source);
			if (!result.ok) {
				throw new Error(
					`Transform threw on input:\n---\n${source}\n---\n${result.error}`,
				);
			}
		}
	});
});
