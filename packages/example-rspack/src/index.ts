import { observable, reaction } from "mobx";

const store = observable({ count: 0 });
reaction(() => store.count, (count) => console.log("count:", count));
store.count += 1;
