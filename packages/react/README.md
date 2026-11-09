# @sobx/react

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

React bindings for sobx, with the same API as [mobx-react](https://github.com/mobxjs/mobx/tree/main/packages/mobx-react) (which includes [mobx-react-lite](https://github.com/mobxjs/mobx/tree/main/packages/mobx-react-lite)'s). `observer` components track the observables they read while rendering and re-render when those change, and only then.

## Migrating from mobx-react

Switch your imports from `"mobx-react"` / `"mobx-react-lite"` to `"@sobx/react"` (and from `"mobx"` to `"@sobx/magic"`, see [@sobx/magic](../magic)). Components don't change:

```tsx
import { observable, runInAction } from "@sobx/magic";
import { observer, useLocalObservable } from "@sobx/react";

const store = observable({ count: 0 });

const Counter = observer(() => {
  const local = useLocalObservable(() => ({
    clicks: 0,
    click() {
      this.clicks++;
      store.count++;
    },
  }));
  return (
    <button type="button" onClick={local.click}>
      {store.count} / {local.clicks}
    </button>
  );
});
```

Files written against `@sobx/magic` need the [sobx compiler](../compiler); `.tsx` / `.jsx` files are compiled like any other. `@sobx/react` itself isn't compiled: it's a library on top of [`@sobx/runtime`](../runtime).

sobx never uses `Proxy`, so the usual sobx rule applies to observables a component receives without the compiler seeing where they came from (props, `useLocalObservable`, context): reading and writing their declared properties is tracked, but adding or deleting keys, `in`, `Object.keys` and array index / `length` writes must use the explicit API (`set`, `remove`, `has`, `keys`, `array.set(i, v)`, ...). See [what's supported](../../docs/support.md).

## Install

```bash
pnpm add @sobx/react @sobx/magic @sobx/runtime
pnpm add -D @sobx/compiler
```

Requires React 18 or later.

## API

- **`observer(component)`**: makes a function component, a `React.forwardRef` component or a class component an observer. Function components are wrapped in `React.memo`; class components get a shallow-comparing `shouldComponentUpdate` (unless they extend `PureComponent`). Also a standard class decorator (`@observer class C extends Component {}`).
- **`<Observer>{() => ...}</Observer>`** (or `render={() => ...}`): an observer for part of a component.
- **`useLocalObservable(initializer, annotations?)`**: an observable created once for the life of the component (`observable(initializer(), annotations, { autoBind: true })`).
- **`Provider`**, **`inject(...storeNames)`** / **`inject(mapStoresToProps)`**, **`MobXProviderContext`**: provide stores through React context and inject them as props.
- **`enableStaticRendering(enable)`**, **`isUsingStaticRendering()`**: for server-side rendering (observers render once, without subscribing).
- Deprecated in mobx-react, and kept for compatibility: `useObserver`, `useLocalStore`, `useAsObservableSource`, `useStaticRendering`, `observerBatching` (does nothing: React batches updates itself), `isObserverBatched`.
- `clearTimers()`: disposes the reactions of components that rendered but never mounted, when `FinalizationRegistry` isn't available (tests).

Components that render but never mount (StrictMode's discarded renders, Suspense, interrupted concurrent renders) have their subscriptions released through a `FinalizationRegistry` (or a timer where it isn't available), as in mobx-react.

### Differences from mobx-react

- `disposeOnUnmount` and `PropTypes` are not provided (both are deprecated or removed in recent mobx-react / React versions). Dispose reactions in `componentWillUnmount` or a `useEffect` cleanup, and use TypeScript for prop types.
- In development builds, mobx-react throws when a class component's `this.props` / `this.state` are read from another reactive context (a `computed` or `reaction`); sobx doesn't check this.
- No `reactionScheduler`: React 18+ batches the updates of the components a change re-renders.

Behaviour is checked against mobx-react: `src/parity.spec.tsx` renders the same components with `mobx` + `mobx-react` and with `@sobx/runtime` + `@sobx/react`, and compares what they render and how often. `src/compiled.spec.tsx` renders components written against `@sobx/magic` and compiled by the sobx Vite plugin.
