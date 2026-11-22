/**
 * Components written against @sobx/magic, compiled by the sobx Vite plugin (see vite.config.ts:
 * `*.compiled.spec.tsx` files go through it), then rendered with @sobx/react.
 */
import {
	computed,
	makeAutoObservable,
	observable,
	remove,
	runInAction,
} from "@sobx/magic";
import {
	MobXProviderContext,
	Observer,
	observer,
	Provider,
	useLocalObservable,
} from "@sobx/react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useContext } from "react";
import { shop } from "../test/store.compiled.js";

afterEach(cleanup);

// Local observable: compiled to the ProxyLike fast path (explicit get / set calls).
const counter = observable({ count: 0, step: 1 });

class Todos {
	items: { title: string; done: boolean }[] = [];
	constructor() {
		makeAutoObservable(this);
	}
	get remaining() {
		return this.items.filter((t) => !t.done).length;
	}
	add(title: string) {
		this.items.push({ title, done: false });
	}
}

describe("compiled components", () => {
	it("re-render on changes to a fast-path observable", () => {
		let renders = 0;
		const Counter = observer(() => {
			renders++;
			return <span>{counter.count}</span>;
		});
		const { container } = render(<Counter />);
		act(() => runInAction(() => (counter.count += counter.step)));
		act(() => runInAction(() => (counter.step = 5))); // not rendered
		act(() => runInAction(() => counter.count++));
		expect(container.textContent).toBe("2");
		expect(renders).toBe(3);
	});

	it("track nested writes, array index and length, and added / removed keys", () => {
		const store = observable({
			todos: new Todos(),
			tags: {} as Record<string, number>,
		});
		const total = computed(() => Object.keys(store.tags).length);
		const View = observer(() => (
			<div>
				{store.todos.remaining}/{store.todos.items.length}{" "}
				{store.todos.items[0]?.title ?? "-"} {total.get()}
				{"a" in store.tags ? " a" : ""}
			</div>
		));
		const { container } = render(<View />);
		expect(container.textContent).toBe("0/0 - 0");
		act(() => store.todos.add("x"));
		expect(container.textContent).toBe("1/1 x 0");
		act(() =>
			runInAction(() => {
				store.todos.items[0] = { title: "y", done: true };
			}),
		);
		expect(container.textContent).toBe("0/1 y 0");
		act(() => runInAction(() => (store.tags.a = 1))); // new key
		expect(container.textContent).toBe("0/1 y 1 a");
		act(() => runInAction(() => remove(store.tags, "a")));
		expect(container.textContent).toBe("0/1 y 0");
	});

	it("useLocalObservable and <Observer>", () => {
		let outer = 0;
		function Form() {
			outer++;
			const form = useLocalObservable(() => ({
				name: "",
				setName(name: string) {
					this.name = name;
				},
			}));
			return (
				<label>
					<input onChange={(e) => form.setName(e.target.value)} />
					<Observer>{() => <b>{form.name.toUpperCase()}</b>}</Observer>
				</label>
			);
		}
		const { container } = render(<Form />);
		const input = container.querySelector("input") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "ada" } });
		expect(container.querySelector("b")?.textContent).toBe("ADA");
		expect(outer).toBe(1); // only the <Observer> re-rendered
	});

	it("observables from props, context and other modules, with any property operation", () => {
		type Stock = Record<string, number>;
		let rowRenders = 0;
		const Row = observer(({ stock, item }: { stock: Stock; item: string }) => {
			rowRenders++;
			return (
				<li>
					{item}: {item in stock ? stock[item] : "none"}
				</li>
			);
		});
		const Summary = observer(() => {
			const { shop: s } = useContext(MobXProviderContext);
			return (
				<p>
					{Object.keys(s.stock).length} items, {s.cart.length} in cart
					{s.cart.length > 0 ? `, first ${s.cart[0]}` : ""}
				</p>
			);
		});
		function restock(stock: Stock, item: string, n: number) {
			stock[item] = (stock[item] ?? 0) + n;
		}
		function clear(stock: Stock, item: string) {
			delete stock[item];
		}
		function addToCart(cart: string[], item: string) {
			cart[cart.length] = item;
		}
		const { container } = render(
			<Provider shop={shop}>
				<Row stock={shop.stock} item="apple" />
				<Summary />
			</Provider>,
		);
		const text = () => container.textContent;
		expect(text()).toBe("apple: none0 items, 0 in cart");
		act(() => runInAction(() => restock(shop.stock, "apple", 2)));
		expect(text()).toBe("apple: 21 items, 0 in cart");
		act(() => runInAction(() => restock(shop.stock, "pear", 1)));
		expect(text()).toBe("apple: 22 items, 0 in cart");
		act(() => runInAction(() => addToCart(shop.cart, "pear")));
		expect(text()).toBe("apple: 22 items, 1 in cart, first pear");
		act(() => runInAction(() => clear(shop.stock, "apple")));
		expect(text()).toBe("apple: none1 items, 1 in cart, first pear");
		expect(rowRenders).toBeGreaterThan(1);
	});

	it("useLocalObservable stores gain keys with plain assignment", () => {
		const Tags = observer(() => {
			const tags = useLocalObservable(() => ({
				byName: {} as Record<string, boolean>,
				toggle(name: string) {
					if (this.byName[name]) delete this.byName[name];
					else this.byName[name] = true;
				},
			}));
			return (
				<button type="button" onClick={() => tags.toggle("a")}>
					{Object.keys(tags.byName).join(",") || "-"}
				</button>
			);
		});
		const { container } = render(<Tags />);
		const button = container.querySelector("button") as HTMLButtonElement;
		expect(button.textContent).toBe("-");
		act(() => button.click());
		expect(button.textContent).toBe("a");
		act(() => button.click());
		expect(button.textContent).toBe("-");
	});
});
