# CelesTrak GP data over HTTP

For anyone writing software that downloads GP data to propagate orbits: trackers, pass predictors,
apps. Any language. Their status codes do not mean what HTTP says they mean, so this is the
classification order that actually works: **read the body first, trust the status second.**

Endpoint used throughout:

```
https://celestrak.org/NORAD/elements/gp.php?GROUP=<name>&FORMAT=csv
```

## Rules

1. **Read the body before the status.** Their codes do not mean what HTTP says; every rule below
   depends on this.
2. **`FORMAT=csv` only.** `json` is about three times the bytes, and `tle` is retired and cannot
   represent catalog numbers above 69999.
3. **At most one request per file per 2 hours**, their regeneration interval, with
   `If-Modified-Since` from your last successful download.
4. **A 403 with "has not updated" in the body is not an error.** Keep your copy, refresh your
   timestamp, do not count a failure.
5. **Never retry a 403, 404 or 301.** The answer will not change, and 50 of them inside two hours
   puts your IP in their firewall.
6. **A 500 or 503 means stop everything for at least 15 minutes.** Their words, not a guess.
7. **Use the last data you downloaded whenever upstream is broken.** Older elements beat no
elements, and it stops your software from retrying.

## Status map

| status | what HTTP means | what CelesTrak means | action |
|---|---|---|---|
| 200 + CSV | OK | current data | store it, update the timestamp |
| 200 + notice | OK | "no GP data found" / "invalid query" | treat as 404, remember it, do not retry |
| 301 | Moved Permanently | legacy URL or wrong domain, file moved | follow once, save the new URL, alert a human |
| 403 + notice | Forbidden | data has not updated since your last download | keep your copy, refresh the timestamp, not an error |
| 403 + anything else | Forbidden | real block, sometimes with a reason in the body | stop, back off, report the body to a human |
| 404 | Not Found | dead object, unknown group, retired query | stop, remember the answer |
| 500 / 503 | server error | overloaded or restarting | stop all requests for 15 minutes or more |
| 304 | Not Modified | never used | not applicable |

## The 403 that is not an error

Captured 2026-11-21 from `GROUP=active`, second request inside the 2 hour window:

```
http=403  bytes=141  content-type: text/plain; charset=UTF-8

GP data has not updated since your last successful
download of GROUP=active at 2026-11-21 00:29:30 UTC.
Data is updated once every 2 hours.
```

Match, lower-cased, on any of:

```
gp data has not updated
has not updated since
data is updated once every
```

On a match: keep the cached file, set your timestamp to now so you stop asking, do not count a
failure, do not alert. It means your copy is current, which is what you wanted.

## Other bodies

| body | status | meaning | action |
|---|---|---|---|
| starts with `OBJECT_NAME` | 200 | real CSV | parse it |
| `No GP data found` | 200 | object is dead or not served | 404 semantics, remember for hours |
| `Invalid query: ... (GROUP=x not found)` | 200 | group name is wrong or retired | 404 semantics, remember it |
| `<!DOCTYPE html` / `Service Unavailable` | 403/500/503 | their server is broken | back off, alert |

Checking the first line of the body is enough for all of these: real data always begins with the
CSV header row, everything else is a sentence.

## Pseudocode

```
function get_group(name):
    if cache[name] exists and now - fetched_at[name] < 2h:
        return cache[name]                      # never ask inside the update window

    resp = GET gp.php?GROUP=name&FORMAT=csv
           headers: If-Modified-Since = fetched_at[name]

    body = text(resp)

    if body matches NOT_UPDATED_NOTICE:
        fetched_at[name] = now                  # we already have current data
        return cache[name]

    if body matches NOT_FOUND_NOTICE:
        remember_missing(name, ttl=6h)
        return NOT_FOUND

    if resp.status == 200 and body starts with "OBJECT_NAME":
        cache[name] = body
        fetched_at[name] = now
        return body

    if resp.status in (301, 302, 307, 308):
        new_url = resolve(resp.location)
        save_endpoint(new_url)                  # use it from now on
        alert_human("endpoint moved", resp.status, body)
        return get_group_retry_once(new_url)     # exactly once, never in a loop

    stop_all_requests(backoff(resp.status))     # 15 min for 5xx, hours for blocks
    alert_human(resp.status, first 120 chars of body)
    return STALE_CACHE_IF_AVAILABLE
```

Keep using the last data you downloaded while upstream is broken. Slightly old elements propagate
well enough, and it stops your software from retrying.

## Why retrying is expensive

CelesTrak moves an IP into the firewall after **50 responses with status 301, 403 or 404 within two
hours**, and removal requires manual review by Dr. T.S. Kelso. A client that ignores codes and retries
reaches that in minutes. A client that classifies bodies and stops never gets there.

They also publish a bandwidth ceiling: more than roughly 100 MB per day per IP invites a block.
Compression is supported (gzip and brotli) and most HTTP clients request it by default, which cuts
GP CSV by about 62 percent.

## Related endpoints, same discipline

- `jsonDir.php` lists what is available. Do not ask more than once per hour.
- `SUP=`, `SATCAT=`, `EOP=`, space weather and SOCRATES have their own update intervals (some once
  a day, some once every 14 hours). The same rule applies: check the interval, download once.
- `GROUP=active` and `GROUP=starlink` are the two they enforce hardest. Starlink is a subset of
  active, so download active and filter locally instead of fetching both.

## Reference implementation

The CelesTrak client in this repository (`src/utils/tleFetcher.ts`) follows the rules above.
