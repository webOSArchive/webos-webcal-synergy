/*exported Transport, Sync, Calendar, Class, DB, Future, Activity, PalmCall, Log,
           xml, querystring, fs, httpClient, checkResult, SyncAssistant, Kinds, KindsCalendar, iCal */
/*global IMPORTS, console, require:true, process */
console.error("Starting to load libraries");

//... Load the Foundations library and create
//... short-hand references to some of its components.
var Transport = IMPORTS["mojoservice.transport"];
var Sync = IMPORTS["mojoservice.transport.sync"];
var Foundations = IMPORTS.foundations;
var Calendar = IMPORTS.calendar;

var Class = Foundations.Class;
var DB = Foundations.Data.DB;
var Future = Foundations.Control.Future;
var Activity = Foundations.Control.Activity;
var PalmCall = Foundations.Comms.PalmCall;
var xml = IMPORTS["foundations.xml"];

//now add some node.js imports:
if (typeof require === "undefined") {
	require = IMPORTS.require;
}
var querystring = require("querystring");
var fs = require("fs");

//node in webos is a bit picky about require paths. Really point it to the library here.
var servicePath = fs.realpathSync(".");
var libPath = servicePath + "/javascript/utils/";
console.log("Service Path: " + servicePath);
var Log = require(libPath + "Log.js");
Log.setFilename("/media/internal/.org.webosarchive.service.webcal.log");
var nodejsMajorVersion = Number(process.version.match(/^v\d+\.(\d+)/)[1]);
if (nodejsMajorVersion >= 4) {
	var httpClient = require(libPath + "httpClient.js");
	httpClient.setTimeoutDefault(60000);
} else {
	var httpClient = require(libPath + "httpClient_legacy.js");
}
var checkResult = require(libPath + "checkResult.js");
var KindsModule = require(servicePath + "/javascript/kinds.js");
var Kinds = KindsModule.Kinds;
var KindsCalendar = KindsModule.KindsCalendar;

var iCal = require(libPath + "iCal.js");
require(libPath + "accountConfigUtils.js"); // searchAccountConfig, lockCreateAssistant as globals

//load assistants:
var SyncAssistant = require(servicePath + "/javascript/assistants/syncassistant.js");

console.error("--------->Loaded Libraries OK");

process.on("uncaughtException", function (e) {
	"use strict";
	Log.log("Uncaought error:" + e.stack);
	Log.log("Will exit now.");
	process.exit();
});

