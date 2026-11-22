import { executeAction, isAction, NO_ARGS } from "./action.js";
import { type Computed, enableTrace, observeComputed } from "./computed.js";
import {
	$mobx,
	computedsChanged,
	DEV,
	type Dep,
	type Derivation,
	debugName,
	type Equals,
	emptyTracking,
	endBatch,
	globalState,
	logTrace,
	now,
	rebind,
	runReactions,
	schedule,
	startBatch,
	type Tracking,
	trackOnly,
	untracked,
} from "./core.js";
import { isPlainObject } from "./enhance.js";
import { isSpying, spyReport, spyReportEnd, spyReportStart } from "./spy.js";

// The runtime targets any JS environment.
declare const console: {
	error(...args: unknown[]): void;
	warn(...args: unknown[]): void;
};
declare function setTimeout(fn: () => void, ms: number): unknown;

const FRESH = 0;
const MAYBE_STALE = 1;
const STALE = 2;
const NO_ERROR = Symbol("no error");

/** An `AbortSignal` (as much of it as is used). */
export interface AbortSignalLike {
	readonly aborted: boolean;
	addEventListener?(type: "abort", listener: () => void): void;
	removeEventListener?(type: "abort", listener: () => void): void;
}

/** Disposer returned by {@link reaction} / {@link autorun}. */
export interface Disposer {
	(): void;
	/** The underlying reaction. */
	[$mobx]: Reaction;
	/** The underlying reaction. */
	$reaction: Reaction;
}

/** A running reaction or autorun. `onInvalidate` is called when what it tracked changed. */
export class Reaction implements Derivation {
	readonly name: string;
	tracing: Derivation["tracing"] = null;
	private tracking: Tracking = emptyTracking();
	private state = STALE;
	private disposed = false;
	private scheduled = false;
	private running = false;
	/** What {@link track} runs, and what it threw (here, so that runs allocate no closures). */
	private body: () => void = () => {};
	private error: unknown = NO_ERROR;
	private readonly runBody = () => {
		try {
			this.body();
		} catch (error) {
			if (globalState.disableErrorBoundaries) throw error;
			this.error = error;
		}
	};

	constructor(
		name: string = debugName("Reaction"),
		private readonly onInvalidate: (this: Reaction) => void = () => {},
		private readonly errorHandler?: (
			error: unknown,
			reaction: Reaction,
		) => void,
		readonly requiresObservable?: boolean,
	) {
		this.name = name;
	}

	get dependencies(): Iterable<Dep> {
		return new Set(this.tracking.deps);
	}

