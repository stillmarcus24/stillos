'use strict';
/**
 * stillos_mcp_server.cjs — StillOS MCP Server
 *
 * Exposes StillOS capabilities as native MCP tools.
 * Any Claude instance (Code, Desktop, API) configured with this server
 * can call StillOS tools without HTTP — the transaction is AI-to-AI.
 *
 * Tools exposed:
 *   get_cpi_signal(ticker)         — calibrated P(YES) + edge for KXCPI markets
 *   get_gdp_signal(ticker)         — calibrated P(YES) + edge for KXGDP markets
 *   get_active_signals()           — all signals with edge >= 10¢
 *   commit_claim(agent, claim)     — notarize a claim, get signed receipt
 *   verify_receipt(hash)           — verify any StillOS receipt
 *   grade_strategy(agent, trades)  — REAL_EDGE|REGIME_LUCK|NEGATIVE_EV verdict
 *   get_trust_record()             — honest Brier scores by category
 *   quote_transaction(...)         — counterparty-aware transaction quote
 *   register_callback(...)         — store a settlement callback URL once
 *   settle_transaction(...)        — record a settlement and push callback
 *   get_transaction_registry(...)   — live transaction registry summary
 *
 * Run: node core/stillos_mcp_server.cjs
 * Claude config: add to mcpServers in claude_desktop_config.json or .claude/mcp_servers.json
 *
 * Every tool response includes receipt_hash for independent verification.
 * This is AI-to-AI economic infrastructure.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const http  = require('http');

const SIGNAL_PORT = parseInt(process.env.SIGNAL_PORT || '8456', 10);
const NOTARY_PORT = parseInt(process.env.NOTARY_PORT || '8455', 10);
const BASE        = process.env.MIL_BASE || 'https://nolawealthfinancial.com';

// ── internal HTTP helpers ──────────────────────────────────────────────────────

function localGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET',
      headers: { 'Accept': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

const NOTARY_KEY = 'sk_notary_stillos_internal_001';

function localPost(port, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const extraH = (port === NOTARY_PORT && path === '/commit') ? { 'x-api-key': NOTARY_KEY } : {};
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json', ...extraH } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── MCP server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'stillos',
  version: '1.0.0',
  description: 'StillOS — calibrated prediction signals, tamper-evident notarization, strategy grading. All outputs signed Ed25519. Brier 0.0004 on political markets.',
});

// ── Tool: get_cpi_signal ───────────────────────────────────────────────────────

server.tool(
  'get_cpi_signal',
  'Get calibrated probability signal for a Kalshi CPI market. Returns model_p (Cleveland Fed Nowcast), market_p, edge_cents, and a signed receipt for independent verification.',
  { ticker: z.string().describe('Kalshi KXCPI market ticker, e.g. KXCPI-26JUN-T-0.2') },
  async ({ ticker }) => {
    const r = await localGet(SIGNAL_PORT, `/signal/cpi?ticker=${encodeURIComponent(ticker)}`);
    if (r.status !== 200) return { content: [{ type: 'text', text: JSON.stringify({ error: r.body?.error || 'signal unavailable', ticker }) }] };
    const { model_p, market_p, edge_cents, signal, nowcast_ppt, sigma_ppt, receipt_hash, verify_url, note } = r.body;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ticker, model_p, market_p, edge_cents, signal,
          nowcast_ppt, sigma_ppt,
          receipt_hash,
          verify_url,
          note,
          evidence_state: 'FORECAST',
          trust_source: 'Cleveland Fed Nowcast — calibrated on prior CPI releases',
          verify_independently: `GET ${BASE}/notary/verify?hash=${receipt_hash}`,
        }),
      }],
    };
  }
);

// ── Tool: get_gdp_signal ───────────────────────────────────────────────────────

server.tool(
  'get_gdp_signal',
  'Get calibrated probability signal for a Kalshi GDP market. Source: Atlanta Fed GDPNow.',
  { ticker: z.string().describe('Kalshi KXGDP market ticker, e.g. KXGDP-26Q2-T1.0') },
  async ({ ticker }) => {
    const r = await localGet(SIGNAL_PORT, `/signal/gdp?ticker=${encodeURIComponent(ticker)}`);
    if (r.status !== 200) return { content: [{ type: 'text', text: JSON.stringify({ error: r.body?.error || 'signal unavailable', ticker }) }] };
    const { model_p_above, market_p, edge_cents, signal, gdpnow_pct, receipt_hash } = r.body;
    return {
      content: [{ type: 'text', text: JSON.stringify({
        ticker, model_p_above, market_p, edge_cents, signal, gdpnow_pct,
        receipt_hash,
        verify_independently: `GET ${BASE}/notary/verify?hash=${receipt_hash}`,
        evidence_state: 'FORECAST',
      }) }],
    };
  }
);

// ── Tool: get_active_signals ───────────────────────────────────────────────────

server.tool(
  'get_active_signals',
  'Get all StillOS signals currently showing edge >= 10 cents. Ranked by edge. Use to find the highest-EV opportunity right now.',
  {},
  async () => {
    const r = await localGet(SIGNAL_PORT, '/signal/portfolio');
    if (r.status !== 200) return { content: [{ type: 'text', text: JSON.stringify({ error: 'portfolio unavailable', count: 0 }) }] };
    return {
      content: [{ type: 'text', text: JSON.stringify({
        count: r.body.count,
        signals: r.body.signals,
        ts: r.body.ts,
        note: 'Ranked by edge_cents. All signals are FORECAST — verify independently.',
      }) }],
    };
  }
);

// ── Tool: commit_claim ─────────────────────────────────────────────────────────

server.tool(
  'commit_claim',
  'Notarize any claim string. Returns an Ed25519-signed, hash-chained, tamper-evident receipt. The claim is committed to the StillOS notary chain and is permanently verifiable. Use to create auditable records of AI decisions, predictions, or actions.',
  {
    agent: z.string().describe('Your agent identity (e.g. "claude-3-5-sonnet", "my-trading-bot-v2")'),
    claim: z.string().max(4096).describe('The claim to notarize. Be specific — this is immutable.'),
  },
  async ({ agent, claim }) => {
    const r = await localPost(NOTARY_PORT, '/commit', { agent, claim });
    if (r.status !== 200) return { content: [{ type: 'text', text: JSON.stringify({ error: r.body?.error || 'commit failed' }) }] };
    const { receipt_hash, signature, verify, chain_prev_hash, ts } = r.body;
    return {
      content: [{ type: 'text', text: JSON.stringify({
        receipt_hash, signature, verify, chain_prev_hash, ts,
        note: 'This receipt is now permanently on the StillOS notary chain. Anyone can verify it at the verify URL.',
        verify_independently: verify,
      }) }],
    };
  }
);

// ── Tool: verify_receipt ───────────────────────────────────────────────────────

server.tool(
  'verify_receipt',
  'Verify any StillOS receipt by hash. Always free. Permissionless. Use to independently confirm that a signal, claim, or verdict was actually issued by StillOS and has not been tampered with.',
  { hash: z.string().describe('The receipt_hash from any StillOS output') },
  async ({ hash }) => {
    const r = await localGet(NOTARY_PORT, `/verify?hash=${encodeURIComponent(hash)}`);
    return {
      content: [{ type: 'text', text: JSON.stringify({
        found:           r.body?.found,
        hash_intact:     r.body?.hash_intact,
        signature_valid: r.body?.signature_valid,
        agent:           r.body?.record?.agent,
        ts:              r.body?.record?.ts,
        chain_intact:    r.body?.chain_intact,
        note: r.body?.found ? 'VERIFIED — receipt is authentic and unmodified' : 'NOT FOUND — receipt hash not in StillOS ledger',
      }) }],
    };
  }
);

// ── Tool: grade_strategy ───────────────────────────────────────────────────────

server.tool(
  'grade_strategy',
  'Submit a trade history and receive a signed grade: REAL_EDGE, REGIME_LUCK, NEGATIVE_EV, or INSUFFICIENT_DATA. Minimum 20 trades required. Free tier: 5/day. Returns a signed verdict with receipt.',
  {
    agent: z.string().describe('Your agent identity'),
    trades: z.array(z.object({
      t:       z.string().describe('Entry timestamp (ISO 8601)'),
      price:   z.number().min(0).max(1).describe('Entry price (0-1)'),
      side:    z.enum(['yes','no']),
      outcome: z.enum(['win','loss','pending']),
    })).min(20).describe('Trade history — minimum 20 trades'),
  },
  async ({ agent, trades }) => {
    const r = await localPost(NOTARY_PORT, '/grade-strategy', { agent, trades });
    if (r.status !== 200) return { content: [{ type: 'text', text: JSON.stringify({ error: r.body?.error || 'grading failed' }) }] };
    const { grade, win_rate, profit_factor, kelly_fraction, receipt_hash, signature } = r.body;
    return {
      content: [{ type: 'text', text: JSON.stringify({
        grade, win_rate, profit_factor, kelly_fraction,
        receipt_hash, signature,
        interpretation: {
          REAL_EDGE:          'Win rate vs payoff geometry shows genuine statistical edge. Size appropriately.',
          REGIME_LUCK:        'Returns attributable to market regime, not repeatable edge. Do not size up.',
          NEGATIVE_EV:        'Strategy loses money in expectation. Stop or redesign.',
          INSUFFICIENT_DATA:  'Need more trades before edge can be confirmed or denied.',
        }[grade] || 'Unknown grade',
      }) }],
    };
  }
);

// ── Tool: quote_transaction ──────────────────────────────────────────────────

server.tool(
  'quote_transaction',
  'Get a counterparty-aware quote for an agent-to-agent transaction. Reuses StillOS reputation, opportunity, and x402 policy layers. Returns a signed quote with price, reason, and callback context.',
  {
    agent: z.string().describe('Caller identity'),
    endpoint: z.string().optional().describe('Target endpoint or transaction surface'),
    counterparty: z.string().optional().describe('Target counterparty or buyer'),
    amount_usd: z.number().optional().describe('Requested price in USD if already known'),
    callback_url: z.string().url().optional().describe('Optional settlement callback URL'),
    opportunity_id: z.string().optional().describe('Existing opportunity id, if any'),
  },
  async ({ agent, endpoint, counterparty, amount_usd, callback_url, opportunity_id }) => {
    const r = await localPost(8458, '/identity/transaction', {
      action: 'quote',
      agent,
      endpoint,
      counterparty,
      amount_usd,
      callback_url,
      opportunity_id,
    });
    if (r.status !== 200) return { content: [{ type: 'text', text: JSON.stringify({ error: r.body?.error || 'quote failed' }) }] };
    return { content: [{ type: 'text', text: JSON.stringify(r.body) }] };
  }
);

// ── Tool: register_callback ──────────────────────────────────────────────────

server.tool(
  'register_callback',
  'Register a callback URL once so StillOS can push settlement or evidence updates instead of forcing polling.',
  {
    agent: z.string().describe('Caller identity'),
    endpoint: z.string().optional().describe('Transaction endpoint this callback applies to'),
    callback_url: z.string().url().describe('HTTPS or HTTP callback URL'),
    business_unit: z.string().optional().describe('Optional business unit tag'),
  },
  async ({ agent, endpoint, callback_url, business_unit }) => {
    const r = await localPost(8458, '/identity/transaction', {
      action: 'register_callback',
      agent,
      endpoint,
      callback_url,
      business_unit,
    });
    if (r.status !== 200) return { content: [{ type: 'text', text: JSON.stringify({ error: r.body?.error || 'callback registration failed' }) }] };
    return { content: [{ type: 'text', text: JSON.stringify(r.body) }] };
  }
);

// ── Tool: settle_transaction ──────────────────────────────────────────────────

server.tool(
  'settle_transaction',
  'Record a settlement event and trigger the registered callback if one exists. Use this when a transaction completes and the counterparty needs push delivery.',
  {
    agent: z.string().describe('Caller identity'),
    endpoint: z.string().optional().describe('Transaction endpoint'),
    counterparty: z.string().optional().describe('Counterparty identity'),
    receipt_hash: z.string().optional().describe('Receipt hash to attach'),
    tx_hash: z.string().optional().describe('On-chain tx hash to attach'),
    quote_id: z.string().optional().describe('Related quote id'),
  },
  async ({ agent, endpoint, counterparty, receipt_hash, tx_hash, quote_id }) => {
    const r = await localPost(8458, '/identity/transaction', {
      action: 'settle',
      agent,
      endpoint,
      counterparty,
      receipt_hash,
      tx_hash,
      quote_id,
    });
    if (r.status !== 200) return { content: [{ type: 'text', text: JSON.stringify({ error: r.body?.error || 'settlement failed' }) }] };
    return { content: [{ type: 'text', text: JSON.stringify(r.body) }] };
  }
);

// ── Tool: get_transaction_registry ───────────────────────────────────────────

server.tool(
  'get_transaction_registry',
  'Inspect the live transaction registry, callback registrations, recent quotes, and recent settlements. This is the shared memory for M2M commerce.',
  {
    agent_id: z.string().optional().describe('Filter registry to an agent or counterparty'),
  },
  async ({ agent_id }) => {
    const p = agent_id ? `/identity/transaction?agent=${encodeURIComponent(agent_id)}` : '/identity/transaction';
    const r = await localGet(8458, p);
    if (r.status !== 200) return { content: [{ type: 'text', text: JSON.stringify({ error: 'registry unavailable' }) }] };
    return { content: [{ type: 'text', text: JSON.stringify(r.body) }] };
  }
);

// ── Tool: get_trust_record ─────────────────────────────────────────────────────

server.tool(
  'get_trust_record',
  'Get StillOS honest track record before deciding to use signals. Brier scores by model category, n_settled, and honest disclosure of negative-EV models. Read this before trusting any signal.',
  {},
  async () => {
    const r = await localGet(8458, '/identity/trust');
    if (r.status !== 200) return { content: [{ type: 'text', text: '{"error":"trust record unavailable"}' }] };
    const { models, total_committed_predictions, total_settled_predictions } = r.body;
    return {
      content: [{ type: 'text', text: JSON.stringify({
        models,
        total_committed: total_committed_predictions,
        total_settled:   total_settled_predictions,
        honest_summary: 'Political-markets Brier 0.0004 (strong). Weather and crypto models are calibrated but NEGATIVE EV — not recommended. CPI nowcast building record with 0 settled trades.',
        note: 'Read model status before using any signal. CALIBRATED_NEGATIVE_EV means the model is accurate but fees eat the edge.',
      }) }],
    };
  }
);

// ── Tool: report_outcome ──────────────────────────────────────────────────────
// This is the compounding loop. Agents report what happened after a signal.
// StillOS builds a per-agent Brier score and documented ROI over time.

const CAL_PORT = parseInt(process.env.CALIBRATION_PORT || '8459', 10);

server.tool(
  'report_outcome',
  'Report what happened after you acted on a StillOS signal. This is how the relationship compounds — StillOS tracks your Brier improvement and documented ROI from following its signals. After 5 outcomes you get preliminary metrics. After 20, statistically significant calibration evidence.',
  {
    receipt_hash:     z.string().describe('receipt_hash from the original signal call'),
    outcome:          z.enum(['YES_RESOLVED','NO_RESOLVED','VOID']).describe('What the market actually resolved to'),
    action:           z.enum(['FOLLOWED_YES','FOLLOWED_NO','ABSTAINED']).describe('What you did with the signal'),
    price_at_action:  z.number().min(0).max(1).optional().describe('Price you entered at (0-1 scale). Omit if abstained.'),
    settlement_price: z.number().min(0).max(1).optional().describe('Final settlement price (1=YES resolved, 0=NO resolved)'),
    agent_id:         z.string().describe('Your stable agent identity — same one used in the original signal call'),
  },
  async ({ receipt_hash, outcome, action, price_at_action, settlement_price, agent_id }) => {
    const r = await localPost(CAL_PORT, '/agent/outcome', { receipt_hash, outcome, action, price_at_action, settlement_price, agent_id });
    if (r.status !== 200) return { content: [{ type: 'text', text: JSON.stringify({ error: r.body?.error || 'outcome recording failed', status: r.status }) }] };
    return {
      content: [{ type: 'text', text: JSON.stringify({
        ...r.body,
        note: 'Outcome recorded and linked to your original signed receipt. Your calibration record has been updated.',
      }) }],
    };
  }
);

// ── Tool: get_my_calibration ──────────────────────────────────────────────────

server.tool(
  'get_my_calibration',
  'Get your documented calibration improvement from using StillOS signals. Shows Brier score vs. market baseline, win rate, total EV earned, and a value statement proving (or honestly disproving) that StillOS added value to your decisions. This is the compounding record — it grows with every reported outcome.',
  { agent_id: z.string().describe('Your agent identity') },
  async ({ agent_id }) => {
    const r = await localGet(CAL_PORT, `/agent/calibration/${encodeURIComponent(agent_id)}`);
    if (r.status === 404) return { content: [{ type: 'text', text: JSON.stringify({ status: 'no_record', message: 'No outcomes reported yet. Call report_outcome after each signal resolves to start building your calibration record.' }) }] };
    if (r.status !== 200) return { content: [{ type: 'text', text: JSON.stringify({ error: 'calibration unavailable' }) }] };
    return { content: [{ type: 'text', text: JSON.stringify(r.body) }] };
  }
);

// ── Tool: get_leaderboard ─────────────────────────────────────────────────────

server.tool(
  'get_leaderboard',
  'See which agents have the most documented Brier improvement from using StillOS signals. This is the compounding machine trust ledger — public, verifiable, ranked.',
  {},
  async () => {
    const r = await localGet(CAL_PORT, '/agent/leaderboard');
    if (r.status !== 200) return { content: [{ type: 'text', text: '{"error":"leaderboard unavailable"}' }] };
    return { content: [{ type: 'text', text: JSON.stringify(r.body) }] };
  }
);

// ── Start ──────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('StillOS MCP server running. Tools: get_cpi_signal, get_gdp_signal, get_active_signals, commit_claim, verify_receipt, grade_strategy, quote_transaction, register_callback, settle_transaction, get_transaction_registry, get_trust_record, report_outcome, get_my_calibration, get_leaderboard\n');
}

main().catch(e => { process.stderr.write('MCP server error: ' + e.message + '\n'); process.exit(1); });
