/**
 * Atoms, `observe` / `intercept`, `onBecomeObserved` / `onBecomeUnobserved`, `trace` and the
 * introspection functions, and MobX's `_` functions that libraries use.
 */
import {
	type ActionRunInfo,
	endAction,
	isAction,
	startAction,
} from "./action.js";
import {
	type ArrayAdministration,
	arrayAdministrationOf,
	ObservableArray,
	ObservableMap,
	ObservableSet,
} from "./collections.js";
import { Computed, enableTrace } from "./computed.js";
import {
	$mobx,
	allowStateChanges,
	DEV,
	Dep,
	type Derivation,
	debugName,
	globalState,
	hooks,
	rawOf,
	resetGlobalState,
} from "./core.js";
import { administrationOf, type ObjectAdministration } from "./object.js";
import { Reaction } from "./reaction.js";
import type { ChangeListener, Interceptor, Lambda } from "./spy.js";
import type {
	IArrayDidChange,
	IArrayWillChange,
	IArrayWillSplice,
	IComputedValue,
	IInterceptor,
	IMapDidChange,
	IMapWillChange,
	IObjectDidChange,
	IObjectWillChange,
	IObservableArray,
	IObservableValue,
	ISetDidChange,
	ISetWillChange,
	IValueDidChange,
	IValueWillChange,
} from "./types.js";
import { ObservableValue } from "./value.js";

// biome-ignore lint/suspicious/noExplicitAny: anything observable
type Any = any;

// -- atoms ----------------------------------------------------------------------------------

/** `createAtom(name, onBecomeObserved?, onBecomeUnobserved?)`: for your own observable data. */
export function createAtom(
	name = debugName("Atom"),
	onBecomeObservedHandler?: () => void,
	onBecomeUnobservedHandler?: () => void,
): Dep {
	const atom = new Dep(undefined, name);
	if (onBecomeObservedHandler) onBecomeObserved(atom, onBecomeObservedHandler);
	if (onBecomeUnobservedHandler) {
		onBecomeUnobserved(atom, onBecomeUnobservedHandler);
	}
	return atom;
}

type Node = Dep | Computed<unknown> | Reaction;
type Admin =
	| Node
	| ArrayAdministration
	| ObjectAdministration
	| ObservableMap<unknown, unknown>
	| ObservableSet<unknown>;

/** What represents `thing` (or its `property`) in the dependency graph. */
export function getAtom(thing: Any, property?: PropertyKey): Node {
	if (typeof thing === "object" && thing !== null) {
		const raw = rawOf(thing);
		if (raw instanceof ObservableArray) {
			if (property !== undefined) {
				throw new Error(
					"sobx: It is not possible to get index atoms from arrays",
				);
			}
			return (arrayAdministrationOf(raw) as ArrayAdministration).atom;
		}
		if (raw instanceof ObservableSet) return raw.atom;
		if (raw instanceof ObservableMap) {
			if (property === undefined) return raw.atom;
			const entry = raw.entry(property) ?? raw.presenceOf(property);
			if (!entry) {
				throw new Error(
					`sobx: the entry '${String(property)}' does not exist in the observable map '${raw.name}'`,
				);
			}
			return entry instanceof Dep ? entry : entry.atom;
		}
		// Decorated members are set up when first used.
		if (
			property !== undefined &&
			!administrationOf(raw)?.values.has(property)
		) {
			void raw[property];
		}
		const adm = administrationOf(raw);
		if (adm) {
			if (property === undefined) {
				throw new Error("sobx: please specify a property");
			}
			const value = adm.values.get(property);
			if (!value) {
				throw new Error(
					`sobx: no observable property '${String(property)}' found on the observable object '${adm.name}'`,
				);
			}
			return value;
		}
		if (
			raw instanceof Dep ||
			raw instanceof Computed ||
			raw instanceof Reaction
		) {
			return raw;
		}
	} else if (typeof thing === "function" && thing[$mobx] instanceof Reaction) {
		return thing[$mobx];
	}
	throw new Error(`sobx: Cannot obtain atom from ${String(thing)}`);
}

/** The dependency behind a node: a computed's value, or the atom itself. */
function depOf(node: Node): Dep {
	if (node instanceof Computed) return node.dep;
	if (node instanceof Dep) return node;
	throw new Error(`sobx: ${node} is not observable`);
}

