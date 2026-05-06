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
				to.excludeFromAll = false;
				to.isReadOnly = true;
				to.name = from.name;
				to.syncSource = "webcal";
				to.remoteId = from.remoteId || from.url;
				to.uri = from.url || from.remoteId;
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
		var future = new Future(), self = this, calendars, noCalendars = false;

		SyncStatus.setRunning(this.client.clientId, kindName);

		future.nest(searchAccountConfig(this.client.config));

		future.then(this, function configCB() {
			var result = checkResult(future);
			if (result.returnValue === true) {
				self.client.config = result.config;
			}
			calendars = (self.client.config && self.client.config.calendars) ? self.client.config.calendars : [];

			if (calendars.length === 0) {
				Log.log("No calendars configured in account config.");
				noCalendars = true;
				future.result = {returnValue: true, results: []}; // synthetic empty-DB result
				return;
			}

			future.nest(DB.find({
				from: Kinds.objects.calendar.id,
				where: [{prop: "accountId", op: "=", val: self.client.clientId}]
			}, false, false));
		});

		future.then(this, function localCalendarsCB() {
			var result = checkResult(future), localCals, entries, i, j, cal, found;

			if (noCalendars) {
				SyncStatus.setDone(self.client.clientId, kindName);
				future.result = {returnValue: true, more: false, entries: []};
				return;
			}

			localCals = (result.returnValue && result.results) ? result.results : [];
			entries = [];

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
				}
			}

			self._syncEventFolders(calendars);

			SyncStatus.setDone(self.client.clientId, kindName);
			future.result = {returnValue: true, more: false, entries: entries};
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
				folders.push({name: cal.name || cal.url, uri: cal.url, ctag: 0});
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
	 * if hash is unchanged; otherwise parses all VEVENTs and finds deletions.
	 *
	 * Intermediate callbacks use a closure variable (skipReason) to propagate
	 * early-exit through the future chain without double-executing cleanup code.
	 */
	_getWebCalEventChanges: function (state, kindName) {
		"use strict";
		var future = new Future(), self = this;
		var folder = this.SyncKey.currentFolder(kindName);
		var skipReason = null; // set when we need to skip the rest of the chain

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
			Log.log("Error state — stopping sync for", kindName);
			SyncStatus.setDone(this.client.clientId, kindName);
			future.result = {more: false, entries: []};
			return future;
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
			if (result.returnValue) {
				future.nest(WebCal.fetch(folder.uri));
			} else {
				Log.log("No local calendar collection for", folder.uri, "— skipping.");
				skipReason = "noCollection";
				future.result = {returnValue: false};
			}
		});

		future.then(this, function fetchDoneCB() {
			var result = checkResult(future), newHash, data, attendeeCount, veventBlocks, lastEnd;

			if (skipReason) {
				future.result = {returnValue: false};
				return;
			}

			if (!result.returnValue) {
				Log.log("Fetch failed for", folder.uri, "code:", result.returnCode);
				folder.downloadsFailed = true;
				folder.ctag = 0;
				skipReason = "fetchFailed";
				future.result = {returnValue: false};
				return;
			}

			newHash = result.hash;
			if (newHash && newHash === folder.ctag) {
				Log.log("Hash unchanged for", folder.name || folder.uri, "— no update needed.");
				self.client.transport.syncKey[kindName].error = false;
				skipReason = "noChange";
				future.result = {returnValue: false};
				return;
			}

			folder.ctag = newHash;
			data = result.data;

			// OOM mitigations: strip excess attendees, truncate descriptions, cap VEVENTs
			attendeeCount = 0;
			data = data.replace(/^ATTENDEE[^\r\n]*(\r\n[ \t][^\r\n]*)*/mg, function (match) {
				attendeeCount += 1;
				return attendeeCount <= 10 ? match : "";
			});
			if (attendeeCount > 10) {
				Log.log("Truncated attendee list from", attendeeCount, "to 10.");
			}

			data = data.replace(/^(DESCRIPTION[^\r\n]*(\r\n[ \t][^\r\n]*)*)/mg, function (match) {
				var plain = match.replace(/\r\n[ \t]/g, "");
				if (plain.length > 520) {
					Log.log("Truncating long description (", plain.length, "bytes).");
					return "DESCRIPTION:" + plain.slice(12, 512) + "...(truncated)";
				}
				return match;
			});

			veventBlocks = data.split("BEGIN:VEVENT");
			if (veventBlocks.length > 22) {
				Log.log("Capping VEVENT count from", veventBlocks.length - 1, "to 20.");
				data = veventBlocks.slice(0, 22).join("BEGIN:VEVENT");
				lastEnd = data.lastIndexOf("END:VEVENT");
				if (lastEnd !== -1) {
					data = data.slice(0, lastEnd + 10) + "\r\nEND:VCALENDAR";
				}
			}

			future.nest(iCal.parseWebCalICal(data));
		});

		future.then(this, function parsedCB() {
			var result = checkResult(future);

			if (skipReason) {
				future.result = {returnValue: false};
				return;
			}

			if (!result.returnValue || !result.events || result.events.length === 0) {
				Log.log("iCal parse returned no events for", folder.uri);
				folder.ctag = 0;
				skipReason = "parseFailed";
				future.result = {returnValue: false};
				return;
			}

			future.nest(self._buildEventEntries(kindName, folder, folder.collectionId, result.events));
		});

		// Final cleanup — always runs regardless of skipReason
		future.then(this, function cleanupCB() {
			var result = checkResult(future), entries = [];

			if (!skipReason) {
				entries = result.entries || [];
				self.client.transport.syncKey[kindName].error = false;
				SyncStatus.setDownloadTotal(self.client.clientId, kindName, entries.length);
			}

			SyncStatus.setDone(self.client.clientId, kindName);
			self.SyncKey.nextFolder(kindName);
			future.result = {more: self.SyncKey.hasMoreFolders(kindName), entries: entries};
		});

		return future;
	},

	/*
	 * Convert parsed iCal event groups into sync entries, resolve parent IDs
	 * for recurring events, and add doDelete entries for removed events.
	 */
	_buildEventEntries: function (kindName, folder, collectionId, parsedGroups) {
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
					exc.collectionId = collectionId;
					exc.uid = ev.uid || ev.uId;
					exc.remoteId = remoteId;
					entries.push({
						alreadyDownloaded: true,
						obj: exc,
						uri: uri + "exception" + idx,
						collectionId: collectionId,
						remoteId: remoteId
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
			future.nest(DB.find({
				from: Kinds.objects.calendarevent.id,
				where: [{prop: "calendarId", op: "=", val: collectionId}],
				select: ["remoteId", "_id"]
			}, false, false));
		});

		future.then(this, function localEventsCB() {
			var result = checkResult(future);
			if (result.returnValue && result.results) {
				result.results.forEach(function (local) {
					if (local.remoteId && !newRemoteIds[local.remoteId]) {
						Log.log("Event removed from feed:", local.remoteId);
						entries.push({remoteId: local.remoteId, doDelete: true});
					}
				});
			}
			future.result = {returnValue: true, entries: entries};
		});

		return future;
	},

	/*
	 * Query DB for the local calendar object matching the current folder URI.
	 * Stores its _id as folder.collectionId for linking events.
	 */
	_initCollectionId: function (kindName) {
		"use strict";
		var future = new Future(),
			uri = this.SyncKey.currentFolder(kindName).uri,
			query = {
				from: Kinds.objects[Kinds.objects[kindName].connected_kind].id,
				where: [
					{prop: "remoteId", op: "=", val: uri},
					{prop: "accountId", op: "=", val: this.client.clientId}
				],
				select: ["_id", "remoteId", "uri"]
			};

		future.nest(DB.find(query, false, false));

		future.then(this, function findCB() {
			var result = checkResult(future), dbFolder;
			if (result.returnValue === true) {
				dbFolder = result.results[0];
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
