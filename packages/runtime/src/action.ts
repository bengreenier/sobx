/** Actions: batched, untracked, allowed to change state, and reported to spies. */
import {
	endBatch,
	globalState,
	now,
	startBatch,
	type Tracking,
} from "./core.js";
import { isSpying, spyReportEnd, spyReportStart } from "./spy.js";

let nextActionId = 1;

/** A running action (MobX's `IActionRunInfo`). */
export interface ActionRunInfo {
	runAsAction: boolean;
	spied: boolean;
	tracking: Tracking | null;
	allowStateChanges: boolean;
	allowStateReads: boolean;
	startTime: number;
	parentActionId: number;
	actionId: number;
	error?: unknown;
}

/**
 * Start an action. `canRunAsDerivation` (auto-actions): inside a derivation, it's part of the
 * derivation (its reads are tracked, and it may not change state).
 */
export function startAction(
	name: string,
	canRunAsDerivation: boolean,
	scope?: unknown,
	args?: ArrayLike<unknown>,
): ActionRunInfo {
	const spied = isSpying() && !!name;
	let startTime = 0;
	if (spied) {
		startTime = now();
		spyReportStart({
			type: "action",
			name,
			object: scope,
			arguments: args ? Array.from(args) : [],
		});
	}
	const info: ActionRunInfo = {
		runAsAction: !canRunAsDerivation || globalState.tracking === null,
		spied,
		tracking: globalState.tracking,
		allowStateChanges: globalState.allowStateChanges,
		allowStateReads: globalState.allowStateReads,
		startTime,
		parentActionId: globalState.currentActionId,
		actionId: nextActionId,
	};
	startBatch();
	if (info.runAsAction) {
		globalState.tracking = null;
		globalState.allowStateChanges = true;
	}
	globalState.allowStateReads = true;
	globalState.currentActionId = nextActionId++;
	return info;
}

export function endAction(info: ActionRunInfo): void {
	if (globalState.currentActionId !== info.actionId) {
		throw new Error(
			"sobx: invalid action stack. did you forget to finish an action?",
		);
	}
	globalState.currentActionId = info.parentActionId;
	if (info.error !== undefined) globalState.suppressReactionErrors = true;
	globalState.allowStateChanges = info.allowStateChanges;
	globalState.allowStateReads = info.allowStateReads;
	try {
		endBatch();
	} finally {
		if (info.runAsAction) globalState.tracking = info.tracking;
		if (info.spied) spyReportEnd({ time: now() - info.startTime });
		globalState.suppressReactionErrors = false;
	}
}

/** Run `fn` as an action. */
export function executeAction<T>(
	name: string,
	canRunAsDerivation: boolean,
	fn: (...args: never[]) => T,
	scope?: unknown,
	args: ArrayLike<unknown> = NO_ARGS,
): T {
	if (globalState.spying !== 0) {
		return executeSpied(name, canRunAsDerivation, fn, scope, args);
	}
	// As `startAction` / `endAction` do, without the allocations.
	const { tracking, allowStateChanges, allowStateReads, currentActionId } =
		globalState;
	const runAsAction = !canRunAsDerivation || tracking === null;
	startBatch();
	if (runAsAction) {
		globalState.tracking = null;
		globalState.allowStateChanges = true;
	}
	globalState.allowStateReads = true;
	globalState.currentActionId = nextActionId++;
	let failed = true;
	try {
		const result =
			args === NO_ARGS && scope === undefined
				? (fn as () => T)()
				: fn.apply(scope, args as never);
		failed = false;
		return result;
	} finally {
		globalState.currentActionId = currentActionId;
		globalState.allowStateChanges = allowStateChanges;
		globalState.allowStateReads = allowStateReads;
		if (failed) endFailedBatch();
		else endBatch();
		if (runAsAction) globalState.tracking = tracking;
	}
}

/** No arguments: the function is called directly. */
export const NO_ARGS: ArrayLike<unknown> = [];

/** End the batch of an action that threw: errors of the reactions it runs are suppressed. */
function endFailedBatch(): void {
	globalState.suppressReactionErrors = true;
	try {
		endBatch();
	} finally {
		globalState.suppressReactionErrors = false;
	}
}

function executeSpied<T>(
	name: string,
	canRunAsDerivation: boolean,
	fn: (...args: never[]) => T,
	scope: unknown,
	args: ArrayLike<unknown>,
): T {
	const info = startAction(name, canRunAsDerivation, scope, args);
	try {
		return fn.apply(scope, args as never);
	} catch (error) {
		info.error = error;
		throw error;
	} finally {
		endAction(info);
	}
}

/** Run `fn` as an (unnamed, not reported) action. */
export function runAction<T>(fn: () => T): T {
	return executeAction("", false, fn);
}

/** `runInAction(fn)`: run `fn` now as an action and return its result. */
export function runInAction<T>(fn: () => T): T {
	// (Reading a function's name is not free.)
	const name = globalState.spying === 0 ? "" : fn.name || "<unnamed action>";
	return executeAction(name, false, fn);
}

const actions = new WeakSet<object>();

/** `fn` is (bound from) an action. */
export function markAction<F extends object>(fn: F): F {
	actions.add(fn);
	return fn;
}

/** Whether `fn` was created by `action()` / an action annotation. */
export function isAction(fn: unknown): boolean {
	return typeof fn === "function" && actions.has(fn);
}

/** Wrap `fn` as an action (or auto-action). `ref`: what `this` is always. */
export function createAction<A extends unknown[], R>(
	name: string,
	fn: (...args: A) => R,
	auto = false,
	ref?: unknown,
): (...args: A) => R {
	const wrapped = function (this: unknown, ...args: A): R {
		return executeAction(name, auto, fn as never, ref ?? this, args);
	};
	actions.add(wrapped);
	Object.defineProperties(wrapped, {
		name: { value: name, configurable: true },
		isMobxAction: { value: true, configurable: true },
		toString: { value: () => fn.toString(), configurable: true },
	});
	return wrapped;
}
