/**
 * The same React scenarios run against mobx + mobx-react and against @sobx/runtime +
 * @sobx/react; what they render and how often must match.
 */

import * as sobx from "@sobx/runtime";
import { act, cleanup, render } from "@testing-library/react";
import * as mobx from "mobx";
import * as mobxReact from "mobx-react";
import {
	Component,
	forwardRef,
	type ReactNode,
	StrictMode,
	useEffect,
} from "react";
import * as sobxReact from "./index.js";

interface Lib {
	observable: typeof sobx.observable;
	runInAction: typeof sobx.runInAction;
	action: typeof sobx.action;
	computed: typeof sobx.computed;
	makeObservable: typeof sobx.makeObservable;
	observer: typeof sobxReact.observer;
	Observer: typeof sobxReact.Observer;
	useLocalObservable: typeof sobxReact.useLocalObservable;
	Provider: typeof sobxReact.Provider;
	inject: typeof sobxReact.inject;
}

const libs: Record<string, Lib> = {
	mobx: { ...mobx, ...mobxReact } as unknown as Lib,
	sobx: { ...sobx, ...sobxReact },
};

type Scenario = (lib: Lib, log: string[]) => void;

/** Run `scenario` with each library; return what each logged. */
function runBoth(scenario: Scenario): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [name, lib] of Object.entries(libs)) {
		const log: string[] = [];
		scenario(lib, log);
		cleanup();
		out[name] = log;
	}
	return out;
}

function expectParity(scenario: Scenario): string[] {
	const { mobx: expected, sobx: actual } = runBoth(scenario);
	expect(actual).toEqual(expected);
	return actual as string[];
}

beforeAll(() => {
	mobx.configure({ enforceActions: "never" });
	sobx.configure({ enforceActions: "never" });
});
afterAll(() => {
	mobx.configure({ enforceActions: "observed" });
	sobx.configure({ enforceActions: "observed" });
});

