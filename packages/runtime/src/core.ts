/**
 * The dependency-tracking engine shared by observables, computeds and reactions.
 *
 * A {@link Dep} is one observable slot (a property of an observable, or a computed's value).
 * While a derivation (computed or reaction) runs, every `Dep` read is recorded; afterwards the
 * derivation subscribes to exactly those. When a `Dep` changes, its derivations are told:
 * reactions are scheduled, computeds become stale and pass a "maybe stale" signal on.
 */

/** Something that depends on observable values: a computed or a reaction. */
export interface Derivation {
	/** A dependency changed (`definite`), or a computed dependency may have changed. */
	onChange(definite: boolean, dep: Dep): void;
	readonly name: string;
	/** What it read in its last run. */
	readonly dependencies: Iterable<Dep>;
	/** Set by `trace()`. */
	tracing: "break" | "log" | null;
	/** Warn when it reads no observables (`requiresObservable`). */
	readonly requiresObservable?: boolean;
}

/** Minimal view of a computed, used to check whether a "maybe stale" derivation must re-run. */
export interface VersionedComputed {
	version: number;
	/** Whether a dependency (maybe) changed since it was computed. */
	readonly stale: boolean;
	/** Bring the value up to date (recomputing if needed). */
	refresh(): void;
	/** Called when nothing depends on it any more, at the end of the batch. */
	suspend(): void;
}

/** Anything with a name for debugging. */
export interface Named {
	readonly name: string;
}

/** A debug name: `prefix@<id>` in development builds, `prefix` in production. */
export function debugName(prefix: string): string {
	return DEV ? `${prefix}@${nextId()}` : prefix;
}

/** The time, for spies. */
export const now: () => number = () =>
	(globalThis as unknown as { Date: { now(): number } }).Date.now();

export function nextId(): number {
	return ++globalState.mobxGuid;
}

/** One observable slot that derivations can depend on (an "atom" in MobX). */
export class Dep {
	readonly observers = new Set<Derivation>();
	/** The last derivation run that read it ({@link Tracking.id}), to record each read once. */
	seen = 0;
	/** Whether reactions depend on it (directly or not), as of the last batch. */
	observed = false;
	/** Queued to be checked for observers when the batch ends. */
	pending = false;
	/** `onBecomeObserved` / `onBecomeUnobserved` listeners. */
	onBO: Set<() => void> | null = null;
	onBUO: Set<() => void> | null = null;
	/** Called when nothing observes it any more (unless it has the listeners above). */
	onUnused: (() => void) | null = null;
	/**
	 * `owner`: the computed whose value this is. `holder` (and `key` in it): what it belongs to,
	 * for its name.
	 */
	constructor(
		readonly owner?: VersionedComputed & Derivation,
		protected readonly holder?: Named | string,
		protected readonly key?: unknown,
	) {}

	get name(): string {
		if (this.owner) return this.owner.name;
		const { holder, key } = this;
		const base = typeof holder === "string" ? holder : (holder?.name ?? "Atom");
		if (key === undefined) return base;
		return DEV ? `${base}.${stringifyKey(key)}` : `${base}.key`;
	}

	/** Record that a derivation reads it. Returns whether something observes it. */
	reportObserved(): boolean {
		reportObserved(this);
		return this.observed;
	}

	/** Notify what depends on it that it changed. */
	reportChanged(): void {
		startBatch();
		try {
			reportChanged(this);
		} finally {
			endBatch();
		}
	}

	toString(): string {
		return this.name;
	}
}

export function stringifyKey(key: unknown): string {
	if (typeof key === "string") return key;
	if (typeof key === "symbol") return key.toString();
	return String(key);
}

/** What a running derivation has read so far. */
export interface Tracking {
	/** Identifies this run. */
	readonly id: number;
	/** The derivation running. */
	readonly derivation: Derivation | null;
	/**
	 * What it read, in order. May have duplicates: what was also read by a derivation that ran
	 * during this one (which changes {@link Dep.seen}).
	 */
	deps: Dep[];
	/** Computed dependencies and the version that was read (created on first computed read). */
	versions: Map<VersionedComputed, number> | null;
}

export type EnforceActions = "never" | "observed" | "always";

const runNow = (run: () => void): void => run();

