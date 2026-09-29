// ============================================================
//  HubSpot_Push.gs
//  Author:  Jibril Sulaiman
//  Date:    2026-08-10 (published 2026-09-29)
//  Deploy:  Same Apps Script project > + > Script, named HubSpot_Push
//  What:    Pushes changed "MN Live" dates into the HubSpot contact property
//           mn_last_visited_network, matched on mn_member_id; links or creates
//           members HubSpot doesn't know yet; chains both steps daily.
//  Why:     HubSpot has no scheduler for pulls, and mn_member_id can't be made
//           unique after creation, so matching has to happen here.
// ============================================================

// ============================================================
//  MN Live tab → HubSpot contacts (mn_last_visited_network)
//  Runs after refreshRoster() via dailySync().
//
//  HubSpot has no cron — workflows are enrollment-triggered — so the
//  schedule lives here and HubSpot is just the sink.
//
//  mn_member_id CANNOT be made unique (HubSpot only allows that at property
//  creation), so we can't match by idProperty. Instead: search contacts by
//  mn_member_id to resolve HubSpot's internal record IDs, then batch-update
//  by those. Two calls per 100 contacts, and it surfaces unmatched members.
//
//  SETUP:
//   1. HubSpot > Settings > Integrations > Private Apps (or a service key) > Create.
//      Scopes: crm.objects.contacts.read + crm.objects.contacts.write
//   2. Project Settings > Script Properties > HS_TOKEN = <token>
//   3. Run testHubSpotOne(<a member id from MN Live>) to prove the wiring
//   4. Run pushLastVisitedToHubSpot()
// ============================================================

const HS_SEARCH_URL   = "https://api.hubapi.com/crm/v3/objects/contacts/search";
const HS_UPDATE_URL   = "https://api.hubapi.com/crm/v3/objects/contacts/batch/update";
const HS_CREATE_URL   = "https://api.hubapi.com/crm/v3/objects/contacts/batch/create";
const HS_ID_PROPERTY  = "mn_member_id";                // number (not unique — hence the search)
const HS_DATE_PROPERTY = "mn_last_visited_network";    // date
const HS_BATCH_SIZE   = 100;                           // HubSpot max per batch
const STATE_TAB       = "_hs_state";                   // hidden sync-state tab
const UNMATCHED_TAB   = "MN Unmatched";

function hsToken() {
  const t = PropertiesService.getScriptProperties().getProperty("HS_TOKEN");
  if (!t) throw new Error("No HS_TOKEN in Script Properties.");
  return t;
}

// ---------- sync state ----------
// Deliberately NOT in PropertiesService. The whole store is capped at 500KB, and
// an older sync's equivalent state had already grown to about half of it — half the
// budget for one key, which is the kind of pressure that makes unrelated writes
// start failing. Sheet rows have no such ceiling.
function loadSyncState() {
  const ss = getSpreadsheet();   // defined in MN_Member_Sync.gs
  const sh = ss.getSheetByName(STATE_TAB);
  if (!sh || sh.getLastRow() < 2) return {};
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  const map = {};
  vals.forEach(function (r) { if (r[0] !== "" && r[0] !== null) map[String(r[0])] = String(r[1]); });
  return map;
}

function saveSyncState(map) {
  const ss = getSpreadsheet();   // defined in MN_Member_Sync.gs
  const sh = ss.getSheetByName(STATE_TAB) || ss.insertSheet(STATE_TAB);
  sh.clearContents();
  sh.getRange(1, 1, 1, 2).setValues([["mn_member_id", "last_pushed"]]);
  const keys = Object.keys(map);
  if (keys.length) {
    // Force text on the date column so Sheets doesn't reinterpret "2026-08-04".
    sh.getRange(2, 2, keys.length, 1).setNumberFormat("@");
    sh.getRange(2, 1, keys.length, 2).setValues(keys.map(function (k) { return [Number(k), map[k]]; }));
  }
  if (!sh.isSheetHidden()) sh.hideSheet();
}

// ---------- HubSpot helpers ----------
function hsFetch(url, payload) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + hsToken() },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code === 429 || code >= 500) { Utilities.sleep(1000 * (attempt + 1)); continue; }
    return { code: code, text: res.getContentText() };
  }
  return { code: 429, text: "Retries exhausted (rate limited or 5xx)." };
}

