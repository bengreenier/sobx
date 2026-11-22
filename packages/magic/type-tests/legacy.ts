/** Type-checked only (`pnpm test`): MobX's API, with legacy (`experimentalDecorators`) decorators. */
import {
	$mobx,
	action,
	autorun,
	computed,
	configure,
	createAtom,
	extendObservable,
	flow,
	getDependencyTree,
	type IObservableArray,
	type IReactionDisposer,
	intercept,
	isObservableProp,
	makeObservable,
	ObservableMap,
	observable,
	observe,
	onBecomeObserved,
	override,
	Reaction,
	reaction,
	spy,
	trace,
	when,
} from "../src/index.js";

export class Base {
	@observable x = 1;
	@observable.ref r: { a: number } | undefined;
	@observable.shallow l: number[] = [];
	constructor() {
		makeObservable(this);
	}
	@computed get d() {
		return this.x * 2;
	}
	@computed({ keepAlive: true }) get k() {
		return 1;
	}
	@computed.struct get s() {
		return { a: 1 };
	}
	@action inc() {
		this.x++;
	}
	@action.bound b() {}
	@action("named") n() {}
	@action f = () => {};
	@flow *g(): Generator<Promise<number>, void, number> {
		this.x = yield Promise.resolve(1);
	}
}

export class Sub extends Base {
	@override override get d() {
		return 1;
	}
	@override override inc() {}
}

const e = extendObservable({ z: 1 }, { y: 1 });
export const sum: number = e.y + e.z;
export const off: () => void = observe(e, "y", (c) => {
	void c.newValue;
});
intercept(e, "y", (c) => c);
intercept(observable([1]), () => null);
observable.map<string, number>().observe((c) => {
	void c.type;
});
observable.box(1).intercept((c) => c);
spy((event) => {
	void event.type;
});
trace(e, "y");
const atom = createAtom(
	"a",
	() => {},
	() => {},
);
export const observed: boolean = atom.reportObserved();
atom.reportChanged();
const r: Reaction = new Reaction("r", () => {});
r.track(() => {});
const m: ObservableMap<string, number> = new ObservableMap([["a", 1]]);
m.merge({ b: 2 });
m.replace({ c: 3 });
onBecomeObserved(e, "y", () => {});
reaction(
	() => e.y,
	() => {},
	{ delay: 1, scheduler: (fn) => fn(), onError: () => {} },
);
autorun((self) => self.dispose(), { delay: 1 });
when(() => true, { timeout: 1 }).cancel();
configure({ computedRequiresReaction: true, reactionScheduler: (fn) => fn() });
export const tree: string = getDependencyTree(autorun(() => {})).name;
export const isProp: boolean = isObservableProp(e, "y");
export const administration = (e as never)[$mobx];
const c = computed(() => 1, { set: () => {}, context: e });
c.set(1);
c.observe((change) => {
	void change.newValue;
});
observable.array([1]).clear();
observable([1]).replace([2]);
observable([1]).remove(1);
export const q: number = observable.object({ q: 1 }).q;

// Private members, values of change objects, and types used as in MobX code.
export class Private {
	private hidden = 1;
	public items: IObservableArray<string> = observable.array<string>([]);
	private dispose: IReactionDisposer;
	constructor() {
		makeObservable<Private, "hidden">(this, { hidden: observable });
		this.dispose = reaction(
			() => this.hidden,
			(value, previous) => {
				const change: number = value - previous;
				void change;
			},
		);
	}
	stop() {
		this.dispose();
		this.items.replace([]);
	}
}
export const untyped: ObservableMap = observable.map();
observe(observable([1]), (change) => {
	const added: number[] = change.type === "splice" ? change.added : [];
	void added;
});
observe(observable.map<string, number>(), (change) => {
	const name: string = change.name;
	void name;
});
intercept(observable.box(1), (change) =>
	change.newValue > 10 ? null : change,
);
