/**
 * The MobX-compatible API, as you write it. These exports are not meant to run: the sobx
 * compiler redirects imports of "@sobx/magic" to `@sobx/runtime` (and compiles local
 * observables to a faster form). If one of them is ever called, the compiler was not enabled
 * for that file, and it throws to say so.
 *
 * The types are the runtime's, so code type-checks exactly as it will run.
 */
import type * as runtime from "@sobx/runtime";

export type {
	Annotation,
	AnnotationsMap,
	AnnotationValue,
	ArrayOptions,
	AutorunOptions,
	BoxOptions,
	CancellablePromise,
	CollectionOptions,
	Computed,
	ComputedOptions,
	ConfigureOptions,
	Disposer,
	EnforceActions,
	FlowPromise,
	ObservableArray,
	ObservableBox,
	ObservableMap,
	ObservableOptions,
	ObservableSet,
	Reaction,
	ReactionOptions,
	WhenOptions,
} from "@sobx/runtime";

function notCompiled(name: string): never {
	throw new Error(
		`sobx: ${name} was not compiled. Ensure the sobx compiler is enabled for this file.`,
	);
}

/** A function that throws `notCompiled`, with the same properties (e.g. `observable.ref`). */
function placeholder<T>(name: string, members: string[] = []): T {
	const fn = () => notCompiled(`${name}()`);
	for (const member of members) {
		Object.defineProperty(fn, member, {
			value: () => notCompiled(`${name}.${member}`),
		});
	}
	return fn as T;
}

export const observable: runtime.ObservableFn = placeholder("observable", [
	"ref",
	"shallow",
	"struct",
	"deep",
	"array",
	"box",
	"map",
	"set",
]);
export const computed: runtime.ComputedFn = placeholder("computed", ["struct"]);
export const action: runtime.ActionFn = placeholder("action", ["bound"]);
export const runInAction =
	placeholder<typeof runtime.runInAction>("runInAction");
export const reaction = placeholder<typeof runtime.reaction>("reaction");
export const autorun = placeholder<typeof runtime.autorun>("autorun");
export const makeObservable =
	placeholder<typeof runtime.makeObservable>("makeObservable");
export const makeAutoObservable =
	placeholder<typeof runtime.makeAutoObservable>("makeAutoObservable");
export const when = placeholder<typeof runtime.when>("when");
export const flow: runtime.FlowFn = placeholder("flow", ["bound"]);
export const comparer: typeof runtime.comparer = {
	default: placeholder("comparer.default"),
	identity: placeholder("comparer.identity"),
	structural: placeholder("comparer.structural"),
	shallow: placeholder("comparer.shallow"),
};
export const toJS = placeholder<typeof runtime.toJS>("toJS");
export const configure = placeholder<typeof runtime.configure>("configure");
export const untracked = placeholder<typeof runtime.untracked>("untracked");
export const isObservable =
	placeholder<typeof runtime.isObservable>("isObservable");
export const isObservableArray =
	placeholder<typeof runtime.isObservableArray>("isObservableArray");
export const isObservableObject =
	placeholder<typeof runtime.isObservableObject>("isObservableObject");
export const isObservableMap =
	placeholder<typeof runtime.isObservableMap>("isObservableMap");
export const isObservableSet =
	placeholder<typeof runtime.isObservableSet>("isObservableSet");
export const isBoxedObservable =
	placeholder<typeof runtime.isBoxedObservable>("isBoxedObservable");
export const isComputed = placeholder<typeof runtime.isComputed>("isComputed");
export const isAction = placeholder<typeof runtime.isAction>("isAction");
export const isFlowCancellationError = placeholder<
	typeof runtime.isFlowCancellationError
>("isFlowCancellationError");
/** sobx's explicit API (same names and semantics as MobX's object API functions). */
export const set = placeholder<typeof runtime.set>("set");
export const remove = placeholder<typeof runtime.remove>("remove");
export const has = placeholder<typeof runtime.has>("has");
export const get = placeholder<typeof runtime.get>("get");
export const keys = placeholder<typeof runtime.keys>("keys");
export const values = placeholder<typeof runtime.values>("values");
export const entries = placeholder<typeof runtime.entries>("entries");
