# WebCal Sync for webOS

<img src="app-enyo/images/caldav-64.png">

Subscribe to public iCal (`.ics`) calendar feeds and sync them into the webOS Calendar app — with automatic change detection, large-feed batching, and no account credentials required.

This app uses public calendar URLs -- commonly provided with Cloud services including iCloud, Office365, Google, Canvas and more.

## Requirements

- webOS device (TouchPad or phone)
- Preware installed (for installation and updates)
- Internet access from the device
- A solution for modern TLS/SSL (eg: Squid SSL-Bump proxy) 

## Installation

Install via App Museum II or manually with Preware. The package installs:

- **WebCal Sync** — the companion app for managing your subscribed calendars
- **WebCal Synergy service** — the background sync engine
- **WebCal account type** — registers with the webOS Accounts system

## Setup

1. Open the **Accounts** app (or tap **Set Up Account** inside WebCal Sync).
2. Choose **WebCal Sync** from the account list.
3. Enter any name for the account and tap **Sign In**.
4. Return to the **WebCal Sync** app once the account is created.

## Adding Calendars

1. Open **WebCal Sync**.
2. Paste a public `.ics` URL into the **URL** field. URLs starting with `webcal://` are automatically converted to `https://`.
3. Optionally enter a display name. If left blank, the name embedded in the feed (`X-WR-CALNAME`) is used after the first sync.
4. Check **Remove Alerts** if you want reminders stripped from events in this calendar.
5. Tap **Add Calendar**.

Sync runs automatically every 15 minutes. Tap **Sync Now** to force an immediate sync.

## Removing a Calendar

Swipe a calendar row to the left and confirm. Its events are removed from the Calendar app on the next sync.

## Deleting the Account

Delete the account through the webOS **Accounts** app. All calendars and events synced by WebCal Sync are removed automatically.

## Modern HTTPS and TLS Compatibility

webOS devices have an outdated TLS stack and cannot connect to servers that require modern TLS versions or use certain certificate authorities. Many calendar feeds hosted on modern infrastructure will fail to download silently.

For guidance on resolving TLS compatibility issues — including proxy solutions and certificate workarounds tested with webOS — visit:

**[docs.webosarchive.org](https://docs.webosarchive.org)**

## Notes

- Only **public** calendar URLs are supported. Feeds requiring authentication are not.
- Calendars are **read-only**. Changes made in the webOS Calendar app are not synced back.
- Events older than two years are filtered out to keep memory usage low on device.
- Large feeds (more than 50 events) are processed in batches across multiple sync invocations.

## Source

[github.com/webosarchive/webos-webcal-synergy](https://github.com/webosarchive/webos-webcal-synergy)

Derived from [C+Dav for webOS](https://github.com/webOS-ports/org.webosports.service.contacts.carddav).
