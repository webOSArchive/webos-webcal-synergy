/*jslint node: true */
/************************************************************
Contains global kinds references - NOT USED BY CONFIGURATOR
*************************************************************/
var Kinds = {
	objects: {
		calendar: {
			name: "calendar",
			identifier: "org.webosports.cdav.calendar",
			id: "org.webosports.cdav.calendar:1",
			connected_kind: "calendarevent",
			allowUpsync: false
		},
		calendarevent: {
			name: "calendarevent",
			identifier: "org.webosports.cdav.calendarevent",
			id: "org.webosports.cdav.calendarevent:1",
			connected_kind: "calendar",
			allowUpsync: false
		}
	},
	account: {
		id: "com.palm.account:1",
		metadata_id: "org.webosports.cdav.account.calendar:1"
	},
	accountConfig: {
		id: "org.webosports.cdav.account.config:1"
	}
};

exports.KindsCalendar = {
	objects: {
		calendar: {
			name: "calendar",
			identifier: "org.webosports.cdav.calendar",
			id: "org.webosports.cdav.calendar:1",
			connected_kind: "calendarevent",
			allowUpsync: false
		},
		calendarevent: {
			name: "calendarevent",
			identifier: "org.webosports.cdav.calendarevent",
			id: "org.webosports.cdav.calendarevent:1",
			connected_kind: "calendar",
			allowUpsync: false
		}
	},
	account: {
		id: "com.palm.account:1",
		metadata_id: "org.webosports.cdav.account.calendar:1"
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
