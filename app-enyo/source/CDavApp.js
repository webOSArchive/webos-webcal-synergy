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
		{ name: "sync", kind: "PalmService", service: "palm://org.webosarchive.webcal.service/",
			method: "sync", onSuccess: "syncOK", onFailure: "syncFailed" },

		{ name: "dbConfig", kind: "DbService", dbKind: "org.webosarchive.webcal.account.config:1",
			onFailure: "dbFailed", components: [
			{ name: "findConfig", method: "find", onSuccess: "loadedConfig" },
			{ name: "mergeConfig", method: "merge", onSuccess: "savedConfig", onFailure: "dbFailed" }
		]},

		{
			name: "checkStatus",
			kind: "PalmService",
			service: "palm://org.webosarchive.webcal.service/",
			method: "checkStatus",
			onSuccess: "statusResult",
			subscribe: true,
			resubscribe: true
		},

		{ kind: "PageHeader", content: $L("WebCal Subscriptions"), pack: "center" },
		{ kind: "Scroller", flex: 1, style: "margin:10px;", components: [
			{ name: "alert", style: "margin-bottom:10px;text-align:center; background-color:red; color:yellow; padding:4px;" },
			{ name: "success", style: "margin-bottom:10px;text-align:center; background-color:green; color:yellow; padding:4px;" },

			// Account picker (usually just one WebCal account)
			{ kind: "RowGroup", caption: $L("Account"), components: [
				{ kind: "Picker", name: "picker", label: $L("Account: "), onChange: "accountChanged" }
			]},

			// Subscribed calendars list
			{ kind: "RowGroup", name: "calendarListGroup", caption: $L("Subscribed Calendars"), components: [
				{ name: "calendarList", kind: "VFlexBox" },
				{ name: "noCalendarsMsg", content: $L("No calendars yet. Add one below."),
					style: "padding:10px; color:#666;" }
			]},

			// Add calendar form
			{ kind: "RowGroup", name: "addForm", caption: $L("Add Calendar"), components: [
				{kind: "InputBox", components: [
					{kind: "Input", hint: $L("https://example.com/calendar.ics"), value: "",
						name: "txtURL", tabIndex: "0", spellcheck: false,
						className: "enyo-first babelfish", flex: 1, autocorrect: false,
						autoCapitalize: "lowercase", inputType: "url", components: [
						{content: $L("URL")}
					]}
				]},
				{kind: "InputBox", components: [
					{kind: "Input", hint: $L("My Calendar (optional)"), value: "",
						name: "txtName", tabIndex: "1", spellcheck: false,
						className: "enyo-first babelfish", flex: 1, autocorrect: false,
						autoCapitalize: "words", components: [
						{content: $L("Name")}
					]}
				]},
				{ kind: "Button", tabIndex: "2", caption: $L("Add Calendar"),
					onclick: "doAddCalendar", className: "enyo-button-dark" }
			]},

			// Sync status
			{ kind: "RowGroup", caption: $L("Status"), components: [
				{name: "running", content: $L("Sync not running.")},
				{name: "lastMessage", content: $L("Status: ")},
				{name: "numDownloaded", content: $L("Downloads: ")}
			]},

			// Sync button
			{ kind: "RowGroup", caption: $L("Actions"), components: [
				{ kind: "Button", tabIndex: "3", caption: $L("Sync Now"),
					onclick: "doSync", className: "enyo-button-dark" }
			]},

			{kind: "VFlexBox", className: "box-center", flex: 1, pack: "center", align: "center", components: [
				{ kind: "SpinnerLarge", name: "spinner" }
			]}
		]},
		{className: "accounts-footer-shadow", tabIndex: -1}
	],

	create: function () {
		this.inherited(arguments);
		this.accounts = [];
		this.currentConfig = null;
		this.$.findConfig.call({query: {from: "org.webosarchive.webcal.account.config:1"}});
	},

	loadedConfig: function (inSender, inResponse) {
		var i, items = [], results = inResponse.results || [];
		debug("Loaded config (" + results.length + " results)");

		// Post-save refresh: just update the currentConfig object and re-render the list
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

		// Initial load: populate the account picker
		this.accounts = results;

		if (this.accounts.length === 0) {
			items.push({caption: $L("No accounts found"), value: false});
			this.$.picker.setDisabled(true);
		} else {
			for (i = 0; i < this.accounts.length; i += 1) {
				items.push({
					caption: this.accounts[i].name || ("Account " + (i + 1)),
					value: this.accounts[i].accountId
				});
			}
		}

		this.$.picker.setItems(items);
		this.$.picker.setValue(items[0].value);
		this.$.picker.render();

		if (this.accounts.length > 0) {
			this.accountChanged();
		}
	},

	accountChanged: function () {
		var accountId = this.$.picker.getValue(), i;
		this.currentConfig = null;
		this.lastStatus = "";

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
	},

	renderCalendarList: function () {
		var calendars, i, url, name, cal;

		this.$.calendarList.destroyComponents();

		if (!this.currentConfig) {
			this.$.noCalendarsMsg.show();
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
				name = cal.name || url;

				this.$.calendarList.createComponent({
					kind: "HFlexBox",
					style: "padding:8px; border-bottom:1px solid #ccc;",
					calIndex: i,
					components: [
						{kind: "VFlexBox", flex: 1, components: [
							{content: name, style: "font-weight:bold; font-size:14px;"},
							{content: url, style: "font-size:11px; color:#666; word-break:break-all;"}
						]},
						{kind: "Button", caption: $L("Remove"), calIndex: i,
							onclick: "doRemoveCalendar", style: "flex:0; min-width:80px;",
							className: "enyo-button-negative"}
					]
				}, {owner: this});
			}
		}

		this.$.calendarList.render();
	},

	doAddCalendar: function () {
		var url = this.$.txtURL.getValue().trim();
		var name = this.$.txtName.getValue().trim();
		var calendars, i;

		this.$.alert.setContent("");

		if (!url) {
			this.$.alert.setContent($L("Please enter a calendar URL."));
			return;
		}

		if (!this.currentConfig) {
			this.$.alert.setContent($L("Please select an account first."));
			return;
		}

		// Normalize: ensure URL starts with http
		if (url.indexOf("http") !== 0 && url.indexOf("webcal") === 0) {
			url = "https" + url.slice(6); // webcal:// → https://
		}

		calendars = (this.currentConfig.calendars || []).slice(); // copy

		// Check for duplicate
		for (i = 0; i < calendars.length; i += 1) {
			if ((calendars[i].url || calendars[i]) === url) {
				this.$.alert.setContent($L("This URL is already subscribed."));
				return;
			}
		}

		calendars.push({url: url, name: name || url});
		this.saveCalendars(calendars, function () {
			this.$.txtURL.setValue("");
			this.$.txtName.setValue("");
			this.showSuccess($L("Calendar added. It will sync on the next sync cycle."));
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
				this.showSuccess($L("Calendar removed."));
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
				_rev: this.currentConfig._rev,
				calendars: newCalendars
			}]
		});
	},

	savedConfig: function (inSender, inResponse) {
		debug("Saved config: " + JSON.stringify(inResponse));
		// Refresh this account's config from DB to pick up the new _rev
		this.configRefreshAfterSave = true;
		this.$.findConfig.call({query: {from: "org.webosarchive.webcal.account.config:1",
			where: [{prop: "accountId", op: "=", val: this.$.picker.getValue()}]}});

		if (this.pendingSaveCallback) {
			this.pendingSaveCallback();
			this.pendingSaveCallback = null;
		}
	},

	doSync: function () {
		var accountId = this.$.picker.getValue();
		if (accountId) {
			this.indicateActivity();
			this.$.alert.setContent("");
			this.$.sync.call({accountId: accountId});
		}
	},

	syncOK: function (inSender, inResponse) {
		this.endActivity();
		debug("Sync success: " + JSON.stringify(inResponse));
		this.showSuccess($L("Sync completed successfully."));
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

	showError: function (msg) {
		this.$.success.setContent("");
		this.$.alert.setContent(msg);
	},

	showSuccess: function (msg) {
		this.$.alert.setContent("");
		this.$.success.setContent(msg);
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
		if (status.running) {
			var kind, stat, found = false;
			for (kind in status) {
				if (status.hasOwnProperty(kind) && typeof status[kind] === "object") {
					if (status[kind].running) {
						found = true;
						this.$.running.setContent($L("Syncing ") + kind + "...");
						stat = status[kind];
						if (stat.status) {
							this.$.lastMessage.setContent($L("Status: ") + stat.status);
							this.lastStatus = stat.status;
						}
						if (stat.downloadTotal) {
							this.$.numDownloaded.setContent(
								$L("Downloading ") + (stat.downloadsDone || 0) + $L(" of ") + stat.downloadTotal
							);
						} else {
							this.$.numDownloaded.setContent($L("Downloads: "));
						}
					}
				}
			}
			if (!found) {
				this.$.running.setContent($L("Sync is running."));
			}
		} else {
			this.$.running.setContent($L("Sync not running."));
			if (this.lastStatus) {
				this.$.lastMessage.setContent($L("Last status: ") + this.lastStatus);
			} else {
				this.$.lastMessage.setContent($L("Status: "));
			}
			this.$.numDownloaded.setContent($L("Downloads: "));
		}
	}
});
