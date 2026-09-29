/**
 * sync.test.mjs -- tests for the last-visited sync
 * ------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-29 (ET)
 * Deploy:  Local only. Run with `npm test` (Node 20+).
 * What:    OAuth setup, roster paging, UTC date pinning, change-only pushes,
 *          partial failures, the Unmatched link/create flow and the triggers.
 * Why:     Every one of these fails quietly in production: nothing errors, the
 *          numbers are just wrong.
 */
// Run in US Eastern, where a UTC date read the naive way lands a day early.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, boot } from './harness.mjs';

function authed(opts) {
  const w = makeWorld(opts);
  Object.assign(w.props, { MN_CLIENT_ID: 'c'.repeat(43), MN_CLIENT_SECRET: 's'.repeat(43), MN_SCOPES: 'host:read:network_members read:userinfo', MN_REFRESH_TOKEN: 'RT0', HS_TOKEN: 'test-hubspot-token' });
  return w;
}
const logHas = (w, re) => w.logs.some((l) => re.test(l));
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- OAuth ----------

test('authorize URL carries state, scopes and the exact redirect', () => {
  const w = authed(); const api = boot(w);
  api.logAuthorizeUrl();
  const url = new URL(w.logs[0].split('\n')[1]);
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('state'), w.props.MN_OAUTH_STATE);
  assert.equal(url.searchParams.get('scope'), 'host:read:network_members read:userinfo');
  assert.equal(url.searchParams.get('redirect_uri'), api.REDIRECT_URI);
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('exchangeCode stores the refresh token (client auth in the body)', () => {
  const w = authed(); delete w.props.MN_REFRESH_TOKEN; const api = boot(w);
  api.exchangeCode('CODE');
  assert.equal(w.props.MN_REFRESH_TOKEN, 'RT1');
  assert.equal(w.props.MN_AUTH_BASIC, undefined);
  assert.equal(w.tokenCalls[0].payload.client_secret, 's'.repeat(43));
});

test('exchangeCode falls back to HTTP Basic on 401 and remembers it', () => {
  const w = authed({ requireBasic: true }); delete w.props.MN_REFRESH_TOKEN; const api = boot(w);
  api.exchangeCode('CODE');
  assert.equal(w.props.MN_AUTH_BASIC, '1');
  assert.equal(w.props.MN_REFRESH_TOKEN, 'RT1');
  // Later refreshes go straight to Basic, and the secret never rides in the body.
  api.getAccessToken();
  const last = w.tokenCalls.at(-1);
  assert.equal(last.basic, true);
  assert.equal(last.payload.client_secret, undefined);
});

test('no refresh_token in the response is a hard stop', () => {
  const w = authed({ issueRefresh: false }); delete w.props.MN_REFRESH_TOKEN; const api = boot(w);
  assert.throws(() => api.exchangeCode('CODE'), /No refresh_token returned/);
});

test('a rotated refresh token is saved, and the access token is cached', () => {
  const w = authed(); const api = boot(w);
  assert.equal(api.getAccessToken(), 'AT1');
  assert.equal(w.props.MN_REFRESH_TOKEN, 'RT1');
  assert.equal(api.getAccessToken(), 'AT1');
  assert.equal(w.tokenCalls.length, 1);
});

// ---------- roster pull ----------

test('roster pages past 50, sorts by join date, numbers ids, drops staff accounts', () => {
  const w = authed(); const api = boot(w);
  for (let i = 1; i <= 120; i++) w.addMember(1000 + i, 'F' + i, 'L' + i, `m${i}@example.com`, '2026-08-01T15:00:00Z');
  w.addMember(9001, 'Apple', 'Tester', 'apple@mightynetworks.com', null);
  w.addMember(9002, 'Test', 'User', 'x@tfbnw.net', null);
  api.refreshRoster();
  const rows = w.sheets['MN Live']._rows();
  assert.equal(rows.length, 121); // header + 120
  assert.equal(typeof rows[1][0], 'number');
  assert.equal(new Set(rows.slice(1).map((r) => r[0])).size, 120);
  assert.equal(w.rosterCalls.length, 3);
  assert.match(api.MEMBERS_QUERY, /sort: DATE_JOINED/);
  assert.ok(logHas(w, /Excluded 2 staff\/test accounts/));
});

test('lastActiveAt keeps its UTC calendar date in any timezone', () => {
  const w = authed(); const api = boot(w);
  w.addMember(1, 'A', 'B', 'a@example.com', '2026-03-06T00:06:17Z');
  w.addMember(2, 'C', 'D', 'c@example.com', null);
  api.refreshRoster();
  const rows = w.sheets['MN Live']._rows();
  assert.equal(ymd(rows[1][4]), '2026-03-06'); // naive local conversion would say 03-05
  assert.equal(rows[2][4], '');
  assert.equal(api.hsDateString(rows[1][4]), '2026-03-06');
});

test('an empty roster leaves the existing tab alone', () => {
  const w = authed(); const api = boot(w);
  w.addMember(1, 'A', 'B', 'a@example.com', '2026-08-01T12:00:00Z');
  api.refreshRoster();
  w.members = [];
  api.refreshRoster();
  assert.equal(w.sheets['MN Live']._rows().length, 2);
  assert.ok(logHas(w, /ABORT: API returned 0 members/));
});

test('all-null lastActiveAt warns that the token is not a Host', () => {
  const w = authed(); const api = boot(w);
  w.addMember(1, 'A', 'B', 'a@example.com', null);
  api.refreshRoster();
  assert.ok(logHas(w, /NOT a Host\/Moderator/));
});

// ---------- HubSpot push ----------

function seeded() {
  const w = authed(); const api = boot(w);
  w.addMember(11, 'Ann', 'One', 'ann@example.com', '2026-08-01T10:00:00Z');
  w.addMember(12, 'Ben', 'Two', 'ben@example.com', '2026-08-02T10:00:00Z');
  w.addMember(13, 'Cy', 'Three', 'CY@Example.com', '2026-08-03T10:00:00Z');
  w.addMember(14, 'Di', 'Four', '', '2026-08-04T10:00:00Z');
  w.addMember(15, 'Ed', 'Five', 'ed@example.com', null); // never visited: not pushed
  const a = w.addContact({ mn_member_id: 11, email: 'ann@example.com' });
  const b = w.addContact({ mn_member_id: 12, email: 'ben@example.com' });
  const c = w.addContact({ email: 'cy@example.com' }); // exists, but no member id yet
  api.refreshRoster();
  return { w, api, a, b, c };
}

test('push writes changed dates, then does nothing on an unchanged day', () => {
  const { w, api, a, b } = seeded();
  api.pushLastVisitedToHubSpot();
  assert.equal(w.contacts[a].props.mn_last_visited_network, '2026-08-01');
  assert.equal(w.contacts[b].props.mn_last_visited_network, '2026-08-02');
  assert.ok(logHas(w, /2 updated, 0 failed, 2 MN members have no HubSpot contact/));
  assert.equal(w.sheets._hs_state.isSheetHidden(), true);

  // Unchanged day: matched members aren't touched. Unmatched ones are searched
  // again (they were never recorded), so they're picked up once they're linked.
  const calls = w.hsCalls.length;
  api.pushLastVisitedToHubSpot();
  const again = w.hsCalls.slice(calls);
  assert.deepEqual(again.map((c) => c.path), ['/crm/v3/objects/contacts/search']);
  assert.deepEqual(again[0].body.filterGroups[0].filters[0].values.sort(), [13, 14]);

  // Once everyone is matched, an unchanged day makes no HubSpot calls at all.
  w.addContact({ mn_member_id: 13 }); w.addContact({ mn_member_id: 14 });
  api.pushLastVisitedToHubSpot();
  const settled = w.hsCalls.length;
  api.pushLastVisitedToHubSpot();
  assert.equal(w.hsCalls.length, settled);
  assert.ok(logHas(w, /Nothing changed since last push/));

  // One member visits again: only that one is pushed.
  w.members.find((m) => m.resourceId === '12').lastActiveAt = '2026-08-09T01:00:00Z';
  api.refreshRoster(); api.pushLastVisitedToHubSpot();
  assert.equal(w.contacts[b].props.mn_last_visited_network, '2026-08-09');
  assert.ok(logHas(w, /^1 contacts with a changed last-visited date/));
});

test('a failed row in a 207 is not recorded, so it retries next run', () => {
  const { w, api, a, b } = seeded();
  w.failUpdateIds.add(b);
  api.pushLastVisitedToHubSpot();
  assert.ok(logHas(w, /1 updated, 1 failed/));
  w.failUpdateIds.clear();
  api.pushLastVisitedToHubSpot();
  assert.equal(w.contacts[b].props.mn_last_visited_network, '2026-08-02');
  assert.equal(w.contacts[a].props.mn_last_visited_network, '2026-08-01');
});

test('two contacts sharing a member id: warned, first match wins', () => {
  const { w, api } = seeded();
  w.addContact({ mn_member_id: 11, email: 'ann.dupe@example.com' });
  api.pushLastVisitedToHubSpot();
  assert.ok(logHas(w, /1 duplicate contacts share an mn_member_id/));
});

test('a 401 on search stops the run with the scope to fix', () => {
  const { w, api } = seeded();
  w.searchStatus = 401;
  assert.throws(() => api.pushLastVisitedToHubSpot(), /crm\.objects\.contacts\.read/);
});

test('unmatched members land in MN Unmatched with a text date', () => {
  const { w, api } = seeded();
  api.pushLastVisitedToHubSpot();
  const rows = w.sheets['MN Unmatched']._rows();
  assert.deepEqual(rows.slice(1).map((r) => r[0]).sort(), [13, 14]);
  assert.equal(rows[1][4], '2026-08-03'); // stays text, not a shifted Date
});

// ---------- Unmatched link/create ----------

test('preview writes nothing; apply links by email and creates the rest', () => {
  const { w, api, c } = seeded();
  api.pushLastVisitedToHubSpot();
  const before = Object.keys(w.contacts).length;
  api.previewUnmatched();
  assert.equal(Object.keys(w.contacts).length, before);
  assert.ok(logHas(w, /1 already in HubSpot by email .*, 1 genuinely new/));
  assert.ok(logHas(w, /1 of the new ones have no email/));
  assert.ok(logHas(w, /DRY RUN/));

  api.applyUnmatched();
  assert.equal(String(w.contacts[c].props.mn_member_id), '13');
  assert.equal(w.contacts[c].props.mn_last_visited_network, '2026-08-03');
  const created = w.byMember(14);
  assert.equal(created.length, 1);
  assert.equal(created[0].props.mn_last_visited_network, '2026-08-04');
  assert.equal(created[0].props.email, undefined);
  assert.ok(logHas(w, /Linked 1, created 1, failed 0/));

  // Next run finds everyone.
  api.refreshRoster(); api.pushLastVisitedToHubSpot();
  assert.ok(logHas(w, /0 MN members have no HubSpot contact\.$/));
});

test('hsYmd reads a Date or a string the same way', () => {
  const w = authed(); const api = boot(w);
  const D = api.utcDateOnly('2026-08-10T23:59:00Z');
  assert.equal(api.hsYmd(D), '2026-08-10');
  assert.equal(api.hsYmd('2026-08-10'), '2026-08-10');
});

// ---------- triggers ----------

test('installDailySyncTrigger leaves exactly one 4am dailySync', () => {
  const w = authed(); const api = boot(w);
  api.installDailyTrigger();
  api.installDailySyncTrigger();
  api.installDailySyncTrigger();
  assert.deepEqual(w.triggers, [{ fn: 'dailySync', d: 1, h: 4 }]);
});

test('dailySync pulls and pushes in one run', () => {
  const w = authed(); const api = boot(w);
  w.addMember(21, 'Fay', 'Six', 'fay@example.com', '2026-08-05T09:00:00Z');
  const id = w.addContact({ mn_member_id: 21 });
  api.dailySync();
  assert.equal(w.contacts[id].props.mn_last_visited_network, '2026-08-05');
});

test('decommissionGhlPush removes only syncBatch triggers and its state', () => {
  const w = authed(); const api = boot(w);
  w.triggers.push({ fn: 'syncBatch' }, { fn: 'dailySync' });
  Object.assign(w.props, { cursor: '5', hashes: 'x'.repeat(100) });
  api.decommissionGhlPush();
  assert.deepEqual(w.triggers.map((t) => t.fn), ['dailySync']);
  assert.equal(w.props.cursor, undefined);
  assert.equal(w.props.MN_REFRESH_TOKEN, 'RT0');
});
