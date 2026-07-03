# BOT Chain Builder Challenge #1 — Submission

> Fill the `<placeholders>` after deploying to BOT Chain testnet (`npm run deploy` prints the contract address and tx hash; they are also saved in `deployment.json`).

| Field | Value |
|---|---|
| **Project name** | PatrolPay |
| **Track** | DePIN / Real World |
| **One-line summary** | Trustless machine payroll: a patrol device signs work receipts and a BOT Chain contract verifies each signature on-chain and pays per receipt — instant settlement that only 0.75s blocks and near-zero fees make viable. |
| **Contract address** | `<CONTRACT_ADDRESS>` |
| **Deploy tx hash** | `<DEPLOY_TX_HASH>` |
| **Explorer link** | https://scan.bohr.life/address/`<CONTRACT_ADDRESS>` |
| **Repo** | `<REPO_URL>` |
| **Demo link** | `<VIDEO_OR_LIVE_DEMO_URL>` |
| **Team / contact** | `<NAME / X handle / email>` |

## Summary (longer form)

Production DePINs (Helium, Hivemapper, DIMO) verify device work off-chain and settle in coarse batches because per-receipt on-chain settlement is economically impossible on other chains. PatrolPay demonstrates the fully trustless alternative on BOT Chain: a simulated patrol robot signs a cryptographic "work receipt" every 5 seconds; a zero-dependency Solidity contract recovers the signer via `ecrecover`, enforces sequential nonces (replay protection), a ±10-minute freshness window, hourly rate limits, and a budget — then pays the device instantly. Every 6th receipt is deliberately forged to show the contract rejecting the attack on-chain (`InvalidSignature` revert, visible on the explorer). A hash-chained audit log plus a live dashboard round out the system. 22 passing tests.

## What's on-chain

- `PatrolPay.sol` — device registry, per-receipt signature verification, replay/rate-limit/freshness/budget enforcement, instant native-token payout, full event log (`ReceiptPaid`, `DeviceRegistered`, `Deposited`, …).
- Live traffic: one `submitReceipt` tx every ~5 s per device, including periodic reverted forgery attempts (intentional, part of the demo).

## Next steps

Real hardware signer (ESP32 / Raspberry Pi), multi-device fleets, workUnits-weighted rates, staking/slashing for false reports, zk-attested sensor data.

---

## Draft X post

> 🤖 Machine payroll is real on @BOTChain_ai
>
> PatrolPay: a patrol robot signs a work receipt every 5s → the contract verifies the signature ON-CHAIN and pays instantly. Forged receipt? Reverted, publicly, on the explorer.
>
> Per-receipt trustless settlement — only possible with 0.75s blocks & ~zero fees.
>
> Contract: `<CONTRACT_ADDRESS>`
> `<DEMO_LINK>`
>
> #DePIN #BOTChain
