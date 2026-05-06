# webos-webcal-synergy

A webOS Synergy service that subscribes to public iCal (.ics) calendar URLs and syncs events into the webOS calendar app. Forked from `org.webosports.service.contacts.carddav` at commit 35cb6cc; all CardDAV, contacts, auth, upsync, Mojo app, and multi-provider support has been stripped out.

## What this is

- **Read-only** — no upsync, ever
- **No auth** — public calendars only
- **No CalDAV** — plain HTTP GET of `.ics` files
- **One account type** — user creates a "WebCal" synergy account and manages a list of calendar URLs through the companion Enyo app
- **Change detection** — MD5 hash of the raw HTTP response body; skip re-parsing if hash unchanged
- **30-minute sync interval**

## Identifiers

All IDs use `org.webosarchive` as the base domain:

| Thing | ID |
|---|---|
| Package | `org.webosarchive.webcal` |
| Service | `org.webosarchive.service.webcal` |
| Companion app | `org.webosarchive.app.webcal` |
| Account template | `org.webosarchive.webcal.account` |
| Calendar DB8 kind | `org.webosarchive.webcal.calendar:1` |
| Calendar event DB8 kind | `org.webosarchive.webcal.calendarevent:1` |
| Account config DB8 kind | `org.webosarchive.webcal.account.config:1` |
| Permission group | `webcal-service.operation` |

## Key files

### Service
- `service/javascript/prologue.js` — loads all globals (DB, Future, Log, httpClient, iCal, etc.); `require()`s `accountConfigUtils.js` as a side-effect so `searchAccountConfig` becomes a global
- `service/javascript/kinds.js` — DB8 kind definitions; only calendar + calendarevent; no upsync
- `service/javascript/assistants/syncassistant.js` — the entire sync engine (see Architecture below)
- `service/javascript/assistants/serviceassistant.js` — transport setup; always uses `KindsCalendar`; returns `"30m"` sync interval
- `service/javascript/assistants/checkcredentialsassistant.js` — stub; always returns `{returnValue: true}`
- `service/javascript/utils/WebCal.js` — HTTP GET wrapper; computes MD5 hash; extracts `X-WR-CALNAME`
- `service/javascript/utils/iCal.js` — iCal parser; `parseWebCalICal()` added for full-calendar files with multiple VEVENTs
- `service/javascript/utils/accountConfigUtils.js` — loaded as side-effect require; exposes `searchAccountConfig` global

### Companion app (Enyo)
- `app-enyo/source/CDavApp.js` — URL list manager: add/remove calendar URLs, "Sync Now" button, live status display
- `app-enyo/CrossAppTarget/CrossAppTarget.js` — account creation UI: prompts for account name only (no credentials)

### Config
- `accounts-enyo/account-template.json` — single CALENDAR capability provider; no-credential validator
- `service/services.json` — service endpoint definitions (checkCredentials, sync, checkStatus, onCalendar*)
- `files/sysbus/org.webosarchive.service.webcal.*` — Luna Bus ACG/role/perm files
- `package/packageinfo.json` — package manifest
- `build.js` — `palm-package app-enyo service accounts-enyo package`

## Architecture

### Account config
URL list lives in `org.webosarchive.webcal.account.config:1` as `calendars: [{url, name}]`. The companion app reads and writes this directly via DB8. The service re-reads it at the start of each `_getWebCalCollectionChanges` call to pick up any changes made since last sync.

### Sync flow

1. Outer `run()` call (no `capability` arg) — routes to inner call with `capability: "CALENDAR"` via PalmCall
2. Inner call — initializes SyncKey, calls `$super(run)`, which drives `getRemoteChanges` for each kind in `syncOrder`

**Calendar kind** (`_getWebCalCollectionChanges`):
- Re-reads account config from DB
- Queries local DB for existing calendar objects
- Diffs config URLs vs local calendars → returns add/delete entries
- Calls `_syncEventFolders` to align SyncKey event folders with the URL list

**Calendarevent kind** (`_getWebCalEventChanges`):
- Uses `skipReason` closure variable to propagate early-exit through the future chain without double-executing cleanup
- Per folder: `_initCollectionId` → `WebCal.fetch` → hash check vs stored ctag → `iCal.parseWebCalICal` → `_buildEventEntries`
- `_buildEventEntries`: processes each VEVENT group, calls `CalendarEventHandler.fillParentIds` for recurring events, then queries local DB to find deletions (events no longer in the feed)

### Foundations Future chain semantics (CRITICAL)
All `future.then()` callbacks fire in order regardless of what intermediate callbacks do. Setting `future.result` in callback N causes callback N+1 to run — there is **no way to skip callbacks**. The `skipReason` closure pattern is the correct early-exit:

```javascript
var skipReason = null;
// intermediate callback:
future.then(function () {
    if (something_failed) { skipReason = "reason"; future.result = {returnValue: false}; return; }
    // ... normal work ...
});
// next callback:
future.then(function () {
    if (skipReason) { future.result = {returnValue: false}; return; } // propagate
    // ... normal work ...
});
// final cleanup callback (always runs):
future.then(function () {
    SyncKey.nextFolder(); // called EXACTLY ONCE here, never in intermediate callbacks
    SyncStatus.setDone();
    future.result = { more: SyncKey.hasMore(), entries: entries };
});
```

### iCal parsing
- `iCal.parseICal(text)` — original CalDAV parser; handles one VCALENDAR with one parent VEVENT + recurring exceptions. Do not use for WebCal files.
- `iCal.parseWebCalICal(text)` — added for WebCal; groups all VEVENTs by UID using a map + order array; calls `tryToFillParentIds` per group; returns `{returnValue, events: [{result, exceptions, hasExceptions}]}`

### OOM mitigations (TouchPad kills at ~25-30MB RSS)
Applied in `_getWebCalEventChanges` before calling `parseWebCalICal`:
- Attendee cap: 10 per event
- Description truncation: 500 chars
- VEVENT cap: 20 per calendar feed
- Fisher-Yates folder shuffle + checkpoint/resume logic (inherited from carddav, unchanged)

## Runtime constraints

- **ES5 only** — old Node.js on device. No arrow functions, no `let`/`const`, no template literals, no destructuring.
- **Globals via prologue** — `DB`, `Future`, `Log`, `httpClient`, `checkResult`, `Kinds`, `KindsCalendar`, `iCal`, `PalmCall`, `Class`, `Sync`, `Transport`, `Activity`, `xml`, `querystring`, `fs` are all globals set in `prologue.js`. Files without `module.exports` (like `accountConfigUtils.js`) are `require()`d for side effects to inject their `var` declarations as globals.
- **`WebCal`** is required locally in `syncassistant.js` (not a prologue global); Node module cache prevents double-loading.
- **Log file** — `/media/internal/.org.webosarchive.service.webcal.log`

## What still needs work

- **Device testing** — the Enyo companion app's dynamic component rendering (calendar list add/remove) has not been tested on actual webOS hardware
- **X-WR-CALNAME writeback** — the service reads `X-WR-CALNAME` from the iCal feed during sync but does not write it back to the account config. The user's manually-entered name is preserved as-is. Implementing writeback would require a `DB.merge` on the config object after a successful fetch when `calName` differs from the stored name.

## Build

```
node build.js           # build org.webosarchive.webcal_<version>_all.ipk
node build.js install   # build + palm-install
```
