// freeswitch/bin/verto-shim.ts
//
// Translates between the Telnyx WebRTC SDK and mod_verto (v555).
//
//   browser --wss:443/verto--> nginx --> THIS (127.0.0.1:8080) --> mod_verto (127.0.0.1:8081)
//
// WHY THIS EXISTS. @telnyx/webrtc is FreeSWITCH's Verto protocol with the
// method prefix renamed. Verified against the published bundle at 2.21.1:
// the wire format is JSON-RPC 2.0, the call methods are telnyx_rtc.invite /
// .answer / .bye / .attach / .subscribe / .broadcast / .modify / .media /
// .info / .display / .ping / .punt / .clientReady -- one for one with
// Verto's verto.* set -- and internal symbols in the bundle are still named
// vertoSubscribe, vertoBroadcast, vertoClientReady and Verto.newCall.
//
// So the ONLY incompatibility is a string prefix. Rewriting it here means
// the console keeps the softphone we have already debugged in production:
// the call state machine, DTMF, hold, mute, the keypad, the synthesised
// ringtone, and the identity-based inbound detection that works around the
// SDK setting call.direction one line after it dispatches the notification.
// Swapping to an unfamiliar Verto library would mean rediscovering every one
// of those quirks in a different codebase.
//
// NOT REWRITTEN: "login". Both sides use the bare, unprefixed method with
// {login, passwd, sessid, userVariables}, so authentication passes straight
// through. Only the call methods carry a prefix.
//
// This process handles signalling only. Media (SRTP) goes browser <-> the
// FreeSWITCH RTP ports directly and never touches it, so it is not on the
// audio path and cannot degrade call quality.
//
// Run:  deno run --allow-net verto-shim.ts
// See freeswitch/systemd/verto-shim.service.

const LISTEN_PORT = Number(Deno.env.get('SHIM_PORT') || 8080);
const UPSTREAM = Deno.env.get('VERTO_UPSTREAM') || 'ws://127.0.0.1:8081';

const CLIENT_PREFIX = 'telnyx_rtc.';
const SERVER_PREFIX = 'verto.';

// Rewrite ONLY the top-level JSON-RPC method. Everything else -- params,
// SDP, call ids, error bodies -- is relayed byte for byte. A message that is
// not JSON, or that has no method, passes through untouched rather than
// being dropped: this shim is a translator, not a filter, and anything it
// does not understand is none of its business.
function reprefix(raw: string, from: string, to: string): string {
  if (raw.length === 0 || raw[0] !== '{') return raw;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return raw;
  }
  const method = msg.method;
  if (typeof method !== 'string' || !method.startsWith(from)) return raw;
  msg.method = to + method.slice(from.length);
  return JSON.stringify(msg);
}

Deno.serve({ port: LISTEN_PORT, hostname: '127.0.0.1' }, (req) => {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    // Handy for a health check from systemd or a monitor.
    return new Response('verto-shim ok\n', { status: 200 });
  }

  const { socket: client, response } = Deno.upgradeWebSocket(req);
  const upstream = new WebSocket(UPSTREAM);

  // The SDK sends its login the instant the socket opens, which is normally
  // before the upstream connection has finished opening. Without this queue
  // that first message is thrown away and the agent simply never registers
  // -- a failure that looks exactly like a wrong password.
  const pending: string[] = [];
  let upstreamOpen = false;

  upstream.onopen = () => {
    upstreamOpen = true;
    for (const m of pending) upstream.send(m);
    pending.length = 0;
  };

  client.onmessage = (e) => {
    const out = reprefix(String(e.data), CLIENT_PREFIX, SERVER_PREFIX);
    if (upstreamOpen) upstream.send(out);
    else pending.push(out);
  };

  upstream.onmessage = (e) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(reprefix(String(e.data), SERVER_PREFIX, CLIENT_PREFIX));
    }
  };

  // Either side going away takes the other with it. A half-open pair would
  // leave the console believing it is registered while nothing reaches the
  // switch, which is worse than a clean disconnect the SDK will retry.
  const closeBoth = (code?: number, reason?: string) => {
    // 1000-1015 and 3000-4999 are the only codes close() accepts; upstream
    // can hand us others, and throwing here would leak the other socket.
    const safe = code && ((code >= 3000 && code <= 4999) || code === 1000) ? code : 1000;
    try { if (client.readyState === WebSocket.OPEN) client.close(safe, reason); } catch { /* already gone */ }
    try { if (upstream.readyState === WebSocket.OPEN) upstream.close(safe, reason); } catch { /* already gone */ }
  };

  client.onclose = (e) => closeBoth(e.code, e.reason);
  upstream.onclose = (e) => closeBoth(e.code, e.reason);
  client.onerror = () => closeBoth();
  upstream.onerror = (e) => {
    console.error('verto-shim: upstream error', e instanceof ErrorEvent ? e.message : '');
    closeBoth();
  };

  return response;
});

console.log(`verto-shim listening on 127.0.0.1:${LISTEN_PORT} -> ${UPSTREAM}`);
