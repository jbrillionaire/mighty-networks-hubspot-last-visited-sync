// ============================================================
//  MN_Member_Sync.gs
//  Author:  Jibril Sulaiman
//  Date:    2026-08-10 (published 2026-09-29)
//  Deploy:  Google Apps Script project > Editor > + > Script, named MN_Member_Sync
//  What:    Pulls every Mighty Networks member and their lastActiveAt from the
//           Headless API (GraphQL) into the "MN Live" tab, once a day.
//  Why:     lastActiveAt is only exposed to Host tokens on the Headless API, so a
//           scheduled OAuth pull is the only way to get it out of Mighty.
// ============================================================

// ============================================================
//  Mighty Networks → Sheet  (member roster + last active, daily)
//  Writes tab "MN Live":
//    A=Member ID, B=First, C=Last, D=Email, E=Last Visited Network
//  HubSpot_Push.gs then pushes column E to HubSpot.
//
//  Requires Headless API (GraphQL) access — it is the ONLY surface
//  that exposes lastActiveAt. Auth is OAuth2; we store a refresh
//  token once and mint short-lived access tokens each run.
//
//  SETUP ORDER:
//    1. setScriptProps()   — paste client id/secret, run once, then delete the values
//    2. logAuthorizeUrl()  — open the URL, sign in AS A HOST, approve
//    3. exchangeCode("...") — paste the ?code= value from the redirect
//    4. refreshRoster()    — verify it fills the tab
//    5. installDailySyncTrigger() in HubSpot_Push.gs (pull + push). installDailyTrigger()
//       below schedules the pull alone.
// ============================================================

// Endpoint copied verbatim from Admin > Integrations > Headless API.
const NETWORK       = "REPLACE_WITH_NETWORK_ID";        // numeric network id (subdomain also accepted)
const GRAPHQL_URL   = "https://api.mn.co/networks/" + NETWORK + "/graphql";

// If your network has a custom domain, your session lives there, so try that first
// for the authorize step. If /oauth/authorize 404s there, use your
// "https://<subdomain>.mn.co" address instead.
const OAUTH_HOST    = "https://your-community.mn.co";

// MUST match the Redirect URI on the OAuth app character-for-character.
// Any page you control works — you'll read the ?code= out of the address bar.
const REDIRECT_URI  = "https://your-community.mn.co/";
const TARGET_TAB    = "MN Live";

// The id is the long string between /d/ and /edit in the sheet's URL.
// Pinned by ID rather than getActiveSpreadsheet(), which returns null when the
// script project is standalone rather than bound to the sheet. openById() works
// in both cases, so the daily trigger can't fail on a detached project.
const SPREADSHEET_ID = "REPLACE_WITH_SPREADSHEET_ID";
function getSpreadsheet() { return SpreadsheetApp.openById(SPREADSHEET_ID); }
const PAGE_SIZE     = 50;    // schema max
const MAX_PAGES     = 400;   // safety stop (400 * 50 = 20k members)

// Mighty seeds every network with staff/test accounts (Apple Tester, Google
// Tester, Login Tester, a Mighty employee). They are real members to the API and
// would sync into your CRM as contacts. Set to null to keep them.
const EXCLUDE_EMAIL_RE = /@(mightynetworks\.com|tfbnw\.net)$/i;
const DATE_FORMAT   = "MMM dd yyyy";  // display only; the push reads the Date value, not the text

// ---------- 1. one-time: store credentials ----------
// PREFERRED: skip this function entirely and add the three properties via
//   Project Settings (gear) > Script Properties > Add script property
// so the client secret never appears in source. Keys:
//   MN_CLIENT_ID, MN_CLIENT_SECRET, MN_SCOPES
// Use the function below only if you'd rather not click through the UI —
// and blank the literals immediately after running it.
function setScriptProps() {
  PropertiesService.getScriptProperties().setProperties({
    MN_CLIENT_ID:     "PASTE_CLIENT_ID",
    MN_CLIENT_SECRET: "PASTE_CLIENT_SECRET",
    // Must match the scopes checked on the OAuth app, space-separated.
    // host:read:network_members is the one that unlocks Network.members + lastActiveAt.
    MN_SCOPES:        "host:read:network_members read:userinfo"
  });
  Logger.log("Stored. Now clear the literals above so secrets aren't left in source.");
}

// ---------- 2. one-time: get the authorize URL ----------
function logAuthorizeUrl() {
  const p = PropertiesService.getScriptProperties();
  // Mighty REQUIRES `state` and rejects the request without it ("Missing required
  // parameter: state"), even though OAuth 2.0 only recommends it. It's a CSRF
  // nonce echoed back on the redirect; we store it so exchangeCode can verify.
  const state = Utilities.getUuid().replace(/-/g, "").slice(0, 16);
  p.setProperty("MN_OAUTH_STATE", state);

  const url = OAUTH_HOST + "/oauth/authorize"
    + "?client_id=" + encodeURIComponent(p.getProperty("MN_CLIENT_ID"))
    + "&redirect_uri=" + encodeURIComponent(REDIRECT_URI)
    + "&response_type=code"
    + "&scope=" + encodeURIComponent(p.getProperty("MN_SCOPES") || "read")
    + "&state=" + encodeURIComponent(state);
  Logger.log("Open this while signed in as a HOST, approve, then copy the ?code= param:\n" + url);
}

