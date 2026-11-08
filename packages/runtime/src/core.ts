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

/** Mutable global state. A single object so that every module sees the same values. */
export const globalState = {
	/** The derivation currently collecting dependencies, if any. */
	tracking: null as Tracking | null,
	batchDepth: 0,
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
