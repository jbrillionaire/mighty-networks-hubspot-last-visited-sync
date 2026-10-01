<!--
  README.md -- Mighty Networks last visited -> HubSpot, daily
  Author:  Jibril Sulaiman
  Date:    2026-09-29
  What:    Build guide for a Google Apps Script that copies every Mighty Networks
           member's "last visited" date into a HubSpot contact property each day.
  Why:     Mighty only exposes last-active to Host tokens on its Headless API, and
           HubSpot can't pull on a schedule, so the job needs its own scheduler.
-->

# Mighty Networks last visited → HubSpot, daily

A Google Apps Script that pulls every member of a Mighty Networks community with the
date they last visited, writes the list to a Google Sheet, and pushes each changed date
into a HubSpot contact property. You can then segment and trigger on it in HubSpot, for
example with *"hasn't visited in 60 days"*.

It runs once a day at 4am, with no server and no paid middleware. Only dates that
changed are sent. Members HubSpot doesn't know yet are listed so you can link them by
email or create them.

This covers **last visited only**. Sending Mighty direct messages is a separate
integration:
[mighty-networks-hubspot-dm-integration](https://github.com/jbrillionaire/mighty-networks-hubspot-dm-integration).

## Why it exists

You want to know when each community member last showed up, and you want that date on
their CRM contact so you can segment on it, for example "hasn't visited in 60 days".
Mighty Networks shows hosts activity inside its own admin analytics, but it gives you
no simple way to get a per-member "last visited" date out of the platform.

### What Mighty doesn't give you natively

Mighty's own docs and API schema show the following:

1. **The Admin API has no activity field.** The Admin API (REST, long-lived key from
   **Admin → Integrations → Admin API**) is the easy one to script against, and it has a
   members endpoint. Its member object has id, name, email, profile fields, `created_at`
   and `updated_at`, but nothing for last active, last seen, last visit or last sign-in.
   `updated_at` records profile edits, not visits, so don't use it as a stand-in.
2. **Only the Headless API (GraphQL) has it.** `User.lastActiveAt` is documented as when
   the member last visited the network. A per-space version is on `Membership`. Both are
   **restricted to Hosts and Moderators**.
3. **The Headless API is OAuth-only and invite-gated.** No API key. You create an OAuth
   application, a Host signs in and approves it, and you swap the code for 1-hour access
   tokens plus a refresh token. If your admin menu has no **OAuth Applications** or
   **Headless API** item, your network doesn't have access yet. Ask Mighty for it.
4. **No webhook event returns the last visited date.** Mighty has 44 webhook event
   types: member lifecycle events (joined, left, updated, plan changed, purchased,
   tags, course progress) and content events (post, comment, reaction, RSVP). None of
   them fires when a member visits, and none of them carries the last visited date,
   not even the member events. A member who logs in every day to read and never posts
   sends no events at all, while their `lastActiveAt` moves every day. Zapier and Make
   run on those same events, so they can't get the date either. The GraphQL schema
   has no subscriptions, so the only way to get it is to poll the Headless API.
5. **You can't pull it for one contact at a time on demand.** A HubSpot workflow that
   calls Mighty for each contact would run once per contact, and the 1-hour tokens have
   to be refreshed. HubSpot workflow secrets are fixed, so a workflow has nowhere to save
   a rotated refresh token.
6. **Emails are not guaranteed.** Mighty returns a member's email to a Host only if the
   network's plan includes email visibility **and** that member has consented to share
   it. Members who haven't come back with an empty string. So the join key has to be
   the member ID, not the email.

HubSpot adds one constraint of its own: **it has no scheduler.** Workflows start when a
record enrolls, not on a clock. Something outside HubSpot has to run the daily pull.

### What went wrong before

The older pipeline used a spreadsheet `IMPORTRANGE` of an analytics export, then an
hourly Apps Script push that sent one webhook per changed row to a CRM. It had three
problems that stayed hidden:

- **The import range was capped at a fixed row number.** When the roster outgrew it, the
  extra members stopped arriving and no error appeared. The first full API pull showed
  that **about 24% of the roster** (roughly 1 in 4 members) had been missing from the
  old sheet.
- **Its dedupe state lived in Script Properties.** The whole Script Properties store is
  capped at 500 KB per project. One JSON property of `{memberId: fingerprint}` had grown
  to **about half of that cap**. While it was that large, new credentials typed into the
  same project didn't persist.
- **Its trigger installer deleted every trigger in the project**, not just its own. Any
  new schedule added to that project would have been removed without warning the next
  time someone ran it.

### The design choices, and why

| Choice | Why |
|---|---|
| **Apps Script owns the schedule** | HubSpot can't run on a clock. Apps Script can page the whole roster in one run, and it can write a rotated refresh token back to Script Properties. |
| **A Google Sheet sits in the middle** (`MN Live`) | You get a readable copy of every member and date that you can check against HubSpot. The script writes the full roster on each run, so no row cap can drop anyone. |
| **Sort by `DATE_JOINED`, not `LAST_VISIT`** | Mighty's cursors behave like page numbers. The first `endCursor` decoded to "page 2". If you sort by last visit, a member who visits during the run moves to the end of the list, everyone after them shifts by one, and one member is skipped. Join dates never change, so the pages stay stable. |
| **Pin the date to the UTC calendar day** | `lastActiveAt` is UTC. If you convert it to local time, anyone active between midnight and about 4-5 am UTC lands on the previous day. That happened in testing: a timestamp just after 00:00 UTC came out one day off from the old export. HubSpot `date` properties also require midnight UTC exactly. Anything else is rejected with `INVALID_DATE ... not midnight!`. |
| **Search, then update by record ID** | HubSpot can match a batch update on a custom property only if that property is set to **Require unique values**, and that option exists only when the property is first created (*"Properties can only be made unique during property creation."*). An existing `mn_member_id` can't be made unique later. So the script searches `mn_member_id IN [...]` to get HubSpot record IDs, then batch-updates by those IDs. That's two calls per 100 contacts, and it tells you exactly which members have no contact. |
| **Sync state goes in a hidden sheet tab (`_hs_state`)**, not PropertiesService | It stays clear of the 500 KB store cap that affected the older script. A sheet tab can hold one row per member with no size ceiling. |
| **Only changed dates are pushed** | The first run updates everyone. Later runs send only members whose date changed since the last successful push. |
| **Unmatched members are linked by email before any are created** | In production, about 94% of the members with no ID match were already in HubSpot under their email, just with `mn_member_id` blank. Creating new contacts for them would have made duplicates or failed on the email. |

### Before and after (ratios)

- Roster coverage: about 76% of members in the old sheet, 100% in `MN Live`.
- First push: about 99.8% of members matched a HubSpot contact by `mn_member_id`, with
  0 failures. The remaining 0.2% went to `MN Unmatched`, and all but one of those were
  linked by email.

---

## How it works

```
 4:00am  dailySync()                          (Apps Script time trigger)
   │
   ├─ refreshRoster()          MN_Member_Sync.gs
   │     OAuth refresh token ──► 1-hour access token (rotated token saved)
   │     Mighty Headless API: network.members, 50 per page, sorted by join date
   │     drop staff/test accounts ──► tab "MN Live"
   │        A Member ID | B First | C Last | D Email | E Last Visited (UTC date)
   │
   └─ pushLastVisitedToHubSpot()   HubSpot_Push.gs
         compare column E with hidden tab "_hs_state" ──► only changed rows
         search contacts: mn_member_id IN [100 ids] ──► HubSpot record ids
         batch update mn_last_visited_network (YYYY-MM-DD)
         record what applied in "_hs_state"; members with no contact ──► "MN Unmatched"

 By hand, when "MN Unmatched" has rows:
   previewUnmatched() ──► applyUnmatched()
     link by email (fill in mn_member_id), create only members HubSpot really lacks
```

## What's in this repo

| Path | What it is | Where it goes |
|---|---|---|
| [`apps-script/MN_Member_Sync.gs`](apps-script/MN_Member_Sync.gs) | OAuth setup and token refresh, the roster pull, UTC date pinning, the `MN Live` tab | Apps Script editor: a script file named `MN_Member_Sync` (Step 3) |
| [`apps-script/HubSpot_Push.gs`](apps-script/HubSpot_Push.gs) | Change detection, the search-then-update push, `MN Unmatched` link/create, the daily trigger | Same project: a script file named `HubSpot_Push` (Step 3) |
| [`tests/harness.mjs`](tests/harness.mjs) | Runs both `.gs` files unchanged in Node against fake Apps Script, Mighty and HubSpot services | Local only |
| [`tests/sync.test.mjs`](tests/sync.test.mjs) | 19 tests: OAuth, paging, UTC dates, change-only pushes, partial failures, link/create, triggers | Local only: `npm test` |

## Table of contents

1. [Requirements](#1-requirements)
2. [Setup, step by step](#2-setup-step-by-step)
   - [Step 1: Confirm your network has Headless API access](#step-1-confirm-your-network-has-headless-api-access)
   - [Step 2: Create the Google Sheet](#step-2-create-the-google-sheet)
   - [Step 3: Create the Apps Script project and paste both files](#step-3-create-the-apps-script-project-and-paste-both-files)
   - [Step 4: Fill in the four config values](#step-4-fill-in-the-four-config-values)
   - [Step 5: Create the Mighty OAuth application](#step-5-create-the-mighty-oauth-application)
   - [Step 6: Store the Mighty credentials in Script Properties](#step-6-store-the-mighty-credentials-in-script-properties)
   - [Step 7: Authorize the script with Mighty](#step-7-authorize-the-script-with-mighty)
   - [Step 8: Run the first roster pull](#step-8-run-the-first-roster-pull)
   - [Step 9: Create the two HubSpot contact properties](#step-9-create-the-two-hubspot-contact-properties)
   - [Step 10: Create a HubSpot key and store it as `HS_TOKEN`](#step-10-create-a-hubspot-key-and-store-it-as-hs_token)
   - [Step 11: Test one contact](#step-11-test-one-contact)
   - [Step 12: Run the full push](#step-12-run-the-full-push)
   - [Step 13: Resolve `MN Unmatched` (link by email, create only the rest)](#step-13-resolve-mn-unmatched-link-by-email-create-only-the-rest)
   - [Step 14 (optional): Retire an older hourly sync in the same project](#step-14-optional-retire-an-older-hourly-sync-in-the-same-project)
   - [Step 15: Install the daily trigger](#step-15-install-the-daily-trigger)
   - [Step 16: Watch the first unattended runs](#step-16-watch-the-first-unattended-runs)
   - [Step 17 (optional): React to the date in HubSpot](#step-17-optional-react-to-the-date-in-hubspot)
3. [Troubleshooting](#3-troubleshooting)
4. [Limits](#4-limits)
5. [Testing](#5-testing)
6. [Security](#6-security)

---

## 1. Requirements

| You need | Why |
|---|---|
| A Mighty Networks community with **Headless API** access (**Admin → Integrations** shows **OAuth Applications** and **Headless API**) | The Headless API is the only place `lastActiveAt` exists. Step 1 checks this. |
| The **Host** account of that community | `lastActiveAt` is visible only to Hosts and Moderators. Signed in as anyone else, every date comes back empty. |
| A Google account | It owns the Sheet, the Apps Script project and the daily trigger. The trigger runs as this account. |
| HubSpot access that can create **contact properties** and a **service key** (usually a Super Admin) | Steps 9 and 10 |
| Optional: Node.js 20+ | Only to run the tests. Nothing here needs installing to use the sync. |

---

## 2. Setup, step by step

Everything runs in one Google Apps Script project that is bound to one Google Sheet.
Both `.gs` files **must be in the same project**. `HubSpot_Push.gs` calls
`getSpreadsheet()` and reads `TARGET_TAB`, and both are defined in `MN_Member_Sync.gs`.

About how you run things in Apps Script: pick a function name in the dropdown next to
**Debug** on the editor toolbar, then click **Run**. Output appears in the
**Execution log** panel. The dropdown can't pass arguments. So for `exchangeCode(code)`
and `testHubSpotOne(memberId)` you'll add a temporary one-line wrapper function, run it,
then delete it.

---

### Step 1: Confirm your network has Headless API access

About 5 minutes.

**1a. Open the admin.** Sign in to your community **as a Host** (for example
`https://your-community.mn.co`) and open the admin panel (**Admin**). In the left
sidebar, scroll to **Integrations** and expand it. You should see **Admin API**, **MCP**,
**Webhooks**, **OAuth Applications** and **Headless API**.

> ⚠️ **No OAuth Applications or Headless API item means no access.** Only the Headless
> API returns `lastActiveAt`. The Admin API doesn't have it, and no amount of scripting
> works around that. Ask Mighty for Headless API access before you go further.

**1b. Copy the GraphQL endpoint.** Click **Headless API**. The page is titled
**Headless API**, and the **GraphQL Endpoint** box shows:

```
POST   https://api.mn.co/networks/1234567/graphql
```

The number between `/networks/` and `/graphql` is your **network ID**. Keep it for
Step 4. The same page shows **Headless API Usage**. In production the banner said
*"API quotas are currently for informational purposes and are not yet enforced."*

**1c. (Recommended) Prove the data exists before you do any OAuth work.** Click
**Headless API Explorer** (top right). To pick an app in the **OAuth Application**
dropdown you need one, so if you have none yet, do Step 5 first and come back. The
Explorer gets its own short-lived token (you'll see *"Expires at …"* and a
**Refresh token** button). Paste this query and click the green ▶ button:

```graphql
{
  network {
    members(first: 50, sort: DATE_JOINED, sortOrder: ASC) {
      nodes { resourceId firstName lastName email lastActiveAt }
      pageInfo { endCursor hasNextPage }
    }
  }
}
```

Success looks like this: 50 nodes, each with a real `lastActiveAt` such as
`"2026-08-04T15:42:07Z"`, `"hasNextPage": true`, and
`"extensions": { "cost": { "complexity": 50 } }`. That's about one complexity unit per
member.

> ⚠️ **`resourceId` is the ID you want, not `id`.** `id` is a base64 global ID.
> `resourceId` is the numeric member ID that other tools and exports use. The API
> returns it as a **string** (`"1234567"`). The script converts it to a number.

> ⚠️ **Ignore `subscription` in the Explorer's autocomplete.** It's a generic GraphQL
> keyword. This schema has no subscriptions.

✅ **Check:** the Explorer returns members with non-null `lastActiveAt` values, and some
of the `resourceId` values match member IDs you already know.

---

### Step 2: Create the Google Sheet

About 3 minutes.

**2a.** In Google Drive, create a new blank Google Sheet. Name it something like
`Mighty Members Last Visited`.

**2b. Copy the spreadsheet ID** from the address bar. It's the part between `/d/` and
`/edit`:

```
https://docs.google.com/spreadsheets/d/REPLACE_WITH_SPREADSHEET_ID/edit#gid=0
```

Keep it for Step 4.

**2c.** Leave the default tab alone. The script creates its own tabs: `MN Live`
(roster), `MN Unmatched` (members with no HubSpot contact) and `_hs_state` (hidden sync
state). You don't need to create them.

✅ **Check:** you have a spreadsheet ID about 44 characters long.

---

### Step 3: Create the Apps Script project and paste both files

About 5 minutes.

**3a.** In the sheet, click **Extensions → Apps Script**. A new project opens with one
file, `Code.gs`.

**3b. Rename the project.** Click the project title at the top (**Untitled project**,
wording may differ) and give it a name such as `MN Last Visited Sync`.

**3c. Add `MN_Member_Sync.gs`.** Next to **Files**, click **+** → **Script** (wording
may differ). Name it `MN_Member_Sync` (Apps Script adds `.gs`). Delete the sample
`function myFunction() {}` and paste in **all** of [`apps-script/MN_Member_Sync.gs`](apps-script/MN_Member_Sync.gs).

**3d. Add `HubSpot_Push.gs`.** **+** → **Script** again, name it `HubSpot_Push`, delete
the sample code and paste in **all** of [`apps-script/HubSpot_Push.gs`](apps-script/HubSpot_Push.gs).

**3e.** If `Code.gs` still contains only the empty sample function, you can delete it
(**⋮** next to the file → **Delete**, wording may differ). If this project already has
an older sync in `Code.gs`, keep it for now and read Step 14.

**3f. Save.** Press **Ctrl+S** or click the save (disk) icon. The toolbar shows
*"Unsaved changes"* until you do. Functions in an unsaved file don't show up in the Run
dropdown.

**3g. Check the time zone.** Click **Project Settings** (gear icon in the left rail).
Note the project **Time zone** (wording may differ). Then in the sheet, open
**File → Settings** and make sure the spreadsheet's **Time zone** is the same. See the
⚠️ below.

> ⚠️ **Keep the script time zone and the sheet time zone the same.** The script stores
> each member's UTC calendar date as local midnight in the **script's** time zone, then
> reads it back and sends `YYYY-MM-DD` to HubSpot. If the sheet is set to a different
> time zone, the displayed date can shift by a day. The daily trigger's 4 am also means
> 4 am in the script's time zone.

✅ **Check:** the **Files** list shows `MN_Member_Sync.gs` and `HubSpot_Push.gs`, and
the Run dropdown lists functions such as `refreshRoster`, `checkCreds`,
`pushLastVisitedToHubSpot` and `installDailySyncTrigger`.

---

### Step 4: Fill in the four config values

About 5 minutes.

At the top of `MN_Member_Sync.gs`, replace the placeholders:

| Constant | Placeholder in the repo | Replace with | Where it comes from |
|---|---|---|---|
| `NETWORK` | `"REPLACE_WITH_NETWORK_ID"` | Your numeric network ID, as a string, e.g. `"1234567"` | Step 1b: the number in `https://api.mn.co/networks/<number>/graphql`. (The code comment says the subdomain also works. The build used the number.) |
| `OAUTH_HOST` | `"https://your-community.mn.co"` | The address where you sign in as a Host, **no trailing slash** | Your browser's address bar on the community. If your community uses a custom domain, use that domain, since your session lives there. |
| `REDIRECT_URI` | `"https://your-community.mn.co/"` | Any page on your community that loads, usually the home page **with** its trailing slash | You choose it. You'll type the same value into the OAuth app in Step 5. The page never handles anything. You only copy `?code=` from the address bar. |
| `SPREADSHEET_ID` | `"REPLACE_WITH_SPREADSHEET_ID"` | The ID from Step 2b | The sheet URL. |

`GRAPHQL_URL` is built from `NETWORK`. Don't edit it.

Optional constants you can leave as they are:

| Constant | Default | Change it if |
|---|---|---|
| `TARGET_TAB` | `"MN Live"` | Leave it. `HubSpot_Push.gs` reads it too. |
| `PAGE_SIZE` | `50` | Don't. 50 is the schema maximum. |
| `MAX_PAGES` | `400` | Your roster is over 20,000 members (400 × 50). |
| `EXCLUDE_EMAIL_RE` | `/@(mightynetworks\.com|tfbnw\.net)$/i` | You want to keep Mighty's seeded staff and test accounts. Set it to `null`. In production, the first 50 members included four of them (Apple, Google and Login testers and a Mighty employee). |
| `DATE_FORMAT` | `"MMM dd yyyy"` | You want a different display format in `MN Live`. It only affects display. |

In `HubSpot_Push.gs`, change `HS_ID_PROPERTY` (`"mn_member_id"`) and
`HS_DATE_PROPERTY` (`"mn_last_visited_network"`) only if your HubSpot internal names
will be different (Step 9).

**4a.** Save (**Ctrl+S**).

> ⚠️ **`REDIRECT_URI` must match the OAuth app exactly**, trailing slash included. A
> mismatch shows up later as `invalid_grant` when you exchange the code (Step 7).

✅ **Check:** run `checkCreds` (it's safe to run now). The last two log lines echo your
values:
```
OAUTH_HOST: https://your-community.mn.co
REDIRECT_URI: https://your-community.mn.co/
```
The two length lines will read `0` until Step 6. That's expected.

---

### Step 5: Create the Mighty OAuth application

About 5 minutes.

**5a.** Go to **Admin → Integrations → OAuth Applications**. With no apps yet, the page
reads *"You haven't created an OAuth application yet."* Click
**New OAuth Application** (top right).

**5b. Fill the New OAuth Application dialog:**

1. **Application Name \***: for example `Last Active Sync`.
2. **Redirect URI \***: exactly your `REDIRECT_URI` from Step 4, e.g.
   `https://your-community.mn.co/`. (The field says *"Multiple URIs can be separated by
   newlines"*. One is enough.)
3. **Host Scopes**: tick **`host:read:network_members`** (*"View members in the
   network"*). This scope returns `Network.members` and the Host-only `lastActiveAt`.
4. **Member Scopes**: tick **`read:userinfo`** (*"View your basic profile
   information"*).
5. Leave everything else unticked unless you need it: `host:read:network_events`,
   `host:read:network_spaces`, `host:read:network_plans`, `host:read:network_posts`,
   `read:network`, `write:posts`, `write:comments`. The script requests only the two
   scopes in `MN_SCOPES`. (The production app had extra read-only scopes ticked. That
   works, because a token can ask for fewer scopes than the app allows.)
6. **Confidential client**: keep it **ticked**. The dialog says *"Uncheck for public
   clients (native/SPA apps). Public clients require PKCE for security."* The script
   authenticates with the client secret, so it needs a confidential client. Unticking it
   would require PKCE, which the script doesn't do.
7. **Skip consent screen**: tick it if you're the only one authorizing. With it on,
   the authorize link sends you straight back to the redirect page with no approve
   button.

**5c.** Click **Create**.

**5d.** The app card now shows **Client ID**, **Client Secret** (masked, with a
**Reveal** button), **Redirect URI**, **Type: Confidential**, **Scopes** and
**Consent screen: Skipped**. You can open the secret again later with **Reveal**.

> ⚠️ **Treat the Client Secret like a password.** Don't paste it into chat, a doc or a
> screenshot. In the build, the secret was pasted into a chat by mistake. If that
> happens, delete the app with the 🗑️ icon and create a new one. Nothing depends on the
> secret until Step 7, so rotating it early costs nothing. The Client ID is public by
> design (it appears in the authorize URL).

✅ **Check:** the app card shows `Type: Confidential`, your exact Redirect URI, and
`host:read:network_members` under Scopes.

---

### Step 6: Store the Mighty credentials in Script Properties

About 5 minutes.

**6a.** In Apps Script, click **Project Settings** (gear icon, left rail) and scroll to
**Script Properties**. Click **Add script property** (on later visits the button reads
**Edit script properties**).

**6b.** Add three rows. Copy the values straight from the OAuth app card with its copy
icons or **Reveal**:

| Property | Value |
|---|---|
| `MN_CLIENT_ID` | The app's **Client ID** |
| `MN_CLIENT_SECRET` | The app's **Client Secret** (Reveal → copy) |
| `MN_SCOPES` | `host:read:network_members read:userinfo` |

**6c.** Click **Save script properties**.

**6d. Verify.** Go back to the editor (the `< >` icon), select **`checkCreds`** and
click **Run**. It prints lengths, never the values:

```
MN_CLIENT_ID length: 43 (expect 43)
MN_CLIENT_SECRET length: 43 (expect 43)
id starts/ends: AbCd…WxYz
secret starts/ends: EfGh…StUv
OAUTH_HOST: https://your-community.mn.co
REDIRECT_URI: https://your-community.mn.co/
```

(The start/end characters shown here are made up. Yours will differ.)

| You got | Cause | Fix |
|---|---|---|
| `length: 0` for both, even though the values appear in Project Settings | The properties didn't persist. In production they were visible in the UI but read back as `0`. | Use the fallback in 6e, then run `checkCreds` again. |
| A length other than 43 | Truncated on paste. The input field cuts off the display, so you can't see it by eye. | Copy again from **Reveal** and paste into the property. |
| `An unknown error has occurred, please try again later.` when running a function | A transient Apps Script error. It happened once in the build. | Click **Run** again. The retry worked. |

**6e. Fallback: set them in code.** `MN_Member_Sync.gs` includes `setScriptProps()`.
Temporarily replace `PASTE_CLIENT_ID` and `PASTE_CLIENT_SECRET` with your real values,
save, run **`setScriptProps`** (log: `Stored. Now clear the literals above so secrets
aren't left in source.`), run **`checkCreds`** to confirm 43/43, then **put the
placeholders back and save**. The stored properties stay after you blank the code.

> ⚠️ **Script Properties are readable by anyone with edit access to the Apps Script
> project** (not by people who can only view the sheet). If colleagues can edit the
> script, they can read the tokens. Don't store the values in sheet cells, a hardcoded
> source file, or an outside database (an outside store would need its own credentials
> in this project anyway).

The script writes the other Mighty properties itself. Don't add them by hand:

| Property | Written by | Holds |
|---|---|---|
| `MN_OAUTH_STATE` | `logAuthorizeUrl()` | The random `state` value used in the authorize link |
| `MN_REFRESH_TOKEN` | `exchangeCode()`, updated by `getAccessToken()` whenever Mighty issues a new one | The long-lived refresh token |
| `MN_AUTH_BASIC` | `exchangeCode()` | `"1"` if the token endpoint accepted only HTTP Basic client auth |

✅ **Check:** `checkCreds` prints `43 (expect 43)` twice.

---

### Step 7: Authorize the script with Mighty

About 10 minutes. Authorization codes are **single-use and expire in about 10 minutes**,
so do 7b to 7e in one go.

**7a. Build the authorize link.** Run **`logAuthorizeUrl`**. The log prints:

```
Open this while signed in as a HOST, approve, then copy the ?code= param:
https://your-community.mn.co/oauth/authorize?client_id=...&redirect_uri=https%3A%2F%2Fyour-community.mn.co%2F&response_type=code&scope=host%3Aread%3Anetwork_members%20read%3Auserinfo&state=...
```

**7b. Open it while signed in as a Host.** Copy the whole URL into the browser where
you're signed in to the community as a **Host** (not a member account). With
**Skip consent screen** on, it redirects straight back to something like:

```
https://your-community.mn.co/?code=AbC123...&state=9f2c...
```

**7c. Copy only the code.** That's everything after `code=` and before `&state`. Don't
include `&state=...`.

**7d. Add a temporary wrapper** at the bottom of `MN_Member_Sync.gs`. It's needed
because the Run dropdown can't pass an argument:

```javascript
function doExchange() { exchangeCode("PASTE_CODE_HERE"); }
```

Paste the code between the quotes, **save**, select **`doExchange`** in the dropdown and
click **Run**.

**7e. Approve Google's permission prompt (first run only).** Apps Script asks you to
authorize the project. The wording may differ: **Review permissions** → choose your
Google account → *"Google hasn't verified this app"* → **Advanced** →
**Go to <project name> (unsafe)** → **Allow**. This is normal for your own unverified
script. It's giving your script permission to call external URLs, edit your
spreadsheet and manage its triggers. The prompt takes time, so if the code has expired
by then, get a fresh one (7a-7c) and run `doExchange` again.

Success in the Execution log:

```
Refresh token stored. Run testAuth() next.
```

If the endpoint wanted HTTP Basic client authentication, you'll first see
`Body-param auth rejected; retrying with HTTP Basic…`, followed by the success line. The
script remembers that in `MN_AUTH_BASIC` for later refreshes.

**7f. Test the token.** Run **`testAuth`**. Success:

```
Auth OK. Sample member: {
  "resourceId": "1234567",
  "firstName": "Jane",
  "lastName": "Example",
  "email": "jane@example.com",
  "lastActiveAt": "2026-08-10T14:02:11Z"
}
```

**7g. Clean up.** Delete the `doExchange` function (it holds a used code) and save. The
refresh token stays in Script Properties.

Errors hit during the build, and the others the code checks for:

| You got | Cause | Fix |
|---|---|---|
| Redirect to `.../events?error=invalid_request&error_description=Missing+required+parameter%3A+state.` | Mighty **requires** the `state` parameter, even though OAuth 2.0 only recommends it. This happened with a hand-built link that had no `state`. | Always use the link from `logAuthorizeUrl()`. It adds `state`. |
| `Error: Token exchange failed: HTTP 401 {"error":"invalid_client","error_description":"Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method."}` | In production the credentials were **blank** (`checkCreds` showed length 0). It can also mean a truncated secret or the wrong client-auth method. | Run `checkCreds`. Fix the properties (Step 6). The code already retries with HTTP Basic on a 401. Get a fresh code and run again. |
| `MN_CLIENT_ID / MN_CLIENT_SECRET missing from Script Properties.` | The current code checks for blank properties before calling Mighty. | Step 6. |
| `Token exchange failed: HTTP 400 ... invalid_grant` | The code was already used, has expired, or `REDIRECT_URI` doesn't match the app. | Get a fresh code (7a-7c). Compare `REDIRECT_URI` with the app's Redirect URI character for character. |
| `404` on `/oauth/authorize` | `OAUTH_HOST` isn't where the OAuth endpoints live. | Switch `OAUTH_HOST` between your custom domain and `https://<subdomain>.mn.co`, save, and run `logAuthorizeUrl` again. |
| `invalid_scope` | `MN_SCOPES` asks for a scope the app doesn't have. | Tick `host:read:network_members` and `read:userinfo` on the app, or make `MN_SCOPES` match the app's scopes exactly. |
| `No refresh_token returned — unattended sync impossible. Body: ...` | The token response had no refresh token. The script stops on purpose, because it can't run unattended without one. | Check the app is a **Confidential client** and try again. |
| `GraphQL HTTP 403: ...`, or an empty roster in `testAuth` | Authorized as a member, not a Host, or the host scope wasn't granted. | Sign in as a Host, confirm the scope, and repeat 7a-7f. |

> ⚠️ **The code, the access token and the refresh token are all credentials.** Don't
> paste `exchangeCode` output into chat. When asking for help, share only the HTTP
> status and error message.

✅ **Check:** `testAuth` logs `Auth OK. Sample member:` with a recent `lastActiveAt`.

---

### Step 8: Run the first roster pull

About 5 minutes.

**8a.** Select **`refreshRoster`** and click **Run**. It fetches every page first, then
writes the tab in one go, so the sheet stays empty until the end. In production a
roster of several thousand members took about 2 minutes (about one page of 50 per
second, with a 150 ms pause between pages).

Success:

```
Excluded 4 staff/test accounts via EXCLUDE_EMAIL_RE.
Wrote 5000 members to 'MN Live'. 5000 have lastActiveAt, 4600 have email.
```

(These counts are examples. Yours will differ.)

**8b.** Open the sheet. A new **`MN Live`** tab has a bold, frozen header row:
**Member ID | First Name | Last Name | Email Address | Last Visted Network**. (The typo
"Visted" is in the code. It was kept so the column matches an older sheet.) Member IDs
are right-aligned numbers, and column E shows dates like `Aug 10 2026`.

**8c.** Scroll to the bottom and compare the row count with the `Wrote N members` line.

| You got | Cause | Fix |
|---|---|---|
| Sheet still blank while the log shows *Execution started* and a spinner | It's still running. Nothing is written until the last page arrives. | Wait. Look for the new `MN Live` tab, not the default tab. |
| `WARNING: every lastActiveAt is null — the OAuth user is probably NOT a Host/Moderator.` | The token was granted by a non-Host account. | Repeat Step 7 while signed in as a Host. |
| `ABORT: API returned 0 members — leaving existing tab intact.` | Empty response. The script leaves the old data in place rather than clearing it. | Check the scope and Host sign-in (Step 7). |
| `WARNING: hit MAX_PAGES (400) — roster truncated at 20000. Raise MAX_PAGES.` | Roster larger than the safety stop. | Raise `MAX_PAGES` (and see Limits: the 6-minute run cap). |
| `Exceeded maximum execution time` | Apps Script stops a run at 6 minutes. | Not seen in the build. The pull isn't resumable yet, so a very large roster needs a code change. |
| `Another run holds the lock; skipping.` | Another `refreshRoster` is still running. | Wait for it to finish. |
| `Refresh failed: HTTP 4xx ... redo logAuthorizeUrl() + exchangeCode().` | The refresh token was revoked or expired. | Repeat Step 7. |
| Many blank emails | Mighty returns an email only when the plan allows it **and** the member has consented. A sort by Email makes the blanks look like one big block. | Expected. Matching uses member ID, not email. |

> ⚠️ **Sorting or filtering `MN Live` by hand is harmless.** `refreshRoster` clears and
> rewrites the tab on every run.

✅ **Check:** `MN Live` exists, the row count matches the log, Mighty's staff/test
accounts are absent, and today's date appears for recently active members.

---

### Step 9: Create the two HubSpot contact properties

About 5 minutes. Skip any property that already exists, but check its internal name and
field type.

**9a.** In HubSpot, click the **Settings** gear (top nav) → **Properties** (under
**Data Management**, wording may differ). Make sure the object is **Contact**, then click
**Create property**.

**9b. `mn_member_id`:**
1. **Property label \***: `MN Member ID`. HubSpot shows **Internal name**:
   `mn_member_id`. It must match `HS_ID_PROPERTY` exactly.
2. **Object type \***: **Contact**. **Group \***: e.g. **Contact information**.
3. **Field type**: **Number**.
4. **Rules**: under **Validation options** you'll see
   **Require unique values for this property (0 of 10)**. The script doesn't need it.
   You can tick it only now, at creation. Hovering later shows *"Properties can only be
   made unique during property creation."*
5. **Create**.

**9c. `mn_last_visited_network`:**
1. **Property label \***: `MN Last Visited Network` → **Internal name**:
   `mn_last_visited_network`. It must match `HS_DATE_PROPERTY`.
2. **Field type**: **Date picker** (wording may differ). It must be a **date** type.
   The script sends a bare `YYYY-MM-DD` at UTC midnight.
3. **Create**.

> ⚠️ **Watch for duplicate ID properties.** The build portal had two: `mn_member_id`
> (number) and an older `mighty_network_member_id` (text). Before you delete either,
> open a contact you know is in both systems and see which one is filled. The script
> uses `mn_member_id`. If that property is empty, every member lands in `MN Unmatched`.
> HubSpot can restore a deleted property for a while (**Properties → Restore deleted**,
> wording may differ).

✅ **Check:** both internal names appear exactly as `mn_member_id` (Number) and
`mn_last_visited_network` (Date).

---

### Step 10: Create a HubSpot key and store it as `HS_TOKEN`

About 5 minutes.

**10a.** In HubSpot, open **Development** in the left nav. **Development → Private Apps**
now shows *"Your private apps have moved"* with a **Go to Legacy Apps** button, and
**Legacy Apps** has **Create legacy app** (top right).

**10b.** Click **Create legacy app**. The **Create Legacy App** dialog asks *"What kind
of legacy app do you want to create?"* Pick **Private** (*"For one account"*), not
**Public** (*"For many accounts"*, an OAuth app for many portals).

**10c.** The next screen, **Before you continue**, recommends **Service Keys**:
*"Service Keys are the better path"*. Click **Use Service Keys instead**. That's what the
build used. (The other option is to tick *"I understand that legacy private apps have
limited functionality…"* and click **Continue with legacy private app**. That token
works the same way.)

**10d. Create the key** with exactly these two scopes (the key-creation screen wasn't
captured, so labels may differ):
- `crm.objects.contacts.read`: the search that finds record IDs by `mn_member_id` and by email
- `crm.objects.contacts.write`: the batch update and batch create

Copy the key.

**10e. Store it.** Either add it in **Project Settings → Script Properties** as
`HS_TOKEN` and click **Save script properties**, or, since the UI once failed to save,
set it with a temporary function and check the length:

```javascript
function setHsToken() {
  PropertiesService.getScriptProperties().setProperty("HS_TOKEN", "PASTE_KEY_HERE");
  Logger.log("HS_TOKEN length: " + PropertiesService.getScriptProperties().getProperty("HS_TOKEN").length);
}
```

Run **`setHsToken`**. Success is `HS_TOKEN length: <a non-zero number>`.
Then **delete `setHsToken`** and save.

> ⚠️ **Both scopes are needed.** Without `read`, the first search fails with
> `Token missing crm.objects.contacts.read scope.` before anything is written.

✅ **Check:** the log shows a non-zero `HS_TOKEN length`.

---

### Step 11: Test one contact

About 3 minutes.

**11a.** Pick a member ID from column A of your **`MN Live`** tab. Choose someone you
know has a HubSpot contact with **MN Member ID** filled in.

**11b.** Add a temporary wrapper at the bottom of `HubSpot_Push.gs`. The Run dropdown
can't pass the argument, and `doTestOne` won't appear in the dropdown until you add it
and save:

```javascript
function doTestOne() { testHubSpotOne(1234567); }  // a member id from your MN Live tab
```

Save, select **`doTestOne`**, click **Run**. Success:

```
Resolved 1234567 -> HubSpot record 12345678901
HTTP 200
{"completedAt":"...","status":"COMPLETE","startedAt":"...","results":[{"id":"12345678901","properties":{...
```

**11c.** Delete `doTestOne` and save.

| You got | Cause | Fix |
|---|---|---|
| `No HubSpot contact with mn_member_id = 1234567` | No contact has that value in `mn_member_id`, or the property you're using is empty. | Pick another ID. Check Step 9's ⚠️ about duplicate ID properties. |
| `Token missing crm.objects.contacts.read scope.` (thrown) or `Search failed HTTP 401/403` | Wrong or missing key or scope. | Step 10. |
| `No HS_TOKEN in Script Properties.` | `HS_TOKEN` isn't saved. | Step 10e. |
| No HubSpot functions in the Run dropdown | `HubSpot_Push.gs` is empty or unsaved. | Paste the file again and save (Step 3d). |

> ⚠️ **`testHubSpotOne` writes a fixed test date, `2026-08-04`, to that contact.** It
> doesn't record anything in `_hs_state`, so if you run it **before** the first full
> push (Step 12), the push overwrites it with the real date. If you run it later, the
> contact keeps `2026-08-04` until that member's date changes. Check the contact
> afterwards.

✅ **Check:** the log shows `Resolved ... -> HubSpot record ...` and `HTTP 200` with
`"status":"COMPLETE"`, and the contact's **MN Last Visited Network** shows a value.

---

### Step 12: Run the full push

About 5 minutes.

**12a.** Run **`pushLastVisitedToHubSpot`**. The first run treats every member as
changed. In production the whole run took about 2½ minutes: about a minute of search
calls, then the batch updates.

Success looks like this (the counts are examples):

```
5000 contacts with a changed last-visited date.
WARNING: 2 duplicate contacts share an mn_member_id — first match wins. Worth deduping.
HubSpot push: 4990 updated, 0 failed, 10 MN members have no HubSpot contact (see 'MN Unmatched').
```

The `WARNING` line appears only if two contacts share an ID.

**12b.** Check the new **`MN Unmatched`** tab (**Member ID | First Name | Last Name |
Email | Last Visited**). These are members that no HubSpot contact has in
`mn_member_id`. Step 13 resolves them.

**12c.** The hidden **`_hs_state`** tab now holds `mn_member_id | last_pushed` for every
date that was applied. Don't edit it. If you delete it, the next run pushes everyone
again.

| You got | Cause | Fix |
|---|---|---|
| `Tab not found: MN Live — run refreshRoster() first.` | No roster yet. | Step 8. |
| `Nothing changed since last push.` | No dates changed since the last push. | Normal on a re-run. |
| `Update batch HTTP 4xx: ...` / `Partial: ...` | HubSpot rejected some records. Only the records that applied are saved to `_hs_state`, so the rest retry next run. | Read the message. For `INVALID_DATE`, check the property is a date type (Step 9c). |
| `Search failed HTTP 5xx/429` | Rate limit or HubSpot outage. `hsFetch` retries 4 times. | Run again later. Members whose search failed land in `MN Unmatched` for that run only. |
| `Exceeded maximum execution time` | The first push on a very large roster. State saves only at the end, so a timeout starts over. | Not seen in the build. See Limits. |

> ⚠️ **Merge contacts that share an `mn_member_id`.** Only the first match gets the
> date. The other copy never updates.

✅ **Check:** `0 failed`, and a few contacts you spot-check in HubSpot show **MN Last
Visited Network** equal to column E of `MN Live`.

---

### Step 13: Resolve `MN Unmatched` (link by email, create only the rest)

About 10 minutes.

A member lands in `MN Unmatched` when **no contact carries their `mn_member_id`**, which
doesn't mean they're missing from HubSpot. In production, all but one of them were
already in HubSpot under their email, with the ID field blank.

**13a. Preview (writes nothing).** Run **`previewUnmatched`**:

```
Unmatched: 12 total — 11 already in HubSpot by email (will backfill mn_member_id), 1 genuinely new.
NOTE: 1 of the new ones have no email — unverifiable as duplicates.
DRY RUN — nothing written. Re-run as linkOrCreateUnmatched(false) to apply.
  would CREATE 1234567 Jane Example <no email>
```

**13b. Check every "would CREATE" line that shows `<no email>` by hand.** Search HubSpot
for that name. In production the one no-email member **did** exist in HubSpot with an
email. Mighty simply didn't return it, because that member hadn't consented to share it.
If you find the contact:
1. Open the contact and set **MN Member ID** to that member's ID. Leave **MN Last
   Visited Network** blank, since the sync fills it.
2. Run **`pushLastVisitedToHubSpot`**. It rewrites `MN Unmatched`, so that member now
   matches and drops off the list.

> ⚠️ **Order matters.** If you run `applyUnmatched` while a no-email member who already
> exists in HubSpot is still on the list, it **creates a duplicate** contact.

**13c. Apply.** Run **`applyUnmatched`**. Success:

```
Unmatched: 11 total — 11 already in HubSpot by email (will backfill mn_member_id), 0 genuinely new.
Linked 11, created 0, failed 0. Re-run pushLastVisitedToHubSpot() to confirm 0 unmatched.
```

**13d.** Run **`pushLastVisitedToHubSpot`** again. It should end with
`0 MN members have no HubSpot contact.`

| You got | Cause | Fix |
|---|---|---|
| `Link batch HTTP 400: {"status":"error","message":"Property values were not valid: [{\"isValid\":false,\"message\":\"1786334400000 is at 4:0:0.0 UTC, not midnight!\",\"error\":\"INVALID_DATE\",\"name\":\"mn_last_visited_network\"}, ...` followed by `Linked 0, created 0, failed 11.` | Hit in the build. Google Sheets turned the `2026-08-10` text into a local-midnight date, which is 04:00 UTC on Eastern time. The shipped code fixes this two ways: `writeUnmatched` sets the column to plain text, and `hsYmd()` normalizes the value. | Make sure you pasted the current `HubSpot_Push.gs`. Nothing is written on a failed batch, so just run it again. |
| `Nothing in MN Unmatched.` | Nothing to do. | Normal. |
| `Email search HTTP ...` | A search failed. Those rows are treated as new. | Run `previewUnmatched` again before you apply. |
| `Create batch HTTP 409 ...` (not seen in the build) | Probably an email conflict with an existing contact. | Find the contact by email and set its **MN Member ID** by hand. |

> ⚠️ **Creating contacts can't be undone in bulk** and can change your HubSpot contact
> tier. That's why creation is a manual step, never part of the daily run.

✅ **Check:** the second push reports `0 MN members have no HubSpot contact`.

---

### Step 14 (optional): Retire an older hourly sync in the same project

About 5 minutes. **Skip this step** unless this Apps Script project already runs an
older push, such as an hourly webhook sync whose handler is `syncBatch` and which keeps
its dedupe state in Script Properties named `cursor` and `hashes`.

**14a.** Run **`listTriggers`** to see what's scheduled. Example:

```
syncBatch  [CLOCK]
1 trigger(s) total.
```

**14b. Fix the old installer first.** If the old script's installer does this:

```javascript
ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
```

it deletes **every** trigger in the project, including the `dailySync` you'll add in
Step 15. Change it so it removes only its own trigger:

```javascript
ScriptApp.getProjectTriggers()
  .filter(t => t.getHandlerFunction() === "syncBatch")
  .forEach(t => ScriptApp.deleteTrigger(t));
```

Also don't run any old "full re-sync" function out of habit. It restarts the old push
right away.

**14c.** Run **`decommissionGhlPush`**. It removes only `syncBatch` triggers and deletes
the `cursor` and `hashes` properties. It leaves the old code alone, so you can restore
it. Success:

```
Removed 1 syncBatch trigger(s).
Cleared cursor and hashes (123456 chars reclaimed).
syncBatch() and Sheet1 left intact — re-run setupTrigger() to restore.
No triggers installed.
```

The last line comes from the `listTriggers()` call at the end.

> ⚠️ **Only run this if those names are really your old sync's.** It deletes Script
> Properties named exactly `cursor` and `hashes` and triggers whose handler is exactly
> `syncBatch`. Also turn off whatever automation received the old webhook.

✅ **Check:** `listTriggers` shows no `syncBatch` trigger.

---

### Step 15: Install the daily trigger

About 3 minutes.

**15a.** Run **`installDailySyncTrigger`**. It first deletes any existing `refreshRoster`
or `dailySync` trigger, so it's safe to run again. Then it schedules **`dailySync`**,
which runs `refreshRoster()` and then `pushLastVisitedToHubSpot()` every day in the
4 am hour of the project's time zone.

```
Daily 4am dailySync installed (roster pull + HubSpot push).
```

> ⚠️ **Use `installDailySyncTrigger`, not `installDailyTrigger`.** Both are in the code.
> `installDailyTrigger` (in `MN_Member_Sync.gs`) schedules only `refreshRoster`, so
> HubSpot would never update. `installDailySyncTrigger` removes that trigger if it
> exists.

**15b.** Run **`listTriggers`**. You want exactly:

```
dailySync  [CLOCK]
1 trigger(s) total.
```

(`listTriggers` can show only the function and event type. Apps Script's trigger API
can't read back the scheduled hour.)

**15c. Turn on failure emails.** Click **Triggers** (clock icon, left rail). The page
lists each trigger's function, event source, schedule, last run and error rate. On the
`dailySync` row, open its **⋮** menu or edit it (wording may differ) and set failure
notifications to **Notify me immediately**. The default is a daily digest.

> ⚠️ **If the refresh token dies, the job fails and nothing else tells you.**
> `getAccessToken` throws `Refresh failed: ...`, `dailySync` stops, and HubSpot dates
> just stop changing. The immediate email is how you find out.

✅ **Check:** the **Triggers** page shows one time-driven `dailySync` trigger.

---

### Step 16: Watch the first unattended runs

About 5 minutes, the next morning.

**16a.** Click **Executions** (the list icon in the left rail, just above **Triggers**,
wording may differ). Find the `dailySync` run from around 4 am. Its status should be
**Completed**.

**16b.** Click it to see the log. You should see the `refreshRoster` lines (Step 8)
followed by the push summary. From the second day on, the changed count should be much
smaller than the roster, because only members whose date changed are pushed:

```
320 contacts with a changed last-visited date.
HubSpot push: 320 updated, 0 failed, 0 MN members have no HubSpot contact.
```

**16c.** Delete every temporary helper you added (`doExchange`, `setHsToken`,
`doTestOne`, and any credential literals in `setScriptProps`) and save. They hold
secrets, used codes or test IDs. Your stored properties aren't affected.

**16d.** Check `MN Unmatched` now and then. New members who hide their email and have no
HubSpot ID will show up there and need a one-time manual ID (Step 13b).

✅ **Check:** a `dailySync` execution with status **Completed** each morning, and the
push line ends with `0 failed`.

---

### Step 17 (optional): React to the date in HubSpot

About 10 minutes.

A HubSpot workflow shouldn't try to fetch the data. Use one to act on it:

- **Trigger:** **MN Last Visited Network** *is more than* `60` *days ago* (wording may
  differ). HubSpot re-evaluates date conditions daily on its own.
- **Actions:** for example, set a "Dormant" property, enroll the contact in a
  re-engagement email, or notify the owner.
- **Review and turn on.**

Don't use a workflow custom-code action to call Mighty. It would run once per contact,
it needs Operations Hub Professional, and a workflow secret can't store a rotated
refresh token.

✅ **Check:** a test contact whose date is more than 60 days old enrolls.

---

## 3. Troubleshooting

| Symptom | Cause | Step that fixes it |
|---|---|---|
| No **OAuth Applications** or **Headless API** under **Admin → Integrations** | Your network doesn't have Headless API access. The Admin API has no last-active field. | [Step 1](#step-1-confirm-your-network-has-headless-api-access): ask Mighty for access |
| Run dropdown doesn't list `refreshRoster`, `pushLastVisitedToHubSpot` or other functions | The file wasn't saved, or it was pasted into another project | [Step 3](#step-3-create-the-apps-script-project-and-paste-both-files) |
| `ReferenceError: getSpreadsheet is not defined` / `TARGET_TAB is not defined` | `HubSpot_Push.gs` is in a different project from `MN_Member_Sync.gs` | [Step 3](#step-3-create-the-apps-script-project-and-paste-both-files): put both files in one project |
| `Exception: Unexpected error while getting the method or property openById` or similar (wording may differ) | `SPREADSHEET_ID` is still the placeholder or is wrong | [Step 4](#step-4-fill-in-the-four-config-values) |
| Dates in `MN Live` or HubSpot are one day off | Script time zone and sheet time zone differ, or a date was converted through local time | [Step 3](#step-3-create-the-apps-script-project-and-paste-both-files) (3g) |
| `checkCreds` shows `length: 0 (expect 43)` although the values appear in Project Settings | Script Properties didn't persist | [Step 6](#step-6-store-the-mighty-credentials-in-script-properties) (6e fallback) |
| `checkCreds` shows a length other than 43 | Secret was truncated on paste | [Step 6](#step-6-store-the-mighty-credentials-in-script-properties) |
| `An unknown error has occurred, please try again later.` | Transient Apps Script error | Run it again. See [Step 6](#step-6-store-the-mighty-credentials-in-script-properties) |
| Browser lands on `...?error=invalid_request&error_description=Missing+required+parameter%3A+state.` | Hand-built authorize link without `state` | [Step 7](#step-7-authorize-the-script-with-mighty): use `logAuthorizeUrl()` |
| `Token exchange failed: HTTP 401 {"error":"invalid_client",...}` | Blank or truncated client credentials, or the wrong client-auth method | [Step 6](#step-6-store-the-mighty-credentials-in-script-properties), then [Step 7](#step-7-authorize-the-script-with-mighty) with a fresh code |
| `MN_CLIENT_ID / MN_CLIENT_SECRET missing from Script Properties.` | Properties are blank | [Step 6](#step-6-store-the-mighty-credentials-in-script-properties) |
| `invalid_grant` | Code used twice or expired (~10 min), or `REDIRECT_URI` doesn't match the app | [Step 4](#step-4-fill-in-the-four-config-values) and [Step 5](#step-5-create-the-mighty-oauth-application): match exactly, then [Step 7](#step-7-authorize-the-script-with-mighty) |
| `404` at `/oauth/authorize` | `OAUTH_HOST` is on the wrong host | [Step 4](#step-4-fill-in-the-four-config-values): try the custom domain or the `.mn.co` subdomain |
| `invalid_scope` | `MN_SCOPES` asks for a scope the app doesn't have | [Step 5](#step-5-create-the-mighty-oauth-application) / [Step 6](#step-6-store-the-mighty-credentials-in-script-properties) |
| `No refresh_token returned — unattended sync impossible.` | No refresh token issued | [Step 5](#step-5-create-the-mighty-oauth-application): keep **Confidential client** ticked, then [Step 7](#step-7-authorize-the-script-with-mighty) |
| `No MN_REFRESH_TOKEN — complete steps 1-3 first.` | Authorization never completed | [Step 7](#step-7-authorize-the-script-with-mighty) |
| `Refresh failed: HTTP 4xx ... redo logAuthorizeUrl() + exchangeCode().` | Refresh token revoked or expired | [Step 7](#step-7-authorize-the-script-with-mighty) |
| `GraphQL HTTP 403` or an empty roster | Authorized as a member, or scope missing | [Step 5](#step-5-create-the-mighty-oauth-application), [Step 7](#step-7-authorize-the-script-with-mighty) |
| `WARNING: every lastActiveAt is null — the OAuth user is probably NOT a Host/Moderator.` | Token belongs to a non-Host | [Step 7](#step-7-authorize-the-script-with-mighty) as a Host |
| `ABORT: API returned 0 members — leaving existing tab intact.` | Empty API response | [Step 7](#step-7-authorize-the-script-with-mighty) |
| Sheet blank while `refreshRoster` runs | Still running. The script writes only at the end, into a new `MN Live` tab | [Step 8](#step-8-run-the-first-roster-pull) |
| `WARNING: hit MAX_PAGES (400) — roster truncated at ...` | Roster larger than 20,000 | [Step 4](#step-4-fill-in-the-four-config-values): raise `MAX_PAGES` (watch the 6-minute limit) |
| Mighty test/staff accounts (`@mightynetworks.com`, `@tfbnw.net`) in the roster | `EXCLUDE_EMAIL_RE` set to `null` | [Step 4](#step-4-fill-in-the-four-config-values) |
| Many empty emails in `MN Live` | Mighty shares an email only when the plan allows it and the member consents | Expected. Matching uses member ID. See [Step 8](#step-8-run-the-first-roster-pull) |
| `No HubSpot contact with mn_member_id = ...` | Wrong ID, or the ID property is empty or a different one | [Step 9](#step-9-create-the-two-hubspot-contact-properties), [Step 11](#step-11-test-one-contact) |
| `No HS_TOKEN in Script Properties.` | Key not stored | [Step 10](#step-10-create-a-hubspot-key-and-store-it-as-hs_token) |
| `Token missing crm.objects.contacts.read scope.` / `Search failed HTTP 401` or `403` | Key missing a scope, or wrong key | [Step 10](#step-10-create-a-hubspot-key-and-store-it-as-hs_token) |
| **Private Apps** page says *"Your private apps have moved"* | HubSpot moved private apps to **Legacy Apps** and now recommends Service Keys | [Step 10](#step-10-create-a-hubspot-key-and-store-it-as-hs_token) |
| No `doTestOne` in the dropdown | The wrapper must be added by hand | [Step 11](#step-11-test-one-contact) |
| A contact shows `2026-08-04` as last visited | `testHubSpotOne` wrote its fixed test date | [Step 11](#step-11-test-one-contact) ⚠️ |
| `Tab not found: MN Live — run refreshRoster() first.` | No roster yet | [Step 8](#step-8-run-the-first-roster-pull) |
| `WARNING: N duplicate contacts share an mn_member_id — first match wins.` | Two contacts carry one member ID | [Step 12](#step-12-run-the-full-push): merge them in HubSpot |
| `INVALID_DATE ... is at 4:0:0.0 UTC, not midnight!` | A date reached HubSpot as local midnight instead of UTC midnight | [Step 13](#step-13-resolve-mn-unmatched-link-by-email-create-only-the-rest): use the current `HubSpot_Push.gs`. For the main push, check that [Step 9](#step-9-create-the-two-hubspot-contact-properties) made a date property |
| A duplicate contact was created for a member with no email | `applyUnmatched` ran before a manual ID fix | [Step 13](#step-13-resolve-mn-unmatched-link-by-email-create-only-the-rest) (13b order) |
| `MN Unmatched` never empties | Members hide their email and have no ID in HubSpot | [Step 13](#step-13-resolve-mn-unmatched-link-by-email-create-only-the-rest): set **MN Member ID** by hand |
| The daily sync stopped with no error and HubSpot dates are stale | An older installer deleted every project trigger, or the refresh token died | [Step 14](#step-14-optional-retire-an-older-hourly-sync-in-the-same-project), [Step 15](#step-15-install-the-daily-trigger) |
| `listTriggers` shows `refreshRoster` but not `dailySync` | `installDailyTrigger` was used | [Step 15](#step-15-install-the-daily-trigger): run `installDailySyncTrigger` |
| No `dailySync` run under **Executions** in the morning | Trigger not installed, or it failed | [Step 15](#step-15-install-the-daily-trigger), [Step 16](#step-16-watch-the-first-unattended-runs) |
| `Exceeded maximum execution time` | Apps Script's 6-minute cap (not seen in the build) | See Limits. The code needs checkpointing for very large rosters |

---

## 4. Limits

- **Apps Script stops any run after 6 minutes.** There's no checkpointing. The roster
  pull takes about a second per 50 members, and the first push (every contact) takes
  longest. That's comfortable up to roughly 10,000 members. Above that, split the pull
  and the push onto separate triggers, or add paging state. `MAX_PAGES` (400, so 20,000
  members) is a runaway guard, and the 6-minute limit comes first.
- **A HubSpot search error other than 401/403 isn't retried.** The members in that
  batch are reported as unmatched for that run. Before you run `applyUnmatched()`,
  re-run the push. If the same members show up again, they really are unmatched.
- **`applyUnmatched()` counts a whole batch as done on a partial (207) reply.** Re-run
  the push afterwards. Anything that failed shows up in `MN Unmatched` again.
- **`exchangeCode()` doesn't compare the returned `state`** with the one it stored.
  The authorize step is one you do yourself, once, in your own browser, so the risk is
  small. Still, check that the `state` in the redirect matches the one in the log.
- **Dates are calendar days in UTC.** There's no time of day. A member who visits at
  11pm Eastern shows the next day's date, which matches what Mighty's own reports show.
- **The script and the Sheet should use the same time zone** (Step 3). The date logic
  is tested with the script in US Eastern. A Sheet in a different time zone hasn't
  been tested.
- **The email column depends on consent.** Mighty returns a member's email to a Host
  only if the plan includes email visibility and the member agreed to share it.
  Matching uses `mn_member_id`, so a missing email only matters for linking in Step 13.
- **One community per project.** For a second community, make a copy of the project
  and the Sheet.

## 5. Testing

The two `.gs` files run unchanged in Node against fake Apps Script, Mighty and HubSpot
services. Nothing leaves your machine.

```bash
npm test
```

The tests run in US Eastern on purpose. That's where converting a UTC timestamp to local
time moves it to the previous day. They cover:

- the authorize URL
- the HTTP Basic fallback for the token exchange
- refresh-token rotation
- paging past 50 members
- filtering out staff accounts
- UTC date pinning
- an empty roster leaving the tab alone
- change-only pushes
- a failed row in a 207 reply being retried the next day
- duplicate member IDs
- a 401 stopping the run
- the preview/apply link-or-create flow
- the single 4am trigger
- retiring an older sync

## 6. Security

- **Keep the Mighty client secret, the refresh token and the HubSpot key out of the
  code.** They go in **Project Settings → Script Properties** (Steps 6 and 10). If you
  use `setScriptProps()` or a temporary helper, delete the values as soon as they've
  run (Step 16). Apps Script keeps version history.
- **Scopes:** Mighty `host:read:network_members read:userinfo`, read only. HubSpot
  `crm.objects.contacts.read` and `crm.objects.contacts.write`, nothing else.
- **The Sheet holds names and emails.** Share it only with people who can see that
  data in Mighty already.
- **Don't paste secrets into chats or tickets.** If a client secret or refresh token
  ends up somewhere it shouldn't, rotate it in Mighty and redo Steps 6 and 7.
- `checkCreds()` prints lengths and the first and last four characters only, never the
  full values.

---

Built by [Jibril Sulaiman](https://github.com/jbrillionaire).
