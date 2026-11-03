/*jslint nomen: true, node: true */
/*global Class, Future, Log, Sync, DB, checkResult, Kinds */
/*exported OnDelete*/

var OnDelete = Class.create(Sync.DeleteAccountCommand, {
	run: function run(outerFuture) {
		"use strict";
		var future = new Future(), self = this, config = this.client.config;
		var accountId = config && (config.accountId || config._id);

		// Delete config record first.
		if (config && config._id) {
			future.nest(DB.del([config._id]));
		} else {
			future.result = {returnValue: true};
		}

		// Explicitly delete all calendar records for this account, including
		// the META calendar which _getWebCalCollectionChanges never marks doDelete.
		future.then(this, function deleteCalendarsCB() {
			try { checkResult(future); } catch (e) {
				Log.log("OnDelete: config delete error (non-fatal):", e.message || e);
			}
			if (!accountId) {
				future.result = {returnValue: true};
				return;
			}
			future.nest(DB.find({
				from: Kinds.objects.calendar.id,
				where: [{prop: "accountId", op: "=", val: accountId}],
				select: ["_id"]
			}, false, false));
		});

		future.then(this, function calendarsFoundCB() {
			var result, ids, k;
			try { result = checkResult(future); } catch (e) { result = {returnValue: false}; }
			if (result.returnValue && result.results && result.results.length > 0) {
				ids = [];
				for (k = 0; k < result.results.length; k += 1) {
					ids.push(result.results[k]._id);
				}
				Log.log("OnDelete: deleting", ids.length, "calendar record(s) for account", accountId);
				future.nest(DB.del(ids));
			} else {
				future.result = {returnValue: true};
			}
		});

		// Delete events whose calendar is gone. Disabling the account, which comes first,
		// deletes by accountId, and versions before 0.2.3 stored a series with exceptions
		// without one, so those series stayed behind, drawn with no calendar to hide them.
		// That step has already deleted the calendars, so this can't ask which were
		// this account's: it keeps what belongs to a calendar that still exists.
		future.then(this, function liveCalendarsCB() {
			try { checkResult(future); } catch (e) {
				Log.log("OnDelete: calendar delete error (non-fatal):", e.message || e);
			}
			future.nest(DB.find({from: Kinds.objects.calendar.id, select: ["_id"]}, false, false));
		});

		future.then(this, function orphansCB() {
			var result;
			try { result = checkResult(future); } catch (e) { result = {returnValue: false}; }
			if (!result.returnValue || !result.results) {
				// Without the list every event would look orphaned.
				Log.log("OnDelete: could not list calendars, leaving events alone.");
				future.result = {returnValue: true};
				return;
			}
			var live = {};
			result.results.forEach(function (calendar) {
				live[calendar._id] = true;
			});
			future.nest(self._deleteOrphanedEvents(live));
		});

		future.then(this, function superCB() {
			try { checkResult(future); } catch (e) {
				Log.log("OnDelete: event delete error (non-fatal):", e.message || e);
			}
			self.$super(run)(outerFuture);
		});

		return outerFuture;
	},

	_deleteOrphanedEvents: function (liveCalendars, page) {
		"use strict";
		var self = this, future = new Future(), next, query = {
			from: Kinds.objects.calendarevent.id,
			select: ["_id", "calendarId"]
		};
		if (page) {
			query.page = page;
		}

		future.nest(DB.find(query, false, false));

		future.then(this, function foundCB() {
			var result = checkResult(future), ids = [];
			next = result.next;
			(result.results || []).forEach(function (event) {
				if (event.calendarId && !liveCalendars[event.calendarId]) {
					ids.push(event._id);
				}
			});
			if (ids.length) {
				Log.log("OnDelete: deleting", ids.length, "events left without a calendar.");
				future.nest(DB.del(ids));
			} else {
				future.result = {returnValue: true};
			}
		});

		future.then(this, function deletedCB() {
			checkResult(future);
			if (next) {
				future.nest(self._deleteOrphanedEvents(liveCalendars, next));
			} else {
				future.result = {returnValue: true};
			}
		});

		return future;
	}
});
