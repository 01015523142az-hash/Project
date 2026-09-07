// Exercises the exact reprefix() body from freeswitch/bin/verto-shim.ts.
import fs from 'node:fs';

const src = fs.readFileSync(process.argv[2], 'utf8');
const m = src.match(/function reprefix\(raw: string, from: string, to: string\): string \{([\s\S]*?)\n\}/);
if (!m) { console.error('could not extract reprefix from the shim'); process.exit(1); }
const body = m[1]
  .replace(/let msg: Record<string, unknown>;/, 'let msg;')
  .replace(/const method = msg\.method;/, 'const method = msg.method;');
const reprefix = new Function('raw', 'from', 'to', body);

const C = 'telnyx_rtc.', S = 'verto.';
let fails = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got  ${got}\n        want ${want}`);
}

// 1. Every call method the SDK actually emits, client -> switch.
for (const verb of ['invite','answer','bye','attach','subscribe','unsubscribe',
                    'broadcast','modify','media','info','display','ping','pong',
                    'punt','clientReady','gatewayState','ringing','event']) {
  const out = reprefix(JSON.stringify({ jsonrpc: '2.0', id: 7, method: C + verb, params: { x: 1 } }), C, S);
  check(`client->switch  ${C}${verb}`, JSON.parse(out).method, S + verb);
}

// 2. And back the other way.
for (const verb of ['invite','bye','media','answer','display','punt','clientReady']) {
  const out = reprefix(JSON.stringify({ jsonrpc: '2.0', method: S + verb, params: {} }), S, C);
  check(`switch->client  ${S}${verb}`, JSON.parse(out).method, C + verb);
}

// 3. login must pass through UNTOUCHED -- both sides use the bare method.
const login = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'login',
  params: { login: 'agent_ola_1a2b', passwd: 'sekrit', sessid: 'abc', loginParams: {} } });
check('login is not rewritten', reprefix(login, C, S), login);

// 4. Payload must survive byte for byte -- SDP is the thing that matters.
const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nm=audio 1 RTP/SAVPF 111\r\n';
const inv = JSON.stringify({ jsonrpc: '2.0', id: 3, method: C + 'invite',
  params: { sdp, dialogParams: { callID: 'x-1', destination_number: 'atmpt-11111111-1111-1111-1111-111111111111' } } });
check('sdp survives', JSON.parse(reprefix(inv, C, S)).params.sdp, sdp);
check('destination survives', JSON.parse(reprefix(inv, C, S)).params.dialogParams.destination_number,
      'atmpt-11111111-1111-1111-1111-111111111111');

// 5. Things it must not touch.
check('non-json passes through', reprefix('not json at all', C, S), 'not json at all');
check('empty passes through', reprefix('', C, S), '');
check('malformed json passes through', reprefix('{"method":', C, S), '{"method":');
const noMethod = JSON.stringify({ jsonrpc: '2.0', id: 9, result: { ok: true } });
check('result with no method', reprefix(noMethod, C, S), noMethod);
const other = JSON.stringify({ jsonrpc: '2.0', method: 'something.else', params: {} });
check('unrelated method', reprefix(other, C, S), other);
// A method that merely CONTAINS the prefix later on must not be mangled.
const embedded = JSON.stringify({ jsonrpc: '2.0', method: 'x.telnyx_rtc.invite' });
check('prefix only matched at the start', JSON.parse(reprefix(embedded, C, S)).method, 'x.telnyx_rtc.invite');

// 6. Round trip.
const orig = JSON.stringify({ jsonrpc: '2.0', id: 5, method: C + 'bye', params: { causeCode: 16 } });
check('round trip is identity', reprefix(reprefix(orig, C, S), S, C), orig);

console.log(fails === 0 ? '\nall checks passed' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
