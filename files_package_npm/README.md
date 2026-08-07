# Obfuscation build

Turns your readable `code.js` / `ui.html` into a scrambled version that's
much harder to casually read or patch, before handing the plugin source to
your team.

## What this does — and doesn't — protect against

**Stops:** casually opening the file, searching for `licenseValid` or
`fetch(`, and flipping a value to bypass the license check. After this
build, those names don't exist anymore in the shipped code — everything is
renamed to things like `_0x4c53fd`, strings are base64-encoded in an array
and decoded at runtime, and control flow is flattened so the logic doesn't
read top-to-bottom anymore.

**Doesn't stop:** someone determined enough to spend real hours in DevTools
setting breakpoints, watching values change at runtime, and reverse
engineering the flattened logic step by step. No client-side JS obfuscation
can fully prevent this — the code still has to run in the person's own
browser/Figma instance, in the clear, eventually. This raises the bar a lot;
it doesn't make it impossible.

We deliberately left out two more aggressive options
(`debugProtection`, `selfDefending`) that detect DevTools/reformatting and
try to break the code in response. Figma's plugin UI runs in a somewhat
restrictive sandboxed iframe (we already ran into one surprise browser
restriction there with `localStorage`), so adding more runtime self-checks
risked introducing another hard-to-diagnose "why did this silently break"
bug. What's here is pure code transformation — no runtime tricks — so it's
much less likely to misbehave in that environment.

## Usage

```bash
cd obfuscate-build
npm install
npm run build
```

This reads `../usage-tracking/code.js` and `../usage-tracking/ui.html`
(adjust `SRC_DIR` in `build-obfuscated.js` to point at wherever your actual
source files live) and writes the obfuscated versions to `./dist/`.

**Give your team the files in `dist/`, not your original source.** Keep
developing in the readable originals; re-run `npm run build` and re-share
`dist/` whenever you update the plugin.

## After building — always test

Obfuscation is a code transformation, and while `javascript-obfuscator` is
mature and well-tested, always reload the plugin in Figma with the `dist/`
files and click through your core flows (license unlock, resize, batch,
export) before handing it out. If something breaks, the most likely fix is
loosening `controlFlowFlatteningThreshold` / `deadCodeInjectionThreshold` in
`build-obfuscated.js` (lower values = lighter transformation = lower risk).

## Why this specifically addresses the two bypass paths you asked about

- `licenseValid` no longer exists as a findable string in `code.js` — it's
  been renamed to a meaningless hex identifier, and the control-flow
  flattening means even someone who finds the right variable can't easily
  tell "set this to true" is the fix without tracing through obfuscated
  logic.
- `fetch(` is no longer a greppable literal in `ui.html` either — the
  obfuscator rewrites direct calls into indirect forms (passing `fetch` as
  an argument to a helper), so there's no single obvious line to delete.
