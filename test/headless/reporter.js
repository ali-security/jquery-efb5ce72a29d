/**
 * Headless QUnit reporter for the jQuery test suite.
 *
 * test/index.html loads this file right after test/data/testinit.js. It stays
 * completely inert unless the page URL carries a "headlessId" parameter, so a
 * human opening test/index.html in a browser sees exactly the same suite as
 * before.
 *
 * When "headlessId" is present it:
 *   1. drops the individual tests listed in test/headless/excludes.js before
 *      they are registered (the only supported exclusion mechanism),
 *   2. records a per-module / per-test / per-assertion transcript, and
 *   3. POSTs that transcript to test/headless/report.php, which parks it in a
 *      file that test/headless/run.sh reads. The final POST carries
 *      "final=1&failed=<n>", which is what makes run.sh stop waiting.
 *
 * Only the transport lives here; run.sh owns the process exit code.
 */

/* global QUnit: false */

( function( window ) {
	"use strict";

	var document = window.document,
		runId = urlParam( "headlessId" ),
		reportUrl = "headless/report.php",

		// Transcript lines, in emission order. Posted verbatim.
		lines = [],

		// Failed assertions of the test currently running.
		currentFailures = [],

		// { module: ..., name: ..., reason: ... } for every denied test we
		// refused to register.
		skipped = [],

		// Registered / executed test counts, used for the "collected" line.
		registered = 0,
		executed = 0,
		modulesSeen = 0,

		// Per-module recap, printed again as a table in the summary.
		moduleSummaries = [],
		moduleTests = 0,
		moduleStarted = 0,

		// Throttle: the transcript is posted at most this often while the
		// suite runs. Timers are deliberately avoided (the effects and ajax
		// modules install sinon fake timers), so posting is driven by
		// testDone instead.
		postIntervalMs = 3000,
		lastPost = 0,

		// QUnit.load() runs the "begin" callbacks, and test/data/testinit.js
		// calls QUnit.load() itself on top of QUnit's own window-load binding,
		// so "begin" fires twice. Only the first one is real.
		begun = false,
		finished = false,

		// QUnit.asyncTest() delegates to QUnit.test(), which is wrapped too, so
		// registration has to be counted only at the outermost call.
		registering = false;

	if ( !runId ) {
		return;
	}

	function urlParam( name ) {
		var match = new RegExp( "[?&]" + name + "=([^&]*)" ).exec( window.location.search );
		return match ? decodeURIComponent( match[ 1 ] ) : "";
	}

	function emit( line ) {
		lines.push( line );
	}

	function pad( value, width ) {
		var text = "" + value;
		while ( text.length < width ) {
			text = " " + text;
		}
		return text;
	}

	function describe( value ) {
		var text;
		try {
			text = typeof value === "string" ? value : QUnit.jsDump.parse( value );
		} catch ( e ) {
			text = "<undumpable>";
		}
		text = ( "" + text ).replace( /\s+/g, " " );
		if ( text.length > 300 ) {
			text = text.slice( 0, 300 ) + "...";
		}
		return text;
	}

	// Raw XMLHttpRequest, never jQuery.ajax: the suite asserts on jQuery.active
	// after every test, so the reporter must stay invisible to it.
	function post( query, body ) {
		var xhr = new window.XMLHttpRequest();
		xhr.open( "POST", reportUrl + "?id=" + encodeURIComponent( runId ) + query, true );
		xhr.setRequestHeader( "Content-Type", "text/plain" );
		xhr.send( body );
	}

	// Progress snapshot. The transcript is rewritten whole on every POST, so a
	// dropped snapshot only costs freshness, never content.
	function flush( immediate ) {
		var now = new Date().getTime();
		if ( !immediate && now - lastPost < postIntervalMs ) {
			return;
		}
		lastPost = now;
		post( "", lines.join( "\n" ) + "\n" );
	}

	// The one POST that tells run.sh to stop waiting and what to exit with.
	function finish( failedCount ) {
		post( "&final=1&failed=" + failedCount, lines.join( "\n" ) + "\n" );
	}

	function isExcluded( module, name ) {
		var i, entry,
			list = window.headlessExcludes || [];

		for ( i = 0; i < list.length; i++ ) {
			entry = list[ i ];
			if ( entry.module === module && entry.name === name ) {
				return entry;
			}
		}
		return null;
	}

	// Wrap test registration so denied tests are never handed to QUnit.
	// QUnit.config.requireExpects is on, so a placeholder test would have to
	// fake an expect() call; dropping the registration keeps the counts honest.
	function guard( original ) {
		return function( testName ) {
			var entry;

			if ( registering ) {
				return original.apply( this, arguments );
			}

			entry = isExcluded( QUnit.config.currentModule, testName );
			if ( entry ) {
				skipped.push({
					module: QUnit.config.currentModule,
					name: testName,
					reason: entry.reason
				});
				return;
			}

			registered++;
			registering = true;
			try {
				return original.apply( this, arguments );
			} finally {
				registering = false;
			}
		};
	}

	QUnit.test = window.test = guard( QUnit.test );
	QUnit.asyncTest = window.asyncTest = guard( QUnit.asyncTest );

	emit( "=== jQuery headless QUnit run ===" );
	emit( "run id:    " + runId );
	emit( "page url:  " + window.location.href );
	emit( "user agent: " + window.navigator.userAgent );

	QUnit.begin(function() {
		if ( begun ) {
			return;
		}
		begun = true;
		emit( "" );
		emit( "collected " + registered + " tests (" + skipped.length + " excluded by " +
			"test/headless/excludes.js)" );
		emit( "" );
		flush( true );
	});

	QUnit.moduleStart(function( details ) {
		modulesSeen++;
		moduleTests = 0;
		moduleStarted = new Date().getTime();
		emit( "--- module: " + details.name + " ---" );
	});

	QUnit.log(function( details ) {
		if ( details.result ) {
			return;
		}
		currentFailures.push( details );
	});

	QUnit.testStart(function() {
		currentFailures = [];
	});

	QUnit.testDone(function( details ) {
		var i, failure;

		executed++;
		moduleTests++;
		emit( ( details.failed > 0 ? "  FAIL " : "  ok   " ) +
			pad( executed, 4 ) + ". " +
			( details.module ? details.module + ": " : "" ) + details.name +
			" (" + details.total + " assertions, " + details.failed + " failed, " +
			details.runtime + " ms)" );

		for ( i = 0; i < currentFailures.length; i++ ) {
			failure = currentFailures[ i ];
			emit( "         x " + ( failure.message || "(no message)" ) );
			if ( "expected" in failure ) {
				emit( "           expected: " + describe( failure.expected ) );
				emit( "           actual:   " + describe( failure.actual ) );
			}
			if ( failure.source ) {
				emit( "           source:   " + describe( failure.source ) );
			}
		}
		currentFailures = [];

		flush( false );
	});

	QUnit.moduleDone(function( details ) {
		var runtime = new Date().getTime() - moduleStarted;

		moduleSummaries.push({
			name: details.name,
			tests: moduleTests,
			total: details.total,
			passed: details.passed,
			failed: details.failed,
			runtime: runtime
		});

		emit( "--- module done: " + details.name +
			" | tests: " + moduleTests +
			" | assertions: " + details.total +
			" passed: " + details.passed +
			" failed: " + details.failed +
			" | " + runtime + " ms ---" );
		emit( "" );
		flush( false );
	});

	QUnit.done(function( details ) {
		var i, entry,
			resultNode = document.getElementById( "qunit-testresult" );

		if ( finished ) {
			return;
		}
		finished = true;

		emit( "=== per-module results ===" );
		emit( "  module                tests  assertions  passed  failed" );
		for ( i = 0; i < moduleSummaries.length; i++ ) {
			entry = moduleSummaries[ i ];
			emit( "  " + entry.name +
				new Array( Math.max( 1, 22 - entry.name.length ) ).join( " " ) +
				pad( entry.tests, 5 ) +
				pad( entry.total, 12 ) +
				pad( entry.passed, 8 ) +
				pad( entry.failed, 8 ) );
		}
		emit( "" );

		emit( "=== summary ===" );
		emit( "modules executed:    " + modulesSeen );
		emit( "tests collected:     " + registered );
		emit( "tests executed:      " + executed );
		emit( "assertions total:    " + details.total );
		emit( "assertions passed:   " + details.passed );
		emit( "assertions failed:   " + details.failed );
		emit( "runtime:             " + details.runtime + " ms" );
		emit( "qunit-testresult:    " +
			( resultNode ? resultNode.innerText || resultNode.textContent : "(missing)" )
				.replace( /\s+/g, " " ) );

		emit( "excluded tests:      " + skipped.length );
		for ( i = 0; i < skipped.length; i++ ) {
			entry = skipped[ i ];
			emit( "  - " + entry.module + ": " + entry.name + " -- " + entry.reason );
		}

		emit( "result: " + ( details.failed > 0 ? "FAILED" : "PASSED" ) );
		finish( details.failed );
	});

}( window ) );
