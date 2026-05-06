/*jslint node: true */
/*global Future, Log */
/*exported checkCredentialsAssistant*/

var checkCredentialsAssistant = function () { "use strict"; };

checkCredentialsAssistant.prototype.run = function (future) {
	"use strict";
	var args = this.controller.args;
	var name = args.username || args.name || "WebCal";
	Log.log("checkCredentials: approving WebCal account for", name);
	future.result = {
		returnValue: true,
		credentials: { common: { username: name, password: "webcal" } },
		config: { name: name }
	};
};
