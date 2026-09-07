// Exercises the header-matching helpers from index.ts, extracted so the
// mapping can be checked without deploying or importing a real file.
//
//   node column-mapping.test.mjs index.ts
//
// The point of the test is not that norm() works -- it is that the CSV
// headers real vendors send land on the right columns, and that the two
// deliberately-excluded cases stay excluded.

import fs from 'node:fs';

const src = fs.readFileSync(process.argv[2], 'utf8');

function grab(re, name) {
  const m = src.match(re);
  if (!m) { console.error(`could not extract ${name} from index.ts`); process.exit(1); }
  return m[1];
}

const norm = new Function('h', 'return ' + grab(/const norm = \(h: string\) =>([^;]+);/, 'norm'));
const fieldKey = new Function('h', 'return ' +
  grab(/const fieldKey = \(h: string\) =>\s*([\s\S]*?);\n/, 'fieldKey'));

function aliases(name) {
  const body = grab(new RegExp(`const ${name}\\s*=\\s*(\\[[\\s\\S]*?\\]);`), name);
  return JSON.parse(body.replace(/'/g, '"').replace(/,\s*\]/, ']'));
}
const A = {
  phone: aliases('PHONE_ALIASES'), first: aliases('FIRST_ALIASES'),
  last: aliases('LAST_ALIASES'), name: aliases('NAME_ALIASES'),
  email: aliases('EMAIL_ALIASES'), address: aliases('ADDRESS_ALIASES'),
  city: aliases('CITY_ALIASES'), state: aliases('STATE_ALIASES'),
  zip: aliases('ZIP_ALIASES'),
};

function findCol(headers, list) {
  const h = headers.map(norm);
  for (const a of list) { const i = h.indexOf(a); if (i >= 0) return i; }
  return -1;
}

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
  else console.log(`PASS  ${label}`);
};

// A realistic skip-traced seller export.
const headers = ['Owner First Name', 'Owner Last Name', 'Phone 1', 'Owner Email',
                 'Property Address', 'Property City', 'Property State', 'Property Zip',
                 'APN/Parcel ID', 'Land Portal Link', 'Additional Notes'];

check('first name',  findCol(headers, A.first),   0);
check('last name',   findCol(headers, A.last),    1);
check('phone',       findCol(headers, A.phone),   2);
check('email',       findCol(headers, A.email),   3);
check('address',     findCol(headers, A.address), 4);
check('city',        findCol(headers, A.city),    5);
check('state',       findCol(headers, A.state),   6);
check('zip',         findCol(headers, A.zip),     7);

// Plainer headers.
const plain = ['Name', 'Phone', 'Address', 'City', 'State', 'Zip'];
check('plain address', findCol(plain, A.address), 2);
check('plain state',   findCol(plain, A.state),   4);
check('plain zip',     findCol(plain, A.zip),     5);

// THE TWO EXCLUSIONS. A wrong state picks the wrong caller-ID DID, and an
// owner's mailing address is not the property's.
check('"St" is NOT read as state',
      findCol(['Name', 'Phone', 'St'], A.state), -1);
check('mailing address is NOT read as address',
      findCol(['Phone', 'Mailing Address'], A.address), -1);
check('mailing city is NOT read as city',
      findCol(['Phone', 'Mailing City'], A.city), -1);

// contact_fields keys must match dialer_field_defs.key, which is snake_case.
check('apn key',    fieldKey('APN/Parcel ID'),    'apn_parcel_id');
check('link key',   fieldKey('Land Portal Link'), 'land_portal_link');
check('notes key',  fieldKey('Additional Notes'), 'additional_notes');
check('area key',   fieldKey('AREA'),             'area');
check('trims edges', fieldKey('  Lead City  '),   'lead_city');
check('collapses runs', fieldKey('Owner -- Name'), 'owner_name');

// And the distinction that motivated fieldKey existing at all.
check('norm() would NOT match a field-def key', norm('APN/Parcel ID'), 'apnparcelid');

console.log(fails === 0 ? '\nall checks passed' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
