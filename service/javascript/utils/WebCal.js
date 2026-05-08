/*jslint node: true */
/*global Log, Future */

var crypto = require("crypto");
var childProcess = require("child_process");
var fs = require("fs");

var WebCal = (function () {
	"use strict";

	return {
		/*
		 * Fetch a public iCal URL via curl (respects system proxy for TLS bump).
		 * Returns future with: { returnValue, data, hash, calName, returnCode }
		 * hash is MD5 of raw response body — used as ctag for change detection.
		 * calName is from X-WR-CALNAME property if present.
		 *
		 * Downloads to a temp file to avoid exec's 2MB maxBuffer pre-allocation,
		 * which would otherwise push the process past the webOS OOM threshold for
		 * large feeds (e.g. 1.4MB Zoho calendars with 3000+ VEVENTs).
		 */
		fetch: function (url) {
			var future = new Future();
			var safeUrl = url.replace(/"/g, '\\"');
			var tempFile = "/tmp/webcal_" + process.pid + ".ics";
			// -k: accept proxy's re-signed cert; -s: silent; -L: follow redirects
			var cmd = '/usr/bin/curl -k -s -L -o "' + tempFile + '" "' + safeUrl + '"';

			Log.log("WebCal.fetch: " + cmd);

			childProcess.exec(cmd, {timeout: 60000}, function (error) {
				if (error) {
					Log.log("WebCal.fetch error for " + url + ": " + error.message);
					try { fs.unlinkSync(tempFile); } catch (e2) {}
					future.result = { returnValue: false, returnCode: -1 };
					return;
				}

				fs.readFile(tempFile, "utf8", function (readErr, data) {
					try { fs.unlinkSync(tempFile); } catch (e2) {}

					if (readErr || !data) {
						Log.log("WebCal.fetch readFile error for " + url + ": " + (readErr ? readErr.message : "empty response"));
						future.result = { returnValue: false, returnCode: -1 };
						return;
					}

					var hash = crypto.createHash("md5").update(data).digest("hex");

					var calName = null;
					var match = data.match(/^X-WR-CALNAME:(.+)$/m);
					if (match) {
						calName = match[1].trim();
					}

					future.result = {
						returnValue: true,
						data: data,
						hash: hash,
						calName: calName
					};
				});
			});

			return future;
		}
	};
}());

module.exports = WebCal;
