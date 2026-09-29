/**
 * harness.mjs -- runs the two .gs files in Node, unchanged
 * --------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-29 (ET)
 * Deploy:  Local only. Never paste into Apps Script.
 * What:    Fake Apps Script services (UrlFetchApp, SpreadsheetApp, Properties,
 *          Cache, Lock, Utilities, ScriptApp), a fake Mighty OAuth + GraphQL API
 *          and a fake HubSpot contacts API.
 * Why:     Apps Script has no test runner, and this sync's failures are silent:
 *          a date one day off, a member skipped between pages, a failed update
 *          recorded as done. Tests pin those before anything touches real data.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', 'apps-script');
const FILES = ['MN_Member_Sync.gs', 'HubSpot_Push.gs'];

export function makeWorld(opts = {}) {
  const w = {
    props: {}, cache: {}, logs: [], sheets: {}, triggers: [],
    // Mighty
    members: [], requireBasic: !!opts.requireBasic, issueRefresh: opts.issueRefresh !== false,
    tokenCalls: [], rosterCalls: [], refreshSeq: 0,
    // HubSpot
    contacts: {}, hsSeq: 1000, hsCalls: [], failUpdateIds: new Set(), searchStatus: 200,
  };
  w.addMember = (id, first, last, email, lastActiveAt, joined) =>
    w.members.push({ resourceId: String(id), firstName: first, lastName: last, email, lastActiveAt, joined: joined ?? w.members.length });
  w.addContact = (props) => { const id = String(w.hsSeq++); w.contacts[id] = { id, props: { ...props } }; return id; };
  w.byMember = (mid) => Object.values(w.contacts).filter((c) => String(c.props.mn_member_id) === String(mid));
  return w;
}

function mightyGraphql(w, body) {
  const { query, variables: v } = JSON.parse(body);
  w.rosterCalls.push({ query, v });
  const sorted = [...w.members].sort((a, b) => a.joined - b.joined);
  const start = v.after ? Number(v.after) : 0;
  const page = sorted.slice(start, start + v.first);
  return { data: { network: { members: {
    nodes: page.map(({ joined, ...n }) => n),
    pageInfo: { endCursor: String(start + v.first), hasNextPage: start + v.first < sorted.length },
  } } } };
}

function hubspot(w, url, payload) {
  const u = new URL(url); const body = JSON.parse(payload);
  w.hsCalls.push({ path: u.pathname, body });
  if (u.pathname === '/crm/v3/objects/contacts/search') {
    if (w.searchStatus !== 200) return [w.searchStatus, { message: 'nope' }];
    const f = body.filterGroups[0].filters[0];
    // HubSpot compares email case-insensitively; numbers compare as numbers.
    const norm = (x) => (f.propertyName === 'email' ? String(x).toLowerCase() : String(Number(x)));
    const vals = f.values.map(norm);
    const res = Object.values(w.contacts).filter((c) => c.props[f.propertyName] != null && c.props[f.propertyName] !== '' && vals.includes(norm(c.props[f.propertyName])));
    const start = body.after ? Number(body.after) : 0;
    const page = res.slice(start, start + body.limit);
    const out = { results: page.map((c) => ({ id: c.id, properties: { [f.propertyName]: String(c.props[f.propertyName]) } })) };
    if (start + body.limit < res.length) out.paging = { next: { after: String(start + body.limit) } };
    return [200, out];
  }
  if (u.pathname === '/crm/v3/objects/contacts/batch/update') {
    const errors = [];
    body.inputs.forEach((i) => {
      if (w.failUpdateIds.has(i.id)) { errors.push({ status: 'error', context: { id: [i.id] } }); return; }
      Object.assign(w.contacts[i.id].props, i.properties);
    });
    return [errors.length ? 207 : 200, { status: 'COMPLETE', results: [], errors }];
  }
  if (u.pathname === '/crm/v3/objects/contacts/batch/create') {
    body.inputs.forEach((i) => w.addContact(i.properties));
    return [201, { status: 'COMPLETE' }];
  }
  throw new Error('unknown hubspot ' + u.pathname);
}

// A sheet that keeps real values (Dates stay Dates), like Sheets does.
function makeSheet(ctxDate) {
  const s = { rows: [], hidden: false, formats: {} };
  const sheet = {
    getLastRow: () => { for (let i = s.rows.length; i > 0; i--) if ((s.rows[i - 1] || []).some((v) => v !== '' && v !== undefined)) return i; return 0; },
    clearContents: () => { s.rows = []; return sheet; },
    hideSheet: () => { s.hidden = true; }, isSheetHidden: () => s.hidden, setFrozenRows: () => {},
    getRange: (r, c, nr = 1, nc = 1) => {
      const range = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
        setValues: (vals) => {
          vals.forEach((row, i) => row.forEach((v, j) => {
            const rr = r - 1 + i, cc = c - 1 + j;
            (s.rows[rr] ||= []);
            // Sheets turns "2026-08-10" into a local-midnight Date unless the cell is plain text.
            if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && s.formats[cc] !== '@') {
              const [y, m, d] = v.split('-').map(Number); v = new ctxDate(y, m - 1, d);
            }
            s.rows[rr][cc] = v;
          }));
          return range;
        },
        setNumberFormat: (f) => { for (let j = 0; j < nc; j++) s.formats[c - 1 + j] = f; return range; },
        setFontWeight: () => range,
      };
      return range;
    },
    _rows: () => s.rows.slice(0, sheet.getLastRow()),
  };
  return sheet;
}

export function boot(w) {
  const resp = (code, text) => ({ getResponseCode: () => code, getContentText: () => text });
  const ctx = {
    console,
    Logger: { log: (m) => w.logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => w.props[k] ?? null, setProperty: (k, v) => { w.props[k] = String(v); },
      deleteProperty: (k) => { delete w.props[k]; }, setProperties: (o) => Object.assign(w.props, o) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => w.cache[k] ?? null, put: (k, v) => { w.cache[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ScriptApp: {
      getProjectTriggers: () => w.triggers.map((t) => ({ getHandlerFunction: () => t.fn, getEventType: () => 'CLOCK', _t: t })),
      deleteTrigger: (t) => { w.triggers = w.triggers.filter((x) => x !== t._t); },
      newTrigger: (fn) => ({ timeBased: () => ({ everyDays: (d) => ({ atHour: (h) => ({ create: () => w.triggers.push({ fn, d, h }) }) }) }) }),
    },
    SpreadsheetApp: { openById: () => ({
      getSheetByName: (n) => w.sheets[n] || null,
      insertSheet: (n) => (w.sheets[n] = makeSheet(ctx.Date)) }) },
    Utilities: {
      getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', sleep: () => {},
      base64Encode: (s) => Buffer.from(s).toString('base64'),
    },
    UrlFetchApp: { fetch: (url, o = {}) => {
      if (url.endsWith('/oauth/token')) {
        const basic = !!(o.headers && o.headers.Authorization && o.headers.Authorization.startsWith('Basic '));
        w.tokenCalls.push({ url, basic, payload: o.payload });
        if (w.requireBasic && !basic) return resp(401, JSON.stringify({ error: 'invalid_client' }));
        w.refreshSeq++;
        const tok = { access_token: 'AT' + w.refreshSeq, expires_in: 7200 };
        if (w.issueRefresh) tok.refresh_token = 'RT' + w.refreshSeq;
        return resp(200, JSON.stringify(tok));
      }
      if (url.startsWith('https://api.mn.co/')) {
        if (!/^Bearer AT\d+$/.test(o.headers.Authorization)) return resp(401, 'no token');
        return resp(200, JSON.stringify(mightyGraphql(w, o.payload)));
      }
      if (url.startsWith('https://api.hubapi.com')) {
        const [code, json] = hubspot(w, url, o.payload);
        return resp(code, JSON.stringify(json));
      }
      throw new Error('unexpected fetch ' + url);
    } },
  };
  vm.createContext(ctx);
  ctx.Date = vm.runInContext('Date', ctx);
  const src = FILES.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n;\n');
  vm.runInContext(src + `
;globalThis.__api = { setScriptProps, logAuthorizeUrl, exchangeCode, getAccessToken, refreshRoster,
  pushLastVisitedToHubSpot, previewUnmatched, applyUnmatched, dailySync, installDailySyncTrigger,
  installDailyTrigger, decommissionGhlPush, utcDateOnly, hsDateString, hsYmd,
  MEMBERS_QUERY, REDIRECT_URI };`, ctx);
  return ctx.__api;
}
