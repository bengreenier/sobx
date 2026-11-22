import {
	configure,
	makeAutoObservable,
	observable,
	runInAction,
} from "@sobx/runtime";
import { act, render } from "@testing-library/react";
import { Component, memo, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { clearTimers, TimerBasedFinalizationRegistry } from "./finalization.js";
import {
	enableStaticRendering,
	isObserverBatched,
	isUsingStaticRendering,
	Observer,
	observer,
	useAsObservableSource,
	useLocalObservable,
	useObserver,
} from "./index.js";
import { patch } from "./utils.js";

/** How many derivations observe a box (white-box: checks subscriptions are released). */
function observers(box: object): number {
	return (box as unknown as { dep: { observers: Set<unknown> } }).dep.observers
		.size;
}

describe("observer", () => {
	it("releases its subscriptions on unmount", () => {
		const box = observable.box(0);
		const View = observer(() => <span>{box.get()}</span>);
		const { unmount } = render(<View />);
		expect(observers(box)).toBe(1);
		unmount();
		expect(observers(box)).toBe(0);
	});

	it("releases its subscriptions on unmount in StrictMode", () => {
		const box = observable.box(0);
		const View = observer(() => <span>{box.get()}</span>);
		const { container, unmount } = render(
			<StrictMode>
				<View />
			</StrictMode>,
		);
		act(() => runInAction(() => box.set(1)));
		expect(container.textContent).toBe("1");
		unmount();
		// React 18 throws away the state of StrictMode's first render, so its reaction is only
		// disposed by the finalization registry (when garbage collected; immediately here, with
		// the timer-based registry the React 18 tests run on).
		clearTimers();
		expect(observers(box)).toBe(0);
	});

	it("releases class component subscriptions on unmount", () => {
		const box = observable.box(0);
		let unmounted = false;
		const View = observer(
			class extends Component {
				override componentWillUnmount() {
					unmounted = true;
				}
				override render() {
					return <span>{box.get()}</span>;
				}
			},
		);
		const { unmount } = render(<View />);
		expect(observers(box)).toBe(1);
		unmount();
		expect(unmounted).toBe(true);
		expect(observers(box)).toBe(0);
	});

	it("re-renders once per action", () => {
		const store = makeAutoObservable({
			a: 1,
			b: 2,
			both() {
				this.a++;
				this.b++;
			},
		});
		let renders = 0;
		const View = observer(() => {
			renders++;
			return (
				<span>
					{store.a}
					{store.b}
				</span>
			);
		});
		const { container } = render(<View />);
		act(() => store.both());
		expect(renders).toBe(2);
		expect(container.textContent).toBe("23");
	});

	it("keeps the name, displayName and statics, and applies memo", () => {
		function Named() {
			return null;
		}
		Named.displayName = "Display";
		(Named as unknown as { extra: number }).extra = 1;
		const Wrapped = observer(Named) as unknown as {
			$$typeof: symbol;
			type: { name: string; displayName: string };
			extra: number;
		};
		expect(Wrapped.$$typeof).toBe(Symbol.for("react.memo"));
		expect(Wrapped.type.name).toBe("Named");
		expect(Wrapped.type.displayName).toBe("Display");
		expect(Wrapped.extra).toBe(1);
	});

	it("rejects memo and double-observed components", () => {
		expect(() => observer(memo(() => null))).toThrow(/React.memo/);
		class C extends Component {
			override render() {
				return null;
			}
		}
		observer(C);
		expect(() => observer(C)).toThrow(/already been declared/);
		class D extends Component {
			override shouldComponentUpdate() {
				return true;
			}
			override render() {
				return null;
			}
		}
		expect(() => observer(D)).toThrow(/shouldComponentUpdate/);
	});

	it("works as a standard class decorator", () => {
		const box = observable.box("a");
		class View extends Component {
			override render() {
				return <span>{box.get()}</span>;
			}
		}
		// Applied the way a 2022.3-decorators transform applies `@observer`.
		const context = { kind: "class", name: "View" } as ClassDecoratorContext;
		expect(observer(View, context)).toBe(View);
		expect(() =>
			observer(View, { kind: "method" } as unknown as ClassDecoratorContext),
		).toThrow(/classes only/);
		const { container } = render(<View />);
		act(() => runInAction(() => box.set("b")));
		expect(container.textContent).toBe("b");
	});

	it("reacts to changes made between render and mount", () => {
		const box = observable.box(0);
		function Changer() {
			// A sibling's effect runs after View rendered, before View subscribes.
			useLayoutEffectOnce(() => runInAction(() => box.set(1)));
			return null;
		}
		const View = observer(() => <span>{box.get()}</span>);
		const { container } = render(
			<>
				<View />
				<Changer />
			</>,
		);
		expect(container.textContent).toBe("1");
	});

	it("doesn't warn about enforceActions when reacting to changes in actions", () => {
		configure({ enforceActions: "observed" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const box = observable.box(0);
		const View = observer(() => <span>{box.get()}</span>);
		render(<View />);
		act(() => runInAction(() => box.set(1)));
		expect(warn).not.toHaveBeenCalled();
		act(() => box.set(2));
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

import { useLayoutEffect, useRef } from "react";

function useLayoutEffectOnce(fn: () => void) {
	const done = useRef(false);
	useLayoutEffect(() => {
		if (done.current) return;
		done.current = true;
		fn();
	}, [fn]);
}

describe("hooks and components", () => {
	it("Observer accepts render instead of children", () => {
		const box = observable.box(1);
		const { container } = render(<Observer render={() => box.get()} />);
		act(() => runInAction(() => box.set(2)));
		expect(container.textContent).toBe("2");
	});

	it("useLocalObservable makes getters computeds and keeps observers subscribed", () => {
		let calls = 0;
		const View = observer(() => {
			const store = useLocalObservable(() => ({
				items: [1, 2],
				get total() {
					calls++;
					return this.items.reduce((s, v) => s + v, 0);
				},
				add(v: number) {
					this.items.push(v);
				},
			}));
			return (
				<button type="button" onClick={() => store.add(3)}>
					{store.total}
					{store.total}
				</button>
			);
		});
		const { container } = render(<View />);
		expect(container.textContent).toBe("33");
		expect(calls).toBe(1);
		act(() => container.querySelector("button")?.click());
		expect(container.textContent).toBe("66");
		expect(calls).toBe(2);
	});

	it("useAsObservableSource follows props, including new keys", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const View = observer((props: { a: number; b?: number }) => {
			const source = useAsObservableSource(props);
			return <Observer>{() => `${source.a}:${source.b}`}</Observer>;
		});
		const { container, rerender } = render(<View a={1} />);
		expect(container.textContent).toBe("1:undefined");
		rerender(<View a={2} b={3} />);
		expect(container.textContent).toBe("2:3");
		warn.mockRestore();
	});

	it("useObserver (deprecated) still works", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const box = observable.box("x");
		function View() {
			return useObserver(() => <span>{box.get()}</span>);
		}
		const { container } = render(<View />);
		act(() => runInAction(() => box.set("y")));
		expect(container.textContent).toBe("y");
		expect(isObserverBatched()).toBe(true);
		warn.mockRestore();
	});
});

describe("plain JavaScript on observables", () => {
	it("observer components see keys added, deleted and enumerated with plain JavaScript", () => {
		configure({ enforceActions: "never" });
		const tags = observable({} as Record<string, number>);
		const list = observable([1]);
		const View = observer(() => (
			<span>
				{Object.keys(tags).join(",")}|{tags.a ?? "-"}|{list.length}:
				{list[1] ?? "-"}
			</span>
		));
		const { container } = render(<View />);
		expect(container.textContent).toBe("|-|1:-");
		act(() => {
			tags.a = 1;
		});
		act(() => {
			list[1] = 2;
		});
		expect(container.textContent).toBe("a|1|2:2");
		act(() => {
			delete tags.a;
		});
		expect(container.textContent).toBe("|-|2:2");
		configure({ enforceActions: "observed" });
	});
});

describe("static rendering", () => {
	afterEach(() => enableStaticRendering(false));

	it("renders without subscribing", () => {
		enableStaticRendering(true);
		expect(isUsingStaticRendering()).toBe(true);
		const box = observable.box(5);
		function Base() {
			return <span>{box.get()}</span>;
		}
		const View = observer(Base);
		expect(View).toBe(Base);
		expect(renderToString(<View />)).toBe("<span>5</span>");
		expect(observers(box)).toBe(0);
	});

	it("server-renders observers created before static rendering was enabled", () => {
		const box = observable.box(5);
		const View = observer(() => <span>{box.get()}</span>);
		enableStaticRendering(true);
		expect(renderToString(<View />)).toBe("<span>5</span>");
		expect(observers(box)).toBe(0);
	});
});

describe("patch", () => {
	it("runs mixins after the method, however and whenever it's defined", () => {
		const calls: string[] = [];
		class Base {
			componentWillUnmount?(): void;
		}
		patch(Base.prototype, "componentWillUnmount", () => calls.push("first"));
		patch(Base.prototype, "componentWillUnmount", () => calls.push("second"));
		const first = () => calls.push("first");
		patch(Base.prototype, "componentWillUnmount", first);
		patch(Base.prototype, "componentWillUnmount", first); // once
		const a = new Base();
		a.componentWillUnmount?.();
		expect(calls).toEqual(["first", "second", "first"]);

		calls.length = 0;
		Base.prototype.componentWillUnmount = () => calls.push("own (prototype)");
		new Base().componentWillUnmount?.();
		expect(calls).toEqual(["own (prototype)", "first", "second", "first"]);

		calls.length = 0;
		const b = new Base();
		b.componentWillUnmount = () => calls.push("own (instance)");
		b.componentWillUnmount();
		expect(calls).toEqual(["own (instance)", "first", "second", "first"]);
	});
});

describe("TimerBasedFinalizationRegistry", () => {
	it("finalizes registrations that weren't unregistered", () => {
		const finalized: string[] = [];
		const registry = new TimerBasedFinalizationRegistry<string>((v) =>
			finalized.push(v),
		);
		const kept = {};
		const lost = {};
		registry.register(kept, "kept", kept);
		registry.register(lost, "lost", lost);
		registry.unregister(kept);
		registry.sweep(); // too recent
		expect(finalized).toEqual([]);
		registry.finalizeAllImmediately();
		expect(finalized).toEqual(["lost"]);
	});
});
