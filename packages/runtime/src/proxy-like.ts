import { enhance } from "./collections.js";
import {
	adopt,
	checkWrite,
	Dep,
	type Equals,
	globalState,
	type Owner,
	observableValues,
	release,
	reportChanged,
	runAction,
} from "./core.js";

/** Options for {@link ProxyLike}. Emitted by the sobx compiler. */
export interface ProxyLikeOptions<T> {
	/** Getter keys; they run with the `ProxyLike` as `this` (so their reads are tracked). */
	getters?: Array<keyof T>;
	/** Function-valued keys to wrap as actions: their writes are batched. */
	actions?: Array<keyof T>;
	/** Make values observable (plain objects, arrays, Maps, Sets), like MobX's deep observables. Default `true`. */
	deep?: boolean;
}

/**
 * Callback invoked when an observed property changes on a {@link ProxyLike} instance.
 *
 * @typeParam T - The type of the observed object.
 * @param key - The property key that changed.
 * @param previous - The value before the change.
 * @param current - The value after the change.
 */
export type ProxyLikeObserver<T extends object> = <K extends keyof T>(
	key: K,
	previous: T[K],
	current: T[K],
) => void;

/**
 * Handle returned when registering an observer. Call {@link ProxyLikeObserverHandle.dispose}
 * to stop receiving change notifications and allow cleanup.
 */
export interface ProxyLikeObserverHandle {
	/** Stops observing and removes the observer from the proxy. */
	dispose(): void;
}

/**
 * Provides an observable proxy-like interface for an object.
 *
 * Tracks property changes via explicit {@link ProxyLike.get} / {@link ProxyLike.set} calls
 * and notifies registered observers. Reads made while a computed or reaction runs are
 * tracked as its dependencies, and writes that change a value re-run those derivations. This is significantly faster than using a native
 * {@link Proxy} because it avoids trap overhead, but requires you to use the get/set
 * methods instead of direct property access.
 *
 * @typeParam T - The type of the wrapped object (must be an object type).
 *
 * @example
 * ```ts
 * const state = { count: 0 };
 * const proxy = new ProxyLike(state);
 * proxy.addObserver((key, prev, curr) => console.log(`${String(key)}: ${prev} -> ${curr}`));
 * proxy.set('count', 1); // logs: count: 0 -> 1
 * ```
 */
export class ProxyLike<T extends object> {
	// Note: Since the whole point of this class is to be fast, we defer to linter exceptions as opposed to strict type checks.
	// This means you should be a bit more careful when editing this implementation.

	private readonly globalObservers: Set<ProxyLikeObserver<T>> = new Set();
	private readonly scopedObservers: Map<keyof T, Set<ProxyLikeObserver<T>>> =
		new Map();

	protected readonly target: T;
	/** Per-key dependency slots, created on first tracked read. */
	private deps: Map<keyof T, Dep> | undefined;
	private readonly getters: Set<keyof T> | undefined;
	/** Per-key equality (`observable.struct`); `Object.is` otherwise. */
	private equalsByKey: Map<keyof T, Equals> | undefined;
	private readonly deep: boolean;
	/** Tracks the set of keys (`keys()`), created on first tracked use. */
	private keysDep: Dep | undefined;
	/** Per-key {@link Owner}s of the observable values held. */
	private keyOwners: Map<keyof T, Owner> | undefined;

	constructor(target: T, options?: ProxyLikeOptions<T>) {
		this.target = target;
		observableValues.add(this);
		this.deep = options?.deep ?? true;
		if (this.deep) {
			const record = target as Record<keyof T, unknown>;
			for (const key of Object.keys(target) as Array<keyof T>) {
				// Data properties only: reading a getter here would run it with the wrong `this`.
				const value = Object.getOwnPropertyDescriptor(target, key)?.value;
				if (typeof value === "object" && value !== null) {
					const enhanced = enhance(value);
					record[key] = enhanced;
					adopt(enhanced, this.ownerFor(key));
				}
			}
		}
		if (options?.getters?.length) this.getters = new Set(options.getters);
		if (options?.actions) {
			const record = target as Record<keyof T, unknown>;
			for (const key of options.actions) {
				const fn = record[key];
				if (typeof fn !== "function") continue;
				record[key] = function (this: unknown, ...args: unknown[]) {
					// Like a MobX auto-action: batched and allowed to change state, still tracked.
					return runAction(() => fn.apply(this, args), false);
				};
			}
		}
	}

	private observe(key: keyof T): void {
		this.deps ??= new Map();
		let dep = this.deps.get(key);
		if (!dep) {
			dep = new Dep();
			this.deps.set(key, dep);
		}
		// biome-ignore lint/style/noNonNullAssertion: only called while tracking
		globalState.tracking!.deps.add(dep);
	}

	/** The {@link Owner} for values held under `key`: notifies `key`'s readers. */
	private ownerFor(key: keyof T): Owner {
		this.keyOwners ??= new Map();
		let owner = this.keyOwners.get(key);
		if (!owner) {
			owner = {
				ownerChanged: () => {
					const dep = this.deps?.get(key);
					if (dep) reportChanged(dep);
				},
				ownerObserved: () => (this.deps?.get(key)?.observers.size ?? 0) > 0,
			};
			this.keyOwners.set(key, owner);
		}
		return owner;
	}

	/** Track the set of keys (for `keys()` / `has()` on keys added later). */
	private observeKeys(): void {
		this.keysDep ??= new Dep();
		globalState.tracking?.deps.add(this.keysDep);
	}

