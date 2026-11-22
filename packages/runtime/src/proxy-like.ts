import { executeAction } from "./action.js";
import { Computed } from "./computed.js";
import {
	adopt,
	checkRead,
	checkWriteIf,
	DEV,
	Dep,
	debugName,
	globalState,
	type Owner,
	observableValues,
	release,
	reportChanged,
	reportObserved,
} from "./core.js";
import { enhance } from "./enhance.js";
import { report } from "./spy.js";

/** Options for {@link ProxyLike}. Emitted by the sobx compiler. */
export interface ProxyLikeOptions<T> {
	/** Getter keys: computeds, run with the `ProxyLike` as `this` (so their reads are tracked). */
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
	/** For debugging. */
	readonly name: string;
	/** Per-key dependency slots, created on first tracked read. */
	private deps: Map<keyof T, Dep> | undefined;
	private readonly getters: Map<keyof T, Computed<unknown>> | undefined;
	private readonly deep: boolean;
	/** Tracks the set of keys (`keys()`), created on first tracked use. */
	private keysDep: Dep | undefined;
	/** Per key: whether it exists (`has()`), changed only when the key is added or deleted. */
	private presenceDeps: Map<keyof T, Dep> | undefined;
	/** Per-key {@link Owner}s of the observable values held. */
	private keyOwners: Map<keyof T, Owner> | undefined;

	constructor(target: T, options?: ProxyLikeOptions<T>) {
		this.target = target;
		this.name = debugName("ObservableObject");
		observableValues.add(this);
		this.deep = options?.deep ?? true;
		if (this.deep) {
			const record = target as Record<keyof T, unknown>;
			for (const key of Object.keys(target) as Array<keyof T>) {
				// Data properties only: reading a getter here would run it with the wrong `this`.
				const value = Object.getOwnPropertyDescriptor(target, key)?.value;
				if (typeof value === "object" && value !== null) {
					const enhanced = enhance(value, true, this, key);
					record[key] = enhanced;
					adopt(enhanced, this.ownerFor(key));
				}
			}
		}
		if (options?.getters?.length) {
			this.getters = new Map();
			for (const key of options.getters) {
				this.getters.set(
					key,
					new Computed<unknown>(() => Reflect.get(this.target, key, this), {
						name: DEV ? `${this.name}.${String(key)}` : undefined,
					}),
				);
			}
		}
		if (options?.actions) {
			const record = target as Record<keyof T, unknown>;
			for (const key of options.actions) {
				const fn = record[key];
				if (typeof fn !== "function") continue;
				const name = DEV ? `${this.name}.${String(key)}` : String(key);
				record[key] = function (this: unknown, ...args: unknown[]) {
					return executeAction(name, true, fn as never, this, args);
				};
			}
		}
	}

