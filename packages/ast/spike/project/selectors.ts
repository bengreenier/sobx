import { store } from "./store";

export function selectCount() {
	return store.count;
}
