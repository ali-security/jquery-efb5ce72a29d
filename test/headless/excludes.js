/**
 * Deny-list of individual QUnit tests that test/headless/reporter.js refuses to
 * register, for tests that genuinely cannot run in a headless browser.
 *
 * The list is currently EMPTY: headless Firefox runs all 800 tests of the
 * jQuery 1.11.1 suite green, so nothing is skipped. It is kept because it is
 * the only sanctioned exclusion mechanism for this runner -- run.sh prints
 * every entry on every run, so a reviewer always sees what was skipped and why.
 *
 * Rules for adding an entry:
 *   - one entry excludes exactly one test; whole modules are never excluded,
 *   - nothing from unit/ajax.js, unit/attributes.js, unit/core.js or
 *     unit/support.js may ever be listed: those modules carry the coverage the
 *     backported CVE patches rely on. A failure there is a harness bug (wrong
 *     engine, wrong server, too short a timeout) and has to be fixed as one,
 *   - "reason" states what the headless environment cannot provide.
 *
 * Entry shape:
 *   module - QUnit module name the test is registered under
 *   name   - exact test name as passed to test() / asyncTest()
 *   reason - why the test cannot run headlessly
 */

window.headlessExcludes = [
];
