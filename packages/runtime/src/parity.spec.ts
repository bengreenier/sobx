/**
 * Parity with MobX: each scenario runs against both `mobx` and `@sobx/runtime` with the same
 * code, and what it logs must match. Scenarios log values (and reaction arguments), not run
 * counts, except where sobx promises the same batching.
 */
import * as mobx from "mobx";
import * as sobx from "./index.js";

// biome-ignore lint/suspicious/noExplicitAny: the scenarios use the shared MobX API surface
type Api = any;
/**
 * `sobx` is true when the scenario runs against @sobx/runtime. sobx never uses `Proxy`, so
 * operations MobX observes through its proxies (adding / deleting keys, `in`, `Object.keys`,
 * array index / `length` writes) are written with sobx's explicit API on the sobx side (the
 * compiler emits the same calls; see the compiler's parity tests). MobX runs in its default mode.
 */
type Scenario = (
	api: Api,
	log: (...values: unknown[]) => void,
	sobx: boolean,
) => void;

function run(scenario: Scenario, api: Api): unknown[] {
	const logs: unknown[] = [];
	const log = (...values: unknown[]) => {
		logs.push(
			values.length === 1
				? snapshot(api, values[0])
				: values.map((v) => snapshot(api, v)),
		);
	};
	scenario(api, log, api === sobx);
	return logs;
}

/** A plain, comparable copy (observables included). */
function snapshot(api: Api, value: unknown): unknown {
	const plain = api.toJS(value);
	if (plain instanceof Map) return { map: [...plain] };
	if (plain instanceof Set) return { set: [...plain] };
	return plain;
}

function parity(name: string, scenario: Scenario) {
	it(name, () => {
		const expected = run(scenario, mobx);
		const actual = run(scenario, sobx);
		expect(actual).toEqual(expected);
	});
}

beforeAll(() => {
	mobx.configure({ enforceActions: "never" });
	sobx.configure({ enforceActions: "never" });
});
afterAll(() => {
	mobx.configure({ enforceActions: "observed" });
	sobx.configure({ enforceActions: "observed" });
});

describe("parity with MobX: arrays", () => {
	parity("mutators", ({ observable, autorun, runInAction }, log) => {
		const a = observable([3, 1, 2]);
		autorun(() => log(a.slice()));
		const step = (fn: () => unknown) => runInAction(() => log(fn()));
		step(() => a.push(4, 5));
		step(() => a.pop());
		step(() => a.unshift(0));
		step(() => a.shift());
		step(() => a.splice(1, 2, 9));
		step(() => a.splice(1));
		step(() => (a.splice as () => number[])());
		step(() => a.push(5, 1, 4));
		step(() => a.sort().length);
		step(() => a.sort((x: number, y: number) => y - x).length);
		step(() => a.reverse().length);
		step(() => a.fill(7, 1, 2).length);
		step(() => a.copyWithin(0, 2).length);
	});

	parity(
		"index and length writes",
		({ observable, autorun, runInAction }, log, sobx) => {
			const a = observable([1, 2, 3]);
			const setIndex = (i: number, v: number) => {
				if (sobx) a.set(i, v);
				else a[i] = v;
			};
			const setLength = (n: number) => {
				if (sobx) a.setLength(n);
				else a.length = n;
			};
			autorun(() => log(a.slice(), a.slice().length));
			runInAction(() => setIndex(0, 10));
			runInAction(() => setIndex(3, 4)); // at the end
			runInAction(() => setLength(2));
			runInAction(() => setIndex(0, 10)); // unchanged
		},
	);

	parity("reads and methods", ({ observable, autorun, runInAction }, log) => {
		const a = observable([1, 2, 3]);
		autorun(() =>
			log(
				a.map((x: number) => x * 2),
				a.filter((x: number) => x > 1),
				a.reduce((x: number, y: number) => x + y, 0),
				a.indexOf(2),
				a.includes(3),
				[...a],
				Array.isArray(a),
				JSON.stringify(a),
				a.join("-"),
				a.at(-1),
			),
		);
		runInAction(() => a.push(4));
	});

	parity(
		"deep values",
		({ observable, autorun, runInAction, isObservable }, log) => {
			const a = observable([{ n: 1 }]);
			autorun(() => log(a.map((x: { n: number }) => x.n)));
			log(isObservable(a[0]));
			runInAction(() => {
				a[0].n = 2;
			});
			runInAction(() => a.push({ n: 3 }));
			log(isObservable(a[1]));
			runInAction(() => {
				a[1].n = 4;
			});
			const shallow = observable.array([{ n: 1 }], { deep: false });
			log(isObservable(shallow[0]));
		},
	);
});

