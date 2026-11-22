/** A single observable value: a box, or a property of an observable object. */
import { toPrimitive } from "./computed.js";
import {
	adopt,
	checkWrite,
	Dep,
	type Equals,
	type Named,
	type Owner,
	release,
	reportChanged,
	reportObserved,
} from "./core.js";
import type { Enhancer } from "./enhance.js";
import {
	addInterceptor,
	addListener,
	type ChangeListener,
	type Hooks,
	type Interceptor,
	interceptChange,
	isSpying,
	type Lambda,
	notifyListeners,
	spyReportEnd,
	spyReportStart,
} from "./spy.js";
import type {
	IInterceptor,
	IValueDidChange,
	IValueWillChange,
} from "./types.js";

/** Returned by {@link ObservableValue.prepareNew} when there is nothing to change. */
export const UNCHANGED = Symbol("unchanged");

/** `observable.box(value)`, or a property's value. */
export class ObservableValue<T> extends Dep implements Hooks, Owner {
	interceptors: Interceptor[] | null = null;
	listeners: ChangeListener[] | null = null;
	/** @internal Changes what is read (`_interceptReads`). */
	dehancer: ((value: T) => T) | undefined = undefined;
	/** @internal The current value (untracked). */
	current: T;

	constructor(
		value: T,
		private readonly enhancer: Enhancer,
		private readonly equals: Equals,
		private readonly place: Named | string,
		private readonly placeKey?: unknown,
	) {
		super(undefined, place, placeKey);
		this.current = enhancer(value, place, placeKey);
		adopt(this.current, this);
	}

	get(): T {
		reportObserved(this);
		return this.dehancer === undefined
			? this.current
			: this.dehancer(this.current);
	}

	set(value: T): void {
		const next = this.prepareNew(value);
		if (next === UNCHANGED) return;
		const spying = isSpying();
		if (spying) {
			spyReportStart({
				type: "update",
				object: this,
				observableKind: "value",
				debugObjectName: this.name,
				newValue: next,
				oldValue: this.current,
			});
		}
		this.setNew(next as T);
		if (spying) spyReportEnd();
	}

	/** The value to change to (checked, intercepted, converted), or `UNCHANGED`. */
	prepareNew(value: T): T | typeof UNCHANGED {
		checkWrite(this, this);
		let given = value;
		if (this.interceptors !== null) {
			const change = interceptChange(this, {
				object: this,
				type: "update",
				newValue: value,
			});
			if (!change) return UNCHANGED;
			given = change.newValue;
		}
		const next = this.enhancer(given, this.place, this.placeKey);
		return this.equals(this.current, next) ? UNCHANGED : next;
	}

	setNew(next: T): void {
		const previous = this.current;
		release(previous, this);
		this.current = next;
		adopt(next, this);
		reportChanged(this);
		if (this.listeners !== null) {
			notifyListeners(this, {
				type: "update",
				object: this,
				newValue: next,
				oldValue: previous,
			});
		}
	}

	ownerChanged(): void {
		reportChanged(this);
	}

	ownerObserved(): boolean {
		return this.observers.size > 0;
	}

	intercept(handler: IInterceptor<IValueWillChange<T>>): Lambda {
		return addInterceptor(this, handler as Interceptor);
	}

	observe(
		listener: (change: IValueDidChange<T>) => void,
		fireImmediately?: boolean,
	): Lambda {
		if (fireImmediately) {
			listener({
				observableKind: "value",
				debugObjectName: this.name,
				object: this,
				type: "update",
				newValue: this.current,
				oldValue: undefined,
			});
		}
		return addListener(this, listener as ChangeListener);
	}

	toJSON(): T {
		return this.get();
	}

	override toString(): string {
		return `${this.name}[${this.current}]`;
	}

	override valueOf(): unknown {
		return toPrimitive(this.get());
	}

	[Symbol.toPrimitive](): unknown {
		return this.valueOf();
	}
}
