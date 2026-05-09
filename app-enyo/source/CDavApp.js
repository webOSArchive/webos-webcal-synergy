/*jslint sloppy: true */
/*global enyo, $L, console */
/*exported log */

function log(msg) {
	console.error(msg);
}

function debug(msg) {
	console.error(msg);
}

/*
 * WebCal companion app — manages the list of subscribed .ics calendar URLs.
 * Reads/writes the "calendars" array in org.webosarchive.webcal.account.config:1.
 */
enyo.kind({
	name: "Main.CDavApp",
	width: "100%",
	kind: "VFlexBox",
	className: "enyo-bg",
	components: [
		{ kind: "AppMenu", components: [
			{ kind: "EditMenu" },
			{ caption: $L("About"), onclick: "showAbout" }
		]},

		{ name: "sync", kind: "PalmService", service: "palm://org.webosarchive.webcal.service/",
			method: "sync", onSuccess: "syncOK", onFailure: "syncFailed" },
		{ name: "launchAppRequest", kind: "PalmService", service: "palm://com.palm.applicationManager/",
			method: "open", onSuccess: "", onFailure: "" },
		{ name: "getAccountInfo", kind: "PalmService", service: "palm://com.palm.service.accounts/",
			method: "getAccountInfo", onSuccess: "accountInfoLoaded", onFailure: "" },

		{ name: "dbConfig", kind: "DbService", dbKind: "org.webosarchive.webcal.account.config:1",
			onFailure: "dbFailed", components: [
			{ name: "findConfig", method: "find", onSuccess: "loadedConfig" },
			{ name: "mergeConfig", method: "merge", onSuccess: "savedConfig", onFailure: "dbFailed" }
		]},

		{ name: "dbCalendars", kind: "DbService", dbKind: "org.webosarchive.webcal.calendar:1",
			onFailure: "calendarsLoadFailed", components: [
			{ name: "findCalendars", method: "find", onSuccess: "calendarsLoaded",
				onFailure: "calendarsLoadFailed" }
		]},

		{ name: "checkStatus", kind: "PalmService",
			service: "palm://org.webosarchive.webcal.service/",
			method: "checkStatus", onSuccess: "statusResult",
			subscribe: true, resubscribe: true },

		{ kind: "Dialog", name: "aboutDialog", lazy: false, components: [
			{ name: "aboutTitle",
				style: "font-size: 20px; font-weight: bold; text-align: center; padding-bottom: 2px;" },
			{ name: "aboutVersion",
				style: "text-align: center; color: #666; padding-bottom: 4px;" },
			{ name: "aboutCopyright",
				style: "text-align: center; color: #666;" },
			{ kind: "Button", caption: $L("OK"), onclick: "closeAbout",
				className: "enyo-button-dark", style: "margin-top: 16px; width: 100%;" }
		]},

		{ kind: "Dialog", name: "alertDialog", lazy: false, components: [
			{ kind: "HtmlContent", name: "alertMsg", style: "padding: 8px 0;" },
			{ kind: "Button", caption: $L("OK"), onclick: "closeAlert",
				className: "enyo-button-dark", style: "margin-top: 8px; width: 100%;" }
		]},

		// Light-chrome header toolbar with spinner on the right
		{ kind: "Toolbar", className: "enyo-toolbar-light webcal-header", pack: "center",
			align: "center", components: [
			{ kind: "HFlexBox", flex: 1, align: "center", pack: "center", components: [
				{ className: "header-icon webcal-icon" },
				{ content: $L("WebCal Subscriptions"), className: "headerTitle" }
			]},
			{ kind: "Spinner", name: "spinner", showing: false }
		]},
		{ kind: "Scroller", flex: 1, components: [
			{ kind: "Control", className: "box-center", components: [

			// Account picker — shown when ≥1 accounts exist
			{ kind: "RowGroup", name: "accountGroup", caption: $L("Account"), components: [
				{ kind: "Picker", name: "picker", label: $L("Account: "), onChange: "accountChanged" }
			]},

			// Empty state — shown when no accounts exist
			{ name: "noAccountSection", showing: false, components: [
				{ content: $L("No WebCal accounts found. Use the Accounts app to add one."),
					className: "footnote-text" },
				{ kind: "Button", caption: $L("Set Up Account"), onclick: "launchAccounts",
					className: "enyo-button-dark" }
			]},

			// Subscribed calendars list
			{ kind: "RowGroup", name: "calendarListGroup", caption: $L("Subscribed Calendars"),
				components: [
				{ name: "calendarList", kind: "VFlexBox" },
				{ name: "noCalendarsMsg", content: $L("No calendars yet. Add one below."),
					style: "padding: 10px; color: #666;" }
			]},

			// Add calendar form
			{ kind: "RowGroup", name: "addForm", caption: $L("Add Calendar"), components: [
				{ kind: "InputBox", components: [
					{ kind: "Input", hint: $L("https://example.com/calendar.ics"), value: "",
						name: "txtURL", tabIndex: "0", spellcheck: false,
						className: "babelfish", flex: 1, autocorrect: false,
						autoCapitalize: "lowercase", inputType: "url", components: [
						{ content: $L("URL") }
					]}
				]},
				{ kind: "InputBox", components: [
					{ kind: "Input", hint: $L("My Calendar (optional)"), value: "",
						name: "txtName", tabIndex: "1", spellcheck: false,
						className: "babelfish", flex: 1, autocorrect: false,
						autoCapitalize: "words", components: [
						{ content: $L("Name") }
					]}
				]},
				{ kind: "Item", tapHighlight: false, components: [
					{ kind: "HFlexBox", align: "center", components: [
						{ content: $L("  Remove Alerts"), flex: 1 },
						{ kind: "CheckBox", name: "chkRemoteAlerts" }
					]}
				]},
				{ kind: "Button", name: "addCalendarBtn", tabIndex: "2",
					caption: $L("Add Calendar"), onclick: "doAddCalendar",
					className: "enyo-button-dark" }
			]},

			// Sync button
			{ kind: "RowGroup", caption: $L("Actions"), components: [
				{ kind: "Button", name: "syncBtn", tabIndex: "3",
					caption: $L("Sync Now"), onclick: "doSync",
					className: "enyo-button-dark" }
			]},

			// Sync status line
			{ name: "statusText", className: "footnote-text text-truncate" }

		]}  // end box-center
		]}, // end Scroller
		{ className: "accounts-footer-shadow", tabIndex: -1 }
	],

	create: function () {
		this.inherited(arguments);
		this.accounts = [];
		this.currentConfig = null;
		this.calendarRows = [];
		this.calendarNames = {};
		this.lastStatus = "";
		this.$.findConfig.call({query: {from: "org.webosarchive.webcal.account.config:1"}});
	},

	loadedConfig: function (inSender, inResponse) {
		var i, results = inResponse.results || [];
		debug("Loaded config (" + results.length + " results)");

		// Post-save refresh: update the in-memory config and re-render the list
		if (this.configRefreshAfterSave) {
			this.configRefreshAfterSave = false;
			if (results.length > 0) {
				for (i = 0; i < this.accounts.length; i += 1) {
					if (this.accounts[i].accountId === results[0].accountId) {
						this.accounts[i] = results[0];
						break;
					}
				}
				this.currentConfig = results[0];
			}
			this.renderCalendarList();
			return;
		}

		// Initial load: show picker or empty state
		this.accounts = results;

		if (this.accounts.length === 0) {
			this.$.accountGroup.hide();
			this.$.noAccountSection.show();
			this.$.addCalendarBtn.setDisabled(true);
			this.$.syncBtn.setDisabled(true);
			this.$.noCalendarsMsg.setContent($L("An account must be set up before you can add calendars."));
		} else {
			this.$.noAccountSection.hide();
			this.$.accountGroup.show();
			this.$.addCalendarBtn.setDisabled(false);
			this.$.syncBtn.setDisabled(false);
			if (!this.lookupMissingNames()) {
				// All names present — build picker immediately
				this.rebuildPickerItems();
				this.accountChanged();
			}
			// else: accountInfoLoaded() will call rebuildPickerItems() once names arrive
		}
	},

	accountChanged: function () {
		var accountId = this.$.picker.getValue(), i;
		this.currentConfig = null;
		this.calendarNames = {};
		this.lastStatus = "";
		this.$.statusText.setContent("");

		if (!accountId) {
			return;
		}

		for (i = 0; i < this.accounts.length; i += 1) {
			if (this.accounts[i].accountId === accountId) {
				this.currentConfig = this.accounts[i];
				break;
			}
		}

		this.renderCalendarList();
		this.getStatus();
		this.refreshCalendarNames();
	},

	renderCalendarList: function () {
		var calendars, i, url, name, cal, row;

		// Destroy previously created rows so the DOM clears correctly
		for (i = 0; i < this.calendarRows.length; i += 1) {
			this.calendarRows[i].destroy();
		}
		this.calendarRows = [];

		if (!this.currentConfig) {
			this.$.noCalendarsMsg.show();
			this.$.calendarList.render();
			return;
		}

		calendars = this.currentConfig.calendars || [];

		if (calendars.length === 0) {
			this.$.noCalendarsMsg.show();
		} else {
			this.$.noCalendarsMsg.hide();
			for (i = 0; i < calendars.length; i += 1) {
				cal = calendars[i];
				url = cal.url || cal;
				name = this.calendarNames[url] || cal.name || url;

				row = this.$.calendarList.createComponent({
					kind: "SwipeableItem",
					calIndex: i,
					tapHighlight: false,
					confirmCaption: $L("Delete"),
					onConfirm: "doRemoveCalendar",
					components: [
						{ kind: "VFlexBox", components: [
							{ content: name, style: "font-weight: bold;" },
							{ content: url, className: "enyo-item-secondary text-truncate" }
						]}
					]
				}, {owner: this});
				this.calendarRows.push(row);
			}
		}

		this.$.calendarList.render();
	},

	refreshCalendarNames: function () {
		var accountId = this.$.picker.getValue();
		if (!accountId) { return; }
		this.$.findCalendars.call({query: {
			from: "org.webosarchive.webcal.calendar:1",
			where: [{prop: "accountId", op: "=", val: accountId}]
		}});
	},

	calendarsLoaded: function (inSender, inResponse) {
		var i, cal, key, results = (inResponse && inResponse.results) || [];
		debug("calendarsLoaded: " + results.length + " records");
		for (i = 0; i < results.length; i += 1) {
			cal = results[i];
			debug("cal record: name=" + cal.name + " uri=" + (cal.uri || "(none)") +
				" remoteId=" + (cal.remoteId || "(none)"));
			key = cal.uri || cal.remoteId;
			if (key && cal.name && cal.name !== key) {
				this.calendarNames[key] = cal.name;
			}
		}
		this.renderCalendarList();
	},

	calendarsLoadFailed: function (inSender, inResponse) {
		debug("Calendar names query failed (non-fatal): " + JSON.stringify(inResponse));
	},

	doAddCalendar: function () {
		var url = this.$.txtURL.getValue().trim();
		var name = this.$.txtName.getValue().trim();
		var calendars, i;

		if (!url) {
			this.showError($L("Please enter a calendar URL."));
			return;
		}

		if (!this.currentConfig) {
			this.showError($L("Please select an account first."));
			return;
		}

		// Normalize: webcal:// → https://
		if (url.indexOf("http") !== 0 && url.indexOf("webcal") === 0) {
			url = "https" + url.slice(6);
		}

		calendars = (this.currentConfig.calendars || []).slice();

		for (i = 0; i < calendars.length; i += 1) {
			if ((calendars[i].url || calendars[i]) === url) {
				this.showError($L("This URL is already subscribed."));
				return;
			}
		}

		calendars.push({url: url, name: name || url, removeAlerts: this.$.chkRemoteAlerts.getChecked()});
		this.saveCalendars(calendars, function () {
			this.$.txtURL.setValue("");
			this.$.txtName.setValue("");
			this.$.chkRemoteAlerts.setChecked(false);
			enyo.windows.addBannerMessage($L("Calendar added. Sync to load events."),
				"images/caldav-1024.png");
		}.bind(this));
	},

	doRemoveCalendar: function (inSender) {
		var index = inSender.calIndex, calendars;

		if (!this.currentConfig) {
			return;
		}

		calendars = (this.currentConfig.calendars || []).slice();
		if (index >= 0 && index < calendars.length) {
			calendars.splice(index, 1);
			this.saveCalendars(calendars, function () {
				enyo.windows.addBannerMessage($L("Calendar removed."),
					"images/caldav-1024.png");
			}.bind(this));
		}
	},

	saveCalendars: function (newCalendars, callback) {
		if (!this.currentConfig || !this.currentConfig._id) {
			this.showError($L("Cannot save: no account config found."));
			return;
		}

		this.pendingSaveCallback = callback;
		this.$.mergeConfig.call({
			objects: [{
				_id: this.currentConfig._id,
				calendars: newCalendars
			}]
		});
	},

	savedConfig: function (inSender, inResponse) {
		debug("Saved config: " + JSON.stringify(inResponse));
		// Refresh from DB to pick up the new _rev
		this.configRefreshAfterSave = true;
		this.$.findConfig.call({query: {from: "org.webosarchive.webcal.account.config:1",
			where: [{prop: "accountId", op: "=", val: this.$.picker.getValue()}]}});

		if (this.pendingSaveCallback) {
			this.pendingSaveCallback();
			this.pendingSaveCallback = null;
		}
	},

	rebuildPickerItems: function () {
		var i, items = [];
		for (i = 0; i < this.accounts.length; i += 1) {
			items.push({
				caption: this.accounts[i].name || ("Account " + (i + 1)),
				value: this.accounts[i].accountId
			});
		}
		this.$.picker.setDisabled(false);
		this.$.picker.setItems(items);
		this.$.picker.setValue(null);
		this.$.picker.setValue(items[0].value);
		this.$.picker.render();
	},

	lookupMissingNames: function () {
		var i, needed = false;
		for (i = 0; i < this.accounts.length; i += 1) {
			if (!this.accounts[i].name && this.accounts[i].accountId) {
				this.$.getAccountInfo.call({accountId: this.accounts[i].accountId});
				needed = true;
			}
		}
		return needed;
	},

	accountInfoLoaded: function (inSender, inResponse) {
		var account = inResponse.result, i, username;
		if (!account || !account._id) { return; }
		username = account.username || account.alias || "WebCal";
		for (i = 0; i < this.accounts.length; i += 1) {
			if (this.accounts[i].accountId === account._id) {
				this.accounts[i].name = username;
				if (this.accounts[i]._id) {
					this.$.mergeConfig.call({objects: [{_id: this.accounts[i]._id, name: username}]});
				}
				break;
			}
		}
		this.rebuildPickerItems();
	},

	launchAccounts: function () {
		this.$.launchAppRequest.call({"id": "com.palm.app.accounts", "params": {}});
		window.close();
	},

	doSync: function () {
		var accountId = this.$.picker.getValue();
		if (accountId) {
			this.indicateActivity();
			this.$.sync.call({accountId: accountId});
		}
	},

	syncOK: function (inSender, inResponse) {
		this.endActivity();
		debug("Sync success: " + JSON.stringify(inResponse));
		enyo.windows.addBannerMessage($L("Sync completed successfully."), "images/caldav-1024.png");
		this.refreshCalendarNames();
	},

	syncFailed: function (inSender, inResponse) {
		this.endActivity();
		debug("Sync failed: " + JSON.stringify(inResponse));
		this.showError($L("Sync failed: ") + JSON.stringify(inResponse));
	},

	dbFailed: function (inSender, inResponse) {
		debug("DB error: " + JSON.stringify(inResponse));
		this.showError($L("Database error: ") + JSON.stringify(inResponse));
	},

	showAbout: function () {
		var info = enyo.fetchAppInfo();
		this.$.aboutTitle.setContent(info.title || "WebCal Sync");
		this.$.aboutVersion.setContent("Version " + (info.version || ""));
		this.$.aboutCopyright.setContent("Copyright " + (info.copyrightYear || "2026") + ", " + (info.vendor || "webOS Archive"));
		this.$.aboutDialog.open();
	},

	closeAbout: function () {
		this.$.aboutDialog.close();
	},

	showError: function (msg) {
		this.$.alertMsg.setContent(msg);
		this.$.alertDialog.open();
	},

	closeAlert: function () {
		this.$.alertDialog.close();
	},

	indicateActivity: function () {
		this.$.spinner.show();
	},

	endActivity: function () {
		this.$.spinner.hide();
	},

	getStatus: function () {
		var accountId = this.$.picker.getValue();
		this.$.checkStatus.cancel();
		if (accountId) {
			this.$.checkStatus.call({accountId: accountId});
		}
	},

	statusResult: function (inSender, status) {
		var kind, stat, found = false, text = "";
		if (status.running) {
			for (kind in status) {
				if (status.hasOwnProperty(kind) && typeof status[kind] === "object") {
					if (status[kind].running) {
						found = true;
						stat = status[kind];
						text = $L("Syncing ") + kind + "...";
						if (stat.status) {
							this.lastStatus = stat.status;
						}
						if (stat.downloadTotal) {
							text += " (" + (stat.downloadsDone || 0) +
								" of " + stat.downloadTotal + ")";
						}
						break;
					}
				}
			}
			if (!found) {
				text = $L("Sync running.");
			}
		} else {
			if (this.lastStatus) {
				text = $L("Last status: ") + this.lastStatus;
			}
		}
		this.$.statusText.setContent(text);
	}
});