describe("parity with MobX: objects", () => {
	parity("nested writes", ({ observable, autorun, runInAction }, log) => {
		const s = observable({ user: { name: "a", tags: ["x"] }, n: 1 });
		autorun(() => log(s.user.name, s.user.tags.length, s.n));
		runInAction(() => {
			s.user.name = "b";
		});
		runInAction(() => s.user.tags.push("y"));
		runInAction(() => {
			s.user = { name: "c", tags: [] };
		});
		runInAction(() => {
			s.user.name = "d";
		});
		runInAction(() => {
			s.n = 1; // unchanged
		});
	});

	parity("adding and deleting keys", (api, log, sobx) => {
		const { observable, autorun, runInAction } = api;
		const s = observable({ a: 1 } as Record<string, number>);
		// MobX (default mode): plain JavaScript; sobx: the explicit API.
		const keys = () => (sobx ? api.keys(s) : Object.keys(s));
		const has = (k: string) => (sobx ? api.has(s, k) : k in s);
		const get = (k: string) => (sobx ? api.get(s, k) : s[k]);
		const values = () => (sobx ? api.values(s) : Object.values(s));
		const add = (k: string, v: number) => {
			if (sobx) api.set(s, k, v);
			else s[k] = v;
		};
		const del = (k: string) => (sobx ? api.remove(s, k) : delete s[k]);
		autorun(() => log(keys(), has("b"), get("b"), values()));
		runInAction(() => add("b", 2));
		runInAction(() => add("c", 3));
		runInAction(() => del("a"));
		runInAction(() => del("b"));
		log({ ...s });
	});

	parity("getters, setters and methods", ({ observable, autorun }, log) => {
		const s = observable({
			n: 1,
			get double() {
				return this.n * 2;
			},
			set double(v: number) {
				this.n = v / 2;
			},
			inc() {
				this.n++;
			},
		});
		autorun(() => log(s.n, s.double));
		s.inc();
		s.double = 10;
		log(Object.keys(s));
	});

	parity(
		"ref, shallow, struct and deep: false",
		({ observable, autorun, runInAction, isObservable }, log) => {
			const s = observable(
				{
					ref: { a: 1 },
					shallow: [{ a: 1 }],
					struct: { a: 1 },
					deep: { a: 1 },
				},
				{
					ref: observable.ref,
					shallow: observable.shallow,
					struct: observable.struct,
				},
			);
			log(
				isObservable(s.ref),
				isObservable(s.shallow),
				isObservable(s.shallow[0]),
				isObservable(s.struct),
				isObservable(s.deep),
			);
			autorun(() => log(s.struct));
			runInAction(() => {
				s.struct = { a: 1 }; // structurally equal: no change
			});
			runInAction(() => {
				s.struct = { a: 2 };
			});
			const flat = observable({ nested: { a: 1 } }, {}, { deep: false });
			log(isObservable(flat.nested));
		},
	);
});

describe("parity with MobX: Maps, Sets, boxes", () => {
	parity("maps", ({ observable, autorun, runInAction }, log) => {
		const m = observable(new Map([["a", 1]]));
		autorun(() => log(m.get("b") ?? null, m.has("c"), m.size, [...m.keys()]));
		runInAction(() => m.set("b", 2));
		runInAction(() => m.set("c", 3));
		runInAction(() => m.delete("a"));
		runInAction(() => m.set("b", 2)); // unchanged
		runInAction(() => m.clear());
	});

	parity("sets", ({ observable, autorun, runInAction }, log) => {
		const s = observable(new Set([1]));
		autorun(() => log(s.has(2), s.size, [...s]));
		runInAction(() => s.add(2));
		runInAction(() => s.add(2)); // already there
		runInAction(() => s.delete(1));
		runInAction(() => s.clear());
	});

	parity(
		"deep Map values",
		({ observable, autorun, runInAction, isObservable }, log) => {
			const s = observable({ byId: new Map<string, { n: number }>() });
			log(isObservable(s.byId));
			autorun(() => log([...s.byId.values()].map((v) => v.n)));
			runInAction(() => s.byId.set("a", { n: 1 }));
			log(isObservable(s.byId.get("a")));
			runInAction(() => {
				(s.byId.get("a") as { n: number }).n = 2;
			});
		},
	);

	parity("boxes", ({ observable, autorun, comparer }, log) => {
		const b = observable.box({ x: 1 }, { equals: comparer.structural });
		autorun(() => log(b.get()));
		b.set({ x: 1 });
		b.set({ x: 2 });
	});
});

