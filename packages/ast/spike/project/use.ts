import { selectCount } from "./selectors";
import { autorun } from "./sobx";
import type { Cart } from "./store";
import { store } from "./store";

const api = { total: () => store.count };

export function show(cart: Cart, fn: () => number) {
	autorun(() => {
		console.log(store.count, selectCount(), api.total(), cart.total, fn());
	});
}
