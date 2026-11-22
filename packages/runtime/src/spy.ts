/** `spy`, change listeners (`observe`) and interceptors (`intercept`): what they share. */
import { DEV, globalState, untracked } from "./core.js";

/** An event reported to spies; a change event is also what `observe` listeners get. */
// biome-ignore lint/suspicious/noExplicitAny: events have varied shapes, as in MobX
export type SpyEvent = { type: string; [key: string]: any };
export type SpyListener = (event: SpyEvent) => void;
/** Stops what returned it. */
export type Lambda = () => void;

let listeners: SpyListener[] = [];

/** Whether anything is spying (development builds only, as in MobX). */
export function isSpying(): boolean {
	return DEV && listeners.length > 0;
}

/** Report `event` to spies. */
export function spyReport(event: SpyEvent): void {
	if (!isSpying()) return;
	for (const listener of [...listeners]) listener(event);
}

/** Report the start of something (ended by {@link spyReportEnd}). */
export function spyReportStart(event: SpyEvent): void {
	spyReport({ ...event, spyReportStart: true });
}

const END = { type: "report-end", spyReportEnd: true } as const;

export function spyReportEnd(change?: { time?: number }): void {
	spyReport(
		change ? { ...change, type: "report-end", spyReportEnd: true } : END,
	);
}

/** `spy(listener)`: be told about everything that happens. A no-op in production builds. */
export function spy(listener: SpyListener): Lambda {
	if (!DEV) {
		console.warn("[sobx] spy is a no-op in production builds");
		return () => {};
	}
	listeners = [...listeners, listener];
	globalState.spying++;
	let active = true;
	return once(() => {
		if (!active) return;
		active = false;
		listeners = listeners.filter((l) => l !== listener);
		globalState.spying--;
	});
}

declare const console: { warn(...args: unknown[]): void };

export function once(fn: Lambda): Lambda {
	let done = false;
	return () => {
		if (done) return;
		done = true;
		fn();
	};
}

// -- observe / intercept --------------------------------------------------------------------

export type ChangeListener = (change: SpyEvent) => void;
export type Interceptor = (change: SpyEvent) => SpyEvent | null;

/** What can be observed and intercepted. */
export interface Hooks {
	interceptors: Interceptor[] | null;
	listeners: ChangeListener[] | null;
}

function register<T>(get: () => T[] | null, set: (l: T[]) => void, item: T) {
	set([...(get() ?? []), item]);
	return once(() => {
		const list = get() ?? [];
		const i = list.indexOf(item);
		if (i >= 0) set([...list.slice(0, i), ...list.slice(i + 1)]);
	});
}

export function addListener(hooks: Hooks, listener: ChangeListener): Lambda {
	return register(
		() => hooks.listeners,
		(l) => {
			hooks.listeners = l.length > 0 ? l : null;
		},
		listener,
	);
}

export function addInterceptor(hooks: Hooks, handler: Interceptor): Lambda {
	return register(
		() => hooks.interceptors,
		(l) => {
			hooks.interceptors = l.length > 0 ? l : null;
		},
		handler,
	);
}

/** Run the interceptors on `change`: the change to make, or `null` to make none. */
export function interceptChange(hooks: Hooks, change: SpyEvent) {
	const interceptors = hooks.interceptors;
	if (!interceptors) return change;
	return untracked(() => {
		let current: SpyEvent | null = change;
		for (const interceptor of [...interceptors]) {
			current = interceptor(current as SpyEvent);
			if (current && !current.type) {
				throw new Error(
					"sobx: intercept handlers should return nothing or a change object",
				);
			}
			if (!current) break;
		}
		return current ?? null;
	});
}

/** Tell the listeners about `change`. */
export function notifyListeners(hooks: Hooks, change: SpyEvent): void {
	const list = hooks.listeners;
	if (!list) return;
	untracked(() => {
		for (const listener of [...list]) listener(change);
	});
}

/** Make a change (`apply`), reporting it to spies and listeners. */
export function report(
	hooks: Hooks | null,
	change: () => SpyEvent,
	apply: () => void,
): void {
	const spying = isSpying();
	const listening = hooks?.listeners;
	if (!spying && !listening) {
		apply();
		return;
	}
	const event = change();
	if (spying) spyReportStart(event);
	apply();
	if (hooks) notifyListeners(hooks, event);
	if (spying) spyReportEnd();
}
