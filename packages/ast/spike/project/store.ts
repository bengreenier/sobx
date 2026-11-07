import { makeAutoObservable, observable } from "./sobx";

export const store = observable({ count: 0, items: [] as number[] });

export class Cart {
	total = 0;
	constructor() {
		makeAutoObservable(this);
	}
}
