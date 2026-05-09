/*
 * SyncAssistant — WebCal read-only iCal subscription sync.
 * Fetches public .ics URLs via plain HTTP GET, uses MD5 content hash for
 * change detection (stored as ctag), and parses all VEVENTs into webOS
 * calendar events.  No upsync, no auth, no CalDAV.
 */
/*jslint nomen: true, node: true */
/*global Log, Class, Sync, Kinds, Future, DB, PalmCall, checkResult, libPath, iCal, WebCal, searchAccountConfig */
/*exported SyncAssistant */

var SyncKey = require(libPath + "SyncKey.js");
var CalendarEventHandler = require(libPath + "CalendarEventHandler.js");
var SyncStatus = require(libPath + "SyncStatus.js");
var WebCal = require(libPath + "WebCal.js");
var fs = require("fs");

// Strip ATTENDEE lines from the single VEVENT that contains badLine.
// Used as a targeted recovery when the iCal parser throws on a malformed attendee.
function stripAttendeesFromEventWithLine(data, badLine) {
	"use strict";
	var result = [], pos = 0, veventStart, veventEnd, vevent;
	while (pos < data.length) {
		veventStart = data.indexOf("BEGIN:VEVENT", pos);
		if (veventStart === -1) { result.push(data.slice(pos)); break; }
		result.push(data.slice(pos, veventStart));
		veventEnd = data.indexOf("END:VEVENT", veventStart);
		if (veventEnd === -1) { result.push(data.slice(veventStart)); break; }
		veventEnd += 10; // include "END:VEVENT"
		vevent = data.slice(veventStart, veventEnd);
		if (vevent.indexOf(badLine) !== -1) {
			vevent = vevent.replace(/^ATTENDEE[^\r\n]*(\r\n[ \t][^\r\n]*)*/mg, "");
		}
		result.push(vevent);
		pos = veventEnd;
	}
	return result.join("");
}

// Stable remoteId for the account-level meta calendar.
// Its presence makes every account have 2+ calendars, so CalendarsManager uses
// cal.name (not rawAccount.alias) for each calendar's showName.
var META_REMOTE_ID = "webcal-meta";

// Fire-and-forget: update the calendars[].name in the account config record
// so the companion app shows the feed's X-WR-CALNAME instead of the raw URL.
// Only updates entries where name === url (i.e. user left the name blank).
function updateConfigCalendarName(accountId, uri, newName) {
	"use strict";
	var f = searchAccountConfig({accountId: accountId});
	f.then(function () {
		var result = checkResult(f), cals, i;
		if (!result.returnValue || !result.config || !result.config.calendars) { return; }
		cals = result.config.calendars;
		for (i = 0; i < cals.length; i += 1) {
			if (cals[i].url === uri && cals[i].name === uri) {
				cals[i].name = newName;
				DB.merge([{_id: result.config._id, calendars: cals}]);
				Log.log("Config calendar name updated to:", newName);
				return;
			}
		}
	});
}

