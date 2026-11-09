/**
 * The dependency-tracking engine shared by observables, computeds and reactions.
 *
 * A {@link Dep} is one observable slot (a property of an observable, or a computed's value).
 * While a derivation (computed or reaction) runs, every `Dep` read is recorded; afterwards the
 * derivation subscribes to exactly those. When a `Dep` changes, its derivations are told:
 * reactions are scheduled, computeds become stale and pass a "maybe stale" signal on.
 */

/** Something that depends on observable values. */
export interface Derivation {
	/** A dependency changed (`definite`), or a computed dependency may have changed. */
	onChange(definite: boolean): void;
}

/** Minimal view of a computed, used to check whether a "maybe stale" derivation must re-run. */
export interface VersionedComputed {
	version: number;
	/** Bring the value up to date (recomputing if needed). */
	refresh(): void;
	/** Called when the last derivation stops depending on it. */
	suspend(): void;
}

/** One observable slot that derivations can depend on. */
export class Dep {
	readonly observers = new Set<Derivation>();
	constructor(readonly owner?: VersionedComputed) {}
}

/** What a running derivation has read so far. */
export interface Tracking {
	deps: Set<Dep>;
	/** Computed dependencies and the version that was read (created on first computed read). */
	versions: Map<VersionedComputed, number> | null;
}

export type EnforceActions = "never" | "observed" | "always";

/** Mutable global state. A single object so that every module sees the same values. */
export const globalState = {
	/** The derivation currently collecting dependencies, if any. */
	tracking: null as Tracking | null,
	batchDepth: 0,
	/** Greater than zero inside actions, flows steps and reactions, where state may change. */
	allowStateChanges: 0,
	/** Like MobX's `configure({ enforceActions })`. Checked in development builds only. */
	enforceActions: "observed" as EnforceActions,
};

// The runtime targets any JS environment.
declare const console: { warn(...args: unknown[]): void };
declare const process: { env: Record<string, string | undefined> };

/** Development build? Bundlers replace `process.env.NODE_ENV`, as they do for MobX. */
export const DEV: boolean = (() => {
	try {
		return process.env.NODE_ENV !== "production";
	} catch {
		return true;
	}
})();

/**
 * Warn, like MobX, when an observable is changed outside an action while `enforceActions`
 * requires one (`"observed"`: only if something observes it; `"always"`: any change).
 */
export function checkWrite(dep: Dep | undefined, what: string): void {
	if (!DEV || globalState.allowStateChanges > 0) return;
	checkWriteIf(!!dep && dep.observers.size > 0, what);
}

/** {@link checkWrite}, when the caller knows whether the value is observed. */
export function checkWriteIf(observed: boolean, what: string): void {
	if (!DEV || globalState.allowStateChanges > 0) return;
	const mode = globalState.enforceActions;
	if (mode === "never") return;
	if (mode === "observed" && !observed) return;
	console.warn(
		`[sobx] Since enforceActions is "${mode}", ${mode === "observed" ? "observed " : ""}observable values must be changed inside actions (action, runInAction, flow). Tried to modify: ${what}`,
	);
}

/**
 * Present (`true`) on the values whose properties the compiler helpers handle differently from
 * plain JavaScript: observable arrays, `ProxyLike`s and accessor-based observable objects and
 * classes. Compiled writes check it inline (`o[$sobx] !== undefined ? setProperty(...) : ...`),
 * so writes to plain values run as they are.
 */
export const $sobx: unique symbol = Symbol("sobx");

/** Mark `target` (an object or a prototype) with {@link $sobx}. */
export function markObservable(target: object): void {
	Object.defineProperty(target, $sobx, { value: true });
}

/** Every observable value (arrays, objects, Maps, Sets, boxes, ProxyLike, classes). */
export const observableValues = new WeakSet<object>();

/**
 * Plain values being converted to observables, and their observable. Registered before the
 * contents are converted, so cyclic and shared references convert to the same observable.
 */
export const converting = new WeakMap<object, object>();

let conversionDepth = 0;
const converted: object[] = [];

