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
| Service | `org.webosarchive.webcal.service` |
| Companion app | `org.webosarchive.webcal.app` |
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
- When a calendar is deleted, records its `_id` in `deletedCalendarIds` and calls `_cleanupOrphanedEvents` to purge `org.webosarchive.webcal.calendarevent:1` records before returning

**Calendarevent kind** (`_getWebCalEventChanges`):
- Uses `skipReason` closure variable to propagate early-exit through the future chain without double-executing cleanup
- Per folder: `_initCollectionId` → `WebCal.fetch` → hash check vs stored ctag → `iCal.parseWebCalICal` → `_buildEventEntries`
- `_buildEventEntries`: processes each VEVENT group, calls `CalendarEventHandler.fillParentIds` for recurring events, then queries local DB to find deletions (events no longer in the feed)

**`_cleanupOrphanedEvents(calendarIds, idx)`**:
- Recursive future-chain method; iterates `calendarIds` one at a time
- For each ID: `DB.find({where: [{prop: "calendarId", op: "=", val: id}]})` → `DB.del(ids)`
- Called from `_getWebCalCollectionChanges` when deletedCalendarIds is non-empty; errors are caught and treated as non-fatal

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
Applied in `_getWebCalEventChanges`:
- Attendee cap: 10 per event (strip excess ATTENDEE lines before parsing)
- Description truncation: 500 chars
- BATCH_SIZE: 50 events per sync invocation; larger feeds are split into batch files on `/media/internal/` (dot-prefixed, auto-cleaned)
- **Streaming hash**: `stableData = data.replace(...)` was replaced with a line-by-line `crypto.createHash` loop that never materializes the full stripped string. Saves ~1.4MB RSS on large feeds like Zoho (1.4MB / 3,124 VEVENTs).
- **Explicit null-out**: After the date filter rebuilds `data` (`filteredParts = null`) and after batch files are written (`data = null; allEvents = null; uidGroups = null; batchContent = null`) to give GC early collection hints before the async `_saveTransportObject` call.
- Fisher-Yates folder shuffle + checkpoint/resume logic (inherited from carddav, unchanged)

**OOM diagnosis**: the OOM killer on webOS sends SIGABRT (signal 6), not SIGKILL. `minicore_launch: CRASH! bcal.service.js(<pid>) received 6` in `dmesg` is the fingerprint. The service dies silently mid-download with the log frozen at the last `WebCal.fetch:` line and no batch files on `/media/internal/`.

### META calendar
A hidden pseudo-calendar with `remoteId: "webcal-meta"` is always created for each account. Its purpose: if an account has only one calendar, CalendarsManager uses the account's `alias` field as the display name instead of `cal.name`. The META calendar forces every account into "multi-calendar" mode so each subscribed calendar shows its own name. The META calendar is excluded from "All" and hidden (`visible: false`). It is NOT removed when all URL subscriptions are deleted — only when the entire account is deleted.

### DB8 query ordering (CRITICAL)
DB8 requires the `where` clause properties to be ordered to match an index prefix. Given index `accountId_remoteId` (accountId first):
- `where: [{prop: "accountId"}, {prop: "remoteId"}]` → uses the index ✓
- `where: [{prop: "remoteId"}, {prop: "accountId"}]` → silently returns empty results ✗

Do NOT multi-filter with `remoteId` first. `_initCollectionId` was rewritten to query by `accountId` only (the single-prop index), then match `remoteId`/`uri` in JavaScript, which avoids this ordering dependency entirely.

### DB8 merge behavior
- `DB.merge([{_id, _rev, ...}])` — conditional merge; fails with a version conflict if `_rev` is stale. **Do not include `_rev`** when merging the account config from the companion app — the Sync service may update the config's `_rev` between the time the app loaded it and the time it tries to save, causing silent failures.
- `DB.merge([{_id, ...}])` — unconditional (last-write-wins). Correct for the `calendars` array.

### Enyo 1.x dynamic component ownership (CRITICAL)
In Palm Enyo 1.x, `onclick: "handlerName"` on a component resolves the handler against the component's **owner** at dispatch time — it does NOT bubble up the containment tree. The owner chain is: child → child.owner → child.owner.owner → ...

When `container.createComponent(props, {owner: X})` is used:
- The component's owner is X
- Event handlers are looked up on X and X's owner chain
- The component IS in `container.components`, so `container.destroyComponents()` would destroy it

