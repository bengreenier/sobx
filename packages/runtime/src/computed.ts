import { createAction } from "./action.js";
import {
	allowStateChanges,
	computedsChanged,
	DEV,
	Dep,
	type Derivation,
	debugName,
	type Equals,
	emptyTracking,
	endBatch,
	globalState,
	logTrace,
	rebind,
	reportObserved,
	startBatch,
	type Tracking,
	track,
	type VersionedComputed,
} from "./core.js";
import {
	type ChangeListener,
	isSpying,
	type Lambda,
	spyReport,
} from "./spy.js";
import type { IComputedDidChange } from "./types.js";

export interface ComputedOptions<T> {
	/** Decides whether a recomputed value counts as a change. Default `Object.is`. */
	equals?: (a: T, b: T) => boolean;
	/** For debugging. */
	name?: string;
	/** Makes the computed settable: `computed.set(value)`. */
	set?: (value: T) => void;
	/** Keep the value cached when nothing observes it (it keeps its dependencies alive). */
	keepAlive?: boolean;
	/** `this` for the getter and setter. */
	context?: unknown;
	/** Warn when read outside reactive contexts and actions. */
	requiresReaction?: boolean;
}

declare const console: {
	warn(...args: unknown[]): void;
	log(...args: unknown[]): void;
};

/** An error thrown by a computed's function, cached as its value (as MobX does). */
class CaughtException {
	constructor(readonly cause: unknown) {}
}

const FRESH = 0;
const MAYBE_STALE = 1;
const STALE = 2;

/**
 * A derived value. While something observes it (and until the end of the batch it's read in), the
 * value is cached and recomputed only when a dependency changes; otherwise it's simply recomputed.
 */
export class Computed<T> implements Derivation, VersionedComputed {
	readonly name: string;
	readonly dep: Dep;
	version = 0;
	tracing: Derivation["tracing"] = null;
	private tracking: Tracking = emptyTracking();
	private state = STALE;
	private active = false;
	private computing = false;
	private runningSetter = false;
	private hasValue = false;
	private value: T | CaughtException | undefined;
	private readonly equals: Equals;
	private readonly setter: ((value: T) => void) | undefined;

	constructor(
		private readonly fn: () => T,
		private readonly options: ComputedOptions<T> = {},
		/** The object it's a property of (for spies). */
		private readonly scope: unknown = options.context,
	) {
		this.name =
			options.name || (DEV ? fn.name : "") || debugName("ComputedValue");
		this.dep = new Dep(this);
		this.equals = (options.equals as Equals | undefined) ?? Object.is;
		if (options.set) {
			this.setter = createAction(`${this.name}-setter`, options.set);
		}
	}

	get dependencies(): Iterable<Dep> {
		return new Set(this.tracking.deps);
	}

	get(): T {
		if (this.computing) {
			throw new Error(`sobx: Cycle detected in computation ${this.name}`);
		}
		const outer = globalState.tracking;
		if (
			globalState.batchDepth === 0 &&
			this.dep.observers.size === 0 &&
			!this.options.keepAlive
		) {
			if (DEV) this.warnUntracked();
			startBatch();
			try {
				const value = this.compute();
				if (value instanceof CaughtException) throw value.cause;
				return value;
			} finally {
				endBatch();
			}
		}
		startBatch();
		try {
			reportObserved(this.dep);
			this.refresh();
			if (outer !== null) {
				outer.versions ??= new Map();
				outer.versions.set(this, this.version);
			}
		} finally {
			endBatch();
		}
		// Rethrown to every reader, which still depends on the computed (and so re-runs when
		// what it read before throwing changes).
		if (this.value instanceof CaughtException) throw this.value.cause;
		return this.value as T;
	}

	set(value: T): void {
		if (!this.setter) {
			throw new Error(
				`sobx: [ComputedValue '${this.name}'] It is not possible to assign a new value to a computed value.`,
			);
		}
		if (this.runningSetter) {
			throw new Error(
				`sobx: The setter of computed value '${this.name}' is trying to update itself. Did you intend to update an _observable_ value, instead of the computed property?`,
			);
		}
		this.runningSetter = true;
		try {
			this.setter.call(this.scope, value);
		} finally {
			this.runningSetter = false;
		}
	}

