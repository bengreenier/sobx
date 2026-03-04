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
 * and notifies registered observers. This is significantly faster than using a native
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

	constructor(target: T) {
		this.target = target;
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
	get(key: keyof T) {
		return this.target[key];
	}

	/**
	 * Writes a value to a property and notifies all observers (global and key-scoped).
	 *
	 * @typeParam K - The property key type (narrowed from keyof T).
	 * @param key - The property key to set.
	 * @param value - The new value (must be assignable to T[K]).
	 */
	set<K extends keyof T>(key: K, value: T[K]): void {
		const previous = this.target[key];
		this.target[key] = value;

		this.scopedObservers.get(key)?.forEach((observer) => {
			observer(key, previous, value);
		});
		this.globalObservers.forEach((observer) => {
			observer(key, previous, value);
		});
	}
}
