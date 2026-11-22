/** `toJS`, `configure` and the `isObservable*` checks. */
import {
	isObservableArray,
	ObservableMap,
	ObservableSet,
} from "./collections.js";
import { Computed } from "./computed.js";
import {
	DEV,
	Dep,
	type EnforceActions,
	globalState,
	observableValues,
} from "./core.js";
import { isPlainObject } from "./enhance.js";
import { isObservableObject } from "./observable.js";
import { ProxyLike } from "./proxy-like.js";
import { Reaction } from "./reaction.js";
import { ObservableValue } from "./value.js";

// The runtime targets any JS environment.
declare const console: { warn(...args: unknown[]): void };

/** Whether `value` is observable (an observable object, array, Map, Set or box). */
export function isObservable(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		(observableValues.has(value) ||
			isObservableObject(value) ||
			value instanceof Dep ||
			value instanceof Computed ||
			value instanceof Reaction)
	);
}

export { isObservableArray, isObservableObject };

export function isObservableMap(
	value: unknown,
): value is ObservableMap<unknown, unknown> {
	return value instanceof ObservableMap;
}

export function isObservableSet(
	value: unknown,
): value is ObservableSet<unknown> {
	return value instanceof ObservableSet;
}

export function isBoxedObservable(
	value: unknown,
): value is ObservableValue<unknown> {
	return value instanceof ObservableValue;
}

export function isComputed(value: unknown): value is Computed<unknown> {
	return value instanceof Computed;
}

/**
 * Recursively convert observables (and the plain objects / arrays containing them) to plain
 * JavaScript: arrays, objects (their enumerable data properties, without computeds and
 * functions), Maps and Sets. Cycles are preserved.
 */
export function toJS<T>(value: T): T {
	return convert(value, new Map()) as T;
}

function convert(value: unknown, seen: Map<unknown, unknown>): unknown {
	if (typeof value !== "object" || value === null) return value;
	const done = seen.get(value);
	if (done !== undefined) return done;
	if (Array.isArray(value) || isObservableArray(value)) {
		const out: unknown[] = [];
		seen.set(value, out);
		for (const item of value as unknown[]) out.push(convert(item, seen));
		return out;
	}
	if (value instanceof Map) {
		const out = new Map();
		seen.set(value, out);
		for (const [k, v] of value) out.set(k, convert(v, seen));
		return out;
	}
	if (value instanceof Set) {
		const out = new Set();
		seen.set(value, out);
		for (const v of value) out.add(convert(v, seen));
		return out;
	}
	if (value instanceof ObservableValue) return convert(value.get(), seen);
	if (value instanceof Computed || value instanceof Reaction) return value;
	const source = value instanceof ProxyLike ? value.unwrap() : value;
	if (!isPlainObject(source) && !isObservableObject(value)) return value;
	const out: Record<string, unknown> = {};
	seen.set(value, out);
	for (const key of Object.keys(source)) {
		const item =
			value instanceof ProxyLike
				? value.get(key as never)
				: (value as Record<string, unknown>)[key];
		if (typeof item === "function") continue;
		out[key] = convert(item, seen);
	}
	return out;
}

export interface ConfigureOptions {
	/**
	 * Require actions to change observables (warnings in development builds): `"observed"`
	 * (default) when something observes them, `"always"`, or `"never"`.
	 */
	enforceActions?: EnforceActions;
	/**
	 * Whether observable objects and arrays created from now on are behind a `Proxy`, so that any
	 * code observes everything on them: `"always"` (default) or `"ifavailable"`. With `"never"`,
	 * adding / deleting keys, `in`, `Object.keys` and array index / `length` need the explicit
	 * API (`set`, `remove`, `has`, `keys`...) where the compiler can't see the observable.
	 */
	useProxies?: "always" | "ifavailable" | "never";
	/** Warn about computeds read outside reactive contexts and actions. */
	computedRequiresReaction?: boolean;
	/** Warn about reactions that read no observables. */
	reactionRequiresObservable?: boolean;
	/** Warn about observables read outside reactive contexts and actions. */
	observableRequiresReaction?: boolean;
	/** Don't catch errors in reactions and computeds (for debugging). */
	disableErrorBoundaries?: boolean;
	/** Use this module's own state (it always does: every copy of the runtime has its own). */
	isolateGlobalState?: boolean;
	/** Members of classes can't be redefined, and actions not overwritten (default `true`). */
	safeDescriptors?: boolean;
	/** Runs the reactions at the end of each outermost batch. */
	reactionScheduler?: (run: () => void) => void;
}

const BOOLEANS = [
	"computedRequiresReaction",
	"reactionRequiresObservable",
	"observableRequiresReaction",
	"disableErrorBoundaries",
	"safeDescriptors",
] as const;

const KNOWN = new Set<string>([
	...BOOLEANS,
	"enforceActions",
	"isolateGlobalState",
	"reactionScheduler",
	"useProxies",
]);

/** Global settings, like MobX's `configure`. */
export function configure(options: ConfigureOptions): void {
	if (options.useProxies !== undefined) {
		globalState.useProxies = options.useProxies !== "never";
	}
	if (options.enforceActions !== undefined) {
		globalState.enforceActions = options.enforceActions;
		globalState.allowStateChanges = options.enforceActions === "never";
	}
	for (const key of BOOLEANS) {
		if (key in options) globalState[key] = !!options[key];
	}
	globalState.allowStateReads = !globalState.observableRequiresReaction;
	if (DEV && globalState.disableErrorBoundaries) {
		console.warn(
			"[sobx] WARNING: Debug feature only. MobX will NOT recover from errors when `disableErrorBoundaries` is enabled.",
		);
	}
	if (options.reactionScheduler) {
		const { reactionScheduler } = options;
		const base = globalState.reactionScheduler;
		globalState.reactionScheduler = (run) => reactionScheduler(() => base(run));
	}
	if (DEV) {
		for (const key of Object.keys(options)) {
			if (!KNOWN.has(key)) {
				console.warn(
					`[sobx] configure(): "${key}" is not supported by @sobx/runtime and is ignored.`,
				);
			}
		}
	}
}