	private compute(): T | CaughtException {
		this.computing = true;
		try {
			return allowStateChanges(false, () => {
				try {
					return this.fn.call(this.scope);
				} catch (error) {
					if (globalState.disableErrorBoundaries) throw error;
					return new CaughtException(error);
				}
			});
		} finally {
			this.computing = false;
		}
	}

	private warnUntracked(): void {
		if (this.tracing !== null) {
			console.log(
				`[sobx.trace] Computed value '${this.name}' is being read outside a reactive context. Doing a full recompute.`,
			);
		}
		if (this.options.requiresReaction ?? globalState.computedRequiresReaction) {
			console.warn(
				`[sobx] Computed value '${this.name}' is being read outside a reactive context. Doing a full recompute.`,
			);
		}
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
		const { value, tracking } = track(this, this.tracking, () =>
			this.compute(),
		);
		this.tracking = tracking;
		this.active = true;
		this.state = FRESH;
		const old = this.value;
		if (
			!this.hasValue ||
			value instanceof CaughtException ||
			old instanceof CaughtException ||
			!this.equals(old, value)
		) {
			this.value = value;
			this.hasValue = true;
			this.version++;
			if (isSpying()) {
				spyReport({
					observableKind: "computed",
					debugObjectName: this.name,
					object: this.scope,
					type: "update",
					oldValue: old instanceof CaughtException ? old.cause : old,
					newValue: value instanceof CaughtException ? value.cause : value,
				});
			}
		}
	}

	/** @internal */
	onChange(definite: boolean, dep: Dep): void {
		const was = this.state;
		if (definite) this.state = STALE;
		else if (this.state === FRESH) this.state = MAYBE_STALE;
		if (was === FRESH) {
			if (this.tracing !== null) logTrace(this, dep);
			for (const observer of [...this.dep.observers]) {
				observer.onChange(false, this.dep);
			}
		}
	}

	/** @internal */
	suspend(): void {
		if (this.options.keepAlive || !this.active) return;
		rebind(this, this.tracking, emptyTracking());
		this.tracking = emptyTracking();
		this.active = false;
		this.hasValue = false;
		this.value = undefined;
		this.state = STALE;
		if (this.tracing !== null) {
			console.log(
				`[sobx.trace] Computed value '${this.name}' was suspended and it will recompute on the next access.`,
			);
		}
	}

	/** `observe(computed, listener, fireImmediately?)`. Set by `reaction.ts`. */
	observe(
		listener: (change: IComputedDidChange<T>) => void,
		fireImmediately?: boolean,
	): Lambda {
		return observeComputed.impl(
			this as Computed<unknown>,
			listener as ChangeListener,
			fireImmediately,
		);
	}

	/** Log why it recomputes. */
	trace(enterBreakPoint = false): void {
		enableTrace(this, enterBreakPoint);
	}

	toJSON(): T {
		return this.get();
	}

	toString(): string {
		return this.name;
	}

	valueOf(): unknown {
		return toPrimitive(this.get());
	}

	[Symbol.toPrimitive](): unknown {
		return this.valueOf();
	}
}

/** `observe` on computeds runs an autorun; filled in by `reaction.ts`. */
export const observeComputed = {
	impl: (
		_computed: Computed<unknown>,
		_listener: ChangeListener,
		_fireImmediately?: boolean,
	): Lambda => {
		throw new Error("unreachable");
	},
};

export function enableTrace(derivation: Derivation, breakpoint: boolean): void {
	if (!DEV) return;
	if (derivation.tracing === null) {
		console.log(`[sobx.trace] '${derivation.name}' tracing enabled`);
	}
	derivation.tracing = breakpoint ? "break" : "log";
}

/** How MobX converts a box's or computed's value to a primitive. */
export function toPrimitive(value: unknown): unknown {
	return value === null ? null : typeof value === "object" ? `${value}` : value;
}

/** Create a computed value: `computed(() => a.x * 2).get()`. */
export function createComputed<T>(
	fn: () => T,
	options?: ComputedOptions<T>,
	scope?: unknown,
): Computed<T> {
	return new Computed(fn, options, scope);
}
