// #78 Step 0 — a SCRIPTED stand-in for a real model, speaking codex's
// wire_api="responses" contract, so probe-codex-hook-payloads.js can drive
// real tool calls (and so real PreToolUse/PostToolUse/PermissionRequest/
// SubagentStart/SubagentStop hooks) without any live model, any API key, and
// crucially without ever touching ~/.codex/auth.json (see CLAUDE.md: copying
// it rotates the refresh token and can revoke the whole family).
//
// MEASURED AGAINST codex-cli 0.147.0, by pointing model_providers.stub.base_url
// at a plain logging server first and reading what it actually sent:
//
//   - Endpoint is POST {base_url}/responses (base_url already ends in /v1), so
//     with base_url="http://127.0.0.1:PORT/v1" the path is "/v1/responses".
//   - Codex only cares about the terminal SSE event; a minimal working stream
//     is response.created -> response.output_item.done (one per item) ->
//     response.completed carrying the full `output` array. No incremental
//     `.delta` events are required.
//   - A function_call output item needs: id, type:"function_call", call_id,
//     name, arguments (a JSON *string*, not an object -- codex parses it), and
//     an OPTIONAL "namespace" field SEPARATE from "name". A namespaced tool
//     (e.g. multi_agent_v1's spawn_agent) is called with
//     {name:"spawn_agent", namespace:"multi_agent_v1"} -- NOT a dotted or
//     double-underscore-joined name. Confirmed by reading codex-rs's own
//     protocol/src/models.rs ResponseItem::FunctionCall definition after two
//     wrong guesses ("spawn_agent" alone, "multi_agent_v1.spawn_agent") both
//     came back `error=unsupported call: <name>` from codex_core::tools::router.
//
// Each POST is logged to REQLOG_DIR before answering, so a probe run leaves a
// full paper trail of exactly what codex sent, not just what this mock chose
// to return.
//
// Requests are bucketed by the `thread-id` request header. The FIRST thread-id
// ever seen gets SCRIPT_MAIN; every OTHER (i.e. later) thread-id gets
// SCRIPT_SUB, which is how a spawned Codex sub-agent -- a second, concurrent
// thread hitting this same mock -- gets its own scripted turns instead of
// stealing the parent's queue. Pass the same script twice if there is no
// sub-agent scenario in play.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

function usage() {
  process.stderr.write('usage: codex-mock-provider.js <port> <reqlogDir> <scriptMainPath> [scriptSubPath]\n');
  process.exit(1);
}

const PORT = Number(process.argv[2]);
const REQLOG_DIR = process.argv[3];
const SCRIPT_MAIN_PATH = process.argv[4];
const SCRIPT_SUB_PATH = process.argv[5] || SCRIPT_MAIN_PATH;
if (!PORT || !REQLOG_DIR || !SCRIPT_MAIN_PATH) usage();

fs.mkdirSync(REQLOG_DIR, { recursive: true });
const scriptMain = JSON.parse(fs.readFileSync(SCRIPT_MAIN_PATH, 'utf8'));
const scriptSub = JSON.parse(fs.readFileSync(SCRIPT_SUB_PATH, 'utf8'));

/**
 * Each scripted turn is `{ output: [item, ...] }`. An item is one of:
 *   { type: 'message', role?, text }                          -- assistant text
 *   { type: 'function_call', name, namespace?, call_id?, arguments }
 * `arguments` may be a plain object (this module JSON.stringifies it) or
 * already a string. Any string value anywhere in an item may contain the
 * literal token `{{SPAWNED_AGENT_ID}}`, substituted at send time with the
 * most recent UUID-looking id this server has observed anywhere in the
 * incoming request's `input` array -- i.e. the agent id codex assigned to a
 * PRIOR spawn_agent call, which this mock cannot know in advance since codex
 * generates it. That is what lets a scripted `wait_agent` target the agent a
 * scripted `spawn_agent` just created two turns earlier.
 */
function fillItem(it, idx) {
  const id = it.id || ('item_' + Date.now() + '_' + idx);
  if (it.type === 'message') {
    return {
      id, type: 'message', role: it.role || 'assistant', status: 'completed',
      content: it.content || [{ type: 'output_text', text: it.text || '', annotations: [] }],
    };
  }
  if (it.type === 'function_call') {
    return {
      id, type: 'function_call', status: 'completed',
      call_id: it.call_id || ('call_' + Date.now() + '_' + idx),
      name: it.name,
      namespace: it.namespace || null,
      arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {}),
    };
  }
  return it;
}

function substitute(v, agentId) {
  if (typeof v === 'string') return v.replace(/\{\{SPAWNED_AGENT_ID\}\}/g, agentId || '');
  if (Array.isArray(v)) return v.map((x) => substitute(x, agentId));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = substitute(v[k], agentId);
    return out;
  }
  return v;
}

const threads = new Map(); // thread-id -> { script, n, role }
let mainAssigned = false;
let reqN = 0;
let lastSeenAgentId = null;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    reqN += 1;
    const parsed = (() => { try { return JSON.parse(body); } catch (e) { return body; } })();
    const threadId = req.headers['thread-id'] || ('unknown-' + reqN);

    if (!threads.has(threadId)) {
      const role = !mainAssigned ? 'main' : 'sub';
      mainAssigned = true;
      threads.set(threadId, { script: role === 'main' ? scriptMain : scriptSub, n: 0, role });
      console.log('[codex-mock-provider] NEW thread ' + threadId + ' -> role=' + role);
    }
    const t = threads.get(threadId);
    t.n += 1;

    fs.writeFileSync(
      path.join(REQLOG_DIR, 'req-' + String(reqN).padStart(2, '0') + '-' + t.role + '-' + t.n + '.json'),
      JSON.stringify({ url: req.url, headers: req.headers, body: parsed }, null, 2),
    );
    console.log('[codex-mock-provider] request #' + reqN + ' thread=' + threadId + ' role=' + t.role + ' turn=' + t.n);

    // Track any UUID mentioned anywhere in this request's input (e.g. inside a
    // spawn_agent function_call_output), for {{SPAWNED_AGENT_ID}} in a LATER
    // scripted turn -- see file header.
    const uuids = JSON.stringify(parsed.input || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    if (uuids && uuids.length) lastSeenAgentId = uuids[uuids.length - 1];

    const turn = t.script[t.n - 1] || t.script[t.script.length - 1] || { output: [{ type: 'message', text: '(script exhausted)' }] };
    const items = (turn.output || []).map((it, idx) => fillItem(substitute(it, lastSeenAgentId), idx));

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (event, data) => { res.write('event: ' + event + '\n'); res.write('data: ' + JSON.stringify(data) + '\n\n'); };
    const respId = 'resp_mock_' + threadId + '_' + t.n;
    send('response.created', { type: 'response.created', response: { id: respId, object: 'response', status: 'in_progress' } });
    items.forEach((item, idx) => send('response.output_item.done', { type: 'response.output_item.done', output_index: idx, item }));
    send('response.completed', {
      type: 'response.completed',
      response: { id: respId, object: 'response', status: 'completed', output: items, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    });
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[codex-mock-provider] listening on 127.0.0.1:' + PORT
    + ' reqlog=' + REQLOG_DIR + ' main=' + SCRIPT_MAIN_PATH + ' sub=' + SCRIPT_SUB_PATH);
});
