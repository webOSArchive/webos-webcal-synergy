/*jslint node: true */
/*global Class, Log, Sync */
/*exported OnEnabled*/

var OnEnabled = Class.create(Sync.EnabledAccountCommand, {
	run: function run(outerFuture) {
		"use strict";
		Log.log("OnEnabled: enabled =", this.controller.args.enabled);
		return this.$super(run)(outerFuture);
	}
});
