#!/usr/bin/env bash
#
# Run jQuery's QUnit unit-test suite headlessly and report the result.
#
#   test/headless/run.sh
#
# jQuery 1.11.x never shipped a headless test task: upstream ran test/index.html
# on the TestSwarm browser farm. This script is that missing task. It
#
#   1. serves the repository root over PHP's built-in server, because ~20 of the
#      ajax fixtures under test/data are .php files,
#   2. opens test/index.html in a headless browser -- Firefox first, then
#      Chrome/Chromium, then PhantomJS; see the engine notes further down for
#      why that order and not the other way round,
#   3. prints the per-module / per-test / per-assertion transcript that
#      test/headless/reporter.js posts back through test/headless/report.php, and
#   4. exits non-zero if any assertion failed, if the suite never finished, or if
#      the browser died on the way.
#
# Nothing here masks a failure. errexit stays on for the whole script, and the
# only path to a zero exit status is a suite that ran to completion and reported
# zero failed assertions.
#
# Environment overrides:
#   JQUERY_TEST_PORT     port for the PHP server         (default: first free
#                                                         port from 8080; an
#                                                         already-running server
#                                                         on that port is reused)
#   JQUERY_TEST_TIMEOUT  wall-clock budget in seconds    (default: 900)
#   JQUERY_TEST_BUILD    "dev" for dist/jquery.js,
#                        "min" for dist/jquery.min.js    (default: dev)
#   JQUERY_TEST_ENGINE   firefox | chrome | phantomjs    (default: try in that
#                                                         order)

set -euo pipefail

HEADLESS_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HEADLESS_DIR/../.." && pwd)

TIMEOUT=${JQUERY_TEST_TIMEOUT:-900}
BUILD=${JQUERY_TEST_BUILD:-dev}
RUN_ID="run$$"
TMP_BASE="${TMPDIR:-/tmp}/jquery-headless-${RUN_ID}"
LOG_FILE="${TMP_BASE}.log"
DONE_FILE="${TMP_BASE}.done"
SERVER_LOG="${TMP_BASE}.server.log"
BROWSER_LOG="${TMP_BASE}.browser.log"
PROFILE_DIR="${TMP_BASE}.profile"

SERVER_PID=""
BROWSER_PID=""

# The support module's CSP fixture (test/data/support/csp.php) points its
# report-uri at test/data/support/csp-log.php, which writes "error" into this
# tracked-but-empty file, and the test then asserts the file is empty. A run
# that is killed between the two, or a violation report that lands after
# csp-clean.php, leaves "error" behind and fails the *next* run for no reason.
# Truncating it on both ends keeps runs independent and the working tree clean.
CSP_LOG="$ROOT/test/data/support/csp.log"

cleanup() {
	if [ -n "$BROWSER_PID" ] && kill -0 "$BROWSER_PID" 2>/dev/null; then
		kill -TERM "$BROWSER_PID" 2>/dev/null
	fi
	if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill -TERM "$SERVER_PID" 2>/dev/null
	fi
	rm -rf "$PROFILE_DIR" "$LOG_FILE" "$DONE_FILE" "$SERVER_LOG" "$BROWSER_LOG"
	if [ -f "$CSP_LOG" ]; then
		: >"$CSP_LOG"
	fi
}
trap cleanup EXIT

die() {
	echo "test/headless/run.sh: $*" >&2
	exit 1
}

port_is_free() {
	! ( exec 3<>"/dev/tcp/127.0.0.1/$1" ) 2>/dev/null
}

pick_port() {
	local candidate

	if [ -n "${JQUERY_TEST_PORT:-}" ]; then
		echo "$JQUERY_TEST_PORT"
		return 0
	fi
	for candidate in $(seq 8080 8119); do
		if port_is_free "$candidate"; then
			echo "$candidate"
			return 0
		fi
	done
	die "no free TCP port in 8080-8119 for the PHP test server"
}

find_binary() {
	local candidate

	for candidate in "$@"; do
		if command -v "$candidate" >/dev/null 2>&1; then
			command -v "$candidate"
			return 0
		fi
	done
	return 1
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

case "$BUILD" in
	dev)
		DIST_FILE="dist/jquery.js"
		BUILD_PARAM="&dev=1"
		;;
	min)
		DIST_FILE="dist/jquery.min.js"
		BUILD_PARAM=""
		;;
	*)
		die "JQUERY_TEST_BUILD must be \"dev\" or \"min\", got \"$BUILD\""
		;;
esac

if [ ! -f "$ROOT/$DIST_FILE" ]; then
	die "$DIST_FILE is missing -- run the grunt build first (npm install && ./node_modules/.bin/grunt)"
fi

if ! command -v php >/dev/null 2>&1; then
	die "php is required: the ajax tests load ~20 .php fixtures from test/data"
fi

PORT=$(pick_port)
URL="http://127.0.0.1:${PORT}/test/index.html?headlessId=${RUN_ID}${BUILD_PARAM}"

