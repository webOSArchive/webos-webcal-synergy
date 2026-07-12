/*jslint node: true */
/*global Log, Future */

var crypto = require("crypto");
var childProcess = require("child_process");
var fs = require("fs");

var WebCal = (function () {
	"use strict";

	// Monotonic counter making every download target unique within this process.
	// The service process is long-lived and two sync runs can overlap (e.g. a
	// manual "Sync Now" during a periodic sync). A temp file named only by pid
	// was shared across all fetches, so an overlapping curl for one feed could
	// overwrite the file while another feed's readFile was reading it — the
	// victim folder then parsed the wrong feed's data and wrote those events
	// under its own calendar. Per-fetch unique names remove that race entirely.
	var fetchCounter = 0;

	// Check if buf[pos] starts with "DTSTAMP:" (8 bytes).
	function startsWithDTSTAMP(buf, pos) {
		return pos + 8 <= buf.length &&
			buf[pos]   === 68 && buf[pos+1] === 84 && buf[pos+2] === 83 &&
			buf[pos+3] === 84 && buf[pos+4] === 65 && buf[pos+5] === 77 &&
			buf[pos+6] === 80 && buf[pos+7] === 58;
	}

	// Check if buf[pos] starts with "X-WR-CALNAME:" (13 bytes).
	function startsWithXWR(buf, pos) {
		return pos + 13 <= buf.length &&
			buf[pos]    === 88  && buf[pos+1]  === 45  && buf[pos+2]  === 87  &&
			buf[pos+3]  === 82  && buf[pos+4]  === 45  && buf[pos+5]  === 67  &&
			buf[pos+6]  === 65  && buf[pos+7]  === 76  && buf[pos+8]  === 78  &&
			buf[pos+9]  === 65  && buf[pos+10] === 77  && buf[pos+11] === 69  &&
			buf[pos+12] === 58;
	}

	return {
		/*
		 * Fetch a public iCal URL via curl (respects system proxy for TLS bump).
		 * Returns future with: { returnValue, data, hash, calName, returnCode }
		 * or { returnValue, hashMatch, hash, calName } when storedCtag matches.
		 *
		 * hash is the DTSTAMP-stripped MD5 — used as ctag for change detection.
		 * calName is from X-WR-CALNAME property if present.
		 *
		 * Downloads to a temp file, then scans it as a Buffer to compute the
		 * stable hash with zero V8 string allocations.  If storedCtag is provided
		 * and the hash matches, returns hashMatch:true without ever converting the
		 * Buffer to a JS string — keeping hash-stable calendars out of V8 heap
		 * so there is headroom for the one calendar that does need re-parsing.
		 */
		fetch: function (url, storedCtag) {
			var future = new Future();
			var safeUrl = url.replace(/"/g, '\\"');
			// Unique per fetch: pid + url hash + monotonic counter. Two overlapping
			// sync runs (or two folders) never share a download target.
			var urlHash = crypto.createHash("md5").update(url).digest("hex").slice(0, 8);
			fetchCounter += 1;
			var tempFile = "/tmp/webcal_" + process.pid + "_" + urlHash + "_" + fetchCounter + ".ics";
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

				fs.readFile(tempFile, function (readErr, buf) {
					try { fs.unlinkSync(tempFile); } catch (e2) {}

					if (readErr || !buf || !buf.length) {
						Log.log("WebCal.fetch readFile error for " + url + ": " + (readErr ? readErr.message : "empty response"));
						future.result = { returnValue: false, returnCode: -1 };
						return;
					}

					// Scan the Buffer line-by-line to compute the DTSTAMP-stripped
					// stable hash and extract X-WR-CALNAME.  Buffer.slice() creates
					// views (no copy), so this loop allocates no new V8 string memory.
					var hasher = crypto.createHash("md5");
					var pos = 0, nl, i, nameEnd, calName = null;

					while (pos < buf.length) {
						nl = -1;
						for (i = pos; i < buf.length; i += 1) {
							if (buf[i] === 10) { nl = i; break; }
						}

						if (!calName && startsWithXWR(buf, pos)) {
							nameEnd = (nl !== -1) ? nl : buf.length;
							if (nameEnd > 0 && buf[nameEnd - 1] === 13) { nameEnd -= 1; }
							calName = buf.slice(pos + 13, nameEnd).toString("utf8").trim();
						}

						if (!startsWithDTSTAMP(buf, pos)) {
							// Old Node.js on webOS does not accept Buffer in hash.update();
							// convert to binary string (1 byte per char) line-by-line so
							// peak allocation stays at one line (~a few hundred bytes), not
							// the full 1.78MB ICS string.
							hasher.update(nl === -1 ? buf.slice(pos).toString("binary") : buf.slice(pos, nl + 1).toString("binary"), "binary");
						}

						if (nl === -1) { break; }
						pos = nl + 1;
					}

					var stableHash = hasher.digest("hex");

					// If the caller supplied a stored ctag and it matches, the feed
					// is unchanged — return without ever converting the Buffer to a
					// JS string.  This keeps 1.4 MB out of the V8 heap so the process
					// that does need a full re-parse has more headroom.
					if (storedCtag && stableHash === storedCtag) {
						future.result = {
							returnValue: true,
							hashMatch: true,
							hash: stableHash,
							calName: calName
						};
						return;
					}

					// Hash mismatch (or no storedCtag): convert to string for processing.
					var data = buf.toString("utf8");
					buf = null;

					future.result = {
						returnValue: true,
						data: data,
						hash: stableHash,
						calName: calName
					};
				});
			});

			return future;
		}
	};
}());

module.exports = WebCal;
