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
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Observer, observer, useLocalObservable } from "./index.js";

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
});
