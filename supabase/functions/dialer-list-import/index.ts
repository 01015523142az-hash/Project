// supabase/functions/dialer-list-import/index.ts
//
// Receiving end of the ReadyMode scrub round-trip.
//
// FLOW (Option A -- ReadyMode stays the DNC authority):
//   1. Portal pushes leads into a ReadyMode Channel via readymode-api's
//      post_leads_batch. Already built.
//   2. ReadyMode scrubs DNC and appends its own verdict columns.
//   3. A ReadyMode Automated Task emails the scrubbed export to Mailgun.
//   4. Mailgun POSTs the whole message here. This function parses the CSV,
//      honours ReadyMode's scrub verdict, and creates a dialable
//      dialer_lists + dialer_contacts set.
//
// A SEPARATE FUNCTION from readymode-email-import on purpose: that one owns
// reporting imports (call logs, agent report) into readymode_* tables. This
// owns dialer lists. They share the Mailgun pattern but nothing else, and
// keeping them apart means neither has to be redeployed to change the other.
// Give this its own Mailgun route/recipient address.
//
// READYMODE'S APPENDED COLUMNS are the fixed contract; the lead columns vary
// by source (DealMachine and others), so they are matched loosely and the
// whole original row is kept in dialer_contacts.source_row.
//   status         e.g. "Lead Accepted"
//   DNC            "Yes" / "No"      <- authoritative scrub verdict
//   Dupe           "Yes" / "No"      <- already in ReadyMode
//   Dupe in file   "Yes" / "No"
//   RMS Result
//   RND Result     Reassigned Numbers Database; "N/A" = not run
//   Accepted       "Yes" / "No"
//
// ON THE DNC COLUMN: the standing rule "don't filter on an uploaded file's
// own DNC column" is about DealMachine exports, whose flag is stale. This is
// the opposite case -- ReadyMode's column IS their scrub result, and it is
// the whole reason the list made the round trip. It is both filtered on AND
// stored, because "we didn't dial this because ReadyMode marked it DNC" is
// the evidence a compliance review asks for.
//
// TIMEZONE IS RESOLVED HERE, FOR NOTHING. dialer-call-control's calling-hours
// gate needs the zone of the NUMBER, not of any address in the file -- an
// Illinois property routinely has an owner with a Florida mobile, and the
// rule follows the number. That zone is carried in the area code: US
// portability is confined to the same rate centre, so a ported number keeps
// its area code and its state. This used to be left null and filled in later
// by Telnyx Number Lookup at $0.0015 a number, which meant an imported list
// sat undialable until somebody paid for it. Now a list is dialable the
// moment it lands, and the paid lookup is what you reach for when an area
// code is not in the table.
//
// Deploy WITHOUT JWT verification -- Mailgun cannot send a Supabase token;
// this function authenticates via Mailgun's HMAC, exactly as
// readymode-email-import does:
//   supabase functions deploy dialer-list-import --no-verify-jwt
//
// Required secrets:
//   supabase secrets set MAILGUN_SIGNING_KEY=xxxxx   (same key as the
//   existing route; it is per-domain, not per-route)

import { createClient } from 'jsr:@supabase/supabase-js@2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

// Mailgun's classic inbound-route signature: hex(HMAC-SHA256(key, ts + token)).
async function verifyMailgunSignature(
  timestamp: string, token: string, signature: string, signingKey: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(signingKey),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp + token));
    const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex === signature;
  } catch { return false; }
}

// The HMAC alone never expires, so a captured POST could be replayed forever.
const MAILGUN_TIMESTAMP_MAX_SKEW_SECONDS = 15 * 60;
function isTimestampFresh(timestamp: string): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Date.now() / 1000 - ts) <= MAILGUN_TIMESTAMP_MAX_SKEW_SECONDS;
}

// --- CSV -----------------------------------------------------------------
// Quote-aware; ReadyMode exports contain addresses with commas.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

// Lead columns vary by vendor, so match on a list of known aliases rather
// than one fixed name. Order matters: the first hit wins.
const PHONE_ALIASES = ['phone', 'phonenumber', 'phone1', 'primaryphone', 'mobile',
                       'cell', 'cellphone', 'telephone', 'ownerphone', 'contactphone'];
