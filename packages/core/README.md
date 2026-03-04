# @sobx/core

**Not production-ready.** This package is in alpha (version includes an `-alpha` suffix). Do not use in production until a stable release.

Lightweight observable proxy runtime for sobx. Tracks property changes via explicit `get` / `set` calls and notifies observers—faster than a native `Proxy` by avoiding trap overhead.

## Install

```bash
pnpm add @sobx/core
```

## API

### `ProxyLike<T>`

Wraps a plain object and notifies observers when properties change. Use `.get(key)` and `.set(key, value)` instead of direct property access.

- **`constructor(target: T)`** — Wrap an object.
- **`get(key)`** — Read a property.
- **`set(key, value)`** — Write a property and notify observers.
- **`addObserver(observer)`** — Observe all keys. Callback: `(key, previous, current) => void`.
- **`addObserver(key, observer)`** — Observe a single key.
- **`dispose()`** — On the handle returned by `addObserver`, stops observing.

### Types

- **`ProxyLikeObserver<T>`** — `(key, previous, current) => void`
- **`ProxyLikeObserverHandle`** — `{ dispose(): void }`

## Example

```ts
import { ProxyLike } from "@sobx/core";

const state = { count: 0 };
const proxy = new ProxyLike(state);

proxy.addObserver((key, prev, curr) => {
  console.log(`${String(key)}: ${prev} -> ${curr}`);
});

proxy.set("count", 1); // logs: count: 0 -> 1
console.log(proxy.get("count")); // 1
```

## Version

0.0.1-alpha.1
