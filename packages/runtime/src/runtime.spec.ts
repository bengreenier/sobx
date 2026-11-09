import {
	action,
	autorun,
	computed,
	makeAutoObservable,
	makeObservable,
	observable,
	ProxyLike,
	reaction,
	runInAction,
	toJS,
	untracked,
} from "./index.js";

describe("reaction", () => {
	it("re-runs data on change and runs the effect with (next, previous) when the result changes", () => {
		const s = new ProxyLike({ a: 1, b: 2 });
		const effect = vi.fn();
		reaction(() => s.get("a") + s.get("b"), effect);
		expect(effect).not.toHaveBeenCalled();
		s.set("b", 3);
		expect(effect).toHaveBeenLastCalledWith(4, 3, expect.anything());
		s.set("a", 2);
		s.set("b", 2);
		expect(effect.mock.calls.map((c) => c[0])).toEqual([4, 5, 4]);
	});

	it("does not run the effect when the result is equal", () => {
		const s = new ProxyLike({ a: 1, b: 2 });
		const effect = vi.fn();
		reaction(() => s.get("a") > 0, effect);
		s.set("a", 5);
		expect(effect).not.toHaveBeenCalled();
	});

	it("supports fireImmediately and equals", () => {
		const s = new ProxyLike({ list: [1] as number[] });
		const effect = vi.fn();
		reaction(() => [...s.get("list")], effect, {
			fireImmediately: true,
			equals: (a, b) => a.join() === b.join(),
		});
		expect(effect).toHaveBeenCalledTimes(1);
		s.set("list", [1]);
		expect(effect).toHaveBeenCalledTimes(1);
		s.set("list", [1, 2]);
		expect(effect).toHaveBeenCalledTimes(2);
	});

	it("tracks dependencies dynamically", () => {
		const s = new ProxyLike({ flag: true, a: 1, b: 1 });
		const data = vi.fn(() => (s.get("flag") ? s.get("a") : s.get("b")));
		reaction(data, () => {});
		s.set("b", 2); // not read yet
		expect(data).toHaveBeenCalledTimes(1);
		s.set("flag", false);
		s.set("a", 2); // no longer read
		expect(data).toHaveBeenCalledTimes(2);
		s.set("b", 3);
		expect(data).toHaveBeenCalledTimes(3);
	});

	it("stops after dispose", () => {
		const s = new ProxyLike({ a: 1 });
		const effect = vi.fn();
		const dispose = reaction(() => s.get("a"), effect);
		dispose();
		s.set("a", 2);
		expect(effect).not.toHaveBeenCalled();
	});

	it("does not track reads in the effect", () => {
		const s = new ProxyLike({ a: 1, b: 1 });
		const effect = vi.fn(() => s.get("b"));
		reaction(() => s.get("a"), effect);
		s.set("a", 2);
		s.set("b", 2);
		expect(effect).toHaveBeenCalledTimes(1);
	});
});

describe("autorun", () => {
	it("runs immediately and on every change", () => {
		const s = new ProxyLike({ a: 1 });
		const seen: number[] = [];
		autorun(() => {
			seen.push(s.get("a"));
		});
		s.set("a", 2);
		s.set("a", 2);
		expect(seen).toEqual([1, 2]);
	});

	it("reports errors without throwing", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() =>
			autorun(() => {
				throw new Error("boom");
			}),
		).not.toThrow();
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});

	it("throws when reactions never converge", () => {
		const s = new ProxyLike({ a: 0 });
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		autorun(() => {
			s.set("a", untracked(() => s.get("a")) + 1);
			s.get("a");
		});
		expect(() => s.set("a", 100)).toThrow(/did not converge/);
		error.mockRestore();
	});
});

