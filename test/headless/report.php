<?php
/**
 * Sink for the headless QUnit reporter (test/headless/reporter.js).
 *
 * The browser has no other way to hand its transcript back to the shell, so it
 * POSTs the running transcript here and this script parks it in the system temp
 * directory where test/headless/run.sh picks it up:
 *
 *   <tmp>/jquery-headless-<id>.log    the transcript (rewritten on every POST)
 *   <tmp>/jquery-headless-<id>.done   written only by the final POST; contains
 *                                     the number of failed assertions
 *
 * run.sh waits for the .done file, prints the .log and exits non-zero when the
 * .done file does not read exactly "0".
 */

header( "Content-Type: text/plain" );
header( "Cache-Control: no-cache, no-store, must-revalidate" );

$id = isset( $_GET["id"] ) ? preg_replace( "/[^A-Za-z0-9_-]/", "", $_GET["id"] ) : "";

if ( $id === "" ) {
	header( "HTTP/1.1 400 Bad Request" );
	echo "missing id\n";
	return;
}

$base = sys_get_temp_dir() . "/jquery-headless-" . $id;
$body = file_get_contents( "php://input" );

// Write-then-rename so run.sh never reads a half-written transcript.
$tmp = $base . ".log." . getmypid();
file_put_contents( $tmp, $body );
rename( $tmp, $base . ".log" );

if ( isset( $_GET["final"] ) ) {
	$failed = isset( $_GET["failed"] ) ? preg_replace( "/[^0-9]/", "", $_GET["failed"] ) : "";
	if ( $failed === "" ) {
		$failed = "1";
	}
	$tmp = $base . ".done." . getmypid();
	file_put_contents( $tmp, $failed );
	rename( $tmp, $base . ".done" );
}

echo "ok\n";