// Post to /oauth/token presenting client credentials either in the body
// (Doorkeeper's default) or as HTTP Basic. Mighty returned "invalid_client:
// ...no client authentication included, or unsupported authentication method",
// which is the standard error when the server wants the other form — so we try
// body first, then Basic, rather than guessing.
function postToken(fields, useBasic) {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty("MN_CLIENT_ID");
  const secret = p.getProperty("MN_CLIENT_SECRET");
  if (!id || !secret) throw new Error("MN_CLIENT_ID / MN_CLIENT_SECRET missing from Script Properties.");

  const payload = {};
  Object.keys(fields).forEach(function (k) { payload[k] = fields[k]; });

  const opts = { method: "post", payload: payload, muteHttpExceptions: true };
  if (useBasic) {
    opts.headers = { Authorization: "Basic " + Utilities.base64Encode(id + ":" + secret) };
  } else {
    payload.client_id = id;
    payload.client_secret = secret;
  }
  return UrlFetchApp.fetch(OAUTH_HOST + "/oauth/token", opts);
}

// ---------- 3. one-time: swap the code for a refresh token ----------
function exchangeCode(code) {
  const p = PropertiesService.getScriptProperties();
  const fields = { grant_type: "authorization_code", code: code, redirect_uri: REDIRECT_URI };

  let res = postToken(fields, false);
  if (res.getResponseCode() === 401) {
    Logger.log("Body-param auth rejected; retrying with HTTP Basic…");
    res = postToken(fields, true);
    if (res.getResponseCode() < 300) p.setProperty("MN_AUTH_BASIC", "1");  // remember for refreshes
  }

  const body = res.getContentText();
  if (res.getResponseCode() >= 300) {
    throw new Error("Token exchange failed: HTTP " + res.getResponseCode() + " " + body
      + "\nIf this says invalid_client, run checkCreds() — a truncated secret is the usual cause."
      + "\nIf it says invalid_grant, the code was reused or expired; get a fresh one.");
  }
  const tok = JSON.parse(body);
  if (!tok.refresh_token) throw new Error("No refresh_token returned — unattended sync impossible. Body: " + body);
  p.setProperty("MN_REFRESH_TOKEN", tok.refresh_token);
  Logger.log("Refresh token stored. Run testAuth() next.");
}

// Prints lengths only — never the values. Both should be 43.
function checkCreds() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty("MN_CLIENT_ID") || "";
  const sec = p.getProperty("MN_CLIENT_SECRET") || "";
  Logger.log("MN_CLIENT_ID length: " + id.length + " (expect 43)");
  Logger.log("MN_CLIENT_SECRET length: " + sec.length + " (expect 43)");
  Logger.log("id starts/ends: " + id.slice(0, 4) + "…" + id.slice(-4));
  Logger.log("secret starts/ends: " + sec.slice(0, 4) + "…" + sec.slice(-4));
  Logger.log("OAUTH_HOST: " + OAUTH_HOST);
  Logger.log("REDIRECT_URI: " + REDIRECT_URI);
}

// ---------- access token (cached ~55 min, refresh-token rotation handled) ----------
function getAccessToken() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get("mn_access_token");
  if (hit) return hit;

  const p = PropertiesService.getScriptProperties();
  const refresh = p.getProperty("MN_REFRESH_TOKEN");
  if (!refresh) throw new Error("No MN_REFRESH_TOKEN — complete steps 1-3 first.");

  // Use whichever client-auth style exchangeCode found to work.
  let res = postToken({ grant_type: "refresh_token", refresh_token: refresh },
                      p.getProperty("MN_AUTH_BASIC") === "1");
  if (res.getResponseCode() === 401) res = postToken(
    { grant_type: "refresh_token", refresh_token: refresh },
    p.getProperty("MN_AUTH_BASIC") !== "1");
  if (res.getResponseCode() >= 300) {
    throw new Error("Refresh failed: HTTP " + res.getResponseCode() + " " + res.getContentText()
      + "\nIf the refresh token was revoked or rotated out, redo logAuthorizeUrl() + exchangeCode().");
  }
  const tok = JSON.parse(res.getContentText());
  // Rotate if the server issued a new refresh token — otherwise tomorrow's run breaks.
  if (tok.refresh_token && tok.refresh_token !== refresh) p.setProperty("MN_REFRESH_TOKEN", tok.refresh_token);

  const ttl = Math.max(60, Math.min(3500, (tok.expires_in || 3600) - 120));
  cache.put("mn_access_token", tok.access_token, ttl);
  return tok.access_token;
}

