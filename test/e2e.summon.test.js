/* node test/e2e.summon.test.js — TRUE end-to-end of the team.summon round-trip. Boots the REAL sidecar with a
   MOCK OpenRouter that makes the lead call team.summon, then ACTS AS THE BROWSER: it reads crew.summon.request off
   the live run stream and POSTs /api/summon/ack with a freshly-"minted" agentId, exactly as the Recruitment Bay's
   summonAgent() would. Proves the whole chain wires together — model → tool → crew.summon.request → ack → the new
  task is automatically handed to the new worker through team.dispatch(background:true), which starts its own run.
  No real key/model/browser.

   NOT in test:fast (a child-process boot test shouldn't gate other agents' merges); run via `npm run test:http`. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');
const fs = require('fs');
const { spawn } = require('child_process');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

// Mock OpenRouter: the lead summons a researcher with a task, a distinct worker run returns its own result, and
// the lead then finishes. Captures each request so the test can distinguish an actual worker run from lead prose.
function startMockOpenRouter() {
  const requests = [];
  const workerRequests = [];
  let resolveWorkerRequest;
  const workerStarted = new Promise(resolve => { resolveWorkerRequest = resolve; });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          let request = {};
          try { request = JSON.parse(body); requests.push(request); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const isLeadContinuation = (request.messages || []).some(m => m && m.role === 'assistant' && Array.isArray(m.tool_calls));
          if (requests.length === 1) {
            // The lead must provide the actual Commander task as part of the summon contract.
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_summon', type: 'function', function: { name: 'team_summon', arguments: JSON.stringify({ name: 'RESEARCHER', specId: 'researcher', task: 'Research potential business names for a new company.' }) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + '\n\n');
          } else if (isLeadContinuation) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Done — RESEARCHER is on the crew.' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }) + '\n\n');
          } else {
            workerRequests.push(request);
            resolveWorkerRequest(request);
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'I researched several potential business names and returned the findings.' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, workerRequests, workerStarted, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// spawn the real sidecar; resolve once it logs its listen URL. Retries the next port on EADDRINUSE.
function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-summon-'));
  // SKYNET_FULL_ACCESS so team.summon's consent gate bypasses (no human in this headless e2e) — exactly the
  // full-auto posture; the APPROVAL-mode prompt path is covered by the consent suites.
  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base, SKYNET_FULL_ACCESS: '1' };
  const { child, port } = await boot(8890 + (process.pid % 50), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');

    // Drive a real streaming lead run; the mock makes it summon and assign a business-name research task.
    const res = await fetch(B + '/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: JSON.stringify({ key: 'sk-or-v1-fake', model: 'test/model', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: 'Research potential business names for a new company.' }] })
    });
    A.eq(res.status, 200, 'POST /api/run streams (200)');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', events = [], runId = null, summonReq = null, ackPosted = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
        events.push(ev);
        if (ev.name === 'agent.run.start' && !runId) runId = ev.payload.runId;
        // ACT AS THE BROWSER: the station ran summonAgent() and reports the new agentId back, unblocking the tool.
        if (ev.name === 'crew.summon.request' && !ackPosted) {
          summonReq = ev.payload; ackPosted = true;
          const roster = await fetch(B + '/api/roster', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
            body: JSON.stringify({ updatedAt: Date.now(), agents: [
              { agentId: 'agent', name: 'Overseer', system: '', model: 'test/model', provider: 'openrouter' },
              { agentId: 'researcher-2', name: 'RESEARCHER', system: 'Research potential business names.', model: 'test/model', provider: 'openrouter' }
            ] })
          });
          A.eq(roster.status, 200, 'the browser syncs the new specialist roster before acknowledging summon');
          A.ok((await roster.json()).ok, 'the sidecar confirms the worker roster landed');
          await fetch(B + '/api/summon/ack', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
            // `desk` = where the station's summonAgent() actually seeded the new worker's workstation
            body: JSON.stringify({ runId, requestId: ev.payload.requestId, agentId: 'researcher-2', desk: 'BRIDGE' })
          });
        }
      }
    }

    // 1) the lead actually emitted a summon COMMAND carrying the class the model chose
    A.ok(summonReq, 'the run emitted crew.summon.request (the lead asked the station to create a worker)');
    A.eq(summonReq.name, 'RESEARCHER', 'summon request carries the requested name');
    A.eq(summonReq.specId, 'researcher', 'summon request carries the requested class');
    A.ok(summonReq.requestId, 'summon request carries a requestId for the ack');
    A.eq(summonReq.agentId, 'agent', 'summon request is attributed to the requesting lead');

    // 2) the run completed cleanly — the tool resolved on our ack and the model gave a final answer
    const ends = events.filter(e => e.name === 'agent.run.end' && e.payload.runId === runId);
    A.eq(ends.length, 1, 'exactly one agent.run.end');
    A.eq(ends[0].payload.reason, 'done', 'the lead turn completes cleanly after handoff');

    // 3) the team.summon tool returned OK (it received our new agentId, not an error)
    const toolResults = events.filter(e => e.name === 'agent.tool_result');
    A.ok(toolResults.some(e => e.payload.ok && !e.payload.isError), 'the team.summon tool returned ok');

    // 4) THE PROOF: the host dispatched the new specialist through the central team.dispatch path.
    const dispatchCalls = events.filter(e => e.name === 'agent.tool_call' && e.payload.name === 'team.dispatch');
    A.eq(dispatchCalls.length, 1, 'summoning a task automatically emits one team.dispatch call');
    A.ok(JSON.stringify(dispatchCalls[0].payload).includes('Research potential business names'), 'dispatch carries the Commander task');
    A.ok(events.some(e => e.name === 'agent.tool_result' && e.payload.callId === dispatchCalls[0].payload.callId && e.payload.ok), 'the generated team.dispatch call succeeds');

    // 5) A separate provider request proves the worker started its own agent loop with the assigned task.
    const workerRequest = await Promise.race([
      mock.workerStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the independent worker run never reached the provider')), 5000))
    ]);
    A.eq(mock.workerRequests.length, 1, 'exactly one independent worker provider request was observed');
    const workerMessages = JSON.stringify(workerRequest.messages || []);
    A.ok(workerMessages.includes('Research potential business names'), 'the worker received the assigned Commander task');
    A.ok(!(workerRequest.tools || []).some(t => t && t.function && /^team_(dispatch|summon)$/.test(t.function.name)), 'the specialist runs without lead orchestration tools');

    // 6) The lead makes no follow-up model call to continue the research itself; its run is free for new COMMS work.
    A.eq(mock.requests.length, 2, 'only the lead handoff call and independent worker call reach the provider');
    A.ok(events.some(e => e.name === 'agent.token' && String(e.payload.delta || '').includes('available for your next request')), 'the Overseer reports it is available for new Commander work');

  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
  }
  A.report('e2e.summon.test');
})().catch(e => { console.error(e); process.exit(1); });
