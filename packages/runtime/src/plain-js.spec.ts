/**
 * Plain JavaScript on observables (no compiler, no explicit API) behaves as with MobX. Each
 * scenario runs as is against `mobx` and `@sobx/runtime`; what it logs must match, including how
 * often reactions run.
 */
import * as mobx from "mobx";
import * as sobx from "./index.js";

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript on purpose
type Any = any;
type Log = (value: unknown) => void;
type Scenario = (api: Any, log: Log) => void;

function run(scenario: Scenario, api: Any): unknown[] {
	const logs: unknown[] = [];
	scenario(api, (value) =>
		logs.push(JSON.parse(JSON.stringify(value ?? null))),
	);
	return logs;
}

function parity(name: string, scenario: Scenario) {
	it(name, () => {
		expect(run(scenario, sobx)).toEqual(run(scenario, mobx));
	});
}

/** Not in the "no-proxies" test project. */
const withProxies = describe.skipIf(process.env.SOBX_NO_PROXIES);

beforeAll(() => {
	mobx.configure({ enforceActions: "never" });
	sobx.configure({ enforceActions: "never" });
});
afterAll(() => {
	mobx.configure({ enforceActions: "observed" });
	sobx.configure({ enforceActions: "observed" });
});

const key = ["later"][0] as string;

/** Ways to read a key that doesn't exist yet from `o`. */
const READS: Record<string, (o: Any) => unknown> = {
	"o.later": (o) => o.later,
	"o?.later": (o) => o?.later,
	"o[k]": (o) => o[key],
	"o?.[k]": (o) => o?.[key],
	"o.later?.x": (o) => o.later?.x,
	"o.later?.()": (o) => {
		try {
			return o.later?.();
		} catch {
			return "not a function";
		}
	},
	destructuring: (o) => {
		const { later } = o;
		return later;
	},
	"destructuring with a default": (o) => {
		const { later = "none" } = o;
		return later;
	},
	"destructured parameter": (o) => (({ later }) => later)(o),
	rest: (o) => {
		const { a, ...rest } = o;
		return [a, rest];
	},
	template: (o) => `${o.later}`,
	in: (o) => "later" in o,
	spread: (o) => ({ ...o }),
	"for...in": (o) => {
		const keys: string[] = [];
		for (const k in o) keys.push(k);
		return keys;
	},
	"Object.keys": (o) => Object.keys(o),
	"Object.keys (aliased)": (o) => {
		const { keys } = Object;
		return keys(o);
	},
	"Object.values": (o) => Object.values(o),
	"Object.entries": (o) => Object.entries(o),
	"Object.assign": (o) => Object.assign({}, o),
	"Object.getOwnPropertyNames": (o) => Object.getOwnPropertyNames(o),
	"Reflect.ownKeys": (o) =>
		Reflect.ownKeys(o).filter((k) => typeof k === "string"),
	"Reflect.has": (o) => Reflect.has(o, "later"),
	"Reflect.get": (o) => Reflect.get(o, "later"),
	"JSON.stringify": (o) => JSON.stringify(o),
};

