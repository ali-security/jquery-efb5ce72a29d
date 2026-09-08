/**
 * PhantomJS page opener for the headless QUnit run.
 *
 * Usage: phantomjs test/headless/phantom.js <url>
 *
 * All reporting is done in the page by test/headless/reporter.js, which POSTs
 * its transcript to test/headless/report.php; this script only has to open the
 * page and stay alive. test/headless/run.sh owns the timeout and the exit code,
 * so the only thing that ends this process early is a page-level load failure.
 *
 * ES5 only — the same style constraint as the rest of test/headless.
 */

/* global phantom: false */

( function() {
	"use strict";

	var system = require( "system" ),
		webpage = require( "webpage" ),
		url = system.args[ 1 ],
		page = webpage.create();

	if ( !url ) {
		console.log( "phantom.js: no url argument" );
		phantom.exit( 2 );
	}

	page.viewportSize = { width: 1280, height: 1024 };

	page.onConsoleMessage = function( message ) {
		console.log( "[page] " + message );
	};

	page.onError = function( message ) {
		console.log( "[page error] " + message );
	};

	page.onResourceError = function( error ) {
		console.log( "[page resource error] " + error.url + " -> " + error.errorString );
	};

	console.log( "phantomjs " + phantom.version.major + "." + phantom.version.minor +
		"." + phantom.version.patch + " opening " + url );

	page.open( url, function( status ) {
		if ( status !== "success" ) {
			console.log( "phantom.js: failed to open " + url + " (" + status + ")" );
			phantom.exit( 3 );
		}
		console.log( "phantom.js: page opened, waiting for the suite to finish" );
	});

}() );
