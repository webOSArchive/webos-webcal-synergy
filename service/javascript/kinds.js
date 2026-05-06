/*jslint node: true */
/************************************************************
Contains global kinds references - NOT USED BY CONFIGURATOR
*************************************************************/
var Kinds = {
	objects: {
		calendar: {
			name: "calendar",
			identifier: "org.webosarchive.webcal.calendar",
			id: "org.webosarchive.webcal.calendar:1",
			connected_kind: "calendarevent",
			allowUpsync: false
		},
		calendarevent: {
			name: "calendarevent",
			identifier: "org.webosarchive.webcal.calendarevent",
			id: "org.webosarchive.webcal.calendarevent:1",
			connected_kind: "calendar",
			allowUpsync: false
		}
	},
	account: {
		id: "com.palm.account:1",
		metadata_id: "org.webosarchive.webcal.account.calendar:1"
	},
	accountConfig: {
		id: "org.webosarchive.webcal.account.config:1"
	}
};

exports.KindsCalendar = {
	objects: {
		calendar: {
			name: "calendar",
			identifier: "org.webosarchive.webcal.calendar",
			id: "org.webosarchive.webcal.calendar:1",
			connected_kind: "calendarevent",
			allowUpsync: false
		},
		calendarevent: {
			name: "calendarevent",
			identifier: "org.webosarchive.webcal.calendarevent",
			id: "org.webosarchive.webcal.calendarevent:1",
			connected_kind: "calendar",
			allowUpsync: false
		}
	},
	account: {
		id: "com.palm.account:1",
		metadata_id: "org.webosarchive.webcal.account.calendar:1"
	},
	syncOrder: [
		Kinds.objects.calendar.name,
		Kinds.objects.calendarevent.name
	]
};

Kinds.syncOrder = [
	Kinds.objects.calendar.name,
	Kinds.objects.calendarevent.name
];

exports.Kinds = Kinds;