echo "=== environment ==="
echo "root:      $ROOT"
echo "jquery:    $DIST_FILE"
echo "php:       $(php -r 'echo PHP_VERSION;')"
if command -v node >/dev/null 2>&1; then
	echo "node:      $(node -v)"
fi
echo

# ---------------------------------------------------------------------------
# PHP server
# ---------------------------------------------------------------------------

echo "=== php server ==="

if port_is_free "$PORT"; then

	# The built-in server is single-threaded before PHP 7.4; the ajax module
	# fires overlapping requests (and test/data/name.php can sleep), so fork
	# workers where the runtime supports it. Older runtimes ignore the variable.
	PHP_CLI_SERVER_WORKERS=8 php -S "127.0.0.1:${PORT}" -t "$ROOT" >"$SERVER_LOG" 2>&1 &
	SERVER_PID=$!
	echo "pid $SERVER_PID serving $ROOT on 127.0.0.1:${PORT}"

	for _ in $(seq 1 50); do
		if ! port_is_free "$PORT"; then
			break
		fi
		sleep 0.2
	done

	if port_is_free "$PORT"; then
		echo "--- php server log ---"
		cat "$SERVER_LOG"
		die "the PHP server never started listening on 127.0.0.1:${PORT}"
	fi
else

	# Something is already listening there -- on CI the server is started in
	# before_script so its log is part of the job output. Reuse it; the probes
	# below still prove it serves this suite, PHP included.
	echo "reusing the server already listening on 127.0.0.1:${PORT}"
fi

# Prove the suite and one of its PHP fixtures are actually reachable.
if command -v curl >/dev/null 2>&1; then
	for probe in "/test/index.html" "/test/data/name.php?name=foo" "/test/headless/report.php"; do
		STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}${probe}")
		echo "probe ${probe} -> HTTP ${STATUS}"
		case "$STATUS" in
			200|400) ;;
			*) die "unexpected HTTP ${STATUS} for ${probe}: the server cannot serve the suite" ;;
		esac
	done
fi
echo

# ---------------------------------------------------------------------------
# Browser
# ---------------------------------------------------------------------------

if [ -f "$CSP_LOG" ]; then
	: >"$CSP_LOG"
fi

echo "=== browser ==="

launch_firefox() {
	local binary=$1

	# A throwaway profile keeps the first-run tour, telemetry pings and update
	# checks out of the run.
	mkdir -p "$PROFILE_DIR"
	cat >"$PROFILE_DIR/user.js" <<-PREFS
		user_pref("browser.shell.checkDefaultBrowser", false);
		user_pref("browser.startup.homepage_override.mstone", "ignore");
		user_pref("browser.startup.page", 0);
		user_pref("datareporting.policy.dataSubmissionEnabled", false);
		user_pref("toolkit.telemetry.enabled", false);
		user_pref("app.update.enabled", false);
		user_pref("browser.tabs.remote.autostart", false);
		user_pref("dom.min_background_timeout_value", 4);
	PREFS

	MOZ_HEADLESS=1 "$binary" \
		--headless \
		--no-remote \
		--new-instance \
		--profile "$PROFILE_DIR" \
		--window-size 1280,1024 \
		"$URL" >"$BROWSER_LOG" 2>&1 &
	BROWSER_PID=$!
}

launch_chrome() {
	local binary=$1 major headless_flag

	major=$("$binary" --version | sed -n "s/[^0-9]*\([0-9]\{1,\}\).*/\1/p")

	# --headless=new only exists from Chrome 112; older builds take --headless.
	if [ -n "$major" ] && [ "$major" -ge 112 ]; then
		headless_flag="--headless=new"
	else
		headless_flag="--headless"
	fi

	mkdir -p "$PROFILE_DIR"

	# Timer throttling has to stay off: the effects and ajax modules depend on
	# setTimeout firing on schedule in a window that is never in the foreground.
	"$binary" \
		"$headless_flag" \
		--no-sandbox \
		--disable-gpu \
		--disable-dev-shm-usage \
		--no-first-run \
		--no-default-browser-check \
		--disable-background-timer-throttling \
		--disable-backgrounding-occluded-windows \
		--disable-renderer-backgrounding \
		--disable-ipc-flooding-protection \
		--disable-hang-monitor \
		--window-size=1280,1024 \
		--user-data-dir="$PROFILE_DIR" \
		"$URL" >"$BROWSER_LOG" 2>&1 &
	BROWSER_PID=$!
}

launch_phantomjs() {
	local binary=$1 openssl_conf=${OPENSSL_CONF:-}

	# PhantomJS 2.1.1 bundles an OpenSSL 1.0 that cannot parse the "providers"
	# section modern distributions put in /etc/ssl/openssl.cnf, and it aborts on
	# startup. Pointing it at an empty config clears that; the suite is plain
	# HTTP on localhost, so no TLS behaviour is lost.
	if ! "$binary" --version >/dev/null 2>&1; then
		openssl_conf="/dev/null"
		echo "note:      phantomjs needs OPENSSL_CONF=/dev/null on this host"
	fi

	OPENSSL_CONF="$openssl_conf" "$binary" "$HEADLESS_DIR/phantom.js" "$URL" \
		>"$BROWSER_LOG" 2>&1 &
	BROWSER_PID=$!
}