function defaults() {
	return {
		/** The derivation currently collecting dependencies, if any. */
		tracking: null as Tracking | null,
		/** The reaction currently running, if any. */
		trackingContext: null as Derivation | null,
		batchDepth: 0,
		/** Whether observables may be changed now (inside actions). */
		allowStateChanges: false,
		/** Whether observables may be read now (`observableRequiresReaction`). */
		allowStateReads: true,
		/** Like MobX's `configure({ enforceActions })`. Checked in development builds only. */
		enforceActions: "observed" as EnforceActions,
		/**
		 * Put observable objects and arrays behind a `Proxy` (see `proxies.ts`), as MobX does:
		 * `configure({ useProxies })`.
		 */
		useProxies: true,
		/** Number of spies. */
		spying: 0,
		computedRequiresReaction: false,
		reactionRequiresObservable: false,
		observableRequiresReaction: false,
		disableErrorBoundaries: false,
		/** Don't log errors in reactions (an action is throwing). */
		suppressReactionErrors: false,
		/** Members of classes can't be redefined, and actions not overwritten. */
		safeDescriptors: true,
		reactionErrorHandlers: [] as Array<
			(error: unknown, reaction: unknown) => void
		>,
		reactionScheduler: runNow,
		pendingReactions: [] as Scheduled[],
		pendingUnobservations: [] as Dep[],
		isRunningReactions: false,
		currentActionId: 0,
		/** The last id in names. */
		mobxGuid: 0,
		/** Proxies throw for what wouldn't work without them (`useProxies: "ifavailable"`). */
		verifyProxies: false,
	};
}

/** Mutable global state. A single object so that every module sees the same values. */
export const globalState = defaults();

/** Back to a fresh state (settings are kept), as after errors in tests. */
export function resetGlobalState(): void {
	const kept = [
		"spying",
		"enforceActions",
		"allowStateReads",
		"useProxies",
		"computedRequiresReaction",
		"reactionRequiresObservable",
		"observableRequiresReaction",
		"disableErrorBoundaries",
		"reactionScheduler",
		"mobxGuid",
		"verifyProxies",
	];
	for (const [key, value] of Object.entries(defaults())) {
		if (!kept.includes(key))
			(globalState as Record<string, unknown>)[key] = value;
	}
	globalState.allowStateChanges = globalState.enforceActions === "never";
}

// The runtime targets any JS environment.
declare const console: {
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
	log(...args: unknown[]): void;
};
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
 * Warn, like MobX, when an observable is changed while that's not allowed: outside an action while
 * `enforceActions` requires one (`"observed"`: only if something observes it; `"always"`: any
 * change), or in a computed.
 */
export function checkWrite(dep: Dep | undefined, what: string | Named): void {
	if (!DEV || globalState.allowStateChanges) return;
	checkWriteIf(!!dep && dep.observers.size > 0, what);
}

/** {@link checkWrite}, when the caller knows whether the value is observed. */
export function checkWriteIf(observed: boolean, what: string | Named): void {
	if (!DEV || globalState.allowStateChanges) return;
	const mode = globalState.enforceActions;
	if (!observed && mode !== "always") return;
	const name = typeof what === "string" ? what : what.name;
	console.warn(
		mode === "never"
			? `[sobx] Side effects like changing state are not allowed at this point. Are you trying to modify state from, for example, a computed value or the render function of a React component? You can wrap side effects in 'runInAction' (or decorate functions with 'action') if needed. Tried to modify: ${name}`
			: `[sobx] Since strict-mode is enabled, changing (observed) observable values without using an action is not allowed. Tried to modify: ${name}`,
	);
}

/** Warn about a read outside derivations and actions (`observableRequiresReaction`). */
export function checkRead(what: Named, key?: unknown): void {
	if (!DEV || globalState.allowStateReads) return;
	const name =
		key === undefined ? what.name : `${what.name}.${stringifyKey(key)}`;
	console.warn(
		`[sobx] Observable '${name}' being read outside a reactive context.`,
	);
}

/** Run `fn` with `allow` deciding whether observables may be changed. */
export function allowStateChanges<T>(allow: boolean, fn: () => T): T {
	const previous = globalState.allowStateChanges;
	globalState.allowStateChanges = allow;
	try {
		return fn();
	} finally {
		globalState.allowStateChanges = previous;
	}
}