/**
 * Run `fill` with `source` registered as converting to `result`. Registrations last until the
 * outermost conversion ends, so a value referenced from several places in one conversion
 * becomes a single observable.
 */
export function convertingTo<T>(
	source: unknown,
	result: object,
	fill: () => T,
): T {
	if (
		typeof source === "object" &&
		source !== null &&
		!converting.has(source)
	) {
		converting.set(source, result);
		converted.push(source);
	}
	conversionDepth++;
	try {
		return fill();
	} finally {
		if (--conversionDepth === 0) {
			for (const value of converted) converting.delete(value);
			converted.length = 0;
		}
	}
}

/**
 * Something that holds an observable value (an object property, a box, a Map value, an array
 * element). sobx never uses `Proxy`, so some reads of a held value can't be tracked by the value
 * itself (`array.length`, `array[i]`, a key that doesn't exist yet). Instead, the value tells its
 * owners when it changes, and they notify whoever read it through them: a derivation that read
 * `store.items` re-runs when `store.items` is mutated, whatever it did with the array.
 */
export interface Owner {
	ownerChanged(): void;
	/** Whether anything observes the value through this owner (for `enforceActions`). */
	ownerObserved(): boolean;
}

const ownersOf = new WeakMap<object, Set<Owner>>();

/** Record that `owner` holds `value` (if `value` is observable). */
export function adopt(value: unknown, owner: Owner): void {
	if (typeof value !== "object" || value === null) return;
	if (!observableValues.has(value)) return;
	let owners = ownersOf.get(value);
	if (!owners) {
		owners = new Set();
		ownersOf.set(value, owners);
	}
	owners.add(owner);
}

/** Record that `owner` no longer holds `value`. */
export function release(value: unknown, owner: Owner): void {
	if (typeof value !== "object" || value === null) return;
	ownersOf.get(value)?.delete(owner);
}

/** Whether anything observes `value` through one of its owners. */
export function ownersObserved(value: object): boolean {
	const owners = ownersOf.get(value);
	if (!owners) return false;
	for (const owner of owners) if (owner.ownerObserved()) return true;
	return false;
}

let notifying: Set<object> | null = null;

/** Tell `value`'s owners that it changed (cycle-safe). */
export function notifyOwners(value: object): void {
	const owners = ownersOf.get(value);
	if (!owners || owners.size === 0) return;
	const outer = notifying === null;
	if (outer) notifying = new Set();
	const seen = notifying as Set<object>;
	if (seen.has(value)) return;
	seen.add(value);
	startBatch();
	try {
		for (const owner of [...owners]) owner.ownerChanged();
	} finally {
		if (outer) notifying = null;
		endBatch();
	}
}

/**
 * Hooks filled in by the modules that implement them, so that the value modules can convert
 * nested values without importing each other.
 */
export const hooks = {
	/** Make a plain object observable (`deep`: whether its own values are deep too). */
	object: (value: object, _deep: boolean): object => value,
};

interface Scheduled {
	runScheduled(): void;
}
// Reactions schedule themselves only when they go from fresh to stale, so no duplicates.
let pending: Scheduled[] = [];
let flushing = false;
const MAX_ITERATIONS = 100;

/** Record a read of `dep` in the running derivation. */
export function reportObserved(dep: Dep): void {
	globalState.tracking?.deps.add(dep);
}

/** Schedule a reaction to run when the outermost batch ends. */
export function schedule(reaction: Scheduled): void {
	pending.push(reaction);
}

export function startBatch(): void {
	globalState.batchDepth++;
}

export function endBatch(): void {
	if (--globalState.batchDepth === 0 && pending.length > 0) flush();
}

function flush(): void {
	if (flushing) return;
	flushing = true;
	try {
		let iterations = 0;
		while (pending.length > 0) {
			if (++iterations > MAX_ITERATIONS) {
				pending = [];
				throw new Error(
					`sobx: reactions did not converge after ${MAX_ITERATIONS} iterations; a reaction probably changes a value it depends on.`,
				);
			}
			const reactions = pending;
			pending = [];
			for (let i = 0; i < reactions.length; i++) {
				(reactions[i] as Scheduled).runScheduled();
			}
		}
	} finally {
		flushing = false;
	}
}

