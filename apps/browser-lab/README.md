# Browser laboratory

Measures what a device can actually do locally, and what it should hand to the
cloud. A measurement harness, **not** the customer application — it exists to
turn open decision **O-003** (local-processing thresholds) from a guess into a
number.

## Running it

```powershell
npm install
npm run build --workspace ipw-browser-lab
python tools/serve_browser_lab.py
```

**It must be served over `http://localhost`, not opened as a `file://` URL.**
`crypto.subtle` is only available in a secure context, and without it the lab
cannot compute the content-addressed identifier that makes a browser result
comparable with a server result. Opening the file directly would load the page and
then fail at the one thing it exists to do.

## What it measures

| | |
|---|---|
| **Capability** | Worker, OffscreenCanvas, createImageBitmap, Web Crypto, secure context, WebAssembly, cores, device memory, touch |
| **Timing** | decode, operation, encode — separately, in integer nanoseconds |
| **Responsiveness** | frames painted *while working* (see below) |
| **Routing** | local vs cloud, with every reason recorded |

Everything runs in a Worker using `createImageBitmap` and `OffscreenCanvas`, so no
DOM element is ever touched and the main thread stays free.

### How responsiveness is evidenced rather than claimed

POC-005 requires that "the UI remains responsive during tested operations". A
blocked main thread cannot paint, so the lab counts animation frames throughout
each measurement and reports the number. If work were running on the main thread
the count would collapse toward zero, and the report would say so.

## Routing

Implements the policy table in benchmark plan §14 and decisions D-015 to D-019.
The logic is a pure function in [`src/routing.ts`](src/routing.ts) and is tested
exhaustively in Node — a routing rule that can only be checked by hand on a phone
is a routing rule that silently rots.

| Condition | Route |
|---|---|
| Missing an essential capability | cloud, no override |
| AI operation | cloud GPU, no local override (D-019) |
| Result must survive the tab closing | cloud |
| Authoritative full-quality output | cloud, override allowed when local is also safe (D-017) |
| Beyond provisional local limits | cloud |
| Otherwise | local, **preview only** |

**The thresholds in `PROVISIONAL_LIMITS` are not measured.** They are conservative
starting points so the lab has something to compare against, and every local
decision says so in its reasons. Replacing them with real figures is the point of
running this on real devices.

Two details worth knowing:

- **No user-agent parsing.** Benchmark plan §9 requires feature detection, not
  user-agent assumptions. The user agent is *recorded* for the report but never
  feeds a decision.
- **Unreported `deviceMemory` never counts against a device.** It is Chromium-only;
  treating its absence as "unsuitable" would push every Firefox and Safari user to
  the cloud for no reason.

## Why output is always a preview

Canvas resampling is implementation-defined. It differs between browsers, and even
between GPU drivers on the same browser. Browser output is therefore **not**
byte-comparable with the server baseline, and the lab labels every result
`is_preview: true` with `deterministic_output: false`.

Compare **timings and dimensions** across the two, not hashes. That is a finding,
not a limitation to work around: it is precisely why AGENTS.md says browser output
is a preview unless explicitly eligible as final.

## Known limitations

Recorded in [`src/result.ts`](src/result.ts) as `BROWSER_LIMITATIONS` and emitted
with every run, so they travel with the data rather than living only here:

- Work stops when the tab closes; local processing cannot promise background
  continuation, so anything needing durability is routed to the cloud.
- A backgrounded tab is throttled, and timings taken while hidden are not
  comparable.
- A refresh discards all state. The lab deliberately persists nothing —
  keeping customer images in browser storage is a privacy decision nobody has taken.
- No browser API reports per-operation memory. `peak_rss_bytes` is recorded as `0`
  with the method stated, rather than fabricated.

## No bundler

The build is `tsc` and nothing else. Browsers resolve bare specifiers through the
import map in [`index.html`](index.html), and `rewriteRelativeImportExtensions`
turns `.ts` imports into `.js` on emit.

This is not minimalism for its own sake: every dependency is a licence-register
entry (D-039), and a bundler brings hundreds. The whole Node dependency surface is
`typescript` and `@types/node` — both types-and-tooling only, neither shipped.

## Not yet done

Real device measurement. The lab runs and is tested, but it has **not** been
executed on the device matrix in benchmark plan §9 — Chrome/Edge desktop, Safari,
a mid-range Android, an iPhone, a tablet. Until it has, `PROVISIONAL_LIMITS`
remain provisional and O-003 stays open.
