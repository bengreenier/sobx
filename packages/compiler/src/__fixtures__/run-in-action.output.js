import { runInAction } from "mobx";
const value = (() => 42)();
(() => {
  console.log(value);
})();