const FIRST_ALIASES = ['firstname', 'first', 'ownerfirstname', 'contactfirstname'];
const LAST_ALIASES  = ['lastname', 'last', 'ownerlastname', 'contactlastname'];
const NAME_ALIASES  = ['name', 'fullname', 'ownername', 'contactname', 'owner'];
// The agent console's profile panel reads these off REAL COLUMNS -- see
// renderProfile()'s `direct` map in dialer/index.html. Until now the importer
// wrote none of them, so every imported contact showed a profile panel
// containing nothing but the phone number, and the Property line was blank
// however the admin field defs were configured.
//
// The lists are deliberately conservative. Two things are NOT in them:
//
//   'st' for state -- it is at least as likely to mean "street". A wrong
//   state is not cosmetic: dialer-call-control picks the caller-ID DID by
//   matching dialer_contacts.state, so a street column read as a state
//   silently dials from the wrong area code.
//
//   mailing* anything -- that is the OWNER's address, a different thing from
//   the property's, and properties keeps them in separate columns for that
//   reason. Showing an owner's mailing address on a line labelled Property
//   would be worse than showing nothing.
const EMAIL_ALIASES   = ['email', 'emailaddress', 'owneremail', 'contactemail', 'email1'];
const ADDRESS_ALIASES = ['address', 'propertyaddress', 'siteaddress', 'streetaddress',
                         'address1', 'addressline1'];
const CITY_ALIASES    = ['city', 'propertycity', 'sitecity'];
const STATE_ALIASES   = ['state', 'propertystate', 'sitestate'];
const ZIP_ALIASES     = ['zip', 'zipcode', 'postalcode', 'propertyzip', 'sitezip', 'zip5'];

// contact_fields is keyed to match dialer_field_defs.key, which is
// snake_case ('apn_parcel_id', 'land_portal_link'). That is NOT what norm()
// produces -- norm strips separators entirely for alias matching, so
// "APN/Parcel ID" would become "apnparcelid" and match no field def at all.
const fieldKey = (h: string) =>
  h.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function findCol(headers: string[], aliases: string[]): number {
  const h = headers.map(norm);
  for (const a of aliases) {
    const i = h.indexOf(a);
    if (i >= 0) return i;
  }
  return -1;
}

function toE164(raw: string): string | null {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null; // not NANP -- do not guess
}

