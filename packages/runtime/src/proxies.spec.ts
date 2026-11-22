/**
 * `configure({ useProxies: "always" })`: code the compiler doesn't process (plain JavaScript,
 * no explicit API) is observed, as with MobX. Each scenario runs as is against `mobx` and
 * against `@sobx/runtime` with proxies on; what it logs must match.
 */
import * as mobx from "mobx";
import * as sobx from "./index.js";

// biome-ignore lint/suspicious/noExplicitAny: the scenarios use the shared MobX API surface
type Api = any;
type Scenario = (api: Api, log: (value: unknown) => void) => void;

function run(scenario: Scenario, api: Api): unknown[] {
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

beforeAll(() => {
	mobx.configure({ enforceActions: "never" });
	sobx.configure({ enforceActions: "never", useProxies: "always" }); // also in the "no-proxies" project
});
afterAll(() => {
	mobx.configure({ enforceActions: "observed" });
	sobx.configure({ enforceActions: "observed", useProxies: "never" });
});

describe("useProxies: plain JavaScript on observables, as with MobX", () => {
	parity(
		"adding, deleting and enumerating keys",
		({ observable, autorun, runInAction }, log) => {
			const store = observable({ tags: {} as Record<string, number> });
			const tags = store.tags; // held directly: no owner property involved
			autorun(() =>
				log([
					Object.keys(tags),
					Object.values(tags),
					"a" in tags,
					tags.a ?? "none",
					{ ...tags },
					JSON.stringify(tags),
					Object.hasOwn(tags, "a"),
				]),
			);
			autorun(() => {
				const keys: string[] = [];
				for (const k in tags) keys.push(k);
				log(keys);
			});
			runInAction(() => {
				tags.a = 1;
			});
			runInAction(() => {
				tags.b = 2;
			});
			runInAction(() => {
				tags.a = 3;
			});
			runInAction(() => {
				delete tags.a;
			});
			runInAction(() => Object.assign(tags, { c: 4 }));
		},
	);

	parity(
		"dynamic keys and keys that don't exist yet",
		({ observable, autorun, runInAction }, log) => {
			const o = observable({} as Record<string, unknown>);
			const key = "later";
			autorun(() =>
				log([o[key] ?? "none", (o as { other?: unknown }).other ?? "none"]),
			);
			runInAction(() => {
				o[key] = 1;
			});
			runInAction(() => {
				(o as { other?: unknown }).other = { deep: true };
			});
			runInAction(() => {
				(o.other as { deep: boolean }).deep = false;
			});
			log(o);
		},
	);

	parity(
		"arrays: index and length reads and writes",
		({ observable, autorun, runInAction }, log) => {
			const list = observable([1, 2, 3]);
			autorun(() =>
				log([list.length, list[0], list[5] ?? "none", Array.isArray(list)]),
			);
			runInAction(() => {
				list[0] = 10;
			});
			runInAction(() => {
				list[5] = 6;
			});
			runInAction(() => {
				list.length = 2;
			});
			runInAction(() => {
				list.push({ n: 1 } as never);
			});
			runInAction(() => {
				(list[2] as unknown as { n: number }).n = 2;
			});
			log([list.sort() === list, list.reverse() === list, [...list]]);
			log(list);
		},
	);

	parity(
		"methods adding keys through `this`",
		({ observable, autorun }, log) => {
			const store = observable({
				items: {} as Record<string, number>,
				add(key: string) {
					this.items[key] = (this.items[key] ?? 0) + 1;
				},
				get count() {
					return Object.keys(this.items).length;
				},
			});
			autorun(() => log([store.count, store.items.x ?? 0]));
			store.add("x");
			store.add("x");
			store.add("y");
		},
	);

	parity(
		"nested values stay observable and identical",
		(
			{
				observable,
				autorun,
				runInAction,
				isObservableArray,
				isObservableObject,
				toJS,
			},
			log,
		) => {
			const store = observable({
				user: { name: "a" },
				list: [] as { n: number }[],
			});
			const { user, list } = store;
			log([user === store.user, list === store.list]);
			log([isObservableObject(store.user), isObservableArray(store.list)]);
			autorun(() => log(store.list.map((x: { n: number }) => x.n)));
			runInAction(() => {
				store.list.push({ n: 1 });
			});
			runInAction(() => {
				(store.list[0] as { n: number }).n = 2;
			});
			runInAction(() => {
				store.user = { name: "b" };
			});
			log(toJS(store));
		},
	);

	parity(
		"computeds and reactions over proxies",
		({ observable, computed, reaction, runInAction }, log) => {
			const counts = observable({} as Record<string, number>);
			const total = computed(() =>
				Object.keys(counts).reduce((t, k) => t + (counts[k] as number), 0),
			);
			reaction(
				() => total.get(),
				(value: number, previous: number) => log([value, previous]),
			);
			runInAction(() => {
				counts.a = 1;
			});
			runInAction(() => {
				counts.b = 2;
			});
			runInAction(() => {
				counts.a = 5;
			});
		},
	);
});

describe("useProxies with sobx's own API", () => {
	it("the explicit API and compiled helpers work on proxies", () => {
		const o = sobx.observable({ a: 1 } as Record<string, number>);
		const seen: unknown[] = [];
		sobx.autorun(() => seen.push([sobx.keys(o), sobx.get(o, "b") ?? null]));
		sobx.runInAction(() => sobx.set(o, "b", 2));
		sobx.runInAction(() => sobx.setProperty(o, "c", 3));
		expect(seen).toEqual([
			[["a"], null],
			[["a", "b"], 2],
			[["a", "b", "c"], 2],
		]);
		expect(sobx.isObservable(o)).toBe(true);
	});

	it("only applies to observables created while it's on", () => {
		sobx.configure({ useProxies: "never" });
		try {
			const o = sobx.observable({} as Record<string, number>);
			const seen: unknown[] = [];
			sobx.autorun(() => seen.push(Object.keys(o)));
			sobx.runInAction(() => {
				o.a = 1; // not observed without a proxy (or the compiler)
			});
			expect(seen).toEqual([[]]);
		} finally {
			sobx.configure({ useProxies: "always" });
		}
	});
});