describe("computed", () => {
	it("caches while observed and recomputes only when a dependency changes", () => {
		const s = new ProxyLike({ a: 1, b: 1 });
		const fn = vi.fn(() => s.get("a") * 2);
		const double = computed(fn);
		const seen: number[] = [];
		autorun(() => {
			seen.push(double.get());
			double.get();
		});
		expect(fn).toHaveBeenCalledTimes(1);
		s.set("b", 2);
		expect(fn).toHaveBeenCalledTimes(1);
		s.set("a", 2);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(seen).toEqual([2, 4]);
	});

	it("does not re-run observers when its value is unchanged", () => {
		const s = new ProxyLike({ a: 1 });
		const positive = computed(() => s.get("a") > 0);
		const run = vi.fn(() => positive.get());
		autorun(run);
		s.set("a", 2);
		expect(run).toHaveBeenCalledTimes(1);
		s.set("a", -1);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("propagates through chains", () => {
		const s = new ProxyLike({ a: 1 });
		const b = computed(() => s.get("a") + 1);
		const c = computed(() => b.get() * 10);
		const seen: number[] = [];
		autorun(() => {
			seen.push(c.get());
		});
		s.set("a", 2);
		expect(seen).toEqual([20, 30]);
	});

	it("computes on demand when unobserved", () => {
		const s = new ProxyLike({ a: 1 });
		const fn = vi.fn(() => s.get("a"));
		const c = computed(fn);
		c.get();
		c.get();
		expect(fn).toHaveBeenCalledTimes(2);
		s.set("a", 3);
		expect(c.get()).toBe(3);
	});
});

describe("actions", () => {
	it("batch writes so reactions run once", () => {
		const s = new ProxyLike({ a: 1, b: 1 });
		const run = vi.fn(() => s.get("a") + s.get("b"));
		autorun(run);
		runInAction(() => {
			s.set("a", 2);
			s.set("b", 2);
		});
		expect(run).toHaveBeenCalledTimes(2);
		const both = action((n: number) => {
			s.set("a", n);
			s.set("b", n);
			return n;
		});
		expect(both(5)).toBe(5);
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("run untracked", () => {
		const s = new ProxyLike({ a: 1, b: 1 });
		const readB = action(() => s.get("b"));
		const run = vi.fn(() => s.get("a") + readB());
		autorun(run);
		s.set("b", 2);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("accepts a name", () => {
		const fn = action("named", () => 1);
		expect(fn()).toBe(1);
	});
});

describe("ProxyLike (compiled objects)", () => {
	it("runs getters with the ProxyLike as this, so their reads are tracked", () => {
		const s = new ProxyLike(
			{
				a: 1,
				get double(): number {
					return (this as unknown as ProxyLike<{ a: number }>).get("a") * 2;
				},
			},
			{ getters: ["double"] },
		);
		const seen: number[] = [];
		autorun(() => {
			seen.push(s.get("double"));
		});
		s.set("a", 2);
		expect(seen).toEqual([2, 4]);
	});

	it("wraps actions so their writes are batched", () => {
		const s = new ProxyLike(
			{
				a: 1,
				b: 1,
				both(n: number) {
					const self = this as unknown as ProxyLike<{ a: number; b: number }>;
					self.set("a", n);
					self.set("b", n);
				},
			},
			{ actions: ["both"] },
		);
		const run = vi.fn(() => s.get("a") + s.get("b"));
		autorun(run);
		s.get("both").call(s, 3);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("update implements ++ / -- (prefix and postfix)", () => {
		const s = new ProxyLike({ n: 1, big: 1n });
		expect(s.update("n", 1, false)).toBe(1);
		expect(s.update("n", 1, true)).toBe(3);
		expect(s.update("n", -1, true)).toBe(2);
		expect(s.update("big", 1, true)).toBe(2n);
	});

	it("set returns the value and delete notifies", () => {
		const s = new ProxyLike<{ a?: number }>({ a: 1 });
		expect(s.set("a", 5)).toBe(5);
		const seen: Array<number | undefined> = [];
		autorun(() => {
			seen.push(s.get("a"));
		});
		expect(s.delete("a")).toBe(true);
		expect(seen).toEqual([5, undefined]);
	});
});

describe("observable()", () => {
	it("makes an observable copy with accessors, computeds and actions", () => {
		const source = {
			a: 1,
			get double() {
				return this.a * 2;
			},
			inc() {
				this.a++;
			},
		};
		const s = observable(source);
		expect(s).not.toBe(source);
		const seen: number[] = [];
		autorun(() => {
			seen.push(s.double);
		});
		s.inc();
		s.a = 10;
		expect(seen).toEqual([2, 4, 20]);
		// As in MobX: methods stay enumerable, computeds don't.
		expect(Object.keys(s)).toEqual(["a", "inc"]);
		expect(toJS(s)).toEqual({ a: 10 });
	});

	it("respects overrides and autoBind", () => {
		const s = observable(
			{
				a: 1,
				plain: 1,
				inc() {
					this.a++;
				},
			},
			{ plain: false },
			{ autoBind: true },
		);
		const run = vi.fn(() => s.plain);
		autorun(run);
		s.plain = 2;
		expect(run).toHaveBeenCalledTimes(1);
		const { inc } = s;
		inc();
		expect(s.a).toBe(2);
	});

	it("uses structural comparison for observable.struct", () => {
		const s = makeObservable({ point: { x: 1 } }, { point: observable.struct });
		const run = vi.fn(() => s.point);
		autorun(run);
		s.point = { x: 1 };
		expect(run).toHaveBeenCalledTimes(1);
		s.point = { x: 2 };
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("rejects class instances", () => {
		expect(() => observable(new (class {})())).toThrow(/plain objects/);
	});
});

describe("classes", () => {
	it("makeObservable with an annotation map", () => {
		class Store {
			a = 1;
			b = 1;
			constructor() {
				makeObservable(this, {
					a: observable,
					total: computed,
					both: action,
					bound: action.bound,
				});
			}
			get total() {
				return this.a + this.b;
			}
			both(n: number) {
				this.a = n;
				this.b = n;
			}
			bound() {
				return this;
			}
		}
		const s = new Store();
		const seen: number[] = [];
		autorun(() => {
			seen.push(s.total);
		});
		s.b = 5; // b is not observable
		s.both(3);
		expect(seen).toEqual([2, 6]);
		const { bound } = s;
		expect(bound()).toBe(s);
	});

	it("makeAutoObservable infers annotations", () => {
		class Counter {
			count = 0;
			constructor() {
				makeAutoObservable(this);
			}
			get double() {
				return this.count * 2;
			}
			inc() {
				this.count++;
				this.count++;
			}
		}
		const c = new Counter();
		const seen: number[] = [];
		autorun(() => {
			seen.push(c.double);
		});
		c.inc();
		expect(seen).toEqual([0, 4]);
	});

	it("makeObservable rejects unknown members and invalid annotations", () => {
		expect(() => makeObservable({ a: 1 }, { b: observable })).toThrow(
			/not a member/,
		);
		expect(() =>
			makeObservable({ a: 1 }, { a: (() => {}) as unknown as boolean }),
		).toThrow(/invalid annotation/);
	});

	it("standard decorators", () => {
		// Apply decorators the way a 2022.3-decorators transform would.
		const initializers: Array<(this: unknown) => void> = [];
		const context = (kind: string, name: string) => ({
			kind,
			name,
			addInitializer: (fn: (this: unknown) => void) => initializers.push(fn),
		});
		const accessor = (
			observable as unknown as (
				v: unknown,
				c: unknown,
			) => {
				get(this: object): unknown;
				set(this: object, v: unknown): void;
				init(this: object, v: unknown): unknown;
			}
		)(undefined, context("accessor", "count"));
		const double = (
			computed as unknown as (g: unknown, c: unknown) => () => number
		)(
			function (this: { count: number }) {
				return this.count * 2;
			},
			context("getter", "double"),
		);
		const inc = (
			action.bound as unknown as (f: unknown, c: unknown) => () => void
		)(
			function (this: { count: number }) {
				this.count++;
			},
			context("method", "inc"),
		);
		class Store {
			declare count: number;
			declare double: number;
			declare inc: () => void;
		}
		Object.defineProperty(Store.prototype, "count", {
			get: accessor.get,
			set: accessor.set,
		});
		Object.defineProperty(Store.prototype, "double", { get: double });
		Object.defineProperty(Store.prototype, "inc", {
			value: inc,
			writable: true,
		});
		const s = new Store();
		accessor.init.call(s, 1);
		for (const init of initializers) init.call(s);

		const seen: number[] = [];
		autorun(() => {
			seen.push(s.double);
		});
		const { inc: boundInc } = s;
		boundInc();
		expect(seen).toEqual([2, 4]);
	});
});