/** Ways to add the key to `o`. */
const WRITES: Record<string, (o: Any) => void> = {
	"o.later = v": (o) => {
		o.later = 1;
	},
	"o[f()] += v": (o) => {
		o[(() => key)()] += 1;
	},
	"o.later ??= v": (o) => {
		o.later ??= 1;
	},
	"o.later++": (o) => {
		o.later++;
	},
	"array destructuring target": (o) => {
		[o.later] = [1];
	},
	"object destructuring target": (o) => {
		({ x: o.later } = { x: 1 });
	},
	"for...of target": (o) => {
		for (o.later of [1]);
	},
	"Object.assign": (o) => {
		Object.assign(o, { later: 1 });
	},
	"Reflect.set": (o) => {
		Reflect.set(o, "later", 1);
	},
	"Object.defineProperty": (o) => {
		Object.defineProperty(o, "later", {
			value: 1,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	},
};

withProxies(
	"every way of reading and writing a key that doesn't exist yet",
	() => {
		const scenario =
			(
				read: (o: Any) => unknown,
				write: (o: Any) => void,
				nested: boolean,
			): Scenario =>
			({ observable, autorun, runInAction }, log) => {
				const root = observable({ a: 1, tags: { a: 1 } });
				const o = nested ? root.tags : root;
				let runs = 0;
				autorun(() => log([++runs, read(o)]));
				runInAction(() => write(o));
				runInAction(() => {
					delete o.later;
				});
				log(runs);
			};
		const add = WRITES["o.later = v"] as (o: Any) => void;
		for (const nested of [false, true]) {
			const where = nested ? "nested" : "top-level";
			for (const [name, read] of Object.entries(READS)) {
				parity(`${where} read: ${name}`, scenario(read, add, nested));
			}
			for (const [name, write] of Object.entries(WRITES)) {
				parity(
					`${where} write: ${name}`,
					scenario((o) => o.later, write, nested),
				);
				parity(
					`${where} write: ${name}, seen by Object.keys`,
					scenario((o) => Object.keys(o), write, nested),
				);
			}
		}
	},
);

withProxies("arrays", () => {
	const reads: Record<string, (a: Any) => unknown> = {
		"a[i]": (a) => a[1] ?? "none",
		"a.length": (a) => a.length,
		"a.at(i)": (a) => a.at(1) ?? "none",
		destructuring: (a) => {
			const [, second = "none"] = a;
			return second;
		},
		spread: (a) => [...a],
		"for...of": (a) => {
			const out: unknown[] = [];
			for (const x of a) out.push(x);
			return out;
		},
		"Array.from": (a) => Array.from(a),
		"[].concat(a)": (a) => ([] as unknown[]).concat(a),
		"JSON.stringify": (a) => JSON.stringify(a),
		"Math.max(...a)": (a) => Math.max(...a),
	};
	const writes: Record<string, (a: Any) => void> = {
		"a[i] = v": (a) => {
			a[1] = 9;
		},
		push: (a) => {
			a.push(9);
		},
		"length = n": (a) => {
			a.length = 0;
		},
		"destructuring swap": (a) => {
			[a[0], a[1]] = [8, a[0]];
		},
		splice: (a) => {
			a.splice(0, 1, 7, 6);
		},
	};
	for (const [r, read] of Object.entries(reads)) {
		for (const [w, write] of Object.entries(writes)) {
			parity(`${r} after ${w}`, ({ observable, autorun, runInAction }, log) => {
				const a = observable([1]);
				autorun(() => log(read(a)));
				runInAction(() => write(a));
				log(a);
			});
		}
	}

	// MobX doesn't track these; its proxies observe `length`, indexes and methods.
	it("tracks `in` and Object.keys too", () => {
		const a = sobx.observable([1]);
		const seen: unknown[] = [];
		sobx.autorun(() => seen.push([1 in a, Object.keys(a)]));
		sobx.runInAction(() => a.push(2));
		expect(seen).toEqual([
			[false, ["0"]],
			[true, ["0", "1"]],
		]);
	});

	parity("callbacks and methods see the same array", ({ observable }, log) => {
		const a = observable([2, 1]);
		a.forEach((_v: number, _i: number, self: unknown) => {
			log(self === a);
		});
		a.map((_v: number, _i: number, self: unknown) => log(self === a));
		a.reduce((acc: number, _v: number, _i: number, self: unknown) => {
			log(self === a);
			return acc;
		}, 0);
		const { push } = a;
		log(push === a.push);
		log([a.includes(1), a.indexOf(2)]);
		const o = observable({ x: 1 });
		const list = observable([o]);
		log([list[0] === o, list.includes(o), list.indexOf(o)]);
	});
});

withProxies("`this` and identity", () => {
	parity(
		"bound actions, getters and methods see the observable",
		({ observable, autorun, action }, log) => {
			const o = observable(
				{
					a: 1,
					add() {
						(this as Any).later = 1;
					},
					get names() {
						return Object.keys(this);
					},
					get later2() {
						return (this as Any).later ?? "none";
					},
					self() {
						return this;
					},
				} as Any,
				{ add: action.bound, self: action.bound },
			);
			const { add, self } = o;
			autorun(() => log([o.names, o.later2]));
			add();
			log(self() === o);
		},
	);

	parity("autoBind", ({ observable, autorun }, log) => {
		const o = observable(
			{
				tags: {} as Any,
				add(k: string) {
					this.tags[k] = true;
					(this as Any).last = k;
				},
			},
			{},
			{ autoBind: true },
		);
		const { add } = o;
		autorun(() => log([Object.keys(o.tags), (o as Any).last ?? "none"]));
		add("x");
		add("y");
	});

	parity(
		"reading other keys doesn't re-run",
		({ observable, autorun, runInAction }, log) => {
			const o = observable({ tags: { a: 1 } as Any, list: [{ n: 1 }] });
			let runs = 0;
			autorun(() => {
				runs++;
				log([o.tags.a, o.list[0]?.n]);
			});
			runInAction(() => {
				o.tags.b = 1;
			});
			runInAction(() => {
				delete o.tags.b;
			});
			log(runs);
		},
	);

	parity(
		"redefining an observable key with Object.defineProperty",
		({ observable, autorun, runInAction }, log) => {
			const o = observable({ a: 1 } as Any);
			autorun(() => log(o.a ?? "none"));
			runInAction(() =>
				Object.defineProperty(o, "a", {
					value: 2,
					enumerable: true,
					configurable: true,
					writable: true,
				}),
			);
			log([o.a, Object.keys(o), { ...o }]);
			o.a = 3;
			log([o.a, "a" in o]);
		},
	);

	parity("structuredClone can't clone proxies", ({ observable }, log) => {
		for (const value of [observable({ a: 1 }), observable([1])]) {
			try {
				structuredClone(value);
				log("cloned");
			} catch (e) {
				log((e as Error).name);
			}
		}
	});

	parity("proxy: false", ({ observable, autorun, runInAction, set }, log) => {
		const o = observable({ a: 1 } as Any, {}, { proxy: false });
		autorun(() => log(o.a));
		runInAction(() => {
			o.a = 2;
		});
		runInAction(() => set(o, "b", 1));
		log([o.b, o]);
	});

	// Assigning to an object that inherits from an observable is a plain JavaScript assignment.
	it("objects inheriting from an observable", () => {
		const o = sobx.observable({ a: 1 } as Any);
		const child = Object.create(o);
		const seen: unknown[] = [];
		sobx.autorun(() => seen.push([child.a, child.later ?? "none"]));
		child.own = 1;
		expect([Object.hasOwn(child, "own"), Object.hasOwn(o, "own")]).toEqual([
			true,
			false,
		]);
		sobx.runInAction(() => {
			o.later = 2;
		});
		expect(seen).toEqual([
			[1, "none"],
			[1, 2],
		]);
	});
});

withProxies("enforceActions warnings for added and deleted keys", () => {
	it("warn when something observes the keys, as in MobX", () => {
		const count = (api: Any) => {
			api.configure({ enforceActions: "observed" });
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				// Whether each step warned (MobX may warn more than once for one change).
				const counts: boolean[] = [];
				const warned = () => {
					const any = warn.mock.calls.length > 0;
					warn.mockClear();
					counts.push(any);
				};
				const o = api.observable({} as Any);
				o.unobserved = 1;
				warned();
				const stop = api.autorun(() => Object.keys(o));
				o.added = 1;
				warned();
				delete o.added;
				warned();
				stop();
				o.again = 1;
				warned();
				return counts;
			} finally {
				warn.mockRestore();
				api.configure({ enforceActions: "never" });
			}
		};
		expect(count(sobx)).toEqual(count(mobx));
	});
});
