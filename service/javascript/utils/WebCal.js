/*jslint node: true */
/*global Log, Future */

var crypto = require("crypto");
var childProcess = require("child_process");

var WebCal = (function () {
	"use strict";

	return {
		/*
		 * Fetch a public iCal URL via curl (respects system proxy for TLS bump).
		 * Returns future with: { returnValue, data, hash, calName, returnCode }
		 * hash is MD5 of raw response body — used as ctag for change detection.
		 * calName is from X-WR-CALNAME property if present.
		 */
		fetch: function (url) {
			var future = new Future();

			// Escape double-quotes in the URL for the shell command
			var safeUrl = url.replace(/"/g, '\\"');
			// -k: accept proxy's re-signed cert; -s: silent; -L: follow redirects
			var cmd = '/usr/bin/curl -k -s -L "' + safeUrl + '"';

			Log.log("WebCal.fetch: " + cmd);

			childProcess.exec(cmd, { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 }, function (error, stdout, stderr) {
				if (error || !stdout) {
					Log.log("WebCal.fetch error for " + url + ": " + (error ? error.message : "empty response"));
					future.result = { returnValue: false, returnCode: -1 };
					return;
				}

				var hash = crypto.createHash("md5").update(stdout).digest("hex");

				var calName = null;
				var match = stdout.match(/^X-WR-CALNAME:(.+)$/m);
				if (match) {
					calName = match[1].trim();
				}

				future.result = {
					returnValue: true,
					data: stdout,
					hash: hash,
					calName: calName
				};
			});

			return future;
		}
	};
}());

module.exports = WebCal;