**The problem:** `destroyComponents()` in Enyo 1.x does NOT reliably destroy components when the owner is a different object from the container (the component may be registered in the owner's `$` hash but the DOM cleanup is inconsistent). Old calendar rows persisted in the DOM after Remove.

**The fix used in CDavApp.js:** Track dynamically created rows in `this.calendarRows = []`. In `renderCalendarList`, explicitly call `this.calendarRows[i].destroy()` on each old row, then reset `this.calendarRows = []` before creating new ones. Keep `{owner: this}` so onclick handlers still reach CDavApp.

## Runtime constraints

- **ES5 only** — old Node.js on device. No arrow functions, no `let`/`const`, no template literals, no destructuring.
- **Globals via prologue** — `DB`, `Future`, `Log`, `httpClient`, `checkResult`, `Kinds`, `KindsCalendar`, `iCal`, `PalmCall`, `Class`, `Sync`, `Transport`, `Activity`, `xml`, `querystring`, `fs` are all globals set in `prologue.js`. Files without `module.exports` (like `accountConfigUtils.js`) are `require()`d for side effects to inject their `var` declarations as globals.
- **`WebCal`** is required locally in `syncassistant.js` (not a prologue global); Node module cache prevents double-loading.
- **Log file** — `/media/internal/.org.webosarchive.webcal.service.log`
- **System log** — `/var/log/messages`; use `grep webcal` to filter service output. App JS errors appear as `LunaSysMgrJS: org.webosarchive.webcal.app:`.

## Debugging on device

```bash
# Pull service log
novacom run file:///bin/cat -- /media/internal/.org.webosarchive.webcal.service.log

# Query DB8 as the service identity
novacom run file:///usr/bin/luna-send -- -n 1 -a org.webosarchive.webcal.service \
  'palm://com.palm.db/find' '{"query":{"from":"org.webosarchive.webcal.account.config:1"}}'

# Trigger sync manually
novacom run file:///usr/bin/luna-send -- -n 1 \
  'palm://org.webosarchive.webcal.service/sync' '{"accountId":"<accountId>"}'
```

Note: the Sync framework may rate-limit manual sync calls immediately after a sync completes. If Sync Now in the companion app produces no log activity, wait 30–60 seconds and try again.

## Verified working (2026-05-08)

- Account creation and initial sync
- Adding a calendar URL in the companion app → events appear in Calendar app
- Removing a calendar URL → next Sync Now deletes the calendar from DB8 and purges all orphaned `calendarevent:1` records (no DB8 leak)
- Companion app UI: add/remove list refreshes correctly; old rows are properly destroyed
- Large O365 feeds (150+ events) batch-process correctly across multiple sync invocations
- Recurring events and their exceptions appear correctly; no false deletions on subsequent syncs
- ctag stability: O365 feeds with volatile DTSTAMP fields now use a stable hash (DTSTAMP stripped before hashing), so unchanged feeds are correctly skipped

### Key bugs fixed during batch/event sync work (2026-05-08)

- **Folded UIDs truncated in UID index**: O365 UIDs are ~114 chars; ICS folds lines at 75. Phase 1 was extracting the truncated first line as the UID. Fix: unfold VEVENT text (`replace(/\r\n /g, "")`) before extracting UID, matching `preProcessIcal`.
- **Exception false-deletions from timezone normalization**: `normalizeToLocalTimezone` converts `recurrenceId` timestamps from event-local to device-local timezone, changing the string value. Phase 1 stored raw recurrenceId in the UID index; DB8 had the normalized value → mismatch → all exceptions deleted each sync. Fix: UID index now stores only master UIDs (one per unique UID, not one per VEVENT). Deletion check protects exceptions by checking their master UID (`remoteId.slice(0, hashPos)`) instead of the full `UID#timestamp` key.
- **Exception remoteIds missing from `newRemoteIds`**: On the inline path (≤50 events after date filter), exceptions were not added to `newRemoteIds`, causing false deletions. Fix: add `newRemoteIds[excRemoteId] = true` when processing exceptions in `_buildEventEntries`.

## What still needs work / next test areas

- **Multiple calendars** — add 2+ URLs and verify each gets its own calendar entry and events
- **Background sync** — let the 30-minute periodic activity fire without pressing Sync Now; confirm events update
- **Delta detection** — verify that a calendar whose .ics hash hasn't changed is skipped (no re-parse, no re-write)
- **Deleting individual calendars** — when multiple calendars are subscribed, remove one and confirm only that calendar and its events are deleted
- **UI cleanup** — companion app polish (layout, labels, error messaging)
- **Account display name** — The `org.webosarchive.webcal.account.config:1` record never gets a `name` field written by the service (the framework only stores `accountId`). Fixed in the companion app: on first open, `CDavApp` calls `com.palm.service.accounts/getAccountInfo` (public endpoint; app is in `readPermissions` via template override) to get `username`, saves it back to the config record, and rebuilds the picker. After the first sync with a new install the picker shows the user-entered account name. **META calendar** still shows "WebCal Sync" as its calendar name in the Calendar app — this is a separate cosmetic issue.
- **X-WR-CALNAME writeback** — service reads `X-WR-CALNAME` from the feed but does not write it back to the config when it differs from the stored name.

## Build

```
node build.js           # build org.webosarchive.webcal_<version>_all.ipk
node build.js install   # build + palm-install
```