/** Notify the derivations of `dep` that it changed. */
export function reportChanged(dep: Dep): void {
	// onChange only marks and schedules; it never changes `dep.observers`.
	for (const observer of dep.observers) observer.onChange(true);
	if (globalState.batchDepth === 0 && pending.length > 0) flush();
}

/**
 * Run `fn` as `derivation`, collecting what it reads, then update the derivation's
 * subscriptions from `previous` to the new set. Returns the result and the new tracking.
 */
export function track<T>(
	derivation: Derivation,
	previous: Tracking,
	fn: () => T,
): { value: T; tracking: Tracking } {
	const outer = globalState.tracking;
	const tracking: Tracking = { deps: new Set(), versions: null };
	globalState.tracking = tracking;
	try {
		return { value: fn(), tracking };
	} finally {
		globalState.tracking = outer;
		rebind(derivation, previous, tracking);
	}
}

/** Move `derivation`'s subscriptions from `previous` to `next`. */
export function rebind(
	derivation: Derivation,
	previous: Tracking,
	next: Tracking,
): void {
	for (const dep of next.deps) {
		if (!previous.deps.has(dep)) dep.observers.add(derivation);
	}
	for (const dep of previous.deps) {
		if (next.deps.has(dep)) continue;
		dep.observers.delete(derivation);
		if (dep.owner && dep.observers.size === 0) dep.owner.suspend();
	}
}

export function emptyTracking(): Tracking {
	return { deps: new Set(), versions: null };
}

/** Whether any computed read by a derivation has changed since it was read. */
export function computedsChanged(tracking: Tracking): boolean {
	if (tracking.versions === null) return false;
	for (const [computed, version] of tracking.versions) {
		computed.refresh();
		if (computed.version !== version) return true;
	}
	return false;
}

/**
 * The dependency collector of the derivation running now (an opaque object, new for every
 * run), or `null` outside derivations. For bindings that need to know whether a read happens
 * in a particular derivation (e.g. `@sobx/react`'s development checks).
 */
export function currentTracking(): object | null {
	return globalState.tracking;
}

/** Run `fn` without tracking what it reads. */
export function untracked<T>(fn: () => T): T {
	const outer = globalState.tracking;
	globalState.tracking = null;
	try {
		return fn();
	} finally {
		globalState.tracking = outer;
	}
}

/** Run `fn` as an action: batched, untracked, and allowed to change state. */
export function runAction<T>(fn: () => T, untrackedReads = true): T {
	startBatch();
	globalState.allowStateChanges++;
	const outer = globalState.tracking;
	if (untrackedReads) globalState.tracking = null;
	try {
		return fn();
	} finally {
		globalState.tracking = outer;
		globalState.allowStateChanges--;
		endBatch();
	}
}

/** Run `fn` in a batch: reactions run once, when the outermost batch ends. */
export function batch<T>(fn: () => T): T {
	startBatch();
	try {
		return fn();
	} finally {
		endBatch();
	}
}

/** Structural equality for plain objects, arrays, Maps, Sets and primitives. */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	) {
		return false;
	}
	if (Array.isArray(a)) {
		return (
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((x, i) => deepEqual(x, b[i]))
		);
	}
	if (a instanceof Map) {
		if (!(b instanceof Map) || a.size !== b.size) return false;
		for (const [k, v] of a)
			if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
		return true;
	}
	if (a instanceof Set) {
		if (!(b instanceof Set) || a.size !== b.size) return false;
		for (const v of a) if (!b.has(v)) return false;
		return true;
	}
	if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every(
		(k) =>
			Object.hasOwn(b, k) &&
			deepEqual(
				(a as Record<string, unknown>)[k],
				(b as Record<string, unknown>)[k],
			),
	);
}

export type Equals = (a: unknown, b: unknown) => boolean;