/** The administration behind an observable: `observable[$mobx]`, as in MobX. */
export const $mobx: unique symbol = Symbol("mobx administration");

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
 * element). Without proxies (`useProxies: "never"`, `proxy: false`), some reads of a held value
 * can't be tracked by the value itself (`array.length`, `array[i]`, a key that doesn't exist
 * yet). Such a value tells its owners when it changes, and they notify whoever read it through
 * them: a derivation that read `store.items` re-runs when `store.items` is mutated.
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
	// A proxied value tracks every read itself; its owners have nothing to add.
	if (proxyTargets.has(value)) return;
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
	object: (value: object, _deep: boolean, _name?: string): object => value,
	/** Wrap a function put into a deep observable as an auto-action / flow. */
	fn: (fn: unknown, _name: string | undefined): unknown => fn,
	/** Break into the debugger (`trace(true)`). */
	breakpoint: (_derivation: Derivation): void => {},
	/** Put a new observable object / array behind a `Proxy` (set by `proxies.ts`). */
	proxy: <T extends object>(raw: T, _kind: "object" | "array"): T => raw,
};

/** The observable behind each proxy, and the proxy in front of each observable. */
const proxyTargets = new WeakMap<object, object>();
const proxies = new WeakMap<object, object>();

/** The observable behind `value` if it's a proxy of one, else `value`. */
export function rawOf<T>(value: T): T {
	return typeof value === "object" && value !== null
		? ((proxyTargets.get(value) as T | undefined) ?? value)
		: value;
}

/** The proxy in front of `raw` if it has one, else `raw`: what user code must see as `this`. */
export function proxyOf<T extends object>(raw: T): T {
	return (proxies.get(raw) as T | undefined) ?? raw;
}

/**
 * Put a new observable behind a proxy (if `useProxies` is on). Runtime internals only ever work
 * on `raw`, so that traps only run for user code.
 */
export function maybeProxy<T extends object>(
	raw: T,
	kind: "object" | "array",
): T {
	if (!globalState.useProxies) return raw;
	const proxy = hooks.proxy(raw, kind);
	if (proxy !== raw) {
		proxyTargets.set(proxy, raw);
		proxies.set(raw, proxy);
		observableValues.add(proxy);
	}
	return proxy;
}

export interface Scheduled {
	runScheduled(): void;
	readonly name: string;
}
const MAX_ITERATIONS = 100;

/** Record a read of `dep` in the running derivation. */
export function reportObserved(dep: Dep): void {
	const tracking = globalState.tracking;
	if (tracking !== null) {
		if (dep.seen === tracking.id) return;
		dep.seen = tracking.id;
		tracking.deps.push(dep);
		if (!dep.observed && globalState.trackingContext !== null) {
			dep.observed = true;
			if (dep.onBO !== null) for (const listener of dep.onBO) listener();
		}
		return;
	}
	if (DEV && !globalState.allowStateReads) checkRead(dep);
	if (globalState.batchDepth > 0 && dep.observers.size === 0) {
		queueUnobservation(dep);
	}
}

/** Check, when the batch ends, whether `dep` still has observers. */
export function queueUnobservation(dep: Dep): void {
	if (dep.pending) return;
	dep.pending = true;
	globalState.pendingUnobservations.push(dep);
}

function processUnobservations(): void {
	const list = globalState.pendingUnobservations;
	// The list may grow: suspending a computed releases its own dependencies.
	for (let i = 0; i < list.length; i++) {
		const dep = list[i] as Dep;
		dep.pending = false;
		if (dep.observers.size > 0) continue;
		if (dep.observed) {
			dep.observed = false;
			if (dep.onBUO !== null) for (const listener of dep.onBUO) listener();
		}
		dep.owner?.suspend();
		if (dep.onUnused !== null && dep.onBO === null && dep.onBUO === null) {
			dep.onUnused();
		}
	}
	globalState.pendingUnobservations = [];
}

/** Schedule a reaction to run when the outermost batch ends. */
export function schedule(reaction: Scheduled): void {
	globalState.pendingReactions.push(reaction);
}

export function startBatch(): void {
	globalState.batchDepth++;
}

export function endBatch(): void {
	if (--globalState.batchDepth !== 0) return;
	if (globalState.pendingReactions.length > 0) runReactions();
	if (globalState.pendingUnobservations.length > 0) processUnobservations();
}