// memberIds -> { memberId: hsObjectId }
function findHubSpotIds(memberIds) {
  const map = {};
  let dupes = 0;

  for (let i = 0; i < memberIds.length; i += HS_BATCH_SIZE) {
    const chunk = memberIds.slice(i, i + HS_BATCH_SIZE).map(Number);
    let after = null;

    do {
      const body = {
        filterGroups: [{ filters: [{ propertyName: HS_ID_PROPERTY, operator: "IN", values: chunk }] }],
        properties: [HS_ID_PROPERTY],
        limit: 100
      };
      if (after) body.after = after;

      const r = hsFetch(HS_SEARCH_URL, body);
      if (r.code !== 200) {
        Logger.log("Search failed HTTP " + r.code + ": " + r.text.slice(0, 400));
        if (r.code === 401 || r.code === 403) throw new Error("Token missing crm.objects.contacts.read scope.");
        break;
      }

      const parsed = JSON.parse(r.text);
      (parsed.results || []).forEach(function (rec) {
        const raw = rec.properties && rec.properties[HS_ID_PROPERTY];
        if (raw === null || raw === undefined || raw === "") return;
        const key = String(Number(raw));
        if (map[key]) { dupes++; return; }   // two contacts share one MN id
        map[key] = rec.id;
      });

      after = (parsed.paging && parsed.paging.next) ? parsed.paging.next.after : null;
      Utilities.sleep(250);   // search API allows ~5 req/sec
    } while (after);
  }

  if (dupes) Logger.log("WARNING: " + dupes + " duplicate contacts share an mn_member_id — first match wins. Worth deduping.");
  return map;
}

// ---------- main ----------
function pushLastVisitedToHubSpot() {
  const ss = getSpreadsheet();   // defined in MN_Member_Sync.gs
  const sheet = ss.getSheetByName(TARGET_TAB);
  if (!sheet) throw new Error("Tab not found: " + TARGET_TAB + " — run refreshRoster() first.");
  if (sheet.getLastRow() < 2) { Logger.log("No data rows."); return; }

  const rows  = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  const state = loadSyncState();

  // Only rows whose date changed since the last successful push.
  const pending = [];
  rows.forEach(function (r) {
    const id = r[0], dateVal = r[4];
    if (!id || !(dateVal instanceof Date)) return;
    const ymd = hsDateString(dateVal);
    if (state[String(id)] === ymd) return;
    pending.push({ id: String(id), ymd: ymd, first: r[1], last: r[2], email: r[3] });
  });

  if (!pending.length) { Logger.log("Nothing changed since last push."); return; }
  Logger.log(pending.length + " contacts with a changed last-visited date.");

  const idMap = findHubSpotIds(pending.map(function (p) { return p.id; }));

  const matched   = pending.filter(function (p) { return idMap[p.id]; });
  const unmatched = pending.filter(function (p) { return !idMap[p.id]; });

  let ok = 0, failed = 0;

  for (let i = 0; i < matched.length; i += HS_BATCH_SIZE) {
    const slice = matched.slice(i, i + HS_BATCH_SIZE);
    const body = { inputs: slice.map(function (p) {
      const properties = {};
      properties[HS_DATE_PROPERTY] = p.ymd;
      return { id: idMap[p.id], properties: properties };
    }) };

    const r = hsFetch(HS_UPDATE_URL, body);
    if (r.code === 200 || r.code === 207) {
      let parsed = {}; try { parsed = JSON.parse(r.text); } catch (e) {}
      const bad = {};
      (parsed.errors || []).forEach(function (e) {
        const ctx = (e.context && (e.context.id || e.context.ids)) || [];
        [].concat(ctx).forEach(function (b) { bad[String(b)] = true; });
      });
      slice.forEach(function (p) {
        if (bad[idMap[p.id]]) { failed++; return; }
        state[p.id] = p.ymd;      // record only what actually applied
        ok++;
      });
      if (parsed.errors && parsed.errors.length) Logger.log("Partial: " + r.text.slice(0, 400));
    } else {
      failed += slice.length;
      Logger.log("Update batch HTTP " + r.code + ": " + r.text.slice(0, 400));
      if (r.code === 401 || r.code === 403) break;
    }
    Utilities.sleep(200);
  }

  saveSyncState(state);
  writeUnmatched(unmatched);

  Logger.log("HubSpot push: " + ok + " updated, " + failed + " failed, "
    + unmatched.length + " MN members have no HubSpot contact"
    + (unmatched.length ? " (see '" + UNMATCHED_TAB + "')." : "."));
}