/** What `observe` / `intercept` register with. */
export function getAdministration(thing: Any, property?: PropertyKey): Admin {
	if (!thing) throw new Error("sobx: Expecting some object");
	const raw = rawOf(thing);
	if (property !== undefined) {
		if (raw instanceof ObservableMap) {
			const entry = raw.entry(property);
			if (entry) return entry as unknown as Admin;
		}
		return getAtom(raw, property) as Admin;
	}
	if (
		raw instanceof Dep ||
		raw instanceof Computed ||
		raw instanceof Reaction ||
		raw instanceof ObservableMap ||
		raw instanceof ObservableSet
	) {
		return raw;
	}
	const adm = raw[$mobx];
	if (adm) return adm;
	throw new Error(`sobx: Cannot obtain administration from ${String(thing)}`);
}

export function getDebugName(thing: Any, property?: PropertyKey): string {
	if (property !== undefined) return getAtom(thing, property).name;
	if (isAction(thing)) return thing.name;
	const raw = rawOf(thing);
	const adm = administrationOf(raw);
	if (adm) return adm.name;
	if (raw instanceof ObservableMap || raw instanceof ObservableSet) {
		return raw.name;
	}
	return getAtom(raw).name;
}

// -- observe / intercept --------------------------------------------------------------------

interface Observable {
	observe(listener: ChangeListener, fireImmediately?: boolean): Lambda;
	intercept(handler: Interceptor): Lambda;
}

/**
 * `observe(thing, listener, fireImmediately?)` / `observe(thing, property, listener,
 * fireImmediately?)`: be told about changes (after they happen, without batching).
 */
export function observe<T>(
	value: IObservableValue<T> | IComputedValue<T>,
	listener: (change: IValueDidChange<T>) => void,
	fireImmediately?: boolean,
): Lambda;
export function observe<T>(
	array: IObservableArray<T> | Array<T>,
	listener: (change: IArrayDidChange<T>) => void,
	fireImmediately?: boolean,
): Lambda;
export function observe<V>(
	set: ObservableSet<V> | Set<V>,
	listener: (change: ISetDidChange<V>) => void,
	fireImmediately?: boolean,
): Lambda;
export function observe<K, V>(
	map: ObservableMap<K, V> | Map<K, V>,
	listener: (change: IMapDidChange<K, V>) => void,
	fireImmediately?: boolean,
): Lambda;
export function observe<K, V>(
	map: ObservableMap<K, V> | Map<K, V>,
	property: K,
	listener: (change: IValueDidChange<V>) => void,
	fireImmediately?: boolean,
): Lambda;
export function observe(
	object: object,
	listener: (change: IObjectDidChange) => void,
	fireImmediately?: boolean,
): Lambda;
export function observe<T, K extends keyof T>(
	object: T,
	property: K,
	listener: (change: IValueDidChange<T[K]>) => void,
	fireImmediately?: boolean,
): Lambda;
export function observe(
	thing: Any,
	propertyOrListener: Any,
	listenerOrFire?: Any,
	fireImmediately?: boolean,
): Lambda {
	if (typeof listenerOrFire === "function") {
		const adm = getAdministration(thing, propertyOrListener) as Any;
		return (adm as Observable).observe(listenerOrFire, fireImmediately);
	}
	const adm = getAdministration(thing) as Any;
	return (adm as Observable).observe(propertyOrListener, listenerOrFire);
}

/**
 * `intercept(thing, handler)` / `intercept(thing, property, handler)`: change or refuse (by
 * returning `null`) changes before they happen.
 */