describe("parity with MobX: reactions and computeds", () => {
	parity(
		"computeds that throw",
		({ observable, computed, autorun, runInAction }, log) => {
			const s = observable({ n: 1, fail: true });
			let runs = 0;
			const c = computed(() => {
				runs++;
				if (s.fail) throw new Error(`fail ${s.n}`);
				return s.n * 2;
			});
			const stop = autorun(() => {
				try {
					log("value", c.get());
				} catch (e) {
					log("error", (e as Error).message);
				}
				try {
					log("again", c.get()); // cached: not recomputed
				} catch (e) {
					log("again error", (e as Error).message);
				}
			});
			runInAction(() => (s.n = 2)); // read before throwing: re-runs
			runInAction(() => (s.fail = false));
			runInAction(() => (s.fail = true));
			log("runs", runs);
			stop();
		},
	);
	parity("reaction arguments", ({ observable, reaction, runInAction }, log) => {
		const s = observable({ a: 1, b: 1 });
		reaction(
			() => s.a + s.b,
			(sum: number, previous: number) => log(sum, previous),
		);
		runInAction(() => {
			s.a = 2;
		});
		runInAction(() => {
			s.a = 1;
			s.b = 2; // same sum
		});
		runInAction(() => {
			s.b = 5;
		});
	});

	parity(
		"fireImmediately and equals",
		({ observable, reaction, comparer, runInAction }, log) => {
			const s = observable({ p: { x: 1 } });
			reaction(
				() => s.p,
				(p: { x: number }) => log(p.x),
				{ fireImmediately: true, equals: comparer.structural },
			);
			runInAction(() => {
				s.p = { x: 1 };
			});
			runInAction(() => {
				s.p = { x: 2 };
			});
		},
	);

	parity("batching in actions", ({ observable, autorun, action }, log) => {
		const s = observable({ a: 1, b: 1 });
		autorun(() => log(s.a, s.b));
		action(() => {
			s.a = 2;
			s.b = 2;
		})();
	});

	parity(
		"computed chains",
		({ observable, computed, autorun, runInAction }, log) => {
			const s = observable({ items: [1, 2, 3] });
			const total = computed(() =>
				s.items.reduce((x: number, y: number) => x + y, 0),
			);
			const big = computed(() => total.get() > 6);
			autorun(() => log(total.get(), big.get()));
			runInAction(() => s.items.push(1));
			runInAction(() => s.items.push(10));
		},
	);

	parity("when", ({ observable, when, runInAction }, log) => {
		const s = observable({ n: 0 });
		when(
			() => s.n > 1,
			() => log("ready", s.n),
		);
		for (const n of [1, 2, 3]) {
			runInAction(() => {
				s.n = n;
			});
		}
	});

	parity("classes", ({ makeAutoObservable, autorun }, log) => {
		class Todos {
			items: { done: boolean }[] = [];
			constructor() {
				makeAutoObservable(this);
			}
			get open() {
				return this.items.filter((t) => !t.done).length;
			}
			add() {
				this.items.push({ done: false });
			}
			finish(i: number) {
				(this.items[i] as { done: boolean }).done = true;
			}
		}
		const t = new Todos();
		autorun(() => log(t.open));
		t.add();
		t.add();
		t.finish(0);
	});
});

describe("parity with MobX: enforceActions warnings", () => {
	const scenario = (api: Api, warn: { mock: { calls: unknown[] } }) => {
		const { observable, autorun, runInAction, reaction } = api;
		const steps: number[] = [];
		const record = (fn: () => void) => {
			const before = warn.mock.calls.length;
			fn();
			steps.push(warn.mock.calls.length - before);
		};
		const s = observable({ a: 1, b: 1, list: [1] });
		record(() => {
			s.b = 2; // unobserved
		});
		autorun(() => s.a + s.list.length);
		record(() => {
			s.a = 2; // observed, outside an action
		});
		record(() => s.list.push(2)); // observed array
		record(() => runInAction(() => (s.a = 3)));
		reaction(
			() => s.a,
			() => {
				s.b = 9; // in an effect
			},
		);
		record(() => runInAction(() => (s.a = 4)));
		return steps;
	};

	it('"observed" (the default) warns for the same writes', () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			mobx.configure({ enforceActions: "observed" });
			sobx.configure({ enforceActions: "observed" });
			const expected = scenario(mobx, warn);
			const actual = scenario(sobx, warn);
			expect(actual).toEqual(expected);
		} finally {
			mobx.configure({ enforceActions: "never" });
			sobx.configure({ enforceActions: "never" });
			warn.mockRestore();
		}
	});
});
