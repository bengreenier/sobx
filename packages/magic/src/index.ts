/**
 * The MobX-compatible API, as you write it. These exports are not meant to run: the sobx
 * compiler redirects imports of "@sobx/magic" to `@sobx/runtime` (and compiles local
 * observables to a faster form). If one of them is ever called, the compiler was not enabled
 * for that file, and it throws to say so.
 *
 * The types are the runtime's, so code type-checks exactly as it will run.
 */
import type * as runtime from "@sobx/runtime";

// (Those that are also values, below, take precedence.)
export type * from "@sobx/runtime";

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
	"object",
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
export const set = placeholder<typeof runtime.set>("set");
export const remove = placeholder<typeof runtime.remove>("remove");
export const has = placeholder<typeof runtime.has>("has");
export const get = placeholder<typeof runtime.get>("get");
export const keys = placeholder<typeof runtime.keys>("keys");
export const values = placeholder<typeof runtime.values>("values");
export const entries = placeholder<typeof runtime.entries>("entries");
export const defineProperty =
	placeholder<typeof runtime.defineProperty>("defineProperty");
export const ownKeys = placeholder<typeof runtime.ownKeys>("ownKeys");
export const extendObservable =
	placeholder<typeof runtime.extendObservable>("extendObservable");
export const override = placeholder<typeof runtime.override>("override");
export const observe = placeholder<typeof runtime.observe>("observe");
export const intercept = placeholder<typeof runtime.intercept>("intercept");
export const spy = placeholder<typeof runtime.spy>("spy");
export const trace = placeholder<typeof runtime.trace>("trace");
export const onReactionError =
	placeholder<typeof runtime.onReactionError>("onReactionError");
export const onBecomeObserved =
	placeholder<typeof runtime.onBecomeObserved>("onBecomeObserved");
export const onBecomeUnobserved =
	placeholder<typeof runtime.onBecomeUnobserved>("onBecomeUnobserved");
export const createAtom = placeholder<typeof runtime.createAtom>("createAtom");
export const getAtom = placeholder<typeof runtime.getAtom>("getAtom");
export const getDebugName =
	placeholder<typeof runtime.getDebugName>("getDebugName");
export const getDependencyTree =
	placeholder<typeof runtime.getDependencyTree>("getDependencyTree");
export const getObserverTree =
	placeholder<typeof runtime.getObserverTree>("getObserverTree");
export const isObservableProp =
	placeholder<typeof runtime.isObservableProp>("isObservableProp");
export const isComputedProp =
	placeholder<typeof runtime.isComputedProp>("isComputedProp");
export const isFlow = placeholder<typeof runtime.isFlow>("isFlow");
export const flowResult = placeholder<typeof runtime.flowResult>("flowResult");
export const transaction =
	placeholder<typeof runtime.transaction>("transaction");
export const _allowStateChanges =
	placeholder<typeof runtime._allowStateChanges>("_allowStateChanges");
export const _allowStateChangesInsideComputed = placeholder<
	typeof runtime._allowStateChangesInsideComputed
>("_allowStateChangesInsideComputed");
export const _allowStateReadsEnd = placeholder<
	typeof runtime._allowStateReadsEnd
>("_allowStateReadsEnd");
export const _allowStateReadsStart = placeholder<
	typeof runtime._allowStateReadsStart
>("_allowStateReadsStart");
export const _autoAction =
	placeholder<typeof runtime._autoAction>("_autoAction");
export const _endAction = placeholder<typeof runtime._endAction>("_endAction");
export const _getAdministration =
	placeholder<typeof runtime._getAdministration>("_getAdministration");
export const _getGlobalState =
	placeholder<typeof runtime._getGlobalState>("_getGlobalState");
export const _isComputingDerivation = placeholder<
	typeof runtime._isComputingDerivation
>("_isComputingDerivation");
export const _resetGlobalState =
	placeholder<typeof runtime._resetGlobalState>("_resetGlobalState");
export const _startAction =
	placeholder<typeof runtime._startAction>("_startAction");
/** Where an observable's administration is: rewritten to the runtime's by the compiler. */
export const $mobx: typeof runtime.$mobx = Symbol(
	"sobx administration (not compiled)",
) as never;
export const ObservableMap =
	placeholder<typeof runtime.ObservableMap>("ObservableMap");
// biome-ignore lint/suspicious/noExplicitAny: as in MobX
export type ObservableMap<K = any, V = any> = runtime.ObservableMap<K, V>;
export const ObservableSet =
	placeholder<typeof runtime.ObservableSet>("ObservableSet");
// biome-ignore lint/suspicious/noExplicitAny: as in MobX
export type ObservableSet<T = any> = runtime.ObservableSet<T>;
export const Reaction = placeholder<typeof runtime.Reaction>("Reaction");
export type Reaction = runtime.Reaction;
export const FlowCancellationError = placeholder<
	typeof runtime.FlowCancellationError
>("FlowCancellationError");
export type FlowCancellationError = runtime.FlowCancellationError;
