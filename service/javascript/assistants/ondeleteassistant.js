/*jslint nomen: true, node: true */
/*global Class, Future, Log, Sync, DB, checkResult */
/*exported OnDelete*/

var OnDelete = Class.create(Sync.DeleteAccountCommand, {
	run: function run(outerFuture) {
		"use strict";
		var future = new Future(), config = this.client.config;

		if (config && config._id) {
			future.nest(DB.del([config._id]));

			future.then(this, function dbCB() {
				var result = checkResult(future);
				Log.debug("Delete config object result: ", result);
				this.$super(run)(outerFuture);
			});
		} else {
			this.$super(run)(outerFuture);
		}

		return outerFuture;
	}
});