// ---- free pre-dial resolution --------------------------------------------
// NANP area code -> IANA time zone. Free, offline, and the reason an
// imported list is dialable the moment it lands.
//
// WHY THIS IS AS GOOD AS THE PAID LOOKUP: US number portability is confined
// to the same rate centre, so a ported number keeps its area code and its
// state. Telnyx's portability.state and the NPA therefore agree except in
// edge cases -- we were paying $0.0015 a number for an answer already
// carried in the first three digits.
//
// AND BETTER THAN WHAT PRECEDED IT: validation mapped whole STATES, so
// every Florida number resolved to Central and its 9am window opened at
// the seller's 10am. Half the state's dialable morning, gone. Same for
// El Paso (Mountain, not Central) and Boise (Mountain, not Pacific).
//
// SPLIT AREA CODES take the zone of the majority of the population, except
// where the split is close enough to matter, where they take the WESTERN
// zone -- the error direction that is safe. Assuming Central for a number
// that is really Eastern opens the window at their 10am: late, harmless.
// The reverse opens it at their 8am: a complaint. Conservative by choice:
//   448/850 Florida panhandle -> Central (Pensacola)
//   906     Michigan UP       -> Central
//   812/930 southwest Indiana -> Central (Evansville)
//   308     western Nebraska  -> Mountain
//   208/986 Idaho             -> Mountain (Boise; the panhandle is Pacific)
// 574 is the deliberate exception: South Bend is Eastern and carries the
// area code, so the two Central counties lose rather than the other 95%.
const NPA_TZ_GROUPS: Record<string, number[]> = {
  'America/New_York': [
    203, 475, 860, 959,                                        // CT
    302, 202,                                                  // DE, DC
    239, 305, 321, 352, 386, 407, 561, 656, 689, 727, 728,     // FL, eastern
    754, 772, 786, 813, 863, 904, 941, 954,
    229, 404, 470, 478, 678, 706, 762, 770, 912, 943,          // GA
    260, 317, 463, 574, 765,                                   // IN, eastern
    502, 606, 859,                                             // KY, eastern
    207,                                                       // ME
    227, 240, 301, 410, 443, 667,                              // MD
    339, 351, 413, 508, 617, 774, 781, 857, 978,               // MA
    231, 248, 269, 313, 517, 586, 616, 679, 734, 810, 947, 989,// MI
    603,                                                       // NH
    201, 551, 609, 640, 732, 848, 856, 862, 908, 973,          // NJ
    212, 315, 332, 347, 363, 516, 518, 585, 607, 631, 646,     // NY
    680, 716, 718, 838, 845, 914, 917, 929, 934,
    252, 336, 472, 704, 743, 828, 910, 919, 980, 984,          // NC
    216, 220, 234, 283, 326, 330, 380, 419, 436, 440, 513,     // OH
    567, 614, 740, 937,
    215, 223, 267, 272, 412, 445, 484, 570, 582, 610, 717,     // PA
    724, 814, 835, 878,
    401,                                                       // RI
    803, 839, 843, 854, 864,                                   // SC
    423, 865,                                                  // TN, eastern
    802,                                                       // VT
    276, 434, 540, 571, 703, 757, 804, 826, 948,               // VA
    304, 681,                                                  // WV
  ],
  'America/Chicago': [
    205, 251, 256, 334, 659, 938,                              // AL
    327, 479, 501, 870,                                        // AR
    448, 850,                                                  // FL panhandle
    217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 730,     // IL
    773, 779, 815, 847, 861, 872,
    219, 812, 930,                                             // IN, west/south
    319, 515, 563, 641, 712,                                   // IA
    316, 620, 785, 913,                                        // KS
    270, 364,                                                  // KY, western
    225, 318, 337, 504, 985,                                   // LA
    906,                                                       // MI, upper
    218, 320, 507, 612, 651, 763, 924, 952,                    // MN
    228, 601, 662, 769,                                        // MS
    314, 417, 557, 573, 636, 660, 816, 975,                    // MO
    402, 531,                                                  // NE, eastern
    701,                                                       // ND
    405, 539, 572, 580, 918,                                   // OK
    605,                                                       // SD
    615, 629, 731, 901, 931,                                   // TN, central
    210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469,     // TX
    512, 682, 713, 726, 737, 806, 817, 830, 832, 903, 936,
    940, 945, 956, 972, 979,
    262, 274, 353, 414, 534, 608, 715, 920,                    // WI
  ],
  'America/Denver': [
    303, 719, 720, 970, 983,                                   // CO
    208, 986,                                                  // ID
    406,                                                       // MT
    308,                                                       // NE, western
    505, 575,                                                  // NM
    915,                                                       // TX, El Paso
    385, 435, 801,                                             // UT
    307,                                                       // WY
  ],
  'America/Phoenix': [480, 520, 602, 623, 928],                // AZ, no DST
  'America/Los_Angeles': [
    209, 213, 279, 310, 323, 341, 350, 408, 415, 424, 442,     // CA
    510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669,
    707, 714, 738, 747, 760, 764, 805, 818, 820, 831, 840,
    858, 909, 916, 925, 949, 951,
    702, 725, 775,                                             // NV
    458, 503, 541, 971,                                        // OR
    206, 253, 360, 425, 509, 564,                              // WA
  ],
  'America/Anchorage': [907],
  'Pacific/Honolulu': [808],
  'America/Puerto_Rico': [787, 939],
  'America/St_Thomas': [340],
};

// Area codes that can never be a seller's line: toll-free, premium rate,
// and personal-communications ranges. A file carrying these is carrying a
// business switchboard or a typo, and either way a dial is wasted on it.
const NPA_NOT_DIALABLE = new Set([
  800, 833, 844, 855, 866, 877, 888,                           // toll-free
  900, 976,                                                    // premium rate
  500, 521, 522, 523, 524, 525, 526, 527, 528, 529,            // personal comms
  533, 544, 566, 577, 588, 622, 710,
]);

const NPA_TZ: Record<number, string> = {};
for (const [tz, list] of Object.entries(NPA_TZ_GROUPS)) for (const n of list) NPA_TZ[n] = tz;

// The calling-hours gate's only requirement, answered for nothing.
function timezoneForNumber(e164: string): string | null {
  const d = String(e164 || '').replace(/\D/g, '');
  if (d.length !== 11 || d[0] !== '1') return null;
  return NPA_TZ[Number(d.slice(1, 4))] ?? null;
}