var SyncAssistant = Class.create(Sync.SyncCommand, {

	run: function run(outerfuture, subscription) {
		"use strict";
		var args = this.controller.args || {}, future = new Future(), accountId = args.accountId;

		this.recreateActivitiesOnComplete = true;

		if (!args.capability) {
			SyncStatus.setRunning(this.client.clientId);

			if (!accountId) {
				SyncStatus.setStatus("Error: No accountId given");
				SyncStatus.setDone(this.client.clientId);
				outerfuture.result = {returnValue: false, message: "No accountId given"};
				return outerfuture;
			}

			future.nest(PalmCall.call("palm://org.webosarchive.webcal.service/", "sync", {
				accountId: accountId,
				capability: "CALENDAR"
			}));

			future.then(this, function calendarSyncCB() {
				var result = checkResult(future);
				Log.log("Calendar sync returned:", result);
				SyncStatus.setDone(this.client.clientId);
				outerfuture.result = result;
			});
		} else {
			this.SyncKey = new SyncKey(this.client, this.handler);
			this.$super(run)(future);
			future.then(this, function syncCameBackCB() {
				var result = checkResult(future);
				Log.debug("Sync came back: ", result);
				outerfuture.result = result;
			});
		}

		return outerfuture;
	},

	getSyncOrder: function () {
		"use strict";
		return this.client.kinds.syncOrder;
	},

	getSyncObjects: function () {
		"use strict";
		return this.client.kinds.objects;
	},

	getCapabilityProviderId: function () {
		"use strict";
		return "CALENDAR";
	},

	getNewRemoteObject: function (kindName) {
		"use strict";
		throw new Error("WebCal is read-only, cannot create remote objects for kind: " + kindName);
	},

	getTransformer: function (name, kindName) {
		"use strict";
		if (name !== "remote2local") {
			return undefined; // no upsync
		}

		if (kindName === Kinds.objects.calendar.name) {
			return function (to, from) {
				to.accountId = this.client.clientId;
				to.excludeFromAll = !!from.excludeFromAll;
				to.isReadOnly = true;
				to.name = from.name;
				to.syncSource = "icsync";
				to.remoteId = from.remoteId || from.url;
				to.uri = from.url || from.remoteId;
				if (from.visible !== undefined) {
					to.visible = !!from.visible;
				}
				return true;
			}.bind(this);
		}

		if (kindName === Kinds.objects.calendarevent.name) {
			return function (to, from) {
				var key, obj = from.obj;

				if (!obj) {
					Log.log("ERROR: incoming obj undefined for", from);
					return false;
				}

				if (!obj._kind) {
					obj._kind = Kinds.objects[kindName].id;
				}

				for (key in obj) {
					if (obj.hasOwnProperty(key) && obj[key] !== undefined) {
						to[key] = obj[key];
					}
				}

				if (from.collectionId) {
					to.calendarId = from.collectionId;
				}

				to.uri = from.uri;
				if (!to.remoteId) {
					to.remoteId = from.remoteId || from.uri;
				}

				if (to.preventSync) {
					to.preventSync = false;
				}

				return from.obj;
			};
		}

		throw new Error("getTransformer: kind not recognized: " + kindName);
	},

	getRemoteId: function (obj, kindName) {
		"use strict";
		if (obj.remoteId) {
			return obj.remoteId;
		}
		if (obj.uri) {
			obj.remoteId = obj.uri;
			return obj.remoteId;
		}
		if (obj.url) {
			obj.remoteId = obj.url;
			return obj.remoteId;
		}
		throw new Error("No remoteId for object in kind: " + kindName);
	},

	isDeleted: function (obj) {
		"use strict";
		return !!(obj && obj.doDelete);
	},

	getRemoteChanges: function (state, kindName) {
		"use strict";
		Log.log("\n\n***** SyncAssistant:getRemoteChanges kindName=" + kindName + " *****");
		var future = new Future();

		this.SyncKey.setKindName(kindName);
		this.SyncKey.prepare(kindName, state);

		if (kindName === Kinds.objects.calendar.name) {
			future.nest(this._getWebCalCollectionChanges(state, kindName));
		} else if (kindName === Kinds.objects.calendarevent.name) {
			future.nest(this._getWebCalEventChanges(state, kindName));
		} else {
			Log.log("Unknown kindName:", kindName);
			future.result = {returnValue: false, more: false, entries: []};
		}

		return future;
	},

	/*
	 * Sync the calendar collection (calendar kind).
	 * Reads the URL list from account config and returns entries for
	 * new or deleted calendars.  Also syncs the SyncKey event folders.
	 */
	_getWebCalCollectionChanges: function (state, kindName) {
		"use strict";
		var future = new Future(), self = this, calendars, entries, deletedCalendarIds;

		SyncStatus.setRunning(this.client.clientId, kindName);

		future.nest(searchAccountConfig(this.client.config));

		future.then(this, function configCB() {
			var result = checkResult(future);
			if (result.returnValue === true) {
				self.client.config = result.config;
			}
			calendars = (self.client.config && self.client.config.calendars) ? self.client.config.calendars : [];

			future.nest(DB.find({
				from: Kinds.objects.calendar.id,
				where: [{prop: "accountId", op: "=", val: self.client.clientId}]
			}, false, false));
		});

		future.then(this, function localCalendarsCB() {
			var result = checkResult(future), localCals, i, j, cal, found;

			localCals = (result.returnValue && result.results) ? result.results : [];
			entries = [];
			deletedCalendarIds = [];

			// Ensure the account-level meta calendar always exists.
			// Having 2+ calendars per account forces CalendarsManager into the multi-calendar
			// code path where it uses cal.name (not rawAccount.alias) as the display name.
			found = false;
			for (j = 0; j < localCals.length; j += 1) {
				if (localCals[j].remoteId === META_REMOTE_ID) {
					found = true;
					break;
				}
			}
			if (!found) {
				entries.push({
					remoteId: META_REMOTE_ID,
					name: (self.client.config && self.client.config.name) || "WebCal",
					url: META_REMOTE_ID,
					excludeFromAll: true,
					visible: false
				});
			}

			for (i = 0; i < calendars.length; i += 1) {
				cal = calendars[i];
				found = false;
				for (j = 0; j < localCals.length; j += 1) {
					if (localCals[j].uri === cal.url || localCals[j].remoteId === cal.url) {
						found = true;
						break;
					}
				}
				if (!found) {
					Log.log("New calendar URL:", cal.url);
					entries.push({remoteId: cal.url, name: cal.name || cal.url, url: cal.url});
				}
			}

			for (j = 0; j < localCals.length; j += 1) {
				if (localCals[j].remoteId === META_REMOTE_ID) { continue; } // never delete the meta
				found = false;
				for (i = 0; i < calendars.length; i += 1) {
					if (calendars[i].url === (localCals[j].uri || localCals[j].remoteId)) {
						found = true;
						break;
					}
				}
				if (!found) {
					Log.log("Removed calendar:", localCals[j].remoteId || localCals[j].uri);
					entries.push({remoteId: localCals[j].remoteId || localCals[j].uri, doDelete: true});
					if (localCals[j]._id) {
						deletedCalendarIds.push(localCals[j]._id);
					}
				}
			}

			self._syncEventFolders(calendars);
			Log.log("calendar entries to sync:", JSON.stringify(entries));

			if (deletedCalendarIds.length > 0) {
				future.nest(self._cleanupOrphanedEvents(deletedCalendarIds, 0));
			} else {
				future.result = {returnValue: true};
			}
		});

		future.then(this, function doneCB() {
			try { checkResult(future); } catch (e) {
				Log.log("Event cleanup error (non-fatal):", e.message || e);
			}
			SyncStatus.setDone(self.client.clientId, kindName);
			future.result = {returnValue: true, more: false, entries: entries || []};
		});

		return future;
	},

	/*
	 * Delete all org.webosarchive.webcal.calendarevent:1 records linked to any
	 * of the given com.palm.calendar:1 _id values. Called when calendars are
	 * removed so we don't leak DB8 storage.
	 */
	_cleanupOrphanedEvents: function (calendarIds, idx) {
		"use strict";
		var self = this, future = new Future();

		if (idx >= calendarIds.length) {
			future.result = {returnValue: true};
			return future;
		}

		future.nest(DB.find({
			from: Kinds.objects.calendarevent.id,
			where: [{prop: "calendarId", op: "=", val: calendarIds[idx]}],
			select: ["_id"]
		}, false, false));

		future.then(this, function findDoneCB() {
			var result = checkResult(future), ids, k;
			if (result.returnValue && result.results && result.results.length > 0) {
				ids = [];
				for (k = 0; k < result.results.length; k += 1) {
					ids.push(result.results[k]._id);
				}
				Log.log("Deleting", ids.length, "orphaned events for calendar", calendarIds[idx]);
				future.nest(DB.del(ids));
			} else {
				future.result = {returnValue: true};
			}
		});

		future.then(this, function delDoneCB() {
			checkResult(future);
			future.nest(self._cleanupOrphanedEvents(calendarIds, idx + 1));
		});

		return future;
	},

	/*
	 * Keep SyncKey calendarevent folders aligned with the configured URL list.
	 */
	_syncEventFolders: function (calendars) {
		"use strict";
		var eventKind = Kinds.objects.calendarevent.name, i, j, folder, cal, found;
		var folders = this.client.transport.syncKey[eventKind].folders;

		for (i = 0; i < calendars.length; i += 1) {
			cal = calendars[i];
			found = false;
			for (j = 0; j < folders.length; j += 1) {
				if (folders[j].uri === cal.url) {
					found = true;
					break;
				}
			}
			if (!found) {
				folders.push({name: cal.name || cal.url, uri: cal.url, ctag: 0, removeAlerts: !!cal.removeAlerts});
			}
		}

		for (j = folders.length - 1; j >= 0; j -= 1) {
			found = false;
			for (i = 0; i < calendars.length; i += 1) {
				if (calendars[i].url === folders[j].uri) {
					found = true;
					break;
				}
			}
			if (!found) {
				folders.splice(j, 1);
			}
		}
	},

	/*
	 * Fetch and parse events for the current SyncKey folder (one calendar URL).
	 * Uses MD5 hash of the raw response as change detection.  Skips processing
	 * if hash is unchanged; otherwise splits large feeds into BATCH_SIZE-event
	 * files on /media/internal and processes one batch per sync invocation.
	 *
	 * Batch state (batchTotal, batchNext, batchPrefix) is stored on the folder
	 * object and persisted to DB via _saveTransportObject so that crashes between
	 * batches are safe — the next invocation resumes from batchNext.
	 *
	 * Intermediate callbacks use a closure variable (skipReason) to propagate
	 * early-exit through the future chain without double-executing cleanup code.
	 */
	_getWebCalEventChanges: function (state, kindName) {
		"use strict";
		var future = new Future(), self = this;
		var folder = this.SyncKey.currentFolder(kindName);
		var skipReason = null;
		var filteredData = null;
		var entries = [];
		var isBatchResume;
		var BATCH_SIZE = 50;

		isBatchResume = !!(folder && folder.batchTotal > 0 &&
			typeof folder.batchNext === "number" && folder.batchNext < folder.batchTotal);

		if (!folder || !folder.uri) {
			Log.log("No folder for index", this.SyncKey.folderIndex(kindName), "in", kindName);
			this.SyncKey.nextFolder(kindName);
			if (!this.SyncKey.hasMoreFolders(kindName)) {
				SyncStatus.setDone(this.client.clientId, kindName);
			}
			future.result = {more: this.SyncKey.hasMoreFolders(kindName), entries: []};
			return future;
		}

		if (this.SyncKey.hasError(kindName)) {
			Log.log("Error state detected for", kindName, "— clearing and retrying from checkpoint");
			this.client.transport.syncKey[kindName].error = false;
			// Fall through and retry; SyncKey already reset folderIndex to 0
		}

		SyncStatus.setRunning(this.client.clientId, kindName);
		SyncStatus.setStatus(this.client.clientId, kindName, "Syncing " + (folder.name || folder.uri));

		future.nest(this.SyncKey.saveErrorState(kindName));

		future.then(this, function savedStateCB() {
			checkResult(future);
			future.nest(self._initCollectionId(kindName));
		});

		future.then(this, function initCollectionCB() {
			var result = checkResult(future);
			if (!result.returnValue) {
				Log.log("No local calendar collection for", folder.uri, "— skipping.");
				skipReason = "noCollection";
				future.result = {returnValue: false};
				return;
			}
			// Ensure the calendar DB record's name matches the folder's name on every
			// invocation. This handles batch-resume invocations where fetchDoneCB is
			// skipped: folder.name is "Jon" (persisted from the first invocation) but
			// the calendar record may still have the URL if that invocation's DB.merge
			// failed silently.
			if (folder.name && folder.name !== folder.uri && folder.collectionId) {
				DB.merge([{_id: folder.collectionId, name: folder.name}]);
			}
			if (isBatchResume) {
				Log.log("Batch resume for " + (folder.name || folder.uri) + ": batch " + folder.batchNext + " of " + folder.batchTotal);
				future.result = {returnValue: true};
			} else {
				future.nest(WebCal.fetch(folder.uri, folder.ctag));
			}
		});

		future.then(this, function fetchDoneCB() {
			var result, newHash, data, searchPos, veventCount, calNameUpdated;
			var TWO_YEARS_AGO, keptOffsets, filterHeaderEnd, veventStart, veventEnd, rrulePos, dtPos, colon, dateStr, dtMs, kept, removed;
			var rruleLineEnd, untilIdx;
			var rawData, batchHeader, batchTotal, batchContent;
			var evStart, evEnd, innerPos, batchFile, folderKey, batchPrefix, batchVevents;
			var allRemoteIds, uidOrder, uidGroups, uidIdx, uidGrpArr, uidStr, uidGroupSize;
			var kii, uidPos, uidAccum, uidNl, inlineParts, ki;

			if (skipReason || isBatchResume) {
				future.result = {returnValue: false};
				return;
			}

			result = checkResult(future);

			if (!result.returnValue) {
				Log.log("Fetch failed for", folder.uri, "code:", result.returnCode);
				folder.downloadsFailed = true;
				folder.ctag = 0;
				skipReason = "fetchFailed";
				future.result = {returnValue: false};
				return;
			}

			// WebCal.fetch computed the DTSTAMP-stripped stable hash via a
			// Buffer byte scan — no V8 string allocations during hash computation.
			// If storedCtag matched, hashMatch:true is returned without buf.toString().
			newHash = result.hash;
			Log.log("Stable hash for", folder.name || folder.uri, ":", newHash);
			// If the user left the name blank, use X-WR-CALNAME from the feed.
			// Must run before the hash-unchanged exit so it fires even on no-change syncs.
			calNameUpdated = false;
			if (result.calName && folder.name === folder.uri && folder.collectionId) {
				folder.name = result.calName;
				Log.log("Calendar name set from X-WR-CALNAME:", result.calName);
				DB.merge([{_id: folder.collectionId, name: result.calName}]);
				updateConfigCalendarName(self.client.clientId, folder.uri, result.calName);
				calNameUpdated = true;
			}

			if (result.hashMatch) {
				Log.log("Hash unchanged for", folder.name || folder.uri, "— no update needed.");
				self.client.transport.syncKey[kindName].error = false;
				skipReason = "noChange";
				// Persist the SyncKey if we just updated the name, otherwise fast-exit.
				if (calNameUpdated) {
					future.nest(self.SyncKey._saveTransportObject());
				} else {
					future.result = {returnValue: false};
				}
				return;
			}

			data = result.data;
			result = null;

			// Date filter: store [start, end] position pairs into the raw feed string
			// instead of string copies.  filteredParts.join() was creating up to 754×N
			// byte copies of every kept event simultaneously alongside the 1.6 MB raw
			// feed, pushing RSS past the TouchPad ~25 MB OOM threshold.
			TWO_YEARS_AGO = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;
			keptOffsets = []; // flat [start0, end0, start1, end1, ...]
			kept = 0;
			removed = 0;
			filterHeaderEnd = data.indexOf("BEGIN:VEVENT");
			if (filterHeaderEnd !== -1) {
				searchPos = filterHeaderEnd;
				while (true) {
					veventStart = data.indexOf("BEGIN:VEVENT", searchPos);
					if (veventStart === -1) { break; }
					veventEnd = data.indexOf("END:VEVENT", veventStart);
					if (veventEnd === -1) { break; }
					veventEnd += 10;
					if (veventEnd < data.length && data[veventEnd] === "\r") { veventEnd += 1; }
					if (veventEnd < data.length && data[veventEnd] === "\n") { veventEnd += 1; }

					rrulePos = data.indexOf("RRULE:", veventStart);
					if (rrulePos !== -1 && rrulePos < veventEnd) {
						rruleLineEnd = data.indexOf("\n", rrulePos);
						if (rruleLineEnd === -1 || rruleLineEnd > veventEnd) { rruleLineEnd = veventEnd; }
						untilIdx = data.indexOf("UNTIL=", rrulePos);
						if (untilIdx !== -1 && untilIdx < rruleLineEnd) {
							dateStr = data.slice(untilIdx + 6, untilIdx + 14);
							dtMs = Date.UTC(
								parseInt(dateStr.slice(0, 4), 10),
								parseInt(dateStr.slice(4, 6), 10) - 1,
								parseInt(dateStr.slice(6, 8), 10)
							);
							if (dtMs < TWO_YEARS_AGO) {
								removed += 1;
							} else {
								keptOffsets.push(veventStart);
								keptOffsets.push(veventEnd);
								kept += 1;
							}
						} else {
							keptOffsets.push(veventStart);
							keptOffsets.push(veventEnd);
							kept += 1;
						}
					} else {
						dtPos = data.indexOf("DTSTART", veventStart);
						if (dtPos !== -1 && dtPos < veventEnd) {
							colon = data.indexOf(":", dtPos);
							if (colon !== -1 && colon < veventEnd) {
								dateStr = data.slice(colon + 1, colon + 9);
								dtMs = Date.UTC(
									parseInt(dateStr.slice(0, 4), 10),
									parseInt(dateStr.slice(4, 6), 10) - 1,
									parseInt(dateStr.slice(6, 8), 10)
								);
								if (dtMs >= TWO_YEARS_AGO) {
									keptOffsets.push(veventStart);
									keptOffsets.push(veventEnd);
									kept += 1;
								} else {
									removed += 1;
								}
							} else {
								keptOffsets.push(veventStart);
								keptOffsets.push(veventEnd);
								kept += 1;
							}
						} else {
							keptOffsets.push(veventStart);
							keptOffsets.push(veventEnd);
							kept += 1;
						}
					}
					searchPos = veventEnd;
				}
			}
			if (removed > 0) {
				Log.log("Date filter: kept " + kept + " events, removed " + removed + " old events (non-recurring or finished recurring).");
			}

			veventCount = kept;
			Log.log("Feed has " + veventCount + " events after date filter for " + (folder.name || folder.uri));

			if (veventCount <= BATCH_SIZE) {
				// Inline path: build the filtered ICS string from the kept offsets.
				if (filterHeaderEnd === -1) {
					filteredData = data;
				} else if (keptOffsets.length === 0) {
					filteredData = data.slice(0, filterHeaderEnd) + "END:VCALENDAR\r\n";
				} else {
					inlineParts = [data.slice(0, filterHeaderEnd)];
					for (ki = 0; ki < keptOffsets.length; ki += 2) {
						inlineParts.push(data.slice(keptOffsets[ki], keptOffsets[ki + 1]));
					}
					inlineParts.push("END:VCALENDAR\r\n");
					filteredData = inlineParts.join("");
					inlineParts = null;
				}
				keptOffsets = null;
				result = null;
				data = null;
				future.result = {returnValue: true};
				return;
			}

			// Batching path: rawData is the sole reference to the raw feed string.
			// uidGroups stores flat [start, end, ...] pairs into rawData so the full
			// event text is never duplicated — pulled out one batch at a time in Phase 2.
			rawData = data;
			result = null;
			data = null;

			batchHeader = rawData.slice(0, filterHeaderEnd);
			folderKey = folder.uri.replace(/[^a-zA-Z0-9]/g, "").slice(-24);
			batchPrefix = "/media/internal/.webcal_" +
				self.client.clientId.replace(/[^a-zA-Z0-9]/g, "") + "_" + folderKey + "_";

			// Phase 1: extract UIDs by scanning rawData directly — no full VEVENT copies.
			allRemoteIds = [];
			uidOrder = [];
			uidGroups = {};
			for (kii = 0; kii < keptOffsets.length; kii += 2) {
				evStart = keptOffsets[kii];
				evEnd = keptOffsets[kii + 1];
				uidStr = null;
				uidPos = rawData.indexOf("\nUID:", evStart);
				if (uidPos !== -1 && uidPos < evEnd) {
					uidPos += 5;
					uidAccum = "";
					while (uidPos < evEnd) {
						uidNl = rawData.indexOf("\n", uidPos);
						if (uidNl === -1 || uidNl >= evEnd) {
							uidAccum += rawData.slice(uidPos, evEnd);
							break;
						}
						// Trim trailing \r for CRLF feeds; LF-only feeds have no \r
						uidAccum += rawData.slice(uidPos, (uidNl > uidPos && rawData[uidNl - 1] === "\r") ? uidNl - 1 : uidNl);
						// RFC 5545 folded continuation: newline + space or tab
						if (uidNl + 1 < evEnd && (rawData[uidNl + 1] === " " || rawData[uidNl + 1] === "\t")) {
							uidPos = uidNl + 2;
						} else {
							break;
						}
					}
					uidStr = uidAccum.trim() || null;
				}
				if (!uidStr) { uidStr = "anon_" + (kii / 2); }
				if (!uidGroups[uidStr]) {
					uidGroups[uidStr] = [];
					uidOrder.push(uidStr);
					allRemoteIds.push(uidStr);
				}
				uidGroups[uidStr].push(evStart);
				uidGroups[uidStr].push(evEnd);
			}
			keptOffsets = null;

			// Phase 2: pack UID groups into batch files, extracting event text from
			// rawData one batch at a time — never all 754 strings in memory at once.
			batchTotal = 0;
			batchContent = batchHeader;
			batchVevents = 0;
			for (uidIdx = 0; uidIdx < uidOrder.length; uidIdx += 1) {
				uidGrpArr = uidGroups[uidOrder[uidIdx]];
				uidGroupSize = uidGrpArr.length / 2;
				if (batchVevents > 0 && batchVevents + uidGroupSize > BATCH_SIZE) {
					batchContent += "END:VCALENDAR\r\n";
					batchFile = batchPrefix + batchTotal + ".ics";
					try {
						fs.writeFileSync(batchFile, batchContent);
					} catch (e) {
						Log.log("Failed to write batch file " + batchFile + ": " + e.message);
						skipReason = "batchWriteFailed";
						future.result = {returnValue: false};
						return;
					}
					Log.log("Wrote batch " + batchTotal + " (" + batchVevents + " events) to " + batchFile);
					batchTotal += 1;
					batchContent = batchHeader;
					batchVevents = 0;
				}
				for (innerPos = 0; innerPos < uidGrpArr.length; innerPos += 2) {
					batchContent += rawData.slice(uidGrpArr[innerPos], uidGrpArr[innerPos + 1]);
					batchVevents += 1;
				}
			}
			if (batchVevents > 0) {
				batchContent += "END:VCALENDAR\r\n";
				batchFile = batchPrefix + batchTotal + ".ics";
				try {
					fs.writeFileSync(batchFile, batchContent);
				} catch (e) {
					Log.log("Failed to write batch file " + batchFile + ": " + e.message);
					skipReason = "batchWriteFailed";
					future.result = {returnValue: false};
					return;
				}
				Log.log("Wrote batch " + batchTotal + " (" + batchVevents + " events) to " + batchFile);
				batchTotal += 1;
			}

			folder.ctag = newHash;
			folder.batchTotal = batchTotal;
			folder.batchNext = 0;
			folder.batchPrefix = batchPrefix;
			skipReason = "batchQueued";
			Log.log("Split " + veventCount + " events into " + batchTotal + " batches for " + (folder.name || folder.uri));

			try {
				fs.writeFileSync(batchPrefix + "uids.json", JSON.stringify(allRemoteIds));
				Log.log("Wrote remoteId index (" + allRemoteIds.length + " entries) for deletion check.");
			} catch (eUid) {
				Log.log("Could not write remoteId index: " + eUid.message);
			}

			rawData = null;
			uidGroups = null;
			allRemoteIds = null;
			batchContent = null;

			// Persist batch state before returning so a crash here is resumable.
			future.nest(self.SyncKey._saveTransportObject());
		});

		// Load data for parsing: read batch file (resume path) or use filteredData (inline path).
		// Also applies attendee cap and description truncation before handing off to the parser.
		future.then(this, function parseDataCB() {
			var applyTruncations, batchFile, parseFuture2, errStr2, lineMatch2, sanitized2;

			if (skipReason) {
				future.result = {returnValue: false};
				return;
			}

			applyTruncations = function (d) {
				var attendeeCount = 0;
				d = d.replace(/^ATTENDEE[^\r\n]*(\r\n[ \t][^\r\n]*)*/mg, function (match) {
					attendeeCount += 1;
					return attendeeCount <= 10 ? match : "";
				});
				if (attendeeCount > 10) {
					Log.log("Truncated attendee list from " + attendeeCount + " to 10.");
				}
				d = d.replace(/^(DESCRIPTION[^\r\n]*(\r\n[ \t][^\r\n]*)*)/mg, function (match) {
					var plain = match.replace(/\r\n[ \t]/g, "");
					if (plain.length > 520) {
						Log.log("Truncating long description (" + plain.length + " bytes).");
						return "DESCRIPTION:" + plain.slice(12, 512) + "...(truncated)";
					}
					return match;
				});
				if (folder.removeAlerts) {
					d = d.replace(/BEGIN:VALARM[\s\S]*?END:VALARM\r?\n?/g, "");
				}
				return d;
			};

			if (isBatchResume) {
				batchFile = folder.batchPrefix + folder.batchNext + ".ics";
				fs.readFile(batchFile, "utf8", function (readErr, batchData) {
					var parseFuture, errStr, lineMatch, sanitized;
					if (readErr) {
						Log.log("Batch file read failed (" + batchFile + "): " + readErr.message);
						skipReason = "batchReadFailed";
						future.result = {returnValue: false};
						return;
					}
					try {
						parseFuture = iCal.parseWebCalICal(applyTruncations(batchData));
					} catch (eParse) {
						errStr = String(eParse);
						lineMatch = errStr.match(/^Could not correctly parse line (.*?) paramName = /);
						if (lineMatch) {
							sanitized = stripAttendeesFromEventWithLine(applyTruncations(batchData), lineMatch[1]);
							try {
								parseFuture = iCal.parseWebCalICal(sanitized);
								Log.log("Batch " + folder.batchNext + ": recovered by stripping attendees from affected event.");
							} catch (eParse2) {
								Log.log("iCal parse unrecoverable for batch " + folder.batchNext + ": " + String(eParse2));
								skipReason = "parseError";
								future.result = {returnValue: false};
								return;
							}
						} else {
							Log.log("iCal parse threw for batch " + folder.batchNext + ": " + errStr);
							skipReason = "parseError";
							future.result = {returnValue: false};
							return;
						}
					}
					future.nest(parseFuture);
				});
			} else if (filteredData === null) {
				// Batch split just completed this invocation — no data to parse inline.
				// The batched path will process batch files starting from the next invocation.
				skipReason = "batchSplitComplete";
				future.result = {returnValue: false};
			} else {
				try {
					parseFuture2 = iCal.parseWebCalICal(applyTruncations(filteredData));
				} catch (eParse2) {
					errStr2 = String(eParse2);
					lineMatch2 = errStr2.match(/^Could not correctly parse line (.*?) paramName = /);
					if (lineMatch2) {
						sanitized2 = stripAttendeesFromEventWithLine(applyTruncations(filteredData), lineMatch2[1]);
						try {
							parseFuture2 = iCal.parseWebCalICal(sanitized2);
							Log.log("Recovered by stripping attendees from affected event.");
						} catch (eParse3) {
							Log.log("iCal parse unrecoverable: " + String(eParse3));
							skipReason = "parseError";
							future.result = {returnValue: false};
							return;
						}
					} else {
						Log.log("iCal parse threw: " + errStr2);
						skipReason = "parseError";
						future.result = {returnValue: false};
						return;
					}
				}
				future.nest(parseFuture2);
			}
		});

		future.then(this, function parsedCB() {
			var result = checkResult(future);
			var isLastBatch, skipDeletion;

			if (skipReason) {
				future.result = {returnValue: false};
				return;
			}

			if (!result.returnValue || !result.events || result.events.length === 0) {
				Log.log("iCal parse returned no events for " +
					(isBatchResume ? "batch " + folder.batchNext + " of " : "") + folder.uri);
				if (!isBatchResume) {
					// Only reset ctag on a full-feed failure, not a single-batch failure.
					folder.ctag = 0;
				}
				skipReason = "parseFailed";
				future.result = {returnValue: false};
				return;
			}

			// Skip deletion check for all but the final batch.
			// The final batch reads the UID index file written during the split to
			// build priorRemoteIds — avoids storing hundreds of UIDs in the transport
			// object (which can silently fail to save if the record gets too large).
			isLastBatch = !isBatchResume || (folder.batchNext === folder.batchTotal - 1);
			skipDeletion = !isLastBatch;

			var priorRemoteIds = {};
			if (isBatchResume && isLastBatch) {
				var uidIndexPath = folder.batchPrefix + "uids.json";
				try {
					var uidIndexData = JSON.parse(fs.readFileSync(uidIndexPath, "utf8"));
					uidIndexData.forEach(function (uid) { priorRemoteIds[uid] = true; });
					Log.log("Loaded " + uidIndexData.length + " UIDs from index for deletion check.");
				} catch (eIdx) {
					Log.log("Could not read UID index (" + uidIndexPath + "): " + eIdx.message + " — deletion check may be inaccurate.");
				}
			}

			future.nest(self._buildEventEntries(
				kindName, folder, folder.collectionId, result.events,
				skipDeletion, priorRemoteIds
			));
		});

		// Advance batch state after a batch is processed (or skipped due to error).
		// Always advances — even on error — to avoid looping on a bad batch file.
		future.then(this, function batchAdvanceCB() {
			var result = checkResult(future);
			var batchFile;

			if (result && result.entries) {
				entries = result.entries;
			}

			if (!isBatchResume) {
				future.result = {returnValue: true};
				return;
			}

			// Advance regardless of skipReason so a bad batch doesn't stall forever.
			if (skipReason) {
				Log.log("Batch " + folder.batchNext + " skipped (" + skipReason + ") — advancing.");
				skipReason = null;
			}

			batchFile = folder.batchPrefix + folder.batchNext + ".ics";
			folder.batchNext += 1;
			try { fs.unlinkSync(batchFile); } catch (e2) {}

			if (folder.batchNext >= folder.batchTotal) {
				Log.log("All batches complete for " + (folder.name || folder.uri));
				try { fs.unlinkSync(folder.batchPrefix + "uids.json"); } catch (e3) {}
				delete folder.batchTotal;
				delete folder.batchNext;
				delete folder.batchPrefix;
			} else {
				Log.log("Batch " + folder.batchNext + " of " + folder.batchTotal + " queued for next invocation.");
			}

			future.nest(self.SyncKey._saveTransportObject());
		});

		// Final cleanup — always runs regardless of skipReason.
		// Does NOT advance folderIndex while batches remain for this folder.
		future.then(this, function cleanupCB() {
			var stillBatching;
			checkResult(future);

			self.client.transport.syncKey[kindName].error = false;

			if (!skipReason) {
				SyncStatus.setDownloadTotal(self.client.clientId, kindName, entries.length);
			}

			stillBatching = !!(folder.batchTotal !== undefined &&
				typeof folder.batchNext === "number" && folder.batchNext < folder.batchTotal);

			SyncStatus.setDone(self.client.clientId, kindName);

			if (!stillBatching) {
				self.SyncKey.nextFolder(kindName);
			}

			future.result = {more: stillBatching || self.SyncKey.hasMoreFolders(kindName), entries: entries};
		});

		return future;
	},

	/*
	 * Convert parsed iCal event groups into sync entries, resolve parent IDs
	 * for recurring events, and add doDelete entries for removed events.
	 *
	 * skipDeletion: when true, skip the DB deletion check and return newRemoteIds
	 *   in the result so the caller can accumulate them across batches.
	 * priorRemoteIds: IDs seen in previous batches; merged with this batch's IDs
	 *   for the deletion check so that earlier-batch events are not falsely deleted.
	 */
	_buildEventEntries: function (kindName, folder, collectionId, parsedGroups, skipDeletion, priorRemoteIds) {
		"use strict";
		var self = this, entries = [], newRemoteIds = {}, future = new Future();

		function processGroup(index) {
			var groupFuture = new Future(), parsed, ev, remoteId, uri, entry;

			if (index >= parsedGroups.length) {
				groupFuture.result = {returnValue: true};
				return groupFuture;
			}

			parsed = parsedGroups[index];
			ev = parsed.result;
			remoteId = ev.uid || (folder.uri + "#" + index);
			uri = folder.uri + "#" + (ev.uid || index);

			ev.remoteId = remoteId;
			newRemoteIds[remoteId] = true;

			entry = {remoteId: remoteId, uri: uri, collectionId: collectionId, obj: ev};
			entries.push(entry);

			if (parsed.hasExceptions) {
				parsed.exceptions.forEach(function (exc, idx) {
					var excRemoteId = remoteId + "#" + (exc.recurrenceId || String(idx));
					exc.collectionId = collectionId;
					exc.uid = ev.uid || ev.uId;
					exc.remoteId = excRemoteId;
					newRemoteIds[excRemoteId] = true;
					entries.push({
						alreadyDownloaded: true,
						obj: exc,
						uri: uri + "exception" + idx,
						collectionId: collectionId,
						remoteId: excRemoteId
					});
				});

				groupFuture.nest(CalendarEventHandler.fillParentIds(remoteId, ev, parsed.exceptions));
				groupFuture.then(function fillDoneCB() {
					checkResult(groupFuture);
					groupFuture.nest(processGroup(index + 1));
				});
			} else {
				groupFuture.nest(processGroup(index + 1));
			}

			return groupFuture;
		}

		future.nest(processGroup(0));

		future.then(this, function deletionCheckCB() {
			checkResult(future);
			if (skipDeletion) {
				// Not the last batch — return entries and the new IDs so the caller
				// can accumulate them for the final batch's deletion check.
				future.result = {returnValue: true, entries: entries, newRemoteIds: newRemoteIds};
				return;
			}
			future.nest(DB.find({
				from: Kinds.objects.calendarevent.id,
				where: [{prop: "calendarId", op: "=", val: collectionId}],
				select: ["remoteId", "_id"]
			}, false, false));
		});

		future.then(this, function localEventsCB() {
			var result = checkResult(future), allKnown, rid;
			if (skipDeletion) {
				// Pass through the result set in deletionCheckCB.
				future.result = {returnValue: true, entries: entries, newRemoteIds: newRemoteIds};
				return;
			}
			// Build the full set of known IDs: this batch + all prior batches.
			allKnown = priorRemoteIds || {};
			for (rid in newRemoteIds) {
				if (newRemoteIds.hasOwnProperty(rid)) {
					allKnown[rid] = true;
				}
			}
			if (result.returnValue && result.results) {
				result.results.forEach(function (local) {
					var masterUid, hashPos;
					if (!local.remoteId) { return; }
					if (allKnown[local.remoteId]) { return; }
					// Exception events have remoteId = "UID#normalizedTimestamp".
					// normalizeToLocalTimezone converts the raw recurrenceId, so the "#..."
					// suffix in DB8 differs from the raw ICS text. Check by master UID only.
					hashPos = local.remoteId.indexOf("#");
					if (hashPos !== -1) {
						masterUid = local.remoteId.slice(0, hashPos);
						if (allKnown[masterUid]) { return; }
					}
					Log.log("Event removed from feed:", local.remoteId);
					entries.push({remoteId: local.remoteId, doDelete: true});
				});
			}
			future.result = {returnValue: true, entries: entries};
		});

		return future;
	},

	/*
	 * Query DB for the local calendar object matching the current folder URI.
	 * Stores its _id as folder.collectionId for linking events.
	 *
	 * Queries by accountId only (uses the accountId index reliably), then
	 * matches by remoteId/uri in JavaScript.  A two-prop where clause with
	 * [remoteId, accountId] ordering silently returns empty results on DB8
	 * because the index is ordered accountId_remoteId — this approach avoids
	 * that ordering dependency entirely.
	 */
	_initCollectionId: function (kindName) {
		"use strict";
		var future = new Future(),
			folder = this.SyncKey.currentFolder(kindName),
			uri = folder.uri,
			query = {
				from: Kinds.objects[Kinds.objects[kindName].connected_kind].id,
				where: [
					{prop: "accountId", op: "=", val: this.client.clientId}
				],
				select: ["_id", "remoteId", "uri"]
			};

		future.nest(DB.find(query, false, false));

		future.then(this, function findCB() {
			var result = checkResult(future), dbFolder, i, rec;
			if (result.returnValue === true) {
				for (i = 0; i < result.results.length; i += 1) {
					rec = result.results[i];
					if (rec.remoteId === uri || rec.uri === uri) {
						dbFolder = rec;
						break;
					}
				}
				if (dbFolder) {
					Log.debug("collectionId =", dbFolder._id, "for", uri);
					this.SyncKey.currentFolder(kindName).collectionId = dbFolder._id;
					this.currentCollectionId = dbFolder._id;
					future.result = {returnValue: true};
				} else {
					Log.log("No local calendar DB entry for URI:", uri);
					future.result = {returnValue: false};
				}
			} else {
				Log.log("DB.find failed in _initCollectionId:", result.exception);
				future.result = {returnValue: false};
			}
		});

		return future;
	},

	getRemoteMatches: function (remoteIds, kindName) {
		"use strict";
		// Read-only — no upsync needed
		var i, results = [], future = new Future();
		for (i = 0; i < remoteIds.length; i += 1) {
			results.push({remoteId: remoteIds[i]});
		}
		future.result = results;
		return future;
	},

	postPutRemoteModify: function (batch, kindName) {
		"use strict";
		// Read-only — never called in practice
		var future = new Future();
		SyncStatus.setDone(this.client.clientId, kindName);
		future.result = [];
		return future;
	},

	complete: function (activity) {
		"use strict";
		var outerFuture = new Future(), future = new Future(), args = this.controller.args;
		Log.log("WebCal-complete activity", activity.name);

		// No SyncOnEdit activities needed (read-only)
		future.result = true;

		future.then(this, function completeDoneCB(future) {
			checkResult(future);
			if (!this.recreateActivitiesOnComplete || args.capability) {
				Log.log("WebCal-complete(): completing inner activity.");
				activity.complete().then(this, function () {
					Log.log("Complete came back.");
					outerFuture.result = true;
				});
			} else {
				future.nest(this.getPeriodicSyncActivity());

				future.then(this, function getPeriodicSyncActivityCB() {
					var syncActivity = checkResult(future), restart = false, f;
					if (activity._activityId === syncActivity.activityId) {
						Log.log("Periodic sync — restarting activity.");
						restart = true;
					} else {
						Log.log("Not periodic sync — completing activity.");
					}
					if (this._hadLocalRevisionError) {
						restart = true;
						this._hadLocalRevisionError = false;
					}
					f = activity.complete(restart);
					if (f) {
						future.nest(f);
					} else {
						Log.log("Completing activity returned null.");
						future.result = {returnValue: true};
					}
				});

				future.then(this, function completeCB(future) {
					Log.debug("Complete succeeded.");
					outerFuture.result = true;
				}, function completeErrorCB(future) {
					Log.log("Complete FAILED:", future.exception);
					outerFuture.result = false;
				});
			}
		});

		return outerFuture;
	}
});

module.exports = SyncAssistant;
