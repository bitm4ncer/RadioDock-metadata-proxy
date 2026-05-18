// Single-flight wrapper: collapse concurrent identical requests into one
// outbound work unit. Without this, a cache miss on a popular stream can fan
// out into N parallel metadata probes (N listeners × ~10 strategy fetches).
//
// Usage:
//   const sf = createSingleFlight();
//   const result = await sf(key, () => doExpensiveThing());
//
// The factory function is called at most once per concurrent burst per key.

function createSingleFlight() {
  const inflight = new Map();
  return function singleFlight(key, factory) {
    const existing = inflight.get(key);
    if (existing) return existing;
    const promise = Promise.resolve()
      .then(factory)
      .finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  };
}

module.exports = { createSingleFlight };
