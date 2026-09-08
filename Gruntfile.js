module.exports = function( grunt ) {
	"use strict";

	function readOptionalJSON( filepath ) {
		var data = {};
		try {
			data = grunt.file.readJSON( filepath );
		} catch ( e ) {}
		return data;
	}

	var gzip = require( "gzip-js" ),
		srcHintOptions = readOptionalJSON( "src/.jshintrc" );

	// The concatenated file won't pass onevar
	// But our modules can
	delete srcHintOptions.onevar;

	grunt.initConfig({
		pkg: grunt.file.readJSON( "package.json" ),
		dst: readOptionalJSON( "dist/.destination.json" ),
		compare_size: {
			files: [ "dist/jquery.js", "dist/jquery.min.js" ],
			options: {
				compress: {
					gz: function( contents ) {
						return gzip.zip( contents, {} ).length;
					}
				},
				cache: "build/.sizecache.json"
			}
		},
		build: {
			all: {
				dest: "dist/jquery.js",
				minimum: [
					"core",
					"selector"
				],
				removeWith: {
					ajax: [ "manipulation/_evalUrl" ],
					callbacks: [ "deferred" ],
					css: [ "effects", "dimensions", "offset" ]
				}
			}
		},
		bowercopy: {
			options: {
				clean: true
			},
			src: {
				files: {
					"src/sizzle/dist": "sizzle/dist",
					"src/sizzle/test/data": "sizzle/test/data",
					"src/sizzle/test/unit": "sizzle/test/unit",
					"src/sizzle/test/index.html": "sizzle/test/index.html",
					"src/sizzle/test/jquery.js": "sizzle/test/jquery.js"
				}
			},
			tests: {
				options: {
					destPrefix: "test/libs"
				},
				files: {
					"qunit": "qunit/qunit",
					"require.js": "requirejs/require.js",
					"sinon/fake_timers.js": "sinon/lib/sinon/util/fake_timers.js",
					"sinon/timers_ie.js": "sinon/lib/sinon/util/timers_ie.js"
				}
			}
		},
		jsonlint: {
			pkg: {
				src: [ "package.json" ]
			},

			bower: {
				src: [ "bower.json" ]
			}
		},
		jshint: {
			all: {
				src: [
					"src/**/*.js", "Gruntfile.js", "test/**/*.js", "build/tasks/*",
					"build/{bower-install,release-notes,release}.js"
				],
				options: {
					jshintrc: true
				}
			},
			dist: {
				src: "dist/jquery.js",
				options: srcHintOptions
			}
		},
		jscs: {
			src: "src/**/*.js",
			gruntfile: "Gruntfile.js",

			// Right know, check only test helpers
			test: [ "test/data/testrunner.js", "test/data/testinit.js" ],
			tasks: "build/tasks/*.js"
		},
		testswarm: {
			tests: "ajax attributes callbacks core css data deferred dimensions effects event manipulation offset queue selector serialize support traversing".split( " " )
		},
		watch: {
			files: [ "<%= jshint.all.src %>" ],
			tasks: "dev"
		},
		uglify: {
			all: {
				files: {
					"dist/jquery.min.js": [ "dist/jquery.js" ]
				},
				options: {
					preserveComments: false,
					sourceMap: "dist/jquery.min.map",
					sourceMappingURL: "jquery.min.map",
					report: "min",
					beautify: {
						ascii_only: true
					},
					// Year pinned to the 1.11.1 release year so every rebuild reproduces
					// the published dist/jquery.min.js banner instead of stamping the
					// current year.
					banner: "/*! jQuery v<%= pkg.version %> | " +
						"(c) 2005, 2014 jQuery Foundation, Inc. | " +
						"jquery.org/license */",
					compress: {
						hoist_funs: false,
						loops: false,
						unused: false
					}
				}
			}
		}
	});

	// Load grunt tasks from NPM packages
	require( "load-grunt-tasks" )( grunt );

	// Integrate jQuery specific tasks
	grunt.loadTasks( "build/tasks" );

	grunt.registerTask( "bower", "bowercopy" );
	grunt.registerTask( "lint", [ "jshint", "jscs" ] );

	// Short list as a high frequency watch task
	grunt.registerTask( "dev", [ "build:*:*", "lint" ] );

	// The build stamps the current date into the dist/jquery.js banner, so every
	// rebuild emits a different header. Pin it to the 1.11.1 release-build
	// timestamp so a sealed rebuild reproduces the published dist/jquery.js header.
	grunt.registerTask( "pin_build_date", function() {
		var file = "dist/jquery.js",
			date = "2014-05-01T17:42Z",
			rdate = /^ \* Date: .*$/m,
			contents = grunt.file.read( file );

		grunt.file.write( file, contents.replace( rdate, " * Date: " + date ) );
		grunt.log.writeln( "Pinned " + file + " build date to " + date );
	});

	// dist/cdn/ holds the CDN copies that jQuery's upstream release script -- not
	// grunt -- produced and published to code.jquery.com. The npm tarball ships
	// them, so a sealed rebuild has to emit them too. All nine are pure string
	// derivations of the three files "build:*:*" and "uglify" just wrote: the
	// plain, versioned and "latest" stems of dist/jquery.js verbatim; the same
	// three stems of dist/jquery.min.js with its trailing sourceMappingURL
	// comment removed; and dist/jquery.min.map verbatim plus one copy per
	// non-plain stem with its "file" and "sources" fields repointed at that stem.
	grunt.registerTask( "cdn_dist", function() {
		var dir = "dist/cdn/",
			dev = grunt.file.read( "dist/jquery.js" ),

			// The CDN minified copies carry no source map link, and stripping the
			// comment keeps the newline that precedes it.
			min = grunt.file.read( "dist/jquery.min.js" )
				.replace( /\/\/# sourceMappingURL=[^\n]*$/, "" ),
			map = grunt.file.read( "dist/jquery.min.map" ),
			stems = [ "jquery", "jquery-" + grunt.config( "pkg.version" ), "jquery-latest" ],
			write = function( name, contents ) {
				grunt.file.write( dir + name, contents );
				grunt.log.writeln( "Wrote " + dir + name + " (" +
					Buffer.byteLength( contents, "utf8" ) + " bytes)" );
			};

		stems.forEach(function( stem ) {

			// Both patterns include their JSON key, so neither can match the
			// "names" or "mappings" payload further down the map. For the plain
			// "jquery" stem each replacement rewrites the field with itself, which
			// is why that copy comes out byte-identical to dist/jquery.min.map.
			var stemMap = map
				.replace( "\"file\":\"jquery.min.js\"", "\"file\":\"" + stem + ".min.js\"" )
				.replace( "\"sources\":[\"jquery.js\"]", "\"sources\":[\"" + stem + ".js\"]" );

			write( stem + ".js", dev );
			write( stem + ".min.js", min );
			write( stem + ".min.map", stemMap );
		});
	});

	// Default grunt
	grunt.registerTask( "default", [ "jsonlint", "dev", "pin_build_date", "uglify", "cdn_dist", "dist:*", "compare_size" ] );
};
