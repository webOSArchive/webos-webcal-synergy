/*jslint node: true */
/************************************************************
Contains global kinds references - NOT USED BY CONFIGURATOR
*************************************************************/
var Kinds = {
	objects: {
		calendar: {
			name: "calendar",
			identifier: "org.webosports.webcal.calendar",
			id: "org.webosports.webcal.calendar:1",
			connected_kind: "calendarevent",
			allowUpsync: false
		},
		calendarevent: {
			name: "calendarevent",
			identifier: "org.webosports.webcal.calendarevent",
			id: "org.webosports.webcal.calendarevent:1",
			connected_kind: "calendar",
			allowUpsync: false
		}
	},
	account: {
		id: "com.palm.account:1",
		metadata_id: "org.webosports.webcal.account.calendar:1"
	},
	accountConfig: {
		id: "org.webosports.webcal.account.config:1"
	}
};

exports.KindsCalendar = {
	objects: {
		calendar: {
			name: "calendar",
			identifier: "org.webosports.webcal.calendar",
			id: "org.webosports.webcal.calendar:1",
			connected_kind: "calendarevent",
			allowUpsync: false
		},
		calendarevent: {
			name: "calendarevent",
			identifier: "org.webosports.webcal.calendarevent",
			id: "org.webosports.webcal.calendarevent:1",
			connected_kind: "calendar",
			allowUpsync: false
		}
	},
	account: {
		id: "com.palm.account:1",
		metadata_id: "org.webosports.webcal.account.calendar:1"
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
