<?php
	# This test page checkes CSP only for browsers with "Content-Security-Policy" header support
	# i.e. no old WebKit or old Firefox
	#
	# script-src-attr 'unsafe-inline' is not a relaxation of what this test was
	# written to check. jQuery's event-support probe deliberately does
	#
	#     div.setAttribute( "onfocusin", "t" );
	#
	# (src/event/support.js, under a "Beware of CSP restrictions" comment) to
	# detect focusin support in engines where "onfocusin" in window is false,
	# which is every Firefox. The attribute is only ever inspected, never
	# executed, so CSP 1.0 -- all there was when this fixture was written --
	# reported nothing. CSP Level 3 added the script-src-attr directive, which
	# browsers enforce when the attribute is *set*, so a modern engine posts a
	# report-uri hit for that probe and the "No log request should be sent"
	# assertion fails at random depending on whether the report beats the log
	# fetch. Allowing inline handler attributes silences exactly that probe and
	# nothing else: default-src 'self' still governs script-src-elem, so eval,
	# injected inline <script> elements and off-origin resources -- what jQuery
	# is actually being tested for here -- all still report a violation.
	header("Content-Security-Policy: default-src 'self'; script-src-attr 'unsafe-inline'; report-uri csp-log.php");
?>
<!DOCTYPE html>
<html>
<head>
	<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
	<title>CSP Test Page</title>
	<script src="../../jquery.js"></script>
	<script src="csp.js"></script>
	<script src="getComputedSupport.js"></script>
</head>
<body>
	<p>CSP Test Page</p>
</body>
</html>
