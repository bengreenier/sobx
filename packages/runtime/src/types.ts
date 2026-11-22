/** The types MobX exports, by the same names (for code that moves from MobX). */
// biome-ignore-all lint/suspicious/noExplicitAny: as in MobX's types
import type { ActionRunInfo } from "./action.js";
import type { WhenOptions } from "./async.js";
import type {
	MapEntries,
	ObservableMap,
	ObservableSet,
} from "./collections.js";
import type { ComputedOptions } from "./computed.js";
import type { $mobx, Dep } from "./core.js";
import type { Enhancer } from "./enhance.js";
import type { DependencyTree, ObserverTree } from "./extras.js";
import type {
	ActionFn,
	AnnotationValue,
	ComputedFn,
	ObservableFn,
	ObservableOptions,
} from "./observable.js";
import type { AutorunOptions, Reaction, ReactionOptions } from "./reaction.js";
import type { Lambda } from "./spy.js";

// -- values ---------------------------------------------------------------------------------

export interface IObservableValue<T> {
	get(): T;
	set(value: T): void;
}

export interface IComputedValue<T> {
	get(): T;
	set(value: T): void;
}

export interface IObservableArray<T = any> extends Array<T> {
	spliceWithArray(index: number, deleteCount?: number, newItems?: T[]): T[];
	clear(): T[];
	replace(newItems: T[]): T[];
	remove(value: T): boolean;
	toJSON(): T[];
}

export interface IKeyValueMap<V = any> {
	[key: string]: V;
}
export type IMapEntry<K = any, V = any> = [K, V];
export type IMapEntries<K = any, V = any> = IMapEntry<K, V>[];
export type IObservableMapInitialValues<K = any, V = any> = NonNullable<
	MapEntries<K, V>
>;
export type IObservableSetInitialValues<T> = Set<T> | readonly T[];

// -- changes --------------------------------------------------------------------------------

interface IArrayBaseChange<T> {
	object: IObservableArray<T>;
	observableKind: "array";
	debugObjectName: string;
	index: number;
}
export interface IArrayUpdate<T = any> extends IArrayBaseChange<T> {
	type: "update";
	newValue: T;
	oldValue: T;
}
export interface IArraySplice<T = any> extends IArrayBaseChange<T> {
	type: "splice";
	added: T[];
	addedCount: number;
	removed: T[];
	removedCount: number;
}
export type IArrayDidChange<T = any> = IArrayUpdate<T> | IArraySplice<T>;
export interface IArrayWillChange<T = any> {
	object: IObservableArray<T>;
	index: number;
	type: "update";
	newValue: T;
}
export interface IArrayWillSplice<T = any> {
	object: IObservableArray<T>;
	index: number;
	type: "splice";
	added: T[];
	removedCount: number;
}

export type IMapDidChange<K = any, V = any> = {
	observableKind: "map";
	debugObjectName: string;
	object: ObservableMap<K, V>;
	name: K;
} & (
	| { type: "update"; newValue: V; oldValue: V }
	| { type: "add"; newValue: V }
	| { type: "delete"; oldValue: V }
);
export interface IMapWillChange<K = any, V = any> {
	object: ObservableMap<K, V>;
	type: "update" | "add" | "delete";
	name: K;
	newValue?: V;
}

export type ISetDidChange<T = any> = {
	object: ObservableSet<T>;
	observableKind: "set";
	debugObjectName: string;
} & ({ type: "add"; newValue: T } | { type: "delete"; oldValue: T });
export type ISetWillDeleteChange<T = any> = {
	type: "delete";
	object: ObservableSet<T>;
	oldValue: T;
};
export type ISetWillAddChange<T = any> = {
	type: "add";
	object: ObservableSet<T>;
	newValue: T;
};
export type ISetWillChange<T = any> =
	| ISetWillDeleteChange<T>
	| ISetWillAddChange<T>;

export interface IValueWillChange<T> {
	object: IObservableValue<T>;
	type: "update";
	newValue: T;
}
export type IValueDidChange<T = any> = {
	type: "update";
	observableKind: "value";
	object: IObservableValue<T>;
	debugObjectName: string;
	newValue: T;
	oldValue: T | undefined;
};

export interface IComputedDidChange<T = any> {
	type: "update";
	observableKind: "computed";
	object: unknown;
	debugObjectName: string;
	newValue: T;
	oldValue: T | undefined;
}

export type IObjectDidChange<T = any> = {
	observableKind: "object";
	name: PropertyKey;
	object: T;
	debugObjectName: string;
} & (
	| { type: "add"; newValue: any }
	| { type: "update"; oldValue: any; newValue: any }
	| { type: "remove"; oldValue: any }
);
export type IObjectWillChange<T = any> =
	| { object: T; type: "update" | "add"; name: PropertyKey; newValue: any }
	| { object: T; type: "remove"; name: PropertyKey };

export type IInterceptor<T> = (change: T) => T | null;
export interface IInterceptable<T> {
	intercept(handler: IInterceptor<T>): Lambda;
}
export interface IListenable {
	observe(handler: any, fireImmediately?: boolean): Lambda;
}

// -- derivations ----------------------------------------------------------------------------

export interface IDepTreeNode {
	readonly name: string;
}
export type IObservable = Dep;
export interface IAtom {
	readonly name: string;
	reportObserved(): boolean;
	reportChanged(): void;
}
export interface IReactionPublic {
	dispose(): void;
	trace(enterBreakPoint?: boolean): void;
}
export interface IReactionDisposer {
	(): void;
	[$mobx]: Reaction;
}
export type IEqualsComparer<T> = (a: T, b: T) => boolean;
export type IEnhancer<_T = any> = Enhancer;
export type IDependencyTree = DependencyTree;
export type IObserverTree = ObserverTree;

// -- options and functions ------------------------------------------------------------------

export type IAutorunOptions = AutorunOptions;
export type IReactionOptions<
	T,
	FireImmediately extends boolean = boolean,
> = ReactionOptions<T> & { fireImmediately?: FireImmediately };
export type IWhenOptions = WhenOptions;
export type IComputedValueOptions<T> = ComputedOptions<T>;
export type CreateObservableOptions = ObservableOptions & {
	equals?: IEqualsComparer<any>;
};
export type IActionRunInfo = ActionRunInfo;
export type AnnotationMapEntry = AnnotationValue;
export type IObservableFactory = ObservableFn;
export type IComputedFactory = ComputedFn;
export type IActionFactory = ActionFn;