function writeUnmatched(unmatched) {
  const ss = getSpreadsheet();   // defined in MN_Member_Sync.gs
  const sh = ss.getSheetByName(UNMATCHED_TAB) || ss.insertSheet(UNMATCHED_TAB);
  sh.clearContents();
  sh.getRange(1, 1, 1, 5).setValues([["Member ID", "First Name", "Last Name", "Email", "Last Visited"]])
    .setFontWeight("bold");
  if (!unmatched.length) return;
  // Force the date column to plain text, or Sheets reinterprets "2026-08-10"
  // as a local-midnight Date and the value comes back shifted off UTC midnight.
  sh.getRange(2, 5, unmatched.length, 1).setNumberFormat("@");
  sh.getRange(2, 1, unmatched.length, 5).setValues(unmatched.map(function (p) {
    return [Number(p.id), p.first, p.last, p.email, p.ymd];
  }));
}

// HubSpot `date` properties take a bare UTC calendar date. Column E holds a
// local-midnight Date standing for the UTC date (see utcDateOnly), so read local
// components back — never toISOString(), which would shift it a day at UTC-04:00.
function hsDateString(d) {
  const m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
}

// Sheets silently coerces a written "2026-08-10" string into a Date, so reading
// it back yields local midnight — 04:00Z here, which HubSpot rejects with
// INVALID_DATE ("not midnight!"). Normalise whatever the cell hands us.
function hsYmd(v) {
  if (v instanceof Date) return hsDateString(v);
  return String(v || "").slice(0, 10);
}

// ---------- resolve the MN Unmatched tab ----------
// A member lands in MN Unmatched because no HubSpot contact carries their
// mn_member_id — NOT necessarily because they're absent from HubSpot. Many will
// already exist under their email with the ID field simply blank. Creating those
// outright would either collide (HubSpot enforces email uniqueness) or, for
// blank-email rows, silently duplicate a real person.
//
// So: match on email first and backfill mn_member_id on the existing record;
// only genuinely-absent members get created. Run DRY FIRST.
function linkOrCreateUnmatched(dryRun) {
  const sh = getSpreadsheet().getSheetByName(UNMATCHED_TAB);
  if (!sh || sh.getLastRow() < 2) { Logger.log("Nothing in " + UNMATCHED_TAB + "."); return; }
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues()
    .filter(function (r) { return r[0]; });

  // 1. look up every row that has an email
  const emails = rows.map(function (r) { return String(r[3] || "").trim().toLowerCase(); })
                     .filter(function (e) { return e; });
  const byEmail = {};

  for (let i = 0; i < emails.length; i += HS_BATCH_SIZE) {
    const chunk = emails.slice(i, i + HS_BATCH_SIZE);
    let after = null;
    do {
      const body = {
        filterGroups: [{ filters: [{ propertyName: "email", operator: "IN", values: chunk }] }],
        properties: ["email"], limit: 100
      };
      if (after) body.after = after;
      const r = hsFetch(HS_SEARCH_URL, body);
      if (r.code !== 200) { Logger.log("Email search HTTP " + r.code + ": " + r.text.slice(0, 300)); break; }
      const parsed = JSON.parse(r.text);
      (parsed.results || []).forEach(function (rec) {
        const e = String((rec.properties && rec.properties.email) || "").toLowerCase();
        if (e && !byEmail[e]) byEmail[e] = rec.id;
      });
      after = (parsed.paging && parsed.paging.next) ? parsed.paging.next.after : null;
      Utilities.sleep(250);
    } while (after);
  }

  // 2. partition
  const toLink = [], toCreate = [];
  rows.forEach(function (r) {
    const e = String(r[3] || "").trim().toLowerCase();
    if (e && byEmail[e]) toLink.push({ hsId: byEmail[e], row: r });
    else toCreate.push(r);
  });

  Logger.log("Unmatched: " + rows.length + " total — " + toLink.length
    + " already in HubSpot by email (will backfill " + HS_ID_PROPERTY + "), "
    + toCreate.length + " genuinely new.");
  const noEmail = toCreate.filter(function (r) { return !String(r[3] || "").trim(); }).length;
  if (noEmail) Logger.log("NOTE: " + noEmail + " of the new ones have no email — unverifiable as duplicates.");

  if (dryRun !== false) {
    Logger.log("DRY RUN — nothing written. Re-run as linkOrCreateUnmatched(false) to apply.");
    toCreate.forEach(function (r) { Logger.log("  would CREATE " + r[0] + " " + r[1] + " " + r[2] + " <" + (r[3] || "no email") + ">"); });
    return;
  }

  // 3. backfill the ID on existing contacts
  let linked = 0, created = 0, failed = 0;
  for (let i = 0; i < toLink.length; i += HS_BATCH_SIZE) {
    const slice = toLink.slice(i, i + HS_BATCH_SIZE);
    const body = { inputs: slice.map(function (x) {
      const p = {};
      p[HS_ID_PROPERTY]   = x.row[0];
      p[HS_DATE_PROPERTY] = hsYmd(x.row[4]);
      return { id: x.hsId, properties: p };
    }) };
    const res = hsFetch(HS_UPDATE_URL, body);
    if (res.code === 200 || res.code === 207) linked += slice.length;
    else { failed += slice.length; Logger.log("Link batch HTTP " + res.code + ": " + res.text.slice(0, 400)); }
    Utilities.sleep(200);
  }

  // 4. create the rest
  for (let i = 0; i < toCreate.length; i += HS_BATCH_SIZE) {
    const slice = toCreate.slice(i, i + HS_BATCH_SIZE);
    const body = { inputs: slice.map(function (r) {
      const p = {};
      p[HS_ID_PROPERTY]   = r[0];
      p[HS_DATE_PROPERTY] = hsYmd(r[4]);
      p.firstname = r[1] || "";
      p.lastname  = r[2] || "";
      if (r[3]) p.email = r[3];
      return { properties: p };
    }) };
    const res = hsFetch(HS_CREATE_URL, body);
    if (res.code === 201 || res.code === 200 || res.code === 207) created += slice.length;
    else { failed += slice.length; Logger.log("Create batch HTTP " + res.code + ": " + res.text.slice(0, 400)); }
    Utilities.sleep(200);
  }

  Logger.log("Linked " + linked + ", created " + created + ", failed " + failed
    + ". Re-run pushLastVisitedToHubSpot() to confirm 0 unmatched.");
}