describe("parity with mobx-react", () => {
	it("re-renders only when what was rendered changes", () => {
		const log = expectParity(({ observable, runInAction, observer }, log) => {
			const store = observable({ count: 0, other: 0 });
			const Counter = observer(() => {
				log.push(`render ${store.count}`);
				return <span>{store.count}</span>;
			});
			const { container } = render(<Counter />);
			act(() => runInAction(() => store.count++));
			act(() => runInAction(() => store.other++));
			act(() =>
				runInAction(() => {
					store.count++;
					store.count++;
				}),
			);
			log.push(`dom ${container.textContent}`);
		});
		expect(log).toEqual(["render 0", "render 1", "render 3", "dom 3"]);
	});

	it("tracks conditional reads, computeds and nested values", () => {
		expectParity(({ observable, runInAction, computed, observer }, log) => {
			const store = observable({
				show: false,
				a: "a",
				items: [1, 2],
				user: { name: "x" },
			});
			const total = computed(() => store.items.reduce((s, v) => s + v, 0));
			const View = observer(() => {
				log.push("render");
				return (
					<div>
						{store.show ? store.a : "-"} {total.get()} {store.user.name}{" "}
						{store.items.length}
					</div>
				);
			});
			const { container } = render(<View />);
			act(() => runInAction(() => (store.a = "b"))); // not read
			act(() => runInAction(() => (store.show = true)));
			act(() => runInAction(() => (store.a = "c")));
			act(() => runInAction(() => store.items.push(3)));
			act(() => runInAction(() => (store.user.name = "y")));
			log.push(container.textContent ?? "");
		});
	});

	it("re-renders parents and children independently", () => {
		expectParity(({ observable, runInAction, observer }, log) => {
			const store = observable({ title: "t", items: ["a", "b"] });
			const Item = observer(({ index }: { index: number }) => {
				log.push(`item ${index}`);
				return <li>{store.items[index]}</li>;
			});
			const List = observer(() => {
				log.push("list");
				return (
					<div>
						<h1>{store.title}</h1>
						<ul>
							<Item index={0} />
							<Item index={1} />
						</ul>
					</div>
				);
			});
			const { container } = render(<List />);
			act(() => runInAction(() => (store.title = "u")));
			act(() => runInAction(() => store.items.splice(1, 1, "c")));
			log.push(container.textContent ?? "");
		});
	});

	it("<Observer> re-renders only its own children", () => {
		expectParity(({ observable, runInAction, Observer }, log) => {
			const store = observable({ count: 0 });
			function Outer() {
				log.push("outer");
				return (
					<Observer>
						{() => {
							log.push("inner");
							return <span>{store.count}</span>;
						}}
					</Observer>
				);
			}
			const { container } = render(<Outer />);
			act(() => runInAction(() => store.count++));
			log.push(container.textContent ?? "");
		});
	});

	it("useLocalObservable keeps its store across renders", () => {
		expectParity(({ useLocalObservable, observer }, log) => {
			let api: { inc(): void; double: number } | undefined;
			const Counter = observer(() => {
				const store = useLocalObservable(() => ({
					count: 1,
					get double() {
						return this.count * 2;
					},
					inc() {
						this.count++;
					},
				}));
				api = store;
				log.push(`render ${store.count} ${store.double}`);
				return null;
			});
			render(<Counter />);
			const { inc } = api as { inc(): void };
			act(() => inc()); // auto-bound action
			act(() => inc());
		});
	});

	it("class components", () => {
		expectParity(
			({ observable, runInAction, makeObservable, action, observer }, log) => {
				class Store {
					count = 0;
					constructor() {
						makeObservable(this, { count: observable, inc: action });
					}
					inc() {
						this.count++;
					}
				}
				const store = new Store();
				const View = observer(
					class extends Component<{ label: string }> {
						override render() {
							log.push(`render ${this.props.label} ${store.count}`);
							return <span>{store.count}</span>;
						}
					},
				);
				const { rerender, unmount } = render(<View label="a" />);
				act(() => store.inc());
				rerender(<View label="a" />); // shallow-equal props: no render
				rerender(<View label="b" />);
				act(() => runInAction(() => store.inc()));
				unmount();
				act(() => store.inc());
				log.push(`count ${store.count}`);
			},
		);
	});

	it("StrictMode", () => {
		expectParity(({ observable, runInAction, observer }, log) => {
			const store = observable({ count: 0 });
			const Counter = observer(() => {
				log.push(`render ${store.count}`);
				useEffect(() => {
					log.push("effect");
					return () => {
						log.push("cleanup");
					};
				}, []);
				return <span>{store.count}</span>;
			});
			const { container, unmount } = render(
				<StrictMode>
					<Counter />
				</StrictMode>,
			);
			act(() => runInAction(() => store.count++));
			log.push(`dom ${container.textContent}`);
			unmount();
			act(() => runInAction(() => store.count++));
		});
	});

	it("forwardRef components", () => {
		expectParity(({ observable, runInAction, observer }, log) => {
			const store = observable({ text: "a" });
			const Input = observer(
				forwardRef<HTMLSpanElement, { suffix: string }>((props, ref) => {
					log.push("render");
					return (
						<span ref={ref}>
							{store.text}
							{props.suffix}
						</span>
					);
				}),
			);
			let node: HTMLSpanElement | null = null;
			render(
				<Input
					suffix="!"
					ref={(n) => {
						node = n;
					}}
				/>,
			);
			act(() => runInAction(() => (store.text = "b")));
			log.push((node as HTMLSpanElement | null)?.textContent ?? "no ref");
		});
	});

	it("Provider and inject", () => {
		expectParity(
			({ observable, runInAction, observer, Provider, inject }, log) => {
				const counter = observable({ count: 0 });
				const ByName = inject("counter")(
					observer(({ counter }: { counter?: { count: number } }) => {
						log.push(`by name ${counter?.count}`);
						return null;
					}),
				);
				const ByFn = inject((stores: { counter: { count: number } }) => ({
					count: stores.counter.count,
				}))(({ count }: { count?: number }) => {
					log.push(`by fn ${count}`);
					return null;
				});
				render(
					<Provider counter={counter}>
						<ByName />
						<ByFn />
					</Provider>,
				);
				act(() => runInAction(() => counter.count++));
			},
		);
	});

	it("error boundaries see render errors", () => {
		expectParity(({ observable, runInAction, observer }, log) => {
			const store = observable({ fail: false });
			class Boundary extends Component<
				{ children: ReactNode },
				{ error: string | null }
			> {
				override state = { error: null as string | null };
				static getDerivedStateFromError(e: Error) {
					return { error: e.message };
				}
				override render() {
					return this.state.error ?? this.props.children;
				}
			}
			const Bomb = observer(() => {
				if (store.fail) throw new Error("boom");
				return <span>ok</span>;
			});
			const error = console.error;
			console.error = () => {};
			try {
				const { container } = render(
					<Boundary>
						<Bomb />
					</Boundary>,
				);
				log.push(container.textContent ?? "");
				act(() => runInAction(() => (store.fail = true)));
				log.push(container.textContent ?? "");
			} finally {
				console.error = error;
			}
		});
	});
});