# Engine order is measured, not assumed. Against jQuery 1.11.1 on this suite:
#
#   firefox   full suite green.
#   chrome    fails "ajax: #14379 - jQuery.ajax() on unload": Chrome 80+
#             rejects synchronous XHR during page dismissal outright
#             (chromestatus 4664843055398912) and no command-line flag,
#             blink-feature or policy brings it back, so that test can only
#             pass on an engine that still allows it. Also fails
#             "offset: fractions (see #7730 and #7885)", where Blink's 1/64 px
#             LayoutUnit reports 999.984375 for an offset set to 1000.
#   phantomjs fails "core: jQuery.parseXML" (its WebKit DOMParser does not
#             report invalid XML), times out on three JSONP tests plus
#             overrideMimeType, and then crashes before QUnit.done.
#
# JQUERY_TEST_ENGINE=firefox|chrome|phantomjs pins the choice.
ENGINE=""
BROWSER=""

for candidate in ${JQUERY_TEST_ENGINE:-firefox chrome phantomjs}; do
	case "$candidate" in
		firefox)
			if BROWSER=$(find_binary firefox firefox-esr); then
				ENGINE="firefox"
			fi
			;;
		chrome)
			if BROWSER=$(find_binary google-chrome google-chrome-stable chromium chromium-browser chrome); then
				ENGINE="chrome"
			fi
			;;
		phantomjs)
			if BROWSER=$(find_binary phantomjs); then
				ENGINE="phantomjs"
			fi
			;;
		*)
			die "JQUERY_TEST_ENGINE must be firefox, chrome or phantomjs, got \"$candidate\""
			;;
	esac
	if [ -n "$ENGINE" ]; then
		break
	fi
done

if [ -z "$ENGINE" ]; then
	die "no headless engine found: install firefox, google-chrome/chromium or phantomjs"
fi

echo "engine:    $ENGINE -- $("$BROWSER" --version 2>&1 | head -n 1) ($BROWSER)"

case "$ENGINE" in
	firefox) launch_firefox "$BROWSER" ;;
	chrome) launch_chrome "$BROWSER" ;;
	phantomjs) launch_phantomjs "$BROWSER" ;;
esac

echo "pid $BROWSER_PID loading $URL"
echo "timeout:   ${TIMEOUT}s"
echo

# ---------------------------------------------------------------------------
# Wait for the in-page reporter
# ---------------------------------------------------------------------------

DEADLINE=$(( $(date +%s) + TIMEOUT ))
HEARTBEAT=0

while [ ! -f "$DONE_FILE" ]; do
	if [ "$(date +%s)" -ge "$DEADLINE" ]; then
		echo "--- transcript so far ---"
		if [ -f "$LOG_FILE" ]; then
			cat "$LOG_FILE"
		else
			echo "(the reporter never posted anything)"
		fi
		echo "--- browser output ---"
		cat "$BROWSER_LOG"
		if [ -f "$SERVER_LOG" ]; then
			echo "--- php server log (tail) ---"
			tail -n 40 "$SERVER_LOG"
		fi
		die "the suite did not finish within ${TIMEOUT}s"
	fi

	if ! kill -0 "$BROWSER_PID" 2>/dev/null; then
		# Chrome forks and the launcher process can exit while the browser
		# lives on, so only treat this as fatal when nothing was reported.
		sleep 3
		if [ ! -f "$DONE_FILE" ]; then
			echo "--- transcript so far ---"
			if [ -f "$LOG_FILE" ]; then
				cat "$LOG_FILE"
			else
				echo "(the reporter never posted anything)"
			fi
			echo "--- browser output ---"
			cat "$BROWSER_LOG"
			die "the $ENGINE process exited before the suite finished"
		fi
	fi

	HEARTBEAT=$(( HEARTBEAT + 1 ))
	if [ $(( HEARTBEAT % 15 )) -eq 0 ] && [ -f "$LOG_FILE" ]; then
		echo "[running] $(wc -l <"$LOG_FILE" | tr -d " ") transcript lines: $(tail -n 1 "$LOG_FILE")"
	fi
	sleep 1
done

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

echo "=== qunit transcript ==="
cat "$LOG_FILE"
echo

FAILED=$(cat "$DONE_FILE")

if [ -s "$BROWSER_LOG" ]; then
	echo "=== browser output ==="
	cat "$BROWSER_LOG"
	echo
fi

if [ "$FAILED" = "0" ]; then
	echo "test/headless/run.sh: the QUnit suite passed with 0 failed assertions"
	exit 0
fi

echo "test/headless/run.sh: the QUnit suite reported ${FAILED} failed assertion(s)" >&2
exit 1
