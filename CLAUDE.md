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
- `app-enyo/source/webcal.css` — custom styles: `.box-center`, `.footnote-text`, `.text-truncate`, `.webcal-header`, `.header-icon`
- `app-enyo/depends.js` — loads `webcal.css` then `CDavApp.js`
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

### Companion app UI design (Enyo 1.x patterns)

The companion app follows the same conventions as `com.palm.app.accounts` and sibling projects (`webos-imessage-synergy`, `webos-proxyset`):

- **Layout**: `VFlexBox` root → light Toolbar → `Scroller` (flex:1) → inner `Control` with `className: "box-center"`. The `.box-center` class (`width: 500px; margin: 23px auto 0`) must be on the inner Control, NOT on the Scroller — padding/margin on the Scroller's outer div does not push scrollable content.
- **Toolbar**: `enyo-toolbar-light` + custom `webcal-header` class for drop shadow via `-webkit-box-shadow`. Spinner on right for sync activity.
- **Footer**: `{ className: "accounts-footer-shadow", tabIndex: -1 }` — decorative only, zero layout impact.
- **Errors**: `Dialog` with `HtmlContent` + OK button (`showError` / `closeAlert`). Never inline colored banners.
- **Success notifications**: `enyo.windows.addBannerMessage(msg, iconPath)` — webOS notification bar.
- **Swipe-to-delete**: `SwipeableItem` with `calIndex` property for identifying which row; `onConfirm: "doRemoveCalendar"`. Track rows in `this.calendarRows = []` and explicitly `.destroy()` each before re-rendering (see dynamic component ownership section).
- **No-account empty state**: hide `accountGroup`, show `noAccountSection` (footnote text + Set Up Account button), disable Add Calendar and Sync Now buttons, update noCalendarsMsg text.
- **Set Up Account button**: `launchAccounts()` — calls `com.palm.applicationManager/open` for `com.palm.app.accounts`, then `window.close()` to close the companion app (user re-opens it after account creation).
- **AppMenu**: `{ kind: "AppMenu", components: [{ kind: "EditMenu" }] }` — gives Cut/Copy/Paste/Select All in the device menu.
- **URL display**: `.text-truncate` CSS class (`white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block`) on secondary text in calendar rows and status line.

**Picker caption deferred-init pattern (CRITICAL)**
`lookupMissingNames()` returns a boolean. In `loadedConfig()`, `rebuildPickerItems()` is only called immediately if `lookupMissingNames()` returns false (all names already in DB). If names need async lookup, `rebuildPickerItems()` is deferred to `accountInfoLoaded()` — this ensures the picker is built exactly once with the correct name. Calling `rebuildPickerItems()` once with a placeholder and once with the real name does not work: Enyo's Picker does not refresh its button caption when `setValue()` is called with a value that is already selected, even after `setItems()` is updated.

### Enyo 1.x dynamic component ownership (CRITICAL)
In Palm Enyo 1.x, `onclick: "handlerName"` on a component resolves the handler against the component's **owner** at dispatch time — it does NOT bubble up the containment tree. The owner chain is: child → child.owner → child.owner.owner → ...

When `container.createComponent(props, {owner: X})` is used:
- The component's owner is X
- Event handlers are looked up on X and X's owner chain
- The component IS in `container.components`, so `container.destroyComponents()` would destroy it

