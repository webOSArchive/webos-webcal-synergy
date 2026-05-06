---
name: WebCal transformation status
description: WebCal rewrite complete through da7cf4b — service/app/config fully renamed to webcal namespace
type: project
---

Core rewrite: 282a056. Namespace rename: da7cf4b. Branch: webCal-only.

**Why:** Transform the carddav fork into a simpler read-only public iCal subscription service with no auth, no CalDAV, no contacts, no upsync.

**What was done (complete):**
- Deleted all CalDAV, CardDAV, contacts, auth, upsync, Mojo app, test-scripts, Google/iCloud/Yahoo account configs
- service/javascript/utils/WebCal.js — new: HTTP GET + MD5 hash + X-WR-CALNAME extraction
- service/javascript/utils/iCal.js — added parseWebCalICal() for full-calendar .ics files (multiple independent VEVENTs grouped by UID)
- service/javascript/assistants/syncassistant.js — fully rewritten: _getWebCalCollectionChanges, _getWebCalEventChanges (with skipReason closure for future chain early-exit), _buildEventEntries (sequential fillParentIds + deletion detection)
- service/javascript/prologue.js — cleaned up, log path → .org.webosports.service.webcal.log
- service/javascript/kinds.js — stripped to calendar+calendarevent only; all IDs use org.webosports.webcal.*
- service/services.json — id/name → org.webosports.service.webcal; removed contacts/discovery/addItem endpoints
- accounts-enyo/account-template.json — templateId org.webosports.webcal.account; single CALENDAR capability; all palm:// URLs use webcal service
- service/javascript/assistants/serviceassistant.js, checkcredentialsassistant.js, ondeleteassistant.js — simplified
- app-enyo/CrossAppTarget/CrossAppTarget.js — name-only account creation (no username/password); uses webcal service
- app-enyo/source/CDavApp.js — URL list manager using org.webosports.webcal.account.config:1
- app-enyo/appinfo.json — id org.webosports.app.webcal; title "WebCal Sync"; permission webcal-service.operation
- package/packageinfo.json — id org.webosports.webcal; accounts list reduced to single webcal.account
- files/sysbus/ — all 5 files renamed org.webosports.service.cdav.* → org.webosports.service.webcal.*; api.json pruned to actual endpoints
- build.js — simplified to single palm-package call (enyo + service + accounts-enyo)

**What still needs work:**
- Enyo companion app: URL list manager not tested on device; dynamic component rendering untested
- No mechanism to populate X-WR-CALNAME from the service back to the companion app at first add (app stores name provided by user at add time)
- No integration testing on actual device

**Key architecture decisions:**
- URL list stored in account config object (org.webosports.webcal.account.config:1) as "calendars" array: [{url, name}]
- Each URL = one SyncKey folder for calendarevent kind (existing checkpoint/shuffle logic reused)
- MD5 of raw response body = ctag; skip if unchanged
- parseWebCalICal groups VEVENTs by UID for recurring event + exceptions handling
- skipReason closure variable avoids double-executing cleanup in future chains

**How to apply:** When user asks about remaining work, refer to the "What still needs work" list above.