	/** Whether it will run at the end of the batch. */
	get isScheduled(): boolean {
		return this.scheduled;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	/** @internal */
	onChange(definite: boolean, dep: Dep): void {
		const was = this.state;
		if (definite) this.state = STALE;
		else if (this.state === FRESH) this.state = MAYBE_STALE;
		// Already invalidated: nothing new until it tracks again.
		if (was === STALE) return;
		if (definite && this.tracing !== null) logTrace(this, dep);
		this.enqueue();
	}

	private enqueue(): void {
		if (this.scheduled || this.disposed) return;
		this.scheduled = true;
		schedule(this);
	}

	/** Run it (at the end of the batch, if in one). */
	schedule(): void {
		this.enqueue();
		runReactions();
	}

	/** @internal */
	runScheduled(): void {
		if (this.disposed) return;
		startBatch();
		this.scheduled = false;
		const context = globalState.trackingContext;
		globalState.trackingContext = this;
		try {
			if (this.shouldRun()) {
				try {
					this.onInvalidate();
					if (isSpying() && this.state !== FRESH) {
						spyReport({ name: this.name, type: "scheduled-reaction" });
					}
				} catch (error) {
					this.report(error);
				}
			}
		} finally {
			globalState.trackingContext = context;
			endBatch();
		}
	}

	private shouldRun(): boolean {
		if (this.state === FRESH) return false;
		if (this.state === MAYBE_STALE && !computedsChanged(this.tracking, this)) {
			this.state = FRESH;
			return false;
		}
		this.state = STALE;
		return true;
	}

	/** Run `fn`, tracking what it reads as this reaction's dependencies. Errors are reported. */
	track(fn: () => void): void {
		if (this.disposed) return;
		const spied = isSpying();
		const startTime = spied ? now() : 0;
		startBatch();
		if (spied) spyReportStart({ name: this.name, type: "reaction" });
		const context = globalState.trackingContext;
		globalState.trackingContext = this;
		this.running = true;
		const body = this.body;
		this.body = fn;
		let error: unknown = NO_ERROR;
		try {
			this.state = FRESH;
			// Keep what was read before an error: it is subscribed, and must be released later.
			this.tracking = trackOnly(this, this.tracking, this.runBody);
		} finally {
			error = this.error;
			this.error = NO_ERROR;
			this.body = body;
			this.running = false;
			globalState.trackingContext = context;
			if (this.disposed) this.release();
			if (error !== NO_ERROR) this.report(error);
			if (spied) spyReportEnd({ time: now() - startTime });
			endBatch();
		}
	}

	private report(error: unknown): void {
		if (this.errorHandler) {
			this.errorHandler(error, this);
			return;
		}
		if (globalState.disableErrorBoundaries) throw error;
		const message = DEV
			? `[sobx] Encountered an uncaught exception that was thrown by a reaction or observer component, in: '${this}'`
			: `[sobx] uncaught error in '${this}'`;
		if (!globalState.suppressReactionErrors) console.error(message, error);
		else if (DEV) {
			console.warn(
				`[sobx] (error in reaction '${this.name}' suppressed, fix error of causing action below)`,
			);
		}
		if (isSpying()) {
			spyReport({
				type: "error",
				name: this.name,
				message,
				error: `${error}`,
			});
		}
		for (const handler of globalState.reactionErrorHandlers) {
			handler(error, this);
		}
	}

	private release(): void {
		rebind(this, this.tracking, emptyTracking());
		this.tracking = emptyTracking();
	}

	/** Stop the reaction. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		// While running, it's released at the end of the run.
		if (this.running) return;
		startBatch();
		this.release();
		endBatch();
	}

	/** A function that disposes it (also when `signal` is aborted). */
	getDisposer(signal?: AbortSignalLike): Disposer {
		const dispose = function dispose() {
			self.dispose();
			signal?.removeEventListener?.("abort", dispose);
		} as Disposer;
		const self = this;
		signal?.addEventListener?.("abort", dispose);
		dispose[$mobx] = this;
		dispose.$reaction = this;
		const symbol = (Symbol as { dispose?: symbol }).dispose;
		if (symbol)
			(dispose as unknown as Record<symbol, unknown>)[symbol] = dispose;
		return dispose;
	}

	/** Log why it runs. */
	trace(enterBreakPoint = false): void {
		enableTrace(this, enterBreakPoint);
	}

	toString(): string {
		return `Reaction[${this.name}]`;
	}
}

/** `onReactionError(handler)`: be told about errors thrown in reactions. */
export function onReactionError(
	handler: (error: unknown, reaction: unknown) => void,
): () => void {
	globalState.reactionErrorHandlers.push(handler);
	return () => {
		const i = globalState.reactionErrorHandlers.indexOf(handler);
		if (i >= 0) globalState.reactionErrorHandlers.splice(i, 1);
	};
}

export interface AutorunOptions {
	/** For debugging. */
	name?: string;
	/** Run at most once every `delay` milliseconds. */
	delay?: number;
	/** Schedules each run. */
	scheduler?: (run: () => void) => unknown;
	/** Handles errors instead of logging them. */
	onError?: (error: unknown) => void;
	/** Warn when nothing observable is read. */
	requiresObservable?: boolean;
	/** Dispose it when aborted. */
	signal?: AbortSignalLike;
}

export interface ReactionOptions<T> extends AutorunOptions {
	/** Run the effect immediately with the first value. Default `false`. */
	fireImmediately?: boolean;
	/** Decides whether a new value counts as a change. Default `Object.is`. */
	equals?: (a: T, b: T) => boolean;
}

function schedulerOf(options: AutorunOptions): (run: () => void) => unknown {
	if (options.scheduler) return options.scheduler;
	const { delay } = options;
	return delay ? (run) => setTimeout(run, delay) : (run) => run();
}

/**
 * Run `data` (tracked); whenever what it read changes, run it again, and if its result
 * changed, run `effect(next, previous)` (as an action).
 */
export function reaction<T, FireImmediately extends boolean = false>(
	data: (r: Reaction) => T,
	effect: (
		value: T,
		previous: FireImmediately extends true ? T | undefined : T,
		r: Reaction,
	) => void,
	options: ReactionOptions<T> & { fireImmediately?: FireImmediately } = {},
): Disposer {
	if (DEV) {
		if (typeof data !== "function" || typeof effect !== "function") {
			throw new Error(
				"sobx: First and second argument to `reaction` should be functions",
			);
		}
		if (!isPlainObject(options)) {
			throw new Error(
				"sobx: Third argument of `reactions` should be an object",
			);
		}
	}
	const name = options.name ?? debugName("Reaction");
	const { onError } = options;
	type Effect = (value: T, previous: T | undefined, r: Reaction) => void;
	const runEffect = onError
		? (value: T, previous: T | undefined, r: Reaction) => {
				try {
					(effect as Effect)(value, previous, r);
				} catch (error) {
					onError(error);
				}
			}
		: (effect as Effect);
	const runSync = !options.scheduler && !options.delay;
	const scheduler = schedulerOf(options);
	const equals = (options.equals as Equals | undefined) ?? Object.is;
	let first = true;
	let scheduled = false;
	let value: T | undefined;
	let previous: T | undefined;
	const effectBody = () => runEffect(value as T, previous, r);
	const r = new Reaction(
		name,
		() => {
			if (first || runSync) {
				runner();
			} else if (!scheduled) {
				scheduled = true;
				scheduler(runner);
			}
		},
		onError,
		options.requiresObservable,
	);
	let changed = false;
	const view = () => {
		const allowed = globalState.allowStateChanges;
		globalState.allowStateChanges = false;
		let next: T;
		try {
			next = data(r);
		} finally {
			globalState.allowStateChanges = allowed;
		}
		changed = first || !equals(value, next);
		value = next;
	};
	function runner(): void {
		scheduled = false;
		if (r.isDisposed) return;
		changed = false;
		previous = value;
		r.track(view);
		if (first ? options.fireImmediately : changed) {
			const args = globalState.spying === 0 ? NO_ARGS : [value, previous, r];
			executeAction(name, false, effectBody, undefined, args);
		}
		previous = undefined;
		first = false;
	}
	if (!options.signal?.aborted) r.schedule();
	return r.getDisposer(options.signal);
}

/** Run `fn` now, and again whenever anything it read changes. */
export function autorun(
	fn: (r: Reaction) => void,
	options: AutorunOptions = {},
): Disposer {
	if (DEV) {
		if (typeof fn !== "function") {
			throw new Error("sobx: Autorun expects a function as first argument");
		}
		if (isAction(fn)) {
			throw new Error(
				"sobx: Autorun does not accept actions since actions are untrackable",
			);
		}
	}
	const name =
		options.name ?? (DEV ? fn.name || debugName("Autorun") : "Autorun");
	const runSync = !options.scheduler && !options.delay;
	let r: Reaction;
	const view = () => fn(r);
	if (runSync) {
		r = new Reaction(
			name,
			function () {
				this.track(view);
			},
			options.onError,
			options.requiresObservable,
		);
	} else {
		const scheduler = schedulerOf(options);
		let scheduled = false;
		r = new Reaction(
			name,
			() => {
				if (scheduled) return;
				scheduled = true;
				scheduler(() => {
					scheduled = false;
					if (!r.isDisposed) r.track(view);
				});
			},
			options.onError,
			options.requiresObservable,
		);
	}
	if (!options.signal?.aborted) r.schedule();
	return r.getDisposer(options.signal);
}

observeComputed.impl = (
	computed: Computed<unknown>,
	listener,
	fireImmediately,
) => {
	let first = true;
	let previous: unknown;
	return autorun(() => {
		const value = computed.get();
		if (!first || fireImmediately) {
			untracked(() =>
				listener({
					observableKind: "computed",
					debugObjectName: computed.name,
					type: "update",
					object: computed,
					newValue: value,
					oldValue: previous,
				}),
			);
		}
		first = false;
		previous = value;
	});
};