**The problem:** `destroyComponents()` in Enyo 1.x does NOT reliably destroy components when the owner is a different object from the container (the component may be registered in the owner's `$` hash but the DOM cleanup is inconsistent). Old calendar rows persisted in the DOM after Remove.

**The fix used in CDavApp.js:** Track dynamically created rows in `this.calendarRows = []`. In `renderCalendarList`, explicitly call `this.calendarRows[i].destroy()` on each old row, then reset `this.calendarRows = []` before creating new ones. Keep `{owner: this}` so onclick handlers still reach CDavApp.

## Runtime constraints

- **ES5 only** — old Node.js on device. Forbidden: arrow functions (`=>`), `let`/`const`, template literals (`` ` ``), destructuring, shorthand properties (`{foo}` in object literals), `class`, `import`/`export`, spread (`...`). Run `node --check <file>` before every build — a SyntaxError crashes the service silently with no log output.
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

## Verified working (2026-05-09)

- Account creation and initial sync
- Adding a calendar URL in the companion app → events appear in Calendar app
- Removing a calendar URL → next Sync Now deletes the calendar from DB8 and purges all orphaned `calendarevent:1` records (no DB8 leak)
- Companion app UI: add/remove list refreshes correctly; old rows are properly destroyed; calendar names read directly from `org.webosarchive.webcal.calendar:1` so X-WR-CALNAME shows immediately after sync
- Multiple calendars (5 active): each gets its own calendar entry and events; folder shuffle processes them in random order each invocation
- Large O365 feeds (150+ events) batch-process correctly across multiple sync invocations
- Large Zoho feeds (1.4MB / 3,124 VEVENTs, 349 kept after date filter) batch into 7 invocations without OOM
- Recurring events and their exceptions appear correctly; no false deletions on subsequent syncs
- ctag stability: DTSTAMP is stripped before hashing via a streaming line-by-line loop (no second full-string allocation), so unchanged feeds are correctly skipped and the service survives large feeds
- X-WR-CALNAME: feed's embedded calendar name is written to `org.webosarchive.webcal.calendar:1` and (if name === url) to the account config; companion app displays it correctly
- Companion app UI redesign: proper `.box-center` layout, light toolbar with drop shadow, SwipeableItem swipe-to-delete, Dialog for errors, banner messages for success, no-account empty state, disabled buttons when no account, URL truncation with ellipsis, AppMenu with EditMenu
- Picker shows real account name immediately on first launch (deferred `rebuildPickerItems` pattern)
- Set Up Account button launches Accounts app and closes companion app via `window.close()`

### Key bugs fixed during batch/event sync work (2026-05-08)

- **Folded UIDs truncated in UID index**: O365 UIDs are ~114 chars; ICS folds lines at 75. Phase 1 was extracting the truncated first line as the UID. Fix: unfold VEVENT text (`replace(/\r\n /g, "")`) before extracting UID, matching `preProcessIcal`.
- **Exception false-deletions from timezone normalization**: `normalizeToLocalTimezone` converts `recurrenceId` timestamps from event-local to device-local timezone, changing the string value. Phase 1 stored raw recurrenceId in the UID index; DB8 had the normalized value → mismatch → all exceptions deleted each sync. Fix: UID index now stores only master UIDs (one per unique UID, not one per VEVENT). Deletion check protects exceptions by checking their master UID (`remoteId.slice(0, hashPos)`) instead of the full `UID#timestamp` key.
- **Exception remoteIds missing from `newRemoteIds`**: On the inline path (≤50 events after date filter), exceptions were not added to `newRemoteIds`, causing false deletions. Fix: add `newRemoteIds[excRemoteId] = true` when processing exceptions in `_buildEventEntries`.
- **`_initCollectionId` silently returning empty for new calendars**: DB8 `where: [{remoteId}, {accountId}]` silently returns empty results because the index is `accountId_remoteId` (accountId first) and clause ordering must match the index prefix. Calendars added after the bug was introduced never got `collectionId` set → all event syncs skipped with `skipReason="noCollection"`. Fix: query by `accountId` only (single-prop index), then filter by `remoteId`/`uri` in JavaScript.
- **OOM kill (SIGABRT) on large feeds**: `stableData = data.replace(...)` materialized a second ~1.4MB copy of the raw ICS string, pushing RSS above the TouchPad ~25–30MB threshold. Fix: replaced with a streaming line-by-line hash that skips DTSTAMP lines without allocating a second string; also null out `filteredParts`, `data`, `allEvents`, `uidGroups`, `batchContent` after use.
- **Picker shows "Account 1" on first launch**: `rebuildPickerItems()` was called twice — once from `loadedConfig()` with no name yet, then again from `accountInfoLoaded()` with the real name. Enyo's Picker does not refresh its button caption when `setValue()` is called with a value that is already selected. Fix: `lookupMissingNames()` now returns a boolean; `loadedConfig()` skips `rebuildPickerItems()` when a lookup is pending and lets `accountInfoLoaded()` call it once with the correct name already set.

## What still needs work / next test areas

- **Background sync** — let the 30-minute periodic activity fire without pressing Sync Now; confirm events update
- **Delta detection** — verify that a calendar whose .ics hash hasn't changed is skipped (no re-parse, no re-write)
- **Deleting individual calendars** — when multiple calendars are subscribed, remove one and confirm only that calendar and its events are deleted (tested conceptually, not end-to-end with large feeds)
- **META calendar display name** — still shows "WebCal Sync" as its calendar name in the Calendar app; cosmetic issue only
- **Account display name** — resolved in companion app: `CDavApp` calls `com.palm.service.accounts/getAccountInfo` on first open, saves `username` back to the config record; picker shows the correct name immediately on all subsequent launches

## Build

```
node build.js           # build org.webosarchive.webcal_<version>_all.ipk
node build.js install   # build + palm-install
```