	/**
	 * The keys of the data properties (not getters or functions). Tracked: adding or deleting a key
	 * re-runs what read them.
	 */
	keys(): Array<keyof T & string> {
		if (globalState.tracking !== null) this.observeKeys();
		const target = this.target as Record<string, unknown>;
		return Object.keys(target).filter(
			(key) =>
				!this.getters?.has(key as keyof T) && typeof target[key] !== "function",
		) as Array<keyof T & string>;
	}

	/** Whether `key` is a property. Tracked, including for keys that don't exist yet. */
	has(key: keyof T): boolean {
		if (globalState.tracking !== null) this.observe(key);
		return Object.hasOwn(this.target, key);
	}

	/** @internal Use `equals` instead of `Object.is` to decide whether `key` changed. */
	setEquals(key: keyof T, equals: Equals): void {
		this.equalsByKey ??= new Map();
		this.equalsByKey.set(key, equals);
	}

	/** @internal The wrapped object (for `toJS`). */
	unwrap(): T {
		return this.target;
	}

	/** @internal Set an initial value without notifying anyone. */
	init(key: keyof T, value: T[keyof T]): void {
		this.target[key] = value;
		adopt(value, this.ownerFor(key));
	}

	/**
	 * Registers an observer that is notified when any property changes.
	 *
	 * @param observer - Callback invoked with (key, previousValue, currentValue) on any change.
	 * @returns A handle whose {@link ProxyLikeObserverHandle.dispose} unregisters the observer.
	 */
	addObserver(observer: ProxyLikeObserver<T>): ProxyLikeObserverHandle;
	/**
	 * Registers an observer that is notified only when the given property changes.
	 *
	 * @param key - The property to observe.
	 * @param observer - Callback invoked with (key, previousValue, currentValue) when that property changes.
	 * @returns A handle whose {@link ProxyLikeObserverHandle.dispose} unregisters the observer.
	 */
	addObserver(
		key: keyof T,
		observer: ProxyLikeObserver<T>,
	): ProxyLikeObserverHandle;
	addObserver(
		key: keyof T | ProxyLikeObserver<T>,
		observer?: ProxyLikeObserver<T>,
	): ProxyLikeObserverHandle {
		const observerFn = typeof key === "function" ? key : observer;
		const observerKey = typeof key === "function" ? undefined : key;

		if (observerKey) {
			if (!this.scopedObservers.has(observerKey)) {
				this.scopedObservers.set(observerKey, new Set());
			}

			// biome-ignore lint/style/noNonNullAssertion: we know these are both defined because of the method signatures
			this.scopedObservers.get(observerKey)!.add(observerFn!);

			const ref = new WeakRef(this);

			return {
				dispose: () =>
					// biome-ignore lint/style/noNonNullAssertion: we know observerFn is defined because of the method signatures
					ref.deref()?.scopedObservers.get(observerKey)?.delete(observerFn!),
			};
		} else {
			// biome-ignore lint/style/noNonNullAssertion: we know observerFn is defined because of the method signatures
			this.globalObservers.add(observerFn!);

			const ref = new WeakRef(this);

			return {
				// biome-ignore lint/style/noNonNullAssertion: we know observerFn is defined because of the method signatures
				dispose: () => ref.deref()?.globalObservers.delete(observerFn!),
			};
		}
	}

	/**
	 * Reads the current value of a property from the wrapped object.
	 *
	 * @param key - The property key to read.
	 * @returns The current value of that property.
	 */
	get<K extends keyof T>(key: K): T[K] {
		if (globalState.tracking !== null) this.observe(key);
		if (this.getters?.has(key)) return Reflect.get(this.target, key, this);
		return this.target[key];
	}

	/**
	 * Writes a value to a property and notifies all observers (global and key-scoped).
	 *
	 * @typeParam K - The property key type (narrowed from keyof T).
	 * @param key - The property key to set.
	 * @param value - The new value (must be assignable to T[K]).
	 * @returns `value`, so compiled assignment expressions keep their value.
	 */
	set<K extends keyof T>(key: K, value: T[K]): T[K] {
		if (this.deep && typeof value === "object" && value !== null) {
			value = enhance(value);
		}
		const isNewKey =
			this.keysDep !== undefined && !Object.hasOwn(this.target, key);
		const previous = this.target[key];
		this.target[key] = value;
		if (previous !== value) {
			if (typeof previous === "object" && previous !== null) {
				release(previous, this.ownerFor(key));
			}
			if (typeof value === "object" && value !== null) {
				adopt(value, this.ownerFor(key));
			}
		}

		this.scopedObservers.get(key)?.forEach((observer) => {
			observer(key, previous, value);
		});
		this.globalObservers.forEach((observer) => {
			observer(key, previous, value);
		});

		const dep = this.deps?.get(key);
		const equals = this.equalsByKey?.get(key) ?? Object.is;
		if (!equals(previous, value)) {
			checkWrite(dep, String(key));
			if (dep) reportChanged(dep);
		}
		if (isNewKey) reportChanged(this.keysDep as Dep);
		return value;
	}

	/**
	 * Adds `delta` to a numeric property, like `++` / `--`.
	 *
	 * @returns The new value when `prefix`, otherwise the previous one.
	 */
	update<K extends keyof T>(key: K, delta: 1 | -1, prefix: boolean): unknown {
		const previous = this.get(key) as unknown as number | bigint;
		const next =
			typeof previous === "bigint"
				? previous + BigInt(delta)
				: Number(previous) + delta;
		this.set(key, next as T[K]);
		return prefix ? next : typeof previous === "bigint" ? previous : +previous;
	}

	/** Deletes a property and notifies observers, like `delete target[key]`. */
	delete<K extends keyof T>(key: K): boolean {
		if (!Object.hasOwn(this.target, key)) return true;
		this.set(key, undefined as T[K]);
		const deleted = delete this.target[key];
		if (this.keysDep) reportChanged(this.keysDep);
		return deleted;
	}
}
