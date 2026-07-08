# 🤖 PatrolPay — trustless machine payroll on BOT Chain

**A DePIN work-receipt settlement system.** A patrol device (sensor robot) cryptographically signs "work receipts" for every waypoint it visits. A Solidity contract on BOT Chain verifies each receipt's signature **on-chain**, rejects replays and forgeries, and pays the device **per verified receipt** — instant, trustless machine payroll with no off-chain oracle, no batching, no trust.

Built for the **BOT Chain Builder Challenge #1** — DePIN / Real World track.

## The BOT Chain thesis

Every production DePIN today (Helium, Hivemapper, DIMO, …) verifies device work **off-chain** and settles in coarse batches — epochs, daily rewards, merkle claims. Not because off-chain verification is better (it isn't: it reintroduces a trusted operator), but because **per-receipt on-chain settlement is economically impossible on other chains**:

| | Ethereum L1 | Typical L2 | **BOT Chain** |
|---|---|---|---|
| Block time | 12 s | 1–2 s | **0.75 s** |
| Cost per receipt (~90k gas) | dollars | cents | **~nothing** |
| Receipt every 5 s per device | absurd | still adds up × fleet × months | **viable** |

At 0.75-second blocks and near-zero fees, a device can be paid for each unit of work *the moment it happens*, with the signature verified by the chain itself. The trust model collapses to a single statement: **if the receipt wasn't signed by the device's key, it doesn't get paid.** That is what this project demonstrates end-to-end.

## Architecture

```
┌─────────────────────────┐      signed receipt        ┌──────────────────────────┐
│  device.js              │  {nonce, workUnits,        │  PatrolPay.sol           │
│  (patrol simulator)     │   dataHash, timestamp,     │  (BOT Chain testnet)     │
│                         │   secp256k1 signature}     │                          │
│  • walks waypoint route │ ─────────────────────────▶ │  • ecrecover == device?  │
│  • signs w/ DEVICE key  │      tx sent by            │  • nonce == expected?    │
│  • every 6th receipt    │      RELAYER key           │  • timestamp fresh?      │
│    FORGED (attack demo) │      (device needs no gas) │  • under hourly limit?   │
│  • hash-chained         │                            │  • budget sufficient?    │
│    audit log (JSONL)    │ ◀───────────────────────── │                          │
└───────────┬─────────────┘   payment to device /      │  ✅ pay ratePerReceipt   │
            │                 revert (custom error)    │  🛑 revert (forgery,     │
            │ tails audit log                          │     replay, stale, …)    │
            ▼                                          └────────────┬─────────────┘
┌─────────────────────────┐          eth_getLogs / eth_call         │
│  dashboard.js  :3000    │ ◀───────────────────────────────────────┘
│  live feed · earnings · budget · audit-chain integrity ✓/✗        │
└─────────────────────────┘
```

**Three components:**

1. **[`contracts/PatrolPay.sol`](contracts/PatrolPay.sol)** — zero-import Solidity. Owner registers devices (rate + hourly cap) and deposits a budget. `submitReceipt` recovers the signer via `ecrecover` over an EIP-191 personal-sign of `keccak256(chainid, contract, device, nonce, workUnits, dataHash, timestamp)` — binding chain id and contract address kills cross-chain/cross-contract replay; the strictly sequential nonce kills same-contract replay; the ±10-minute timestamp window kills receipt hoarding; the hourly rate limit caps a compromised key's damage. Every rejection is a typed custom error (`InvalidSignature`, `ReplayedNonce`, `StaleTimestamp`, `RateLimitExceeded`, `DeviceNotRegistered`, `InsufficientBudget`).
2. **[`device.js`](device.js)** — single-file simulator + relayer. Patrols a waypoint route every 5 s, hashes the sensor JSON (SHA-256 → `dataHash`), signs the receipt with the device key, and submits via the relayer key (the device never needs gas). **Every 6th receipt is deliberately forged** — signed with a random wrong key — and the on-chain rejection is the demo's proof of trustlessness. Every event is appended to a SHA-256 **hash-chained audit log** (`audit-log.jsonl`).
3. **[`dashboard.js`](dashboard.js)** — zero-dependency `node:http` server on port 3000. Polls `eth_getLogs`/`eth_call` via raw JSON-RPC, tails the audit log, and renders a dark, phone-friendly live feed: green = paid (explorer-linked tx), red = rejected forgery/replay with the revert reason, plus earnings, remaining budget, and a recomputed audit-chain integrity check.

**Dependency note:** the runtime uses exactly **one** dependency, `ethers` v6, and only in `device.js` — Node's built-in `crypto` has neither keccak256 nor recoverable secp256k1 signatures, and hand-rolling RLP + keccak wasn't worth hackathon hours. Everything else (audit hashing, `.env` parsing, dashboard RPC + server) is Node builtins. Hardhat is a devDependency for compile/test/deploy only.

## Network

| | |
|---|---|
| Chain | BOT Chain testnet, chain id **968** |
| RPC | https://rpc.bohr.life |
| Explorer | https://scan.bohr.life |
| Faucet | https://faucet.botchain.ai/basic |

## Setup & run

```bash
# 1. Install (toolchain only — runtime is plain node)
npm install

# 2. Configure
cp .env.example .env
#    put a funded testnet key in DEPLOYER_PRIVATE_KEY (faucet above)
#    and the same (or another funded) key in RELAYER_PRIVATE_KEY.
#    Leave DEVICE_PRIVATE_KEY and CONTRACT_ADDRESS blank — they are
#    generated/filled automatically and NEVER printed to the console.

# 3. Test (local hardhat network, 22 cases)
npm test

# 4. Deploy to BOT Chain testnet
#    deploys + registers the device + deposits budget,
#    prints CONTRACT ADDRESS and TX HASH (needed for submission),
#    and writes CONTRACT_ADDRESS into .env
npm run deploy

# 5. Run — two terminals
npm run device      # terminal 1: the robot starts patrolling & earning
npm run dashboard   # terminal 2: open http://localhost:3000
```

Local dry-run without testnet: `npx hardhat node`, then `npm run deploy:local` with `RPC_URL=http://127.0.0.1:8545` in `.env`, then steps 5 as above.

## How it works — plain language

- **The device** is just a keypair pretending to be a patrol robot. Every 5 seconds it "visits a waypoint," takes sensor readings, and produces a *receipt*: "I am device X, this is my receipt number N, here's a fingerprint (hash) of my sensor data, at this time." It signs that statement with its private key — something only the real device can do.
- **The relayer** is a plain wallet that wraps the signed receipt in a transaction and pays the gas. It can't cheat: it can only deliver what the device signed. Tamper with one byte and the signature no longer matches.
- **The contract** is the paymaster. For each receipt it checks: was this *really* signed by a registered device? Is the receipt number exactly the next one (no replays)? Is it fresh (±10 min)? Is the device under its hourly cap? Is there budget left? All yes → the device is paid instantly and a `ReceiptPaid` event is logged. Any no → the transaction reverts with a named reason. There is no admin who approves payments; the math approves them.
- **The forgery demo**: every 6th receipt, `device.js` plays attacker and signs with a random wrong key. The contract's `ecrecover` yields a different address than the device and reverts with `InvalidSignature` — visible live on the dashboard in red and on the block explorer as a failed transaction.
- **The audit log** is the device's flight recorder: every receipt and outcome is appended to a file where each line contains the SHA-256 hash of the previous line. Editing any historical line breaks every hash after it — the dashboard recomputes the chain and shows ✓ or ✗.

## Contract surface

```solidity
// owner
registerDevice(address device, uint256 ratePerReceipt, uint256 maxReceiptsPerHour)
deactivateDevice(address device)
deposit() payable            withdraw(uint256)
pause()                      unpause()

// anyone (relayer)
submitReceipt(address device, uint256 nonce, uint256 workUnits,
              bytes32 dataHash, uint256 timestamp, bytes signature)

// views
expectedNonce(address device)   budget()   devices(address)
```
Public tier was initially rate-limited to ~1,000 calls/day; the Renaiss team confirmed a hackathon tier of 10,000 calls/day as of [7/07/20226], which resolves the dual-source coverage gap documented above

## Tests

22 passing cases (`npm test`): valid receipt pays · consecutive nonces · forged signature · tampered payload · garbage signature · replayed nonce · skipped nonce · stale timestamp · future timestamp · hourly rate limit + window reset · unregistered device · deactivated device · pause/unpause · budget shortfall · budget depletion · owner-only controls · deposit/withdraw.

## Security notes

- `.env` holds all keys and is gitignored; `.env.example` ships placeholders. **No private key is ever printed** to console, logs, or dashboard — generated keys are written straight into `.env`.
- Signature malleability (high-`s`) is rejected; state is updated before the payment call (checks-effects-interactions); the digest binds chain id + contract address.
- Testnet tokens only — no real value.

## Next steps

Real hardware (ESP32/RPi signing on-device) · multi-device fleets with per-device dashboards · workUnits-weighted pay · staking/slashing for false anomaly reports · zk-attested sensor data.
