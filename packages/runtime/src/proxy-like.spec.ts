import { ProxyLike } from "./proxy-like.js";

describe("ProxyLike", () => {
	describe("constructor and get", () => {
		it("wraps the target object and get returns current values", () => {
			const target = { a: 1, b: "two" };
			const proxy = new ProxyLike(target);

			expect(proxy.get("a")).toBe(1);
			expect(proxy.get("b")).toBe("two");
		});

		it("get returns references to the same object (mutations visible)", () => {
			const target = { nested: { x: 0 } };
			const proxy = new ProxyLike(target);

			const nested = proxy.get("nested") as { x: number };
			nested.x = 42;
			expect(proxy.get("nested")).toEqual({ x: 42 });
		});
	});

	describe("set", () => {
		it("updates the target object", () => {
			const target = { count: 0 };
			const proxy = new ProxyLike(target);

			proxy.set("count", 5);
			expect(proxy.get("count")).toBe(5);
			expect(target.count).toBe(5);
		});

		it("notifies global observer with key, previous, and current value", () => {
			const target = { a: 1, b: 2 };
			const proxy = new ProxyLike(target);
			const observer = vi.fn();

			proxy.addObserver(observer);
			proxy.set("a", 10);
			proxy.set("b", 20);

			expect(observer).toHaveBeenCalledTimes(2);
			expect(observer).toHaveBeenNthCalledWith(1, "a", 1, 10);
			expect(observer).toHaveBeenNthCalledWith(2, "b", 2, 20);
		});

		it("notifies scoped observer only when the observed key changes", () => {
			const target = { a: 1, b: 2 };
			const proxy = new ProxyLike(target);
			const observerA = vi.fn();
			const observerB = vi.fn();

			proxy.addObserver("a", observerA);
			proxy.addObserver("b", observerB);

			proxy.set("a", 10);
			expect(observerA).toHaveBeenCalledTimes(1);
			expect(observerA).toHaveBeenCalledWith("a", 1, 10);
			expect(observerB).not.toHaveBeenCalled();

			proxy.set("b", 20);
			expect(observerB).toHaveBeenCalledTimes(1);
			expect(observerB).toHaveBeenCalledWith("b", 2, 20);
			expect(observerA).toHaveBeenCalledTimes(1);
		});

		it("notifies both global and scoped observers when a key changes", () => {
			const target = { x: 0 };
			const proxy = new ProxyLike(target);
			const globalObserver = vi.fn();
			const scopedObserver = vi.fn();

			proxy.addObserver(globalObserver);
			proxy.addObserver("x", scopedObserver);

			proxy.set("x", 1);

			expect(globalObserver).toHaveBeenCalledWith("x", 0, 1);
			expect(scopedObserver).toHaveBeenCalledWith("x", 0, 1);
		});

		it("calls observers with same key for multiple sets", () => {
			const target = { n: 0 };
			const proxy = new ProxyLike(target);
			const observer = vi.fn();

			proxy.addObserver("n", observer);
			proxy.set("n", 1);
			proxy.set("n", 2);
			proxy.set("n", 3);

			expect(observer).toHaveBeenCalledTimes(3);
			expect(observer).toHaveBeenNthCalledWith(1, "n", 0, 1);
			expect(observer).toHaveBeenNthCalledWith(2, "n", 1, 2);
			expect(observer).toHaveBeenNthCalledWith(3, "n", 2, 3);
		});
	});

	describe("addObserver (global)", () => {
		it("returns a handle with dispose method", () => {
			const proxy = new ProxyLike({ a: 1 });
			const handle = proxy.addObserver(() => {});

			expect(handle).toHaveProperty("dispose");
			expect(typeof handle.dispose).toBe("function");
		});

		it("dispose stops notifying the observer", () => {
			const target = { a: 1 };
			const proxy = new ProxyLike(target);
			const observer = vi.fn();

			const handle = proxy.addObserver(observer);
			proxy.set("a", 2);
			expect(observer).toHaveBeenCalledTimes(1);

			handle.dispose();
			proxy.set("a", 3);
			expect(observer).toHaveBeenCalledTimes(1);
		});

		it("multiple global observers are all notified", () => {
			const proxy = new ProxyLike({ x: 0 });
			const o1 = vi.fn();
			const o2 = vi.fn();

			proxy.addObserver(o1);
			proxy.addObserver(o2);
			proxy.set("x", 1);

			expect(o1).toHaveBeenCalledWith("x", 0, 1);
			expect(o2).toHaveBeenCalledWith("x", 0, 1);
		});
	});

	describe("addObserver (scoped)", () => {
		it("returns a handle with dispose method", () => {
			const proxy = new ProxyLike({ a: 1 });
			const handle = proxy.addObserver("a", () => {});

			expect(handle).toHaveProperty("dispose");
			expect(typeof handle.dispose).toBe("function");
		});

		it("dispose stops notifying the scoped observer", () => {
			const target = { a: 1 };
			const proxy = new ProxyLike(target);
			const observer = vi.fn();

			const handle = proxy.addObserver("a", observer);
			proxy.set("a", 2);
			expect(observer).toHaveBeenCalledTimes(1);

			handle.dispose();
			proxy.set("a", 3);
			expect(observer).toHaveBeenCalledTimes(1);
		});

		it("multiple scoped observers for same key are all notified", () => {
			const proxy = new ProxyLike({ k: 0 });
			const o1 = vi.fn();
			const o2 = vi.fn();

			proxy.addObserver("k", o1);
			proxy.addObserver("k", o2);
			proxy.set("k", 1);

			expect(o1).toHaveBeenCalledWith("k", 0, 1);
			expect(o2).toHaveBeenCalledWith("k", 0, 1);
		});
	});

	describe("edge cases", () => {
		it("set with same value still notifies observers (previous vs current)", () => {
			const target = { v: 1 };
			const proxy = new ProxyLike(target);
			const observer = vi.fn();

			proxy.addObserver(observer);
			proxy.set("v", 1);

			expect(observer).toHaveBeenCalledWith("v", 1, 1);
		});

		it("disposing one observer does not affect others", () => {
			const proxy = new ProxyLike({ a: 0 });
			const o1 = vi.fn();
			const o2 = vi.fn();

			const h1 = proxy.addObserver(o1);
			proxy.addObserver(o2);

			proxy.set("a", 1);
			expect(o1).toHaveBeenCalledTimes(1);
			expect(o2).toHaveBeenCalledTimes(1);

			h1.dispose();
			proxy.set("a", 2);
			expect(o1).toHaveBeenCalledTimes(1);
			expect(o2).toHaveBeenCalledTimes(2);
		});

		it("calling dispose multiple times is safe", () => {
			const proxy = new ProxyLike({ a: 1 });
			const observer = vi.fn();
			const handle = proxy.addObserver(observer);

			handle.dispose();
			handle.dispose();
			proxy.set("a", 2);
			expect(observer).not.toHaveBeenCalled();
		});
	});
});