export function intercept<T>(
	value: IObservableValue<T>,
	handler: IInterceptor<IValueWillChange<T>>,
): Lambda;
export function intercept<T>(
	array: IObservableArray<T> | Array<T>,
	handler: IInterceptor<IArrayWillChange<T> | IArrayWillSplice<T>>,
): Lambda;
export function intercept<K, V>(
	map: ObservableMap<K, V> | Map<K, V>,
	handler: IInterceptor<IMapWillChange<K, V>>,
): Lambda;
export function intercept<V>(
	set: ObservableSet<V> | Set<V>,
	handler: IInterceptor<ISetWillChange<V>>,
): Lambda;
export function intercept<K, V>(
	map: ObservableMap<K, V> | Map<K, V>,
	property: K,
	handler: IInterceptor<IValueWillChange<V>>,
): Lambda;
export function intercept(
	object: object,
	handler: IInterceptor<IObjectWillChange>,
): Lambda;
export function intercept<T extends object, K extends keyof T>(
	object: T,
	property: K,
	handler: IInterceptor<IValueWillChange<T[K]>>,
): Lambda;
export function intercept(
	thing: Any,
	propertyOrHandler: Any,
	handler?: Any,
): Lambda {
	if (typeof handler === "function") {
		const adm = getAdministration(thing, propertyOrHandler) as Any;
		return (adm as Observable).intercept(handler);
	}
	const adm = getAdministration(thing) as Any;
	return (adm as Observable).intercept(propertyOrHandler);
}

// -- onBecomeObserved / onBecomeUnobserved --------------------------------------------------

function hook(
	kind: "onBO" | "onBUO",
	thing: Any,
	second: Any,
	third?: () => void,
): Lambda {
	const dep = depOf(
		typeof third === "function" ? getAtom(thing, second) : getAtom(thing),
	);
	const listener: () => void = typeof third === "function" ? third : second;
	const listeners = dep[kind] ?? new Set();
	dep[kind] = listeners;
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && dep[kind] === listeners) dep[kind] = null;
	};
}

/** Run `listener` when something starts to be observed by a reaction. */
export function onBecomeObserved(thing: Any, listener: () => void): Lambda;
export function onBecomeObserved(
	thing: Any,
	property: Any,
	listener: () => void,
): Lambda;
export function onBecomeObserved(
	thing: Any,
	second: Any,
	third?: () => void,
): Lambda {
	return hook("onBO", thing, second, third);
}

/** Run `listener` when something is no longer observed by any reaction. */
export function onBecomeUnobserved(thing: Any, listener: () => void): Lambda;
export function onBecomeUnobserved(
	thing: Any,
	property: Any,
	listener: () => void,
): Lambda;
export function onBecomeUnobserved(
	thing: Any,
	second: Any,
	third?: () => void,
): Lambda {
	return hook("onBUO", thing, second, third);
}

// -- introspection --------------------------------------------------------------------------

export interface DependencyTree {
	name: string;
	dependencies?: DependencyTree[];
}

export interface ObserverTree {
	name: string;
	observers?: ObserverTree[];
}

/** What a node stands for: a computed's dependency is the computed. */
const nodeOf = (dep: Dep): Node => (dep.owner as Computed<unknown>) ?? dep;

function dependencyTree(node: Node): DependencyTree {
	const tree: DependencyTree = { name: node.name };
	const dependencies =
		node instanceof Dep ? [] : [...(node as Derivation).dependencies];
	if (dependencies.length > 0) {
		tree.dependencies = dependencies.map((dep) => dependencyTree(nodeOf(dep)));
	}
	return tree;
}

/** What a reaction or computed currently depends on. */
export function getDependencyTree(
	thing: Any,
	property?: PropertyKey,
): DependencyTree {
	return dependencyTree(getAtom(thing, property));
}

function observerTree(node: Node): ObserverTree {
	const tree: ObserverTree = { name: node.name };
	const observers = node instanceof Reaction ? [] : [...depOf(node).observers];
	if (observers.length > 0) {
		tree.observers = observers.map((o) => observerTree(o as unknown as Node));
	}
	return tree;
}

/** What currently observes something. */
export function getObserverTree(
	thing: Any,
	property?: PropertyKey,
): ObserverTree {
	return observerTree(getAtom(thing, property));
}

/**
 * `trace()` in a derivation, or `trace(thing, property?)`: log why it runs (with `true` as the
 * last argument, break into the debugger).
 */
export function trace(...args: Any[]): void {
	if (!DEV) return;
	const breakpoint =
		typeof args[args.length - 1] === "boolean" ? args.pop() : false;
	const derivation: Derivation | undefined | null =
		args.length === 0
			? globalState.tracking?.derivation
			: (getAtom(args[0], args[1]) as unknown as Derivation);
	if (!derivation) {
		throw new Error(
			"sobx: 'trace(break?)' can only be used if a tracked computed value or a Reaction is active. Consider passing in the computed value or reaction explicitly",
		);
	}
	enableTrace(derivation, breakpoint);
}

