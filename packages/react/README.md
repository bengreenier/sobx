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

Modules that import `@sobx/magic` need the [sobx compiler](../compiler); `.tsx` / `.jsx` files are compiled like any other. `@sobx/react` itself isn't compiled: it's a library on top of [`@sobx/runtime`](../runtime).

Observables a component gets from props, context, a hook or another module are behind a `Proxy`, as in MobX, so they're observed however the component uses them (`store?.later`, `const { later } = store`, `<C {...store} />`...), whether or not it's compiled.

## Install

```bash
pnpm add @sobx/react @sobx/magic @sobx/runtime
pnpm add -D @sobx/compiler
```

Requires React 18 or later (the tests run against React 18 and 19).

## API

- **`observer(component)`**: makes a function component, a `React.forwardRef` component or a class component an observer. Function components are wrapped in `React.memo`; class components get a shallow-comparing `shouldComponentUpdate` (unless they extend `PureComponent`). Also a standard class decorator (`@observer class C extends Component {}`). In development builds, reading a class component's `this.props` / `this.state` / `this.context` in a derivation other than its render (a `computed`, a `reaction`) throws, as in mobx-react: they aren't observable.
- **`<Observer>{() => ...}</Observer>`** (or `render={() => ...}`): an observer for part of a component.
- **`useLocalObservable(initializer, annotations?)`**: an observable created once for the life of the component (`observable(initializer(), annotations, { autoBind: true })`).
- **`Provider`**, **`inject(...storeNames)`** / **`inject(mapStoresToProps)`**, **`MobXProviderContext`**: provide stores through React context and inject them as props.
- **`enableStaticRendering(enable)`**, **`isUsingStaticRendering()`**: for server-side rendering (observers render once, without subscribing).
- Deprecated in mobx-react, and kept for compatibility: `useObserver`, `useLocalStore`, `useAsObservableSource`, `useStaticRendering`, `observerBatching` (does nothing: React batches updates itself), `isObserverBatched`.
- **`PropTypes`**: prop-types validators for observables (`observableArray`, `observableArrayOf(type)`, `observableMap`, `observableObject`, `arrayOrObservableArray`, `arrayOrObservableArrayOf(type)`, `objectOrObservableObject`, each with `isRequired`).
- **`disposeOnUnmount(component, disposer | disposers)`**, or on a property key (`disposeOnUnmount(C.prototype, "key")`, the legacy decorator form): calls disposers when a class component unmounts. Deprecated in mobx-react, and like it not compatible with React 18+'s StrictMode re-mounts.
- `clearTimers()`: disposes the reactions of components that rendered but never mounted, when `FinalizationRegistry` isn't available (tests).

Errors thrown while rendering go to React (error boundaries), not to `onReactionError`. Components that render but never mount (StrictMode's discarded renders, Suspense, interrupted concurrent renders) have their subscriptions released through a `FinalizationRegistry` (or a timer where it isn't available), as in mobx-react.

### Differences from mobx-react

- `observerBatching(scheduler)` does nothing: React 18+ batches the updates of the components a change re-renders. (`configure({ reactionScheduler })` is there if you need it.)

Behaviour is checked against mobx-react: `src/parity.spec.tsx` renders the same components with `mobx` + `mobx-react` and with `@sobx/runtime` + `@sobx/react`, and compares what they render and how often. `src/react.compiled.spec.tsx` renders components written against `@sobx/magic` and compiled by the sobx Vite plugin.
