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

		future.then(this, function superCB() {
			try { checkResult(future); } catch (e) {
				Log.log("OnDelete: calendar delete error (non-fatal):", e.message || e);
			}
			self.$super(run)(outerFuture);
		});

		return outerFuture;
	}
});
