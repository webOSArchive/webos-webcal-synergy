/* ServiceAssistant
* Description: This method handles the high level transport setup.
* This assistant is called before anything within the service.  This is useful to intercept the various endpoints and
* handle various tasks like key storage or customizations
*
* To run manually:
* run-js-service -d /media/cryptofs/apps/usr/palm/services/org.webosarchive.webcal.service/
*/
/*jslint node: true */
/*global Log, Class, searchAccountConfig, Transport, Sync, Future, KindsCalendar, checkResult, lockCreateAssistant, libPath, iCal, PackageVersion */
/*exported ServiceAssistant, OnCredentialsChanged */

var ServiceAssistant = Transport.ServiceAssistantBuilder({
	clientId: "",

	client: Class.create(Sync.AuthSyncClient, {

		kinds: {},

		setup: function setup(service, accountid, launchConfig, launchArgs) {
			"use strict";
			Log.log("\n\n**************************START SERVICEASSISTANT " + PackageVersion + " *****************************");
			Log.log("Starting ", launchConfig.name, " for account ", launchArgs.accountId, " from activity ", launchArgs.$activity);

			this.accountId = launchArgs.accountId || "";

			if (launchConfig.name.indexOf("Create") >= 0) {
				lockCreateAssistant(this.accountId, launchConfig.name);
			}

			if (!this.config) {
				this.config = {};
			}

			this.config.accountId = this.accountId;
			this.kinds = KindsCalendar;

			var future = new Future();

			if (this.accountId) {
				if (!this.config) {
					this.config = {};
				}
				this.config.accountId = this.accountId;
				future.nest(searchAccountConfig(this.config));
			} else {
				Log.log("No accountId, continue execution without config lookup.");
				future.result = { returnValue: false };
			}

			future.then(this, function () {
				var result = checkResult(future);
				if (result.returnValue === true) {
					this.config = result.config;
				}
				if (launchConfig.name === "checkCredentials") {
					Log.log("Skipping iCal init for checkCredentials");
					future.result = { returnValue: true };
				} else {
					future.nest(iCal.initialize());
				}
			});

			future.then(this, function () {
				var result = checkResult(future);
				if (!result.returnValue) {
					Log.debug("iCal init not ok.");
				} else {
					Log.debug("iCal initialized");
				}
				future.result = { returnValue: true };
			});

			future.then(this, function () {
				this.$super(setup)(service, this.accountId, undefined, Transport.HandlerFactoryBuilder(Sync.SyncHandler(this.kinds)));
				return true;
			});

			return future;
		},

		getSyncInterval: function () {
			"use strict";
			return new Future("30m");
		},

		requiresInternet: function () {
			"use strict";
			return true;
		}
	})
});

var OnCredentialsChanged = Sync.CredentialsChangedCommand;