// Preview only — safe to click.
function previewUnmatched() { linkOrCreateUnmatched(true); }

// Applies changes. Review previewUnmatched() output first.
function applyUnmatched() { linkOrCreateUnmatched(false); }

// ---------- diagnostics ----------
function testHubSpotOne(memberId) {
  const map = findHubSpotIds([memberId]);
  if (!map[String(memberId)]) { Logger.log("No HubSpot contact with " + HS_ID_PROPERTY + " = " + memberId); return; }
  Logger.log("Resolved " + memberId + " -> HubSpot record " + map[String(memberId)]);
  const properties = {}; properties[HS_DATE_PROPERTY] = "2026-08-04";
  const r = hsFetch(HS_UPDATE_URL, { inputs: [{ id: map[String(memberId)], properties: properties }] });
  Logger.log("HTTP " + r.code + "\n" + r.text.slice(0, 600));
}

// ---------- chain both steps on one daily trigger ----------
function dailySync() {
  refreshRoster();
  pushLastVisitedToHubSpot();
}

// ---------- optional: retire an older hourly sync ----------
// Only relevant if this project also holds an older hourly push whose handler is
// syncBatch() and whose dedupe state lives in the "cursor" and "hashes" Script
// Properties. If you started fresh, ignore decommissionGhlPush().
// Shows what's scheduled. Run before and after decommissioning.
function listTriggers() {
  const ts = ScriptApp.getProjectTriggers();
  if (!ts.length) { Logger.log("No triggers installed."); return; }
  ts.forEach(function (t) { Logger.log(t.getHandlerFunction() + "  [" + t.getEventType() + "]"); });
  Logger.log(ts.length + " trigger(s) total.");
}

// Stops the older hourly push and frees the properties store.
// Deliberately reversible: syncBatch() and its source tab are left intact, so
// re-running the old setupTrigger() restores the pipeline. Only
// the schedule and the dedupe state are removed.
function decommissionGhlPush() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "syncBatch") { ScriptApp.deleteTrigger(t); removed++; }
  });

  // cursor/hashes were the older sync's dedupe state only. Clearing them also reclaims the
  // properties store, which is what was likely blocking new writes earlier.
  const p = PropertiesService.getScriptProperties();
  const hadHashes = (p.getProperty("hashes") || "").length;
  p.deleteProperty("cursor");
  p.deleteProperty("hashes");

  Logger.log("Removed " + removed + " syncBatch trigger(s).");
  Logger.log("Cleared cursor and hashes (" + hadHashes + " chars reclaimed).");
  Logger.log("syncBatch() and Sheet1 left intact — re-run setupTrigger() to restore.");
  listTriggers();
}

function installDailySyncTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return ["refreshRoster", "dailySync"].indexOf(t.getHandlerFunction()) !== -1; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("dailySync").timeBased().everyDays(1).atHour(4).create();
  Logger.log("Daily 4am dailySync installed (roster pull + HubSpot push).");
}