	private observe(key: keyof T): void {
		this.deps ??= new Map();
		let dep = this.deps.get(key);
		if (!dep) {
			dep = new Dep(undefined, this, key);
			this.deps.set(key, dep);
		}
		reportObserved(dep);
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

	/** @internal Track the set of keys. */
	observeKeys(): void {
		if (globalState.tracking === null) return;
		this.keysDep ??= new Dep(undefined, this, "keys");
		reportObserved(this.keysDep);
	}

	/**
	 * The keys of the data properties (not getters or functions). Tracked: adding or deleting a key
	 * re-runs what read them.
	 */
	keys(): Array<keyof T & string> {
		this.observeKeys();
		const target = this.target as Record<string, unknown>;
		return Object.keys(target).filter(
			(key) =>
				!this.getters?.has(key as keyof T) && typeof target[key] !== "function",
		) as Array<keyof T & string>;
	}

	/**
	 * Whether `key` is a property. Tracked, including for keys that don't exist yet: re-runs
	 * what read it when the key is added or deleted (not when its value changes, as in MobX).
	 */
	has(key: keyof T): boolean {
		if (globalState.tracking !== null) {
			this.presenceDeps ??= new Map();
			let dep = this.presenceDeps.get(key);
			if (!dep) {
				dep = new Dep(undefined, `${this.name}.${String(key)}?`);
				this.presenceDeps.set(key, dep);
			}
			reportObserved(dep);
		}
		return Object.hasOwn(this.target, key);
	}

	/** Whether anything observes `key` (or, for added keys, its presence or the set of keys). */
	private keyObserved(key: keyof T, added: boolean): boolean {
		if ((this.deps?.get(key)?.observers.size ?? 0) > 0) return true;
		return (
			added &&
			((this.keysDep?.observers.size ?? 0) > 0 ||
				(this.presenceDeps?.get(key)?.observers.size ?? 0) > 0)
		);
	}

	/** Tell `has(key)` readers that `key` was added or deleted. */
	private presenceChanged(key: keyof T): void {
		const dep = this.presenceDeps?.get(key);
		if (dep) reportChanged(dep);
	}

	/** @internal The wrapped object (for `toJS`). */
	unwrap(): T {
		return this.target;
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
		const getter = this.getters?.get(key);
		if (getter !== undefined) return getter.get() as T[K];
		if (globalState.tracking !== null) this.observe(key);
		else if (DEV && !globalState.allowStateReads) checkRead(this, key);
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
		const next =
			this.deep &&
			((typeof value === "object" && value !== null) ||
				typeof value === "function")
				? enhance(value, true, this, key)
				: value;
		if (globalState.spying === 0) {
			this.write(key, next);
			return value;
		}
		const previous = this.target[key];
		if (Object.hasOwn(this.target, key) && Object.is(previous, next)) {
			return value;
		}
		const added = !Object.hasOwn(this.target, key);
		report(
			null,
			() => ({
				type: added ? "add" : "update",
				observableKind: "object",
				debugObjectName: this.name,
				object: this,
				...(added ? {} : { oldValue: previous }),
				name: key,
				newValue: next,
			}),
			() => this.write(key, next),
		);
		return value;
	}

	private write<K extends keyof T>(key: K, value: T[K]): void {
		const isNewKey = !Object.hasOwn(this.target, key);
		const previous = this.target[key];
		const dep = this.deps?.get(key);
		const changed = !Object.is(previous, value);
		if (DEV && (changed || isNewKey) && !globalState.allowStateChanges) {
			checkWriteIf(
				this.keyObserved(key, isNewKey),
				dep ?? `${this.name}.${String(key)}`,
			);
		}
		this.target[key] = value;
		if (previous !== value) {
			if (typeof previous === "object" && previous !== null) {
				release(previous, this.ownerFor(key));
			}
			if (typeof value === "object" && value !== null) {
				adopt(value, this.ownerFor(key));
			}
		}
		if (this.scopedObservers.size > 0) {
			this.scopedObservers.get(key)?.forEach((observer) => {
				observer(key, previous, value);
			});
		}
		if (this.globalObservers.size > 0) {
			this.globalObservers.forEach((observer) => {
				observer(key, previous, value);
			});
		}
		if (changed && dep) reportChanged(dep);
		if (isNewKey) {
			if (this.keysDep) reportChanged(this.keysDep);
			this.presenceChanged(key);
		}
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
		const previous = this.target[key];
		if (DEV && !globalState.allowStateChanges) {
			checkWriteIf(this.keyObserved(key, true), `${this.name}.${String(key)}`);
		}
		const allow = globalState.allowStateChanges;
		globalState.allowStateChanges = true; // checked above
		try {
			report(
				null,
				() => ({
					type: "remove",
					observableKind: "object",
					debugObjectName: this.name,
					object: this,
					oldValue: previous,
					name: key,
				}),
				() => {
					this.write(key, undefined as T[K]);
					delete this.target[key];
					if (this.keysDep) reportChanged(this.keysDep);
					this.presenceChanged(key);
				},
			);
		} finally {
			globalState.allowStateChanges = allow;
		}
		return true;
	}
}