/** Run scheduled reactions, unless in a batch (or already running them). */
export function runReactions(): void {
	if (globalState.batchDepth > 0 || globalState.isRunningReactions) return;
	const { reactionScheduler } = globalState;
	if (reactionScheduler === runNow) flush();
	else reactionScheduler(flush);
}

function flush(): void {
	globalState.isRunningReactions = true;
	try {
		let iterations = 0;
		while (globalState.pendingReactions.length > 0) {
			if (++iterations === MAX_ITERATIONS) {
				const name = globalState.pendingReactions[0]?.name;
				globalState.pendingReactions = [];
				console.error(
					`[sobx] Reaction doesn't converge to a stable state after ${MAX_ITERATIONS} iterations. Probably there is a cycle in the reactive function: ${name}`,
				);
				break;
			}
			const reactions = globalState.pendingReactions;
			globalState.pendingReactions = [];
			for (let i = 0; i < reactions.length; i++) {
				(reactions[i] as Scheduled).runScheduled();
			}
		}
	} finally {
		globalState.isRunningReactions = false;
	}
}

/** Notify the derivations of `dep` that it changed. */
export function reportChanged(dep: Dep): void {
	// onChange only marks and schedules; it never changes `dep.observers`.
	for (const observer of dep.observers) observer.onChange(true, dep);
	if (globalState.batchDepth === 0 && globalState.pendingReactions.length > 0) {
		runReactions();
	}
}

/**
 * Run `fn` as `derivation`, collecting what it reads, then update the derivation's
 * subscriptions from `previous` to the new set. Returns the result and the new tracking.
 * `fn` must not throw. Must be called in a batch.
 */
export function track<T>(
	derivation: Derivation,
	previous: Tracking,
	fn: () => T,
): { value: T; tracking: Tracking } {
	const outer = globalState.tracking;
	const reads = globalState.allowStateReads;
	const tracking = newTracking(derivation);
	globalState.tracking = tracking;
	globalState.allowStateReads = true;
	try {
		return { value: fn(), tracking };
	} finally {
		globalState.tracking = outer;
		globalState.allowStateReads = reads;
		rebind(derivation, previous, tracking);
		if (DEV && tracking.deps.length === 0) checkDependencies(derivation);
	}
}

/** As {@link track}, for derivations without a value. */
export function trackOnly(
	derivation: Derivation,
	previous: Tracking,
	fn: () => void,
): Tracking {
	const outer = globalState.tracking;
	const reads = globalState.allowStateReads;
	const tracking = newTracking(derivation);
	globalState.tracking = tracking;
	globalState.allowStateReads = true;
	try {
		fn();
		return tracking;
	} finally {
		globalState.tracking = outer;
		globalState.allowStateReads = reads;
		rebind(derivation, previous, tracking);
		if (DEV && tracking.deps.length === 0) checkDependencies(derivation);
	}
}

function checkDependencies(derivation: Derivation): void {
	if (derivation.requiresObservable ?? globalState.reactionRequiresObservable) {
		console.warn(
			`[sobx] Derivation '${derivation.name}' is created/updated without reading any observable value.`,
		);
	}
}

/** Move `derivation`'s subscriptions from `previous` to `next`. */
export function rebind(
	derivation: Derivation,
	previous: Tracking,
	next: Tracking,
): void {
	const from = previous.deps;
	const to = next.deps;
	// Most runs read what the last one did.
	let same = 0;
	const length = Math.min(from.length, to.length);
	while (same < length && from[same] === to[same]) same++;
	if (same === from.length && same === to.length) return;
	for (let i = same; i < to.length; i++) {
		const dep = to[i] as Dep;
		dep.observers.add(derivation);
		// It changed after it was read, before it was observed.
		if (dep.owner?.stale) derivation.onChange(false, dep);
	}
	if (same === from.length) return;
	const kept = new Set(to);
	for (let i = same; i < from.length; i++) {
		const dep = from[i] as Dep;
		if (kept.has(dep)) continue;
		dep.observers.delete(derivation);
		if (dep.observers.size === 0) queueUnobservation(dep);
	}
}

let lastTracking = 0;

function newTracking(derivation: Derivation | null): Tracking {
	return {
		id: ++lastTracking,
		derivation,
		deps: [],
		versions: null,
	};
}

export function emptyTracking(): Tracking {
	return newTracking(null);
}

