/** `when` and `flow`. */
import { createAction, executeAction } from "./action.js";
import { $mobx, allowStateChanges, debugName } from "./core.js";
import { type AbortSignalLike, autorun, type Disposer } from "./reaction.js";

export interface WhenOptions {
	/** Reject the promise form (or fail the effect form) after this many milliseconds. */
	timeout?: number;
	/** Called with errors (including the timeout), in the effect form. */
	onError?: (error: unknown) => void;
	/** For debugging. */
	name?: string;
	/** Stops waiting when aborted (the promise form rejects). */
	signal?: AbortSignalLike;
	/** Warn when nothing observable is read. */
	requiresObservable?: boolean;
}

/** The promise returned by `when(predicate)`, with `cancel()`. */
export interface CancellablePromise<T> extends Promise<T> {
	cancel(): void;
}

// The runtime targets any JS environment.
declare function setTimeout(fn: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/**
 * `when(predicate, effect, options?)`: once `predicate` returns true, run `effect` (as an action)
 * and stop. Returns a disposer.
 *
 * `when(predicate, options?)`: a promise that resolves once `predicate` returns true; it has
 * `cancel()`, and rejects after `options.timeout` milliseconds.
 */
export function when(
	predicate: () => boolean,
	effect: () => void,
	options?: WhenOptions,
): Disposer;
export function when(
	predicate: () => boolean,
	options?: WhenOptions,
): CancellablePromise<void>;
export function when(
	predicate: () => boolean,
	second?: (() => void) | WhenOptions,
	third?: WhenOptions,
): Disposer | CancellablePromise<void> {
	if (typeof second === "function") {
		return whenEffect(predicate, second, third ?? {});
	}
	return whenPromise(predicate, second ?? {});
}

function whenEffect(
	predicate: () => boolean,
	effect: () => void,
	options: WhenOptions,
): Disposer {
	let timer: unknown;
	if (typeof options.timeout === "number") {
		const error = new Error("WHEN_TIMEOUT");
		timer = setTimeout(() => {
			if (disposer[$mobx].isDisposed) return;
			disposer();
			if (options.onError) options.onError(error);
			else throw error;
		}, options.timeout);
	}
	const name = options.name ?? debugName("When");
	const run = createAction(`${name}-effect`, effect);
	const disposer = autorun(
		(r) => {
			if (!allowStateChanges(false, predicate)) return;
			r.dispose();
			if (timer !== undefined) clearTimeout(timer);
			run();
		},
		{
			name,
			onError: options.onError,
			requiresObservable: options.requiresObservable,
			signal: options.signal,
		},
	);
	return disposer;
}

function whenPromise(
	predicate: () => boolean,
	options: WhenOptions,
): CancellablePromise<void> {
	if (options.onError) {
		throw new Error(
			"sobx: the options 'onError' and 'promise' cannot be combined",
		);
	}
	const { signal } = options;
	if (signal?.aborted) {
		return Object.assign(Promise.reject(new Error("WHEN_ABORTED")), {
			cancel: () => {},
		});
	}
	let cancel: () => void = () => {};
	let abort: () => void = () => {};
	const promise = new Promise<void>((resolve, reject) => {
		const disposer = whenEffect(predicate, resolve as () => void, {
			...options,
			onError: reject,
		});
		cancel = () => {
			disposer();
			reject(new Error("WHEN_CANCELLED"));
		};
		abort = () => {
			disposer();
			reject(new Error("WHEN_ABORTED"));
		};
		signal?.addEventListener?.("abort", abort);
	}).finally(() =>
		signal?.removeEventListener?.("abort", abort),
	) as CancellablePromise<void>;
	promise.cancel = cancel;
	return promise;
}

/** The promise returned by a flow, with `cancel()`. */
export type FlowPromise<T> = CancellablePromise<T>;

/** Thrown into (and rejected by) a cancelled flow. */
export class FlowCancellationError extends Error {
	constructor() {
		super("FLOW_CANCELLED");
		this.name = "FlowCancellationError";
	}

	override toString(): string {
		return `Error: ${this.message}`;
	}
}

export function isFlowCancellationError(error: unknown): boolean {
	return error instanceof FlowCancellationError;
}

/** For typing the promise a flow returns: returns its argument. */
export function flowResult<T>(
	result: T,
): T extends Generator<unknown, infer R, unknown> ? FlowPromise<R> : T {
	return result as never;
}

/** Whether `fn` was created by `flow()` / a flow annotation. */
export function isFlow(fn: unknown): boolean {
	return (
		(fn as { isMobXFlow?: boolean } | null | undefined)?.isMobXFlow === true
	);
}

type AnyGenerator = Generator<unknown, unknown, unknown>;
type Step = IteratorResult<unknown, unknown>;

let flowId = 0;

const noop = () => {};

function cancelPromise(promise: unknown): void {
	const { cancel } = promise as { cancel?: unknown };
	if (typeof cancel === "function") cancel.call(promise);
}

/**
 * `flow(function* () {...})`: an async action written as a generator. Each step between
 * `yield`s runs as an action; `yield promise` waits for it. Calling the result returns a
 * promise with `cancel()`.
 */
export function createFlow<A extends unknown[], R>(
	generator: (...args: A) => Generator<unknown, R, unknown>,
	label = generator.name || "<unnamed flow>",
): (...args: A) => FlowPromise<R> {
	const wrapped = function (this: unknown, ...args: A): FlowPromise<R> {
		const id = ++flowId;
		const step = (what: string, value: unknown, fn: () => Step): Step =>
			executeAction(
				`${label} - runid: ${id} - ${what}`,
				false,
				fn as never,
				undefined,
				[value],
			);
		const gen = createAction(
			`${label} - runid: ${id} - init`,
			generator as never,
		).apply(this, args as never) as AnyGenerator;
		let rejectFlow: (error: unknown) => void = noop;
		let pending: Promise<unknown> | undefined;
		let yielded: unknown;
		const promise = new Promise<R>((resolve, reject) => {
			let count = 0;
			rejectFlow = reject;
			const onFulfilled = (value: unknown): void => {
				pending = undefined;
				let result: Step;
				try {
					result = step(`yield ${count++}`, value, () => gen.next(value));
				} catch (error) {
					reject(error);
					return;
				}
				next(result);
			};
			const onRejected = (error: unknown): void => {
				pending = undefined;
				let result: Step;
				try {
					result = step(`yield ${count++}`, error, () => gen.throw(error));
				} catch (e) {
					reject(e);
					return;
				}
				next(result);
			};
			const next = (result: Step): void => {
				const { then } = result as unknown as { then?: unknown };
				if (typeof then === "function") {
					// An async generator.
					then.call(result, next, reject);
					return;
				}
				if (result.done) {
					resolve(result.value as R);
					return;
				}
				pending = Promise.resolve(result.value);
				// Keep what was yielded, for cancel().
				yielded = result.value;
				pending.then(onFulfilled, onRejected);
			};
			onFulfilled(undefined);
		}) as FlowPromise<R>;
		promise.cancel = createAction(`${label} - runid: ${id} - cancel`, () => {
			try {
				if (pending) cancelPromise(yielded ?? pending);
				// Finally blocks may yield something more to cancel.
				const result = gen.return(undefined) as Step;
				const last = Promise.resolve(result.value);
				last.then(noop, noop);
				pending = last;
				cancelPromise(result.value ?? last);
				rejectFlow(new FlowCancellationError());
			} catch (error) {
				rejectFlow(error);
			}
		});
		return promise;
	};
	Object.defineProperty(wrapped, "name", { value: label, configurable: true });
	return markFlow(wrapped);
}

/** `fn` is (bound from) a flow. */
export function markFlow<F extends object>(fn: F): F {
	return Object.defineProperty(fn, "isMobXFlow", { value: true });
}