// Structural screen. Catches what a paid lookup would also catch, on the
// numbers where the answer is knowable from the digits alone: service codes,
// toll-free switchboards, and the placeholder rows every skip-trace file
// carries. A number that is merely dead still looks perfectly well-formed,
// and that one is caught on the first dial instead -- see
// dialer-telnyx-webhook, unallocated_number.
function numberProblem(e164: string): string | null {
  const d = String(e164 || '').replace(/\D/g, '');
  if (d.length !== 11 || d[0] !== '1') return 'not a US number';
  const npa = d.slice(1, 4), nxx = d.slice(4, 7), line = d.slice(7);
  if (npa[0] < '2') return 'impossible area code';
  if (npa[1] === '1' && npa[2] === '1') return 'service code, not a phone number';
  if (NPA_NOT_DIALABLE.has(Number(npa))) return 'toll-free or premium-rate';
  if (nxx[0] < '2') return 'impossible exchange';
  if (nxx[1] === '1' && nxx[2] === '1') return 'service code, not a phone number';
  if (nxx === '555' && line >= '0100' && line <= '0199') return 'reserved fictional number';
  if (/^(\d)\1{9}$/.test(d.slice(1))) return 'placeholder digits';
  return null;
}

const yes = (v: string | undefined) => String(v || '').trim().toLowerCase() === 'yes';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const MAILGUN_SIGNING_KEY = Deno.env.get('MAILGUN_SIGNING_KEY');

  if (!MAILGUN_SIGNING_KEY) {
    console.error('dialer-list-import: MAILGUN_SIGNING_KEY not set — refusing all requests.');
    return json({ ok: false, error: 'Not configured' }, 503);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Every attempt is logged, success or failure. A silently missing email is
  // the exact blind spot that made the GHL webhook painful to debug.
  const logImport = async (row: Record<string, unknown>) => {
    await admin.from('readymode_email_imports').insert({
      report_type: 'dialer_list', ...row,
    }).then(() => {}, () => {});
  };

  try {
    const ct = req.headers.get('content-type') || '';
    if (!ct.includes('multipart/form-data')) {
      return json({ ok: false, error: 'Expected multipart/form-data from Mailgun' }, 400);
    }
    const form = await req.formData();

    const timestamp = String(form.get('timestamp') || '');
    const token = String(form.get('token') || '');
    const signature = String(form.get('signature') || '');
    if (!isTimestampFresh(timestamp)) return json({ ok: false, error: 'Stale timestamp' }, 401);
    if (!await verifyMailgunSignature(timestamp, token, signature, MAILGUN_SIGNING_KEY)) {
      return json({ ok: false, error: 'Invalid signature' }, 401);
    }

    const subject = String(form.get('subject') || '').trim();
    // Mailgun's per-message id, used as the idempotency key. A retried
    // delivery or a re-sent Automated Task must update, never clone.
    const messageId = String(form.get('Message-Id') || form.get('message-id') || token).trim();

    // --- resolve the campaign ------------------------------------------
    // The export itself carries no campaign field, so the Automated Task's
    // SUBJECT must name the campaign exactly. Guessing here would silently
    // load thousands of contacts into the wrong campaign, so an unresolved
    // subject fails loudly and visibly instead.
    const { data: campaigns } = await admin
      .from('dialer_campaigns').select('id, name').neq('status', 'archived');
    const subjectNorm = norm(subject);
    const campaign = (campaigns || []).find((c: any) => subjectNorm.includes(norm(c.name)));
    if (!campaign) {
      const msg = `No campaign name found in subject "${subject}". Rename the ReadyMode ` +
                  `Automated Task so its subject contains the exact campaign name.`;
      await logImport({ filename: null, row_count: 0, imported_count: 0, status: 'failed', error: msg });
      return json({ ok: true, skipped: msg });
    }

    // --- find the CSV attachment ----------------------------------------
    let csvText = '';
    let filename: string | null = null;
    for (const [, value] of form.entries()) {
      if (value instanceof File && /\.csv$/i.test(value.name)) {
        csvText = await value.text(); filename = value.name; break;
      }
    }
    if (!csvText) {
      await logImport({ filename: null, row_count: 0, imported_count: 0, status: 'failed', error: 'No CSV attachment' });
      return json({ ok: true, skipped: 'no CSV attachment' });
    }

    const rows = parseCsv(csvText);
    if (rows.length < 2) {
      await logImport({ filename, row_count: 0, imported_count: 0, status: 'failed', error: 'CSV had no data rows' });
      return json({ ok: true, skipped: 'empty CSV' });
    }

    const headers = rows[0];
    const hNorm = headers.map(norm);
    const col = (n: string) => hNorm.indexOf(norm(n));

    const iDnc = col('DNC');
    const iAccepted = col('Accepted');
    const iStatus = col('status');
    const iDupe = col('Dupe');
    const iDupeInFile = col('Dupe in file');
    const iRnd = col('RND Result');

    // The ReadyMode columns are the signature. Without them this is not a
    // scrubbed export, and importing it would create a list marked scrubbed
    // that never was -- the one thing v524's constraint exists to prevent.
    if (iDnc < 0 || iAccepted < 0) {
      const msg = 'CSV lacks ReadyMode DNC/Accepted columns — not a scrubbed export. Refusing to import.';
      await logImport({ filename, row_count: rows.length - 1, imported_count: 0, status: 'failed', error: msg });
      return json({ ok: true, skipped: msg });
    }

    const iPhone = findCol(headers, PHONE_ALIASES);
    if (iPhone < 0) {
      const msg = `No phone column found. Headers: ${headers.join(', ')}`;
      await logImport({ filename, row_count: rows.length - 1, imported_count: 0, status: 'failed', error: msg });
      return json({ ok: true, skipped: msg });
    }
    const iFirst = findCol(headers, FIRST_ALIASES);
    const iLast = findCol(headers, LAST_ALIASES);
    const iName = findCol(headers, NAME_ALIASES);
    const iEmail = findCol(headers, EMAIL_ALIASES);
    const iAddress = findCol(headers, ADDRESS_ALIASES);
    const iCity = findCol(headers, CITY_ALIASES);
    const iState = findCol(headers, STATE_ALIASES);
    const iZip = findCol(headers, ZIP_ALIASES);

    // --- upsert the list (idempotent on the message id) ------------------
    const { data: existingList } = await admin
      .from('dialer_lists').select('id').eq('import_message_id', messageId).maybeSingle();

    let listId = existingList?.id ?? null;
    if (!listId) {
      const { data: created, error: listErr } = await admin.from('dialer_lists').insert({
        campaign_id: campaign.id,
        name: subject || filename || 'ReadyMode import',
        source_type: 'readymode_import',
        source_file_path: filename,
        // ReadyMode scrubbed this list -- that is the entire point of the
        // round trip, and it is what satisfies v524's ready-requires-scrub
        // constraint honestly rather than by assertion.
        readymode_scrubbed_at: new Date().toISOString(),
        readymode_scrub_note: `Automated ReadyMode export "${filename}" received by email`,
        status: 'loading',
        import_message_id: messageId,
        total_rows: rows.length - 1,
      }).select('id').single();
      if (listErr || !created) {
        await logImport({ filename, row_count: rows.length - 1, imported_count: 0, status: 'failed', error: listErr?.message ?? 'list insert failed' });
        return json({ ok: false, error: 'Could not create list' }, 500);
      }
      listId = created.id;
    }

    // --- build contacts --------------------------------------------------
    const stats = {
      total: 0, dnc: 0, rejected: 0, dupe: 0, bad_phone: 0, loaded: 0,
      // Screened on the digits alone, and the residue the area-code table
      // could not place. Both were previously invisible until somebody paid
      // to look the numbers up.
      undialable: 0, no_timezone: 0,
    };
    const contacts: Record<string, unknown>[] = [];
    const seen = new Set<string>();

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      stats.total++;

      // ReadyMode's verdict, honoured in order of severity.
      if (iDnc >= 0 && yes(row[iDnc])) { stats.dnc++; continue; }
      if (iAccepted >= 0 && !yes(row[iAccepted])) { stats.rejected++; continue; }
      if ((iDupe >= 0 && yes(row[iDupe])) || (iDupeInFile >= 0 && yes(row[iDupeInFile]))) {
        stats.dupe++; continue;
      }

      const phone = toE164(row[iPhone] || '');
      if (!phone) { stats.bad_phone++; continue; }
      if (seen.has(phone)) { stats.dupe++; continue; }
      // A service code or a toll-free switchboard is knowable from the
      // digits. Letting one in costs a dial and a mark against the DID that
      // placed it, so it is dropped here rather than loaded and screened
      // later at a cost per number.
      if (numberProblem(phone)) { stats.undialable++; continue; }
      seen.add(phone);

      const name = iName >= 0 && row[iName]
        ? String(row[iName]).trim()
        : [iFirst >= 0 ? row[iFirst] : '', iLast >= 0 ? row[iLast] : ''].filter(Boolean).join(' ').trim();

      // source_row keeps the file verbatim, headers and all, because it is
      // the evidence of what was actually imported. contact_fields is the
      // same data keyed to dialer_field_defs so the profile panel can find
      // it. Both, deliberately: one is the receipt, the other is the index.
      const sourceRow: Record<string, string> = {};
      const contactFields: Record<string, string> = {};
      headers.forEach((h, i) => {
        if (!h) return;
        const v = row[i] ?? '';
        sourceRow[h] = v;
        if (String(v).trim() !== '') contactFields[fieldKey(h)] = v;
      });

      const cell = (i: number) => (i >= 0 && row[i] ? String(row[i]).trim() || null : null);

      const tz = timezoneForNumber(phone);
      if (!tz) stats.no_timezone++;

      contacts.push({
        list_id: listId,
        campaign_id: campaign.id,
        phone_e164: phone,
        contact_name: name || null,
        // The eight the console renders directly. Without these the profile
        // panel is blank no matter what the field defs say, because
        // renderProfile() looks at the COLUMN first and only then at
        // contact_fields.
        first_name: cell(iFirst),
        last_name: cell(iLast),
        email: cell(iEmail),
        address: cell(iAddress),
        city: cell(iCity),
        state: cell(iState),
        zip: cell(iZip),
        contact_fields: contactFields,
        // From the NUMBER's area code, never from an address in this file --
        // see the header. Null only for an area code the table does not
        // carry, and those rows stay undialable until a lookup resolves them,
        // which is the correct conservative behaviour.
        timezone: tz,
        status: 'new',
        readymode_dnc: iDnc >= 0 ? row[iDnc] : null,
        readymode_status: iStatus >= 0 ? row[iStatus] : null,
        readymode_rnd_result: iRnd >= 0 ? row[iRnd] : null,
        source_row: sourceRow,
      });
      stats.loaded++;
    }

    // --- insert in batches ------------------------------------------------
    // A single insert of 9,000+ rows will not survive; and any Supabase read
    // expected to exceed ~1000 rows must paginate, since a large .limit() is
    // silently capped. Batching keeps both sides honest.
    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < contacts.length; i += BATCH) {
      const slice = contacts.slice(i, i + BATCH);
      const { error } = await admin.from('dialer_contacts')
        .upsert(slice, { onConflict: 'list_id,phone_e164', ignoreDuplicates: true });
      if (error) {
        console.error('dialer-list-import: batch insert failed at', i, error.message);
        await logImport({ filename, row_count: stats.total, imported_count: inserted, status: 'failed', error: error.message });
        return json({ ok: false, error: 'Batch insert failed', inserted }, 500);
      }
      inserted += slice.length;
    }

    // Ready only once rows are in. Contacts are dialable from this point:
    // the calling-hours gate has the zone it needs, resolved above at no
    // cost. stats.no_timezone counts the residue that still is not.
    await admin.from('dialer_lists').update({
      status: 'ready',
      loaded_rows: inserted,
      skipped_rows: stats.total - stats.loaded,
      import_stats: stats,
      import_channel_name: campaign.name,
      updated_at: new Date().toISOString(),
    }).eq('id', listId);

    await logImport({
      filename, row_count: stats.total, imported_count: inserted,
      status: 'success',
      error: `dnc=${stats.dnc} rejected=${stats.rejected} dupe=${stats.dupe} bad_phone=${stats.bad_phone}`,
    });

    return json({ ok: true, list_id: listId, campaign: campaign.name, stats });
  } catch (e) {
    console.error('dialer-list-import: unhandled', e);
    await logImport({ filename: null, row_count: 0, imported_count: 0, status: 'failed', error: String(e) });
    return json({ ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