hooks.breakpoint = (derivation) => {
	const lines: string[] = [];
	const print = (tree: DependencyTree, depth: number): void => {
		if (lines.length >= 1000) return;
		lines.push(`${"\t".repeat(depth - 1)}${tree.name}`);
		for (const child of tree.dependencies ?? []) print(child, depth + 1);
	};
	print(dependencyTree(derivation as unknown as Node), 1);
	// biome-ignore lint/suspicious/noDebugger: what it's for
	debugger;
	void `Tracing '${derivation.name}'\n\nYou are entering this break point because derivation '${derivation.name}' is being traced and is now forced to update. The dependencies for this derivation are:\n\n${lines.join("\n")}`;
};

/** Whether `property` of `thing` is observable. */
export function isObservableProp(thing: Any, property: PropertyKey): boolean {
	if (thing instanceof ObservableMap || thing instanceof ObservableArray) {
		throw new Error(
			"sobx: isObservable(object, propertyName) is not supported for arrays and maps. Use map.has or array.length instead.",
		);
	}
	const adm = administrationOf(thing);
	return adm !== undefined && hasMember(thing, adm, property);
}

/** Decorated members are set up when first used. */
function hasMember(
	thing: Any,
	adm: ObjectAdministration,
	property: PropertyKey,
): boolean {
	if (adm.values.has(property)) return true;
	for (
		let o = thing;
		o && o !== Object.prototype;
		o = Object.getPrototypeOf(o)
	) {
		const descriptor = Object.getOwnPropertyDescriptor(o, property);
		if (descriptor) {
			if (!descriptor.get) return false;
			void thing[property];
			return adm.values.has(property);
		}
	}
	return false;
}

/** Whether `property` of `thing` is a computed. */
export function isComputedProp(thing: Any, property: PropertyKey): boolean {
	const adm = administrationOf(thing);
	return (
		adm !== undefined &&
		hasMember(thing, adm, property) &&
		adm.values.get(property) instanceof Computed
	);
}

export function isAtom(thing: unknown): boolean {
	return thing instanceof Dep;
}

export { ObservableValue };

// -- what libraries built on MobX use -------------------------------------------------------

/** Run `fn` allowing (or not) state changes. */
export function _allowStateChanges<T>(allow: boolean, fn: () => T): T {
	return allowStateChanges(allow, fn);
}

/** Run `fn` allowing state changes, even in a computed. */
export function _allowStateChangesInsideComputed<T>(fn: () => T): T {
	return allowStateChanges(true, fn);
}

export function _allowStateReadsStart(allow: boolean): boolean {
	const previous = globalState.allowStateReads;
	globalState.allowStateReads = allow;
	return previous;
}

export function _allowStateReadsEnd(previous: boolean): void {
	globalState.allowStateReads = previous;
}

export function _isComputingDerivation(): boolean {
	return globalState.tracking !== null;
}

export function _resetGlobalState(): void {
	resetGlobalState();
}

/** MobX's global state (what libraries read of it). */
export function _getGlobalState() {
	return {
		version: 6,
		get trackingDerivation() {
			return globalState.tracking?.derivation ?? null;
		},
		get trackingContext() {
			return globalState.trackingContext;
		},
		get inBatch() {
			return globalState.batchDepth;
		},
		get allowStateChanges() {
			return globalState.allowStateChanges;
		},
		get allowStateReads() {
			return globalState.allowStateReads;
		},
		get enforceActions() {
			return globalState.enforceActions === "always"
				? "always"
				: globalState.enforceActions === "observed";
		},
		get isRunningReactions() {
			return globalState.isRunningReactions;
		},
		get useProxies() {
			return globalState.useProxies;
		},
		get safeDescriptors() {
			return globalState.safeDescriptors;
		},
	};
}

export function _startAction(
	name: string,
	canRunAsDerivation: boolean,
	scope?: unknown,
	args?: ArrayLike<unknown>,
): ActionRunInfo {
	return startAction(name, canRunAsDerivation, scope, args);
}

export function _endAction(info: ActionRunInfo): void {
	endAction(info);
}
