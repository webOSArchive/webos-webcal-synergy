/*jslint node: true, regexp: true */

var fs = require("fs");
var exec = require("child_process").execSync;


//delete old ipks:
var files = fs.readdirSync(".");
var ipkRegex = /.*\.ipk$/i;

files.forEach(function (file) {
	"use strict";
	if (ipkRegex.test(file)) {
		fs.unlinkSync(file);
	}
});

var result;
var packageVersion = JSON.parse(fs.readFileSync("package/packageinfo.json")).version;
var ipkBaseName = "org.webosports.webcal_" + packageVersion + "_all";

//set right version in log:
fs.writeFileSync("service/javascript/version.js", "var PackageVersion = \""  + packageVersion + "\";");

result = exec("palm-package app-enyo service accounts-enyo package");
console.log(result.toString("utf8"));

if (process.argv.length > 2) {
	console.log("Installing...");
	result = exec("palm-install " + ipkBaseName + ".ipk");
	console.log(result.toString("utf8"));
}
