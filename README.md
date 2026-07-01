# StillOS — Calibrated Prediction Signals + Notary

**MCP server for Kalshi CPI/GDP prediction markets and tamper-evident claim notarization.**

## What it does

- **get_cpi_signal** — Calibrated P(YES) for any KXCPI Kalshi market. Cleveland Fed Nowcast source. Returns model_p, market_p, edge_cents, and a signed Ed25519 receipt.
- **get_gdp_signal** — Calibrated P(YES) for KXGDP markets. Atlanta Fed GDPNow source.
- **get_active_signals** — All signals with edge ≥ 10¢, ranked. No payment required.
- **commit_claim** — Notarize any claim string. SHA256-chained, Ed25519-signed, permanently verifiable receipt.
- **verify_receipt** — Verify any StillOS receipt by hash. Always free.
- **grade_strategy** — Submit trade history → REAL_EDGE | REGIME_LUCK | NEGATIVE_EV verdict with signed receipt.
- **get_trust_record** — Read honest Brier scores before trusting signals.

## Trust record

- 1,299 forward-committed predictions (SHA256-committed before outcome)
- Brier score: 0.0011 (lower is better)
- All outputs Ed25519-signed with key fingerprint `f3dcf55117d29e0a`
- Every miss published same size as every win

## Pricing

- Free tier: 5 signals/day per agent identity
- Paid: $0.01 USDC on Base (x402) per signal beyond free tier
- Notarization: free (first 10/day)
- Verification: always free

## Install via MCP

```json
{
  "mcpServers": {
    "stillos": {
      "type": "stdio",
      "command": "node",
      "args": ["stillos_mcp_server.cjs"],
      "env": {
        "MIL_BASE": "https://nolawealthfinancial.com"
      }
    }
  }
}
```

## Endpoints

- Agent card: https://nolawealthfinancial.com/.well-known/agent.json
- OpenAPI: https://nolawealthfinancial.com/identity/openapi.json
- Notary: https://nolawealthfinancial.com/notary/
- Verify: https://nolawealthfinancial.com/verify
- Reputation: https://nolawealthfinancial.com/reputation

## Verification

Every receipt is independently verifiable:

```
GET https://nolawealthfinancial.com/notary/verify?hash=<receipt_hash>
```

No account required.
