# Headless QUnit runner

jQuery 1.11.x shipped no headless test task. `grunt` only lints, builds and
packages; upstream ran `test/index.html` on the TestSwarm browser farm, so a CI
job that only ran `npm test` never executed a single unit test.

This directory is that missing task.

```bash
./test/headless/run.sh
```

Nothing here ships in the npm tarball — `.npmignore` excludes `/test`.

## What it does

1. Serves the repository root with PHP's built-in server. The suite needs PHP:
   about twenty of the ajax fixtures under `test/data` are `.php` files, and
   `README.md`'s "Running the Unit Tests" section says as much.
   `PHP_CLI_SERVER_WORKERS=8` makes the server fork so the overlapping ajax
   requests are not serialised.
2. Opens `test/index.html?headlessId=<id>&dev=1` in a headless browser
   (`&dev=1` makes `test/jquery.js` load `dist/jquery.js` rather than the
   minified build; `JQUERY_TEST_BUILD=min` switches that around).
3. `reporter.js`, loaded by `test/index.html`, hooks QUnit's `moduleStart`,
   `testDone`, `log`, `moduleDone` and `done` callbacks and POSTs the growing
   transcript to `report.php`, which parks it in the system temp directory.
   `run.sh` prints it and exits non-zero when any assertion failed, when the
   suite never finished, or when the browser died first.

`reporter.js` and `excludes.js` are inert unless the URL carries `headlessId`,
so opening `test/index.html` by hand is unaffected.

### Files

| File | Role |
|------|------|
| `run.sh` | orchestrator: server, engine, timeout, exit code |
| `reporter.js` | in-page QUnit reporter and exclusion gate |
| `excludes.js` | deny-list of individually excluded tests (currently empty) |
| `report.php` | receives the transcript from the browser |
| `phantom.js` | page opener for the PhantomJS engine |

### Environment overrides

| Variable | Default | Meaning |
|----------|---------|---------|
| `JQUERY_TEST_PORT` | first free port from 8080 | port for the PHP server; if something already listens there it is reused instead of started |
| `JQUERY_TEST_TIMEOUT` | 900 | wall-clock budget in seconds |
| `JQUERY_TEST_BUILD` | `dev` | `dev` for `dist/jquery.js`, `min` for `dist/jquery.min.js` |
| `JQUERY_TEST_ENGINE` | `firefox chrome phantomjs` | pin the engine |

## Why Firefox

Engine order is measured, not assumed. Against the 1.11.1 suite:

| Engine | Result |
|--------|--------|
| Firefox (154, headless) | 800 tests / 6081 assertions, all green |
| Chrome (152, headless) | fails `ajax: #14379 - jQuery.ajax() on unload` and `offset: fractions (see #7730 and #7885)` |
| PhantomJS 2.1.1 | fails `core: jQuery.parseXML`, times out on three JSONP tests and on `ajax: jQuery.ajax() - overrideMimeType`, then crashes before `QUnit.done` |

Chrome's ajax failure is not fixable from here. `test/data/ajax/onunload.html`
issues a synchronous `jQuery.ajax()` from an `unload` handler, and Chrome 80+
rejects synchronous XHR during page dismissal outright
(<https://www.chromestatus.com/feature/4664843055398912>). Neither
`--disable-blink-features=ForbidSyncXHRInPageDismissal`, nor
`--enable-blink-features=SyncXHRInPageDismissal`, nor the retired
`AllowSyncXHRInPageDismissal` policy brings it back — the strings are not even
in the binary any more — and `unload`, `pagehide`, `beforeunload` and
iframe removal all behave the same. `test/unit/ajax.js` may not have tests
excluded from it, so the engine had to change instead.

PhantomJS's `core: jQuery.parseXML` failure ("invalid xml not detected", its
WebKit `DOMParser` does not report malformed XML) is in the same category:
`test/unit/core.js` is not excludable either.

Firefox has never implemented the sync-XHR-in-dismissal block, reports invalid
XML from `DOMParser`, and returns integral offsets for the `offset: fractions`
test, so the whole suite runs green there with no exclusions at all.

## Excluded tests

None. `excludes.js` is empty.

If a test ever has to be excluded, add it there with a reason — `run.sh` prints
every entry on every run. Two rules:

- one entry excludes exactly one test; whole modules are never excluded;
- nothing from `test/unit/ajax.js`, `test/unit/attributes.js`,
  `test/unit/core.js` or `test/unit/support.js` may be listed. Those modules
  carry the coverage the backported security patches depend on, so a failure
  there is a harness bug — wrong engine, wrong server, too short a timeout —
  and has to be fixed as one.

## Fixture changes made for modern engines

- `test/data/support/csp.php` now sends
  `default-src 'self'; script-src-attr 'unsafe-inline'; report-uri csp-log.php`.
  jQuery's event-support probe does `div.setAttribute( "onfocusin", "t" )` in
  any engine where `"onfocusin" in window` is false, which is every Firefox.
  The attribute is only inspected, never executed, so CSP 1.0 — all that
  existed when the fixture was written — reported nothing. CSP Level 3 added
  `script-src-attr`, which is enforced when the attribute is *set*, so a modern
  engine posts a report-uri hit and `support: Check CSP ... restrictions`
  failed roughly half the time depending on whether that report beat the
  `csp.log` fetch. `default-src 'self'` still covers `script-src-elem`, so
  eval, injected inline `<script>` elements and off-origin loads — the things
  the test exists to catch — are still reported. The fixture change is what
  makes that must-run test deterministic; nothing is skipped.
- `run.sh` truncates `test/data/support/csp.log` before and after each run.
  `csp-log.php` writes into that tracked-but-empty file, so a run killed
  between the violation report and `csp-clean.php` used to fail the *next* run
  and leave the working tree dirty.
