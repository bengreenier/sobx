import { runInAction } from "mobx";

const value = runInAction(() => 42);
runInAction(() => {
	console.log(value);
});
