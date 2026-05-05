/*jslint sloppy: true, nomen: true */
/*global enyo, $L, console, setTimeout, PalmSystem */

function log(msg) {
	console.error(msg);
}

function debug(msg) {
	console.error(msg);
}

/*
 * WebCal account creation UI — no credentials required.
 * The user just provides an account name; calendar URLs are managed
 * in the main companion app after account creation.
 */
enyo.kind({
	name: "Main.CrossAppLaunch",
	width: "100%",
	kind: "VFlexBox",
	className: "enyo-bg",
	components: [
		{ name: "checkCredentials", kind: "PalmService", service: "palm://org.webosports.service.webcal/",
			method: "checkCredentials", onSuccess: "credentialsOK", onFailure: "credentialsFailed" },
		{kind: "ApplicationEvents", onWindowParamsChange: "windowParamsChangeHandler"},
		{ kind: "PageHeader", content: $L("WebCal Account Setup"), pack: "center" },
		{ kind: "Scroller", flex: 1, style: "margin:30px;", components: [
			{ name: "alert", style: "margin-bottom:30px;text-align:center; background-color:red; color:yellow;" },
			{ kind: "RowGroup", caption: $L("Account Name"), components: [
				{kind: "InputBox", components: [
					{kind: "Input", hint: $L("My WebCal Account"), value: "", name: "txtAccountName",
						tabIndex: "0", spellcheck: false, className: "enyo-first babelfish",
						flex: 1, autocorrect: false, autoCapitalize: "words", components: [
						{content: $L("Name")}
					]}
				]},
				{ kind: "Button", tabIndex: "1", caption: $L("Create Account"),
					onclick: "doCreateAccount", className: "enyo-button-dark" }
			]}
		]},
		{kind: "CrossAppResult", name: "crossAppResult" },
		{className: "accounts-footer-shadow", tabIndex: -1},
		{kind: "Toolbar", className: "enyo-toolbar-light", components: [
			{ name: "doneButton", kind: "Button", caption: $L("Cancel"),
				onclick: "doBack", className: "accounts-toolbar-btn"}
		]}
	],
	create: function () {
		this.inherited(arguments);

		if (PalmSystem.launchParams) {
			this.params = JSON.parse(PalmSystem.launchParams);
		}
		if (enyo.windowParams) {
			this.params = enyo.windowParams;
		}

		if (this.params && this.params.mode === "modify" && this.params.account) {
			this.$.txtAccountName.setValue(this.params.account.alias || "");
		}
	},
	doCreateAccount: function () {
		var name = this.$.txtAccountName.getValue();
		if (!name) {
			this.$.alert.setContent($L("Please enter an account name."));
			return;
		}
		if (!this.params) {
			this.$.alert.setContent($L("No parameters received. Must be called from Account Manager."));
			return;
		}
		this.accountName = name;
		this.$.alert.setContent("");
		enyo.scrim.show();
		this.$.checkCredentials.call({name: name});
	},
	credentialsOK: function (inSender, inResponse) {
		enyo.scrim.hide();
		debug("checkCredentials OK: " + JSON.stringify(inResponse));

		if (!this.params) {
			this.$.alert.setContent($L("Internal error: no parameters."));
			return;
		}

		var template = this.params.template;
		if (this.params.mode === "create" && template) {
			template.loc_name = this.accountName;
			template.config = {name: this.accountName, calendars: []};

			var i;
			for (i = 0; i < template.capabilityProviders.length; i += 1) {
				if (template.capabilityProviders[i].capability === "CALENDAR") {
					template.capabilityProviders[i].enabled = true;
					template.capabilityProviders[i].loc_name = this.accountName;
					break;
				}
			}
		}

		var accountSettings = {
			template: this.params.template,
			username: this.accountName,
			config: {name: this.accountName, calendars: []},
			alias: this.accountName,
			returnValue: true
		};

		this.$.crossAppResult.sendResult(accountSettings);
	},
	credentialsFailed: function (inSender, inResponse) {
		enyo.scrim.hide();
		this.$.alert.setContent($L("Account setup failed: ") + JSON.stringify(inResponse));
	},
	windowParamsChangeHandler: function (inSender, event) {
		if (event && event.params && event.params.template) {
			this.params = event.params;
		}
	},
	doBack: function () {
		this.$.crossAppResult.sendResult({returnValue: false});
	}
});
