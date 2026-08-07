// build-obfuscated.js
// Usage: node build-obfuscated.js
// Reads ../usage-tracking/code.js and ui.html, produces obfuscated versions
// in ./dist/.

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SRC_DIR = path.join(__dirname, '..', 'usage-tracking');
const OUT_DIR = path.join(__dirname, 'dist');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Strong-but-safe settings: heavy obfuscation on control flow, identifiers,
// and strings. debugProtection/selfDefending are deliberately OFF — those
// rely on runtime self-checks (Function.toString, DevTools detection) that
// can behave unpredictably in sandboxed iframes, which is exactly the kind
// of environment Figma's plugin UI runs in (we already hit one surprise
// restriction there with localStorage). Better to keep this to pure code
// transformations that can't silently break the plugin.
// renameGlobals is OFF — code.js relies on the `figma` global provided by
// the Figma runtime, and ui.html relies on `window`/`document`/`fetch`/etc.
// Renaming those would break the plugin, not just obscure it.
const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: false,
  disableConsoleOutput: false, // keep console.log for your own debugging; flip to true before real distribution if you want
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  rotateStringArray: true,
  selfDefending: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.9,
  splitStrings: true,
  splitStringsChunkLength: 6,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

function obfuscate(code) {
  return JavaScriptObfuscator.obfuscate(code, OBFUSCATOR_OPTIONS).getObfuscatedCode();
}

// ── code.js ─────────────────────────────────────────────────────────────
// Wrapped in an IIFE first: without this, every top-level `var`/`function`
// in the file is technically "global scope" as far as the obfuscator is
// concerned, and identifier renaming skips those to avoid breaking anything
// external that might reference them. Wrapping makes everything we declared
// local to the function, so names like licenseValid/requiresLicense/etc.
// actually get renamed instead of surviving in plain text. `figma` is still
// reachable from inside via the closure — it's a real external global, not
// something we declared, so it's untouched either way.
const codeJs = fs.readFileSync(path.join(SRC_DIR, 'code.js'), 'utf8');
const wrappedCodeJs = '(function(){\n' + codeJs + '\n})();';
const obfuscatedCodeJs = obfuscate(wrappedCodeJs);
fs.writeFileSync(path.join(OUT_DIR, 'code.js'), obfuscatedCodeJs);
console.log(
  'code.js: ' + codeJs.length + ' → ' + obfuscatedCodeJs.length + ' bytes'
);

// ── ui.html (obfuscate only the inline <script>…</script> block) ───────
const uiHtml = fs.readFileSync(path.join(SRC_DIR, 'ui.html'), 'utf8');

// Matches the LAST <script> ... </script> pair with no src attribute —
// i.e. the inline logic block, not the three CDN <script src="..."> tags.
const scriptRegex = /(<script>)([\s\S]*?)(<\/script>)(?![\s\S]*<script>)/;
const match = uiHtml.match(scriptRegex);

if (!match) {
  console.error('Could not find the inline <script> block in ui.html — aborting.');
  process.exit(1);
}

const innerJs = match[2];
const wrappedInnerJs = '(function(){\n' + innerJs + '\n})();';
const obfuscatedInnerJs = obfuscate(wrappedInnerJs);
const obfuscatedHtml = uiHtml.replace(scriptRegex, '$1' + obfuscatedInnerJs + '$3');

fs.writeFileSync(path.join(OUT_DIR, 'ui.html'), obfuscatedHtml);
console.log(
  'ui.html inline script: ' + innerJs.length + ' → ' + obfuscatedInnerJs.length + ' bytes'
);

console.log('\nDone. Obfuscated files are in ./dist/');
