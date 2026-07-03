# PatrolPay — 60–90 second demo script

> Prep (before recording): contract already deployed (`npm run deploy` done, `.env` filled), dashboard open at http://localhost:3000, explorer tab open at https://scan.bohr.life/address/<CONTRACT_ADDRESS>. Delete `audit-log.jsonl` for a clean feed.

**0:00 — The pitch (one breath).**
"Every DePIN today verifies device work off-chain because per-receipt settlement is too expensive. On BOT Chain — 0.75-second blocks, near-zero fees — we settle every single work receipt on-chain. This is PatrolPay: trustless machine payroll."

**0:10 — Start the device.**
```bash
npm run device
```
Point at the terminal: "A patrol robot hits a waypoint every 5 seconds, signs a work receipt with its own secp256k1 key, and a relayer submits it — the device never needs gas."

**0:20 — Show the dashboard** (http://localhost:3000).
"Each green row is a receipt verified by `ecrecover` **on the chain itself** and paid instantly. Watch the earnings counter tick up and the contract budget tick down — machine payroll, receipt by receipt." Click a green **tx ↗** link → the explorer shows the real transaction on BOT Chain.

**0:40 — The attack.** Wait for the device terminal to print `⚠️ ATTACK DEMO — submitting FORGED receipt`.
"Now the attack: every 6th receipt we forge — signed with the wrong key. The contract recovers the signer, sees it isn't the device, and reverts with `InvalidSignature`." Point at the **red FORGERY REJECTED row** on the dashboard, and the failed tx link on the explorer. "No oracle, no operator decided that. The chain did."

**0:55 — Tamper-evidence.**
Point at the **Audit chain ✓** card: "Every receipt is also written to a SHA-256 hash-chained log — edit any historical entry and this flips to ✗."
(Optional 5s: open `audit-log.jsonl`, change one character, refresh → ✗ BROKEN. Undo it.)

**1:10 — Close.**
"Signature checks, replay protection, rate limits, budget — all enforced by ~200 lines of Solidity at per-receipt granularity. That's only economical at 0.75-second blocks and near-zero fees. That's the BOT Chain thesis, running live. PatrolPay."

---

### Fallback lines
- If a tx is slow: "Testnet hiccup — note the nonce is strictly sequential, so nothing can be replayed while we wait."
- If asked "why does the forged receipt still get submitted?": "Deliberately — we want the rejection **on-chain**, so the revert is publicly verifiable on the explorer, not just claimed in our logs."
