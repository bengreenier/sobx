/** `when` and `flow`. */
import { endBatch, globalState, startBatch } from "./core.js";
import { type Disposer, Reaction, runAsAction } from "./reaction.js";

export interface WhenOptions {
	/** Reject the promise form (or dispose the effect form) after this many milliseconds. */
	timeout?: number;
	/** For debugging; not used. */
	name?: string;
}

/** The promise returned by `when(predicate)`, with `cancel()`. */
export interface CancellablePromise<T> extends Promise<T> {
	cancel(): void;
}

// The runtime targets any JS environment.
declare function setTimeout(fn: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/**
 * `when(predicate, effect, options?)`: once `predicate` returns true, run `effect` (untracked,
 * batched) and stop. Returns a disposer.
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
		return whenEffect(predicate, second, third ?? {}).dispose;
	}
	const options = second ?? {};
	let cancel: () => void = () => {};
	const promise = new Promise<void>((resolve, reject) => {
		const { dispose } = whenEffect(predicate, resolve, options, (error) => {
			reject(error);
		});
		cancel = () => {
			dispose();
			reject(new Error("WHEN_CANCELLED"));
		};
	}) as CancellablePromise<void>;
	promise.cancel = () => cancel();
	return promise;
}

function whenEffect(
	predicate: () => boolean,
	effect: () => void,
	options: WhenOptions,
	onTimeout?: (error: Error) => void,
): { dispose: Disposer } {
	let done = false;
	let timer: unknown;
	const r = new Reaction((self) => {
		if (done) return;
		if (!self.track(predicate)) return;
		done = true;
		if (timer !== undefined) clearTimeout(timer);
		self.dispose();
		runAsAction(effect);
	});
	const dispose = (() => {
		done = true;
		if (timer !== undefined) clearTimeout(timer);
		r.dispose();
	}) as Disposer;
	dispose.$reaction = r;
	if (options.timeout !== undefined) {
		timer = setTimeout(() => {
			if (done) return;
			dispose();
			const error = new Error("WHEN_TIMEOUT");
			if (onTimeout) onTimeout(error);
			else throw error;
		}, options.timeout);
	}
	r.execute();
	return { dispose };
}

/** The promise returned by a flow, with `cancel()`. */
export type FlowPromise<T> = CancellablePromise<T>;

/** Thrown into (and rejected by) a cancelled flow. */
export class FlowCancellationError extends Error {
	constructor() {
		super("FLOW_CANCELLED");
		this.name = "FlowCancellationError";
	}
}

export function isFlowCancellationError(error: unknown): boolean {
	return error instanceof FlowCancellationError;
}

type AnyGenerator = Generator<unknown, unknown, unknown>;

/** Run one generator step as an action (batched, untracked). */
function step(fn: () => IteratorResult<unknown, unknown>) {
	startBatch();
	const outer = globalState.tracking;
	globalState.tracking = null;
	try {
		return fn();
	} finally {
		globalState.tracking = outer;
		endBatch();
	}
}

/**
 * `flow(function* () {...})`: an async action written as a generator. Each step between
 * `yield`s runs as an action; `yield promise` waits for it. Calling the result returns a
 * promise with `cancel()`.
 */
export function createFlow<A extends unknown[], R>(
	generator: (...args: A) => Generator<unknown, R, unknown>,
): (...args: A) => FlowPromise<R> {
	return function (this: unknown, ...args: A): FlowPromise<R> {
		const gen = generator.apply(this, args) as AnyGenerator;
		let rejectFlow: (error: unknown) => void = () => {};
		let finished = false;
		const promise = new Promise<R>((resolve, reject) => {
			rejectFlow = reject;
			const advance = (method: "next" | "throw", value: unknown): void => {
				if (finished) return;
				let result: IteratorResult<unknown, unknown>;
				try {
					result = step(() =>
						method === "next" ? gen.next(value) : gen.throw(value),
					);
				} catch (error) {
					finished = true;
					reject(error);
					return;
				}
				if (result.done) {
					finished = true;
					resolve(result.value as R);
					return;
				}
				Promise.resolve(result.value).then(
					(v) => advance("next", v),
					(e) => advance("throw", e),
				);
			};
			advance("next", undefined);
		}) as FlowPromise<R>;
		promise.cancel = () => {
			if (finished) return;
			finished = true;
			try {
				step(() => gen.return(undefined));
			} finally {
				rejectFlow(new FlowCancellationError());
			}
		};
		return promise;
	};
}
