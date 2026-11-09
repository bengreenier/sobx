// Run the React 18 project on the timer-based fallback registry (used where
// FinalizationRegistry is unavailable), so tests can dispose abandoned renders with
// clearTimers() instead of waiting for garbage collection.
// biome-ignore lint/suspicious/noExplicitAny: removing a global for the test run
(globalThis as any).FinalizationRegistry = undefined;
