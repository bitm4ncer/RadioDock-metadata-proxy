// Fetches the published per-station metadata-override map (rendered by the
// RadioDock-Stations dashboard, committed to the PWA repo) and holds the last
// known copy in memory. Both proxy instances (Hetzner + Render) consume it.
//
// Hard invariant: a missing, unreachable, or malformed map NEVER breaks
// metadata resolution — every failure path keeps the last-known map (empty
// until the first success), so the proxy degrades to its normal probe chain.

const EMPTY = { stations: {}, byHost: {} };

// hostname (no port) — stream URLs frequently carry a port the published map's
// byHost keys do not; matching on hostname keeps them aligned.
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

function makeOverrideMap({ url, ttlMs = 300000, fetchImpl = fetch } = {}) {
  let current = EMPTY;

  async function refresh() {
    try {
      const res = await fetchImpl(url, { headers: { 'user-agent': 'radiodock-metadata-proxy override-map' } });
      if (!res || !res.ok) return current;
      const data = await res.json();
      if (data && typeof data === 'object') {
        current = {
          stations: (data.stations && typeof data.stations === 'object') ? data.stations : {},
          byHost: (data.byHost && typeof data.byHost === 'object') ? data.byHost : {},
        };
      }
    } catch (_) {
      // keep last-known
    }
    return current;
  }

  function get() { return current; }

  // stationId (RadioDock/RB UUID) is authoritative; stream host is the fallback
  // for shared-host servers whose byHost carries a single representative entry.
  function lookup({ stationId, streamUrl } = {}) {
    if (stationId && current.stations[stationId]) return current.stations[stationId];
    const host = hostOf(streamUrl);
    if (host && current.byHost[host]) return current.byHost[host];
    return null;
  }

  // Best-effort background refresh; caller starts it once at boot.
  function start() {
    refresh();
    const timer = setInterval(refresh, ttlMs);
    if (timer.unref) timer.unref();
    return timer;
  }

  return { get, refresh, lookup, start };
}

module.exports = { makeOverrideMap };