/** Whether any computed read by a derivation has changed since it was read. */
export function computedsChanged(
	tracking: Tracking,
	derivation: Derivation,
): boolean {
	if (tracking.versions === null) return false;
	const outer = globalState.tracking;
	globalState.tracking = null;
	try {
		for (const [computed, version] of tracking.versions) {
			try {
				computed.refresh();
			} catch {
				// In a cycle: it's found again (and reported) by computing.
				return true;
			}
			if (computed.version === version) continue;
			if (derivation.tracing !== null) {
				logTrace(derivation, computed as unknown as Named);
			}
			return true;
		}
		return false;
	} finally {
		globalState.tracking = outer;
	}
}

/** Log why `derivation` is invalidated (`trace()`). */
export function logTrace(derivation: Derivation, dep: Named): void {
	console.log(
		`[sobx.trace] '${derivation.name}' is invalidated due to a change in: '${dep.name}'`,
	);
	if (derivation.tracing === "break") hooks.breakpoint(derivation);
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

/** Run `fn` in a batch: reactions run once, when the outermost batch ends. */
export function batch<T>(fn: () => T): T {
	startBatch();
	try {
		return fn();
	} finally {
		endBatch();
	}
}

const tagOf = (value: unknown): string => Object.prototype.toString.call(value);

/** What is compared of arrays, Maps and Sets. */
function contents(value: unknown): unknown {
	if (value instanceof Map || value instanceof Set) {
		return Array.from(value.entries());
	}
	return value;
}

/**
 * Structural equality (as MobX's, which is underscore's): primitives and their wrappers, dates
 * and regular expressions by value, arrays, Maps, Sets and objects by content (objects of
 * different classes aren't equal), down to `depth` levels if given. Cycles are fine.
 */
export function deepEqual(a: unknown, b: unknown, depth = -1): boolean {
	return equal(a, b, depth, [], []);
}

function equal(
	a: unknown,
	b: unknown,
	depth: number,
	as: unknown[],
	bs: unknown[],
): boolean {
	if (Object.is(a, b)) return true;
	if (a === null || a === undefined || b === null || b === undefined) {
		return false;
	}
	if (
		typeof a !== "function" &&
		typeof a !== "object" &&
		typeof b !== "object"
	) {
		return false;
	}
	const tag = tagOf(a);
	if (tag !== tagOf(b)) return false;
	let levels = depth;
	switch (tag) {
		case "[object RegExp]":
		case "[object String]":
			return `${a}` === `${b}`;
		case "[object Number]":
		case "[object Date]":
		case "[object Boolean]": {
			const x = Number(a);
			const y = Number(b);
			return tag === "[object Number]" ? Object.is(x, y) : x === y;
		}
		case "[object Symbol]":
			return (
				Symbol.prototype.valueOf.call(a) === Symbol.prototype.valueOf.call(b)
			);
		case "[object Map]":
		case "[object Set]":
			// Compared as arrays of entries: an incidental level.
			if (levels >= 0) levels++;
			break;
	}
	const isArray = tag === "[object Array]";
	const x = contents(a) as Record<string, unknown>;
	const y = contents(b) as Record<string, unknown>;
	if (!isArray) {
		if (typeof x !== "object" || typeof y !== "object") return false;
		const xc = x.constructor as unknown;
		const yc = y.constructor as unknown;
		const isGlobal = (c: unknown) => typeof c === "function" && c instanceof c;
		if (
			xc !== yc &&
			!(isGlobal(xc) && isGlobal(yc)) &&
			"constructor" in x &&
			"constructor" in y
		) {
			return false;
		}
	}
	if (levels === 0) return false;
	if (levels < 0) levels = -1;
	// Being compared already: equal if to the same.
	for (let i = as.length - 1; i >= 0; i--) if (as[i] === a) return bs[i] === b;
	as.push(a);
	bs.push(b);
	const keys = isArray ? null : Object.keys(x);
	let same: boolean;
	if (keys === null) {
		const xs = x as unknown as unknown[];
		const ys = y as unknown as unknown[];
		same =
			xs.length === ys.length &&
			Array.from(xs).every((v, i) => equal(v, ys[i], levels - 1, as, bs));
	} else {
		same =
			keys.length === Object.keys(y).length &&
			keys.every(
				(k) => Object.hasOwn(y, k) && equal(x[k], y[k], levels - 1, as, bs),
			);
	}
	as.pop();
	bs.pop();
	return same;
}

export type Equals = (a: unknown, b: unknown) => boolean;
