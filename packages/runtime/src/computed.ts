import {
	computedsChanged,
	Dep,
	type Derivation,
	type Equals,
	emptyTracking,
	globalState,
	rebind,
	reportObserved,
	type Tracking,
	track,
	type VersionedComputed,
} from "./core.js";

export interface ComputedOptions<T> {
	/** Decides whether a recomputed value counts as a change. Default `Object.is`. */
	equals?: (a: T, b: T) => boolean;
	/** For debugging; not used. */
	name?: string;
	/** Accepted for compatibility; computeds are always kept up to date while observed. */
	keepAlive?: boolean;
}

/** An error thrown by a computed's function, cached as its value (as MobX does). */
class CaughtException {
	constructor(readonly cause: unknown) {}
}

const FRESH = 0;
const MAYBE_STALE = 1;
const STALE = 2;

/**
 * A derived value. While something observes it, the value is cached and recomputed only when
 * a dependency changes; read outside any derivation, it is simply recomputed.
 */
export class Computed<T> implements Derivation, VersionedComputed {
	readonly dep = new Dep(this);
	version = 0;
	private tracking: Tracking = emptyTracking();
	private state = STALE;
	private active = false;
	private hasValue = false;
	private value: T | CaughtException | undefined;
	private readonly equals: Equals;

	constructor(
		private readonly fn: () => T,
		options: ComputedOptions<T> = {},
	) {
		this.equals = (options.equals as Equals | undefined) ?? Object.is;
	}

	get(): T {
		const outer = globalState.tracking;
		if (outer === null && !this.active) {
			// Nobody observes it: just compute (MobX does the same for unobserved computeds).
			return this.fn();
		}
		this.refresh();
		if (outer !== null) {
			reportObserved(this.dep);
			outer.versions ??= new Map();
			outer.versions.set(this, this.version);
		}
		// Rethrown to every reader, which still depends on the computed (and so re-runs when
		// what it read before throwing changes).
		if (this.value instanceof CaughtException) throw this.value.cause;
		return this.value as T;
	}

	/** @internal */
	refresh(): void {
		if (this.active && this.state === FRESH) return;
		if (
			this.active &&
			this.state === MAYBE_STALE &&
			!computedsChanged(this.tracking)
		) {
			this.state = FRESH;
			return;
		}
		const { value, tracking } = track(this, this.tracking, () => {
			try {
				return this.fn();
			} catch (error) {
				return new CaughtException(error);
			}
		});
		this.tracking = tracking;
		this.active = true;
		this.state = FRESH;
		if (
			!this.hasValue ||
			value instanceof CaughtException ||
			this.value instanceof CaughtException ||
			!this.equals(this.value, value)
		) {
			this.value = value;
			this.hasValue = true;
			this.version++;
		}
	}

	/** @internal */
	onChange(definite: boolean): void {
		const was = this.state;
		if (definite) this.state = STALE;
		else if (this.state === FRESH) this.state = MAYBE_STALE;
		if (was === FRESH) {
			for (const observer of [...this.dep.observers]) observer.onChange(false);
		}
	}

	/** @internal */
	suspend(): void {
		rebind(this, this.tracking, emptyTracking());
		this.tracking = emptyTracking();
		this.active = false;
		this.hasValue = false;
		this.value = undefined;
		this.state = STALE;
	}
}

/** Create a computed value: `computed(() => a.x * 2).get()`. */
export function createComputed<T>(
	fn: () => T,
	options?: ComputedOptions<T>,
): Computed<T> {
	return new Computed(fn, options);
}
