/**
 * Disposes the reactions of components that rendered but never mounted (StrictMode's discarded
 * renders, Suspense, interrupted concurrent renders). Rendering subscribes the component's
 * reaction to what it read, before React commits; if React then throws the render away, nothing
 * else would ever dispose it.
 *
 * Uses `FinalizationRegistry` where available, and otherwise a timer that disposes reactions
 * still unmounted after {@link FINALIZE_AFTER} ms.
 */

interface Registry<T> {
	register(target: object, value: T, token: object): void;
	unregister(token: object): void;
	/** Finalize every registration now (timer-based registry only). */
	finalizeAllImmediately?: () => void;
}

export const FINALIZE_AFTER = 10_000;
const SWEEP_INTERVAL = 10_000;

/** A FinalizationRegistry stand-in that finalizes registrations after a delay. */
export class TimerBasedFinalizationRegistry<T> implements Registry<T> {
	private readonly registrations = new Map<
		object,
		{ value: T; registeredAt: number }
	>();
	private timeout: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly finalize: (value: T) => void) {}

	register(_target: object, value: T, token: object): void {
		this.registrations.set(token, { value, registeredAt: Date.now() });
		this.schedule();
	}

	unregister(token: object): void {
		this.registrations.delete(token);
	}

	sweep = (maxAge = FINALIZE_AFTER): void => {
		clearTimeout(this.timeout);
		this.timeout = undefined;
		const now = Date.now();
		for (const [token, registration] of this.registrations) {
			if (now - registration.registeredAt >= maxAge) {
				this.registrations.delete(token);
				this.finalize(registration.value);
			}
		}
		if (this.registrations.size > 0) this.schedule();
	};

	finalizeAllImmediately = (): void => {
		this.sweep(0);
	};

	private schedule(): void {
		if (this.timeout === undefined) {
			this.timeout = setTimeout(this.sweep, SWEEP_INTERVAL);
		}
	}
}

export function createRegistry<T>(finalize: (value: T) => void): Registry<T> {
	return typeof FinalizationRegistry !== "undefined"
		? new FinalizationRegistry<T>(finalize)
		: new TimerBasedFinalizationRegistry<T>(finalize);
}

/** Holds a reaction until the component mounts; `null` once disposed. */
export interface ReactionHolder {
	reaction: { dispose(): void } | null;
}

export const observerFinalizationRegistry = createRegistry<ReactionHolder>(
	(holder) => {
		holder.reaction?.dispose();
		holder.reaction = null;
	},
);

/**
 * Dispose the reactions of unmounted components right away. Only does something when
 * `FinalizationRegistry` isn't available (the timer-based fallback is used); for tests.
 */
export const clearTimers: () => void =
	observerFinalizationRegistry.finalizeAllImmediately ?? (() => {});
