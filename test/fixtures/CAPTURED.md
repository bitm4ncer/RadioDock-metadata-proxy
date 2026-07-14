# Captured live fixtures

Real now-playing payloads captured from the source, used to write + lock parsers.

- `kiosk-airtime.json` — `https://www.kioskradio.com/api/now-playing` (Airtime 1.1), captured 2026-07-14 during a live DJ set. Note: `tracks.current.type === "livestream"` with empty name (no track); the meaningful now-playing is `shows.current.name`. Trimmed (huge per-track metadata blocks removed), shape faithful.
- `wwoz-onair.html` — `https://www.wwoz.org` homepage, captured 2026-07-14. The on-air programme is server-rendered in `<p class="navbar-text on-air"> … <span class="song-artist"><a>SHOW</a>`. No JSON now-playing API is exposed; the parser extracts the on-air show from the HTML. Trimmed to the relevant block.
