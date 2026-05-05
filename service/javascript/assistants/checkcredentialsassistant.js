/*jslint node: true */
/*global Future, Log */
/*exported checkCredentialsAssistant*/

var checkCredentialsAssistant = function () { "use strict"; };

checkCredentialsAssistant.prototype.run = function (future) {
	"use strict";
	Log.log("checkCredentials: approving WebCal account (no credentials required)");
	future.result = { returnValue: true };
};
