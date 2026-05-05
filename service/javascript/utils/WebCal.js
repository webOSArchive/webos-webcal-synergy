/*jslint node: true */
/*global Log, Future, httpClient, checkResult */

var crypto = require("crypto");

var WebCal = (function () {
	"use strict";

	return {
		/*
		 * Fetch a public iCal URL via plain HTTP/HTTPS GET.
		 * Returns future with: { returnValue, data, hash, calName, returnCode }
		 * hash is MD5 of raw response body — used as ctag for change detection.
		 * calName is from X-WR-CALNAME header property if present.
		 */
		fetch: function (url) {
			var future = new Future(), options = {};

			httpClient.parseURLIntoOptions(url, options);
			options.method = "GET";
			options.headers = options.headers || {};

			future.nest(httpClient.sendRequest(options));

			future.then(function fetchCB() {
				var result = checkResult(future), hash, calName, match;

				if (!result.returnValue) {
					Log.log("WebCal.fetch failed for " + url + " code=" + result.returnCode);
					future.result = { returnValue: false, returnCode: result.returnCode };
					return;
				}

				hash = crypto.createHash("md5").update(result.body).digest("hex");

				calName = null;
				match = result.body.match(/^X-WR-CALNAME:(.+)$/m);
				if (match) {
					calName = match[1].trim();
				}

				future.result = {
					returnValue: true,
					data: result.body,
					hash: hash,
					calName: calName
				};
			});

			return future;
		}
	};
}());

module.exports = WebCal;
