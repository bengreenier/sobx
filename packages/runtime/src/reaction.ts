import {
	batch,
	computedsChanged,
	type Derivation,
	type Equals,
	emptyTracking,
	endBatch,
	rebind,
	schedule,
	startBatch,
	type Tracking,
	track,
	untracked,
} from "./core.js";

// The runtime targets any JS environment; only `console.error` is needed.
declare const console: { error(...args: unknown[]): void };

const FRESH = 0;
const MAYBE_STALE = 1;
const STALE = 2;

/** A running reaction or autorun. */
export class Reaction implements Derivation {
	private tracking: Tracking = emptyTracking();
	private state = FRESH;
	private disposed = false;

	constructor(private readonly run: (reaction: Reaction) => void) {}

	/** @internal */
	onChange(definite: boolean): void {
		if (this.disposed) return;
		const was = this.state;
		if (definite) this.state = STALE;
		else if (this.state === FRESH) this.state = MAYBE_STALE;
		if (was === FRESH) schedule(this);
	}

	/** @internal */
	runScheduled(): void {
		if (this.disposed || this.state === FRESH) return;
		if (this.state === MAYBE_STALE && !computedsChanged(this.tracking)) {
			this.state = FRESH;
			return;
		}
		this.state = FRESH;
		this.execute();
	}

	/** @internal Run once (initially, or when scheduled). Errors are reported, not thrown. */
	execute(): void {
		startBatch();
		try {
			this.run(this);
		} catch (error) {
			console.error("[sobx] uncaught error in reaction:", error);
		} finally {
			endBatch();
		}
	}

	/** @internal Run `fn`, tracking what it reads as this reaction's dependencies. */
	track<T>(fn: () => T): T {
		const { value, tracking } = track(this, this.tracking, fn);
		this.tracking = tracking;
		return value;
	}

	/** Stop the reaction. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		rebind(this, this.tracking, emptyTracking());
		this.tracking = emptyTracking();
	}
}

/** Disposer returned by {@link reaction} / {@link autorun}. */
export interface Disposer {
	(): void;
	/** The underlying reaction. */
	$reaction: Reaction;
}

function disposer(r: Reaction): Disposer {
	const dispose = (() => r.dispose()) as Disposer;
	dispose.$reaction = r;
	return dispose;
}

export interface ReactionOptions<T> {
	/** Run the effect immediately with the first value. Default `false`. */
	fireImmediately?: boolean;
	/** Decides whether a new value counts as a change. Default `Object.is`. */
	equals?: (a: T, b: T) => boolean;
	/** For debugging; not used. */
	name?: string;
}

/**
 * Run `data` (tracked); whenever what it read changes, run it again, and if its result
 * changed, run `effect(next, previous)` (untracked, batched).
 */
export function reaction<T>(
	data: (r: Reaction) => T,
	effect: (value: T, previous: T | undefined, r: Reaction) => void,
	options: ReactionOptions<T> = {},
): Disposer {
	const equals = (options.equals as Equals | undefined) ?? Object.is;
	let first = true;
	let value: T | undefined;
	const r = new Reaction((self) => {
		const next = self.track(() => data(self));
		if (first) {
			first = false;
			value = next;
			if (options.fireImmediately)
				runAsAction(() => effect(next, undefined, self));
			return;
		}
		if (equals(value, next)) return;
		const previous = value;
		value = next;
		runAsAction(() => effect(next, previous, self));
	});
	r.execute();
	return disposer(r);
}

export interface AutorunOptions {
	/** For debugging; not used. */
	name?: string;
}

/** Run `fn` now, and again whenever anything it read changes. */
export function autorun(
	fn: (r: Reaction) => void,
	_options: AutorunOptions = {},
): Disposer {
	const r = new Reaction((self) => self.track(() => fn(self)));
	r.execute();
	return disposer(r);
}

/** Untracked and batched, like a MobX action. */
export function runAsAction<T>(fn: () => T): T {
	return batch(() => untracked(fn));
}