// ---------- GraphQL ----------
// NOTE: sort is DATE_JOINED, not LAST_VISIT. joinedAt is immutable, so cursor
// pagination stays stable. Sorting by LAST_VISIT while paging a full roster
// lets a member who visits mid-run shift pages — causing skips and duplicates.
const MEMBERS_QUERY = [
  'query Roster($first: Int!, $after: String) {',
  '  network {',
  '    members(first: $first, after: $after, sort: DATE_JOINED, sortOrder: ASC) {',
  '      nodes { resourceId firstName lastName email lastActiveAt }',
  '      pageInfo { endCursor hasNextPage }',
  '    }',
  '  }',
  '}'
].join("\n");

function gql(query, variables) {
  const res = UrlFetchApp.fetch(GRAPHQL_URL, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + getAccessToken() },
    payload: JSON.stringify({ query: query, variables: variables || {} }),
    muteHttpExceptions: true
  });
  const body = res.getContentText();
  if (res.getResponseCode() >= 300) throw new Error("GraphQL HTTP " + res.getResponseCode() + ": " + body);
  const json = JSON.parse(body);
  if (json.errors && json.errors.length) throw new Error("GraphQL errors: " + JSON.stringify(json.errors));
  return json.data;
}

// lastActiveAt is UTC. Mighty's own reports use the UTC calendar date, so we
// pin to that date rather than converting to the script's timezone: a member
// last active at 2021-03-06T00:06:17Z would render as "Mar 05" in EST and
// silently disagree with the existing sheet by one day. Returning a
// local-midnight Date for the UTC date keeps display, sorting, and date math
// all consistent regardless of the spreadsheet's timezone.
function utcDateOnly(iso) {
  const p = iso.slice(0, 10).split("-");
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function fetchAllMembers() {
  const out = [];
  let after = null, pages = 0, excluded = 0;

  do {
    const conn = gql(MEMBERS_QUERY, { first: PAGE_SIZE, after: after }).network.members;
    conn.nodes.forEach(function (n) {
      if (EXCLUDE_EMAIL_RE && n.email && EXCLUDE_EMAIL_RE.test(n.email)) { excluded++; return; }
      out.push([
        Number(n.resourceId),          // A — API returns this as a STRING; coerce so the
                                       //     column stays numeric and VLOOKUPs still match
        n.firstName || "",
        n.lastName || "",
        n.email || "",                 // null unless plan exposes member emails to Hosts
        n.lastActiveAt ? utcDateOnly(n.lastActiveAt) : ""
      ]);
    });
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages++;
    if (after) Utilities.sleep(150);   // be polite to the rate limiter
  } while (after && pages < MAX_PAGES);

  if (after) Logger.log("WARNING: hit MAX_PAGES (" + MAX_PAGES + ") — roster truncated at " + out.length + ". Raise MAX_PAGES.");
  if (excluded) Logger.log("Excluded " + excluded + " staff/test accounts via EXCLUDE_EMAIL_RE.");
  return out;
}

// ---------- main ----------
function refreshRoster() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log("Another run holds the lock; skipping."); return; }

  try {
    const rows = fetchAllMembers();
    if (!rows.length) { Logger.log("ABORT: API returned 0 members — leaving existing tab intact."); return; }

    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(TARGET_TAB) || ss.insertSheet(TARGET_TAB);

    sheet.clearContents();
    sheet.getRange(1, 1, 1, 5)
         .setValues([["Member ID", "First Name", "Last Name", "Email Address", "Last Visted Network"]])
         .setFontWeight("bold");
    sheet.getRange(2, 1, rows.length, 5).setValues(rows);
    sheet.getRange(2, 5, rows.length, 1).setNumberFormat(DATE_FORMAT);
    sheet.setFrozenRows(1);

    const withDate = rows.filter(function (r) { return r[4] !== ""; }).length;
    const withEmail = rows.filter(function (r) { return r[3] !== ""; }).length;
    Logger.log("Wrote " + rows.length + " members to '" + TARGET_TAB + "'. "
      + withDate + " have lastActiveAt, " + withEmail + " have email.");
    if (withDate === 0) Logger.log("WARNING: every lastActiveAt is null — the OAuth user is probably NOT a Host/Moderator.");
  } finally {
    lock.releaseLock();
  }
}

// ---------- trigger: pull only, at 4am (installDailySyncTrigger in HubSpot_Push.gs replaces this) ----------
function installDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === "refreshRoster"; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("refreshRoster").timeBased().everyDays(1).atHour(4).create();
  Logger.log("Daily 4am trigger installed for refreshRoster.");
}

// ---------- diagnostics ----------
// Tests the scope that actually matters (host:read:network_members). A 403 or an
// empty roster here means the scope wasn't granted — not a bug in the sync.
function testAuth() {
  const conn = gql(MEMBERS_QUERY, { first: 1, after: null }).network.members;
  Logger.log("Auth OK. Sample member: " + JSON.stringify(conn.nodes[0], null, 2));
}

function peekFirstPage() {
  const conn = gql(MEMBERS_QUERY, { first: 5, after: null }).network.members;
  Logger.log(JSON.stringify(conn, null, 2));
}
