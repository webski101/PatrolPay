// PatrolPay device simulator + relayer.
//
// Simulates a patrol robot walking a waypoint route. Every tick it produces a
// work receipt {nonce, workUnits, dataHash, timestamp}, signs it with the
// DEVICE key (secp256k1, EIP-191 personal-sign), and submits it on-chain via
// the RELAYER key — the device itself never needs gas.
//
// Every 6th receipt is deliberately FORGED (signed with a random wrong key)
// to demonstrate the contract rejecting the attack on-chain.
//
// Every receipt/submission/result is appended to a SHA-256 hash-chained audit
// log (audit-log.jsonl): each entry embeds the previous entry's hash, so any
// tampering breaks the chain (the dashboard verifies it).
//
// Dependency note: uses `ethers` v6 for secp256k1 signing, ABI encoding and
// tx submission. Node's built-in crypto has no keccak256 or recoverable
// secp256k1 signatures, so hand-rolling those was not worth the hackathon
// hours — everything else (hashing, audit chain, env parsing) is node builtins.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { loadEnv, saveEnvVar } = require("./lib/env");

const env = loadEnv();
const RPC_URL = env.RPC_URL || "https://rpc.bohr.life";
const EXPLORER = "https://scan.bohr.life";
const TICK_MS = 5000;
const FORGE_EVERY = 6; // every 6th receipt is the attack demo
const AUDIT_LOG = path.join(__dirname, "audit-log.jsonl");

const ABI = [
  "function submitReceipt(address device, uint256 nonce, uint256 workUnits, bytes32 dataHash, uint256 timestamp, bytes signature)",
  "function expectedNonce(address device) view returns (uint256)",
  "function budget() view returns (uint256)",
  "function devices(address) view returns (bool registered, bool active, uint256 ratePerReceipt, uint256 maxReceiptsPerHour, uint256 nextNonce, uint256 windowStart, uint256 receiptsInWindow, uint256 totalEarned, uint256 totalReceipts)",
  "error NotOwner()",
  "error ContractPaused()",
  "error DeviceNotRegistered()",
  "error InvalidSignature()",
  "error ReplayedNonce()",
  "error StaleTimestamp()",
  "error RateLimitExceeded()",
  "error InsufficientBudget()",
  "error TransferFailed()",
  "error InvalidParams()",
];

// ---------------------------------------------------------------- audit log

let lastAuditHash = "0".repeat(64);

// Resume the chain from an existing log so restarts don't break integrity.
function initAuditChain() {
  if (!fs.existsSync(AUDIT_LOG)) return;
  const lines = fs.readFileSync(AUDIT_LOG, "utf8").split("\n").filter(Boolean);
  if (lines.length) {
    try {
      lastAuditHash = JSON.parse(lines[lines.length - 1]).hash;
    } catch {
      console.warn("[audit] could not parse last log entry; starting a fresh chain segment");
    }
  }
}

function auditAppend(entry) {
  const record = { ...entry, ts: new Date().toISOString(), prevHash: lastAuditHash };
  record.hash = crypto
    .createHash("sha256")
    .update(record.prevHash + JSON.stringify({ ...record, hash: undefined }))
    .digest("hex");
  fs.appendFileSync(AUDIT_LOG, JSON.stringify(record) + "\n");
  lastAuditHash = record.hash;
}

// ---------------------------------------------------- patrol work simulation

const WAYPOINTS = [
  { id: "WP-01", name: "North Gate", lat: 6.5244, lng: 3.3792 },
  { id: "WP-02", name: "Warehouse A", lat: 6.5251, lng: 3.3801 },
  { id: "WP-03", name: "Loading Dock", lat: 6.5259, lng: 3.3795 },
  { id: "WP-04", name: "Perimeter East", lat: 6.5263, lng: 3.3811 },
  { id: "WP-05", name: "Server Room Door", lat: 6.5249, lng: 3.3808 },
  { id: "WP-06", name: "South Fence", lat: 6.5238, lng: 3.3799 },
];

const patrol = { waypointIndex: 0, battery: 100, lapsCompleted: 0 };

function doPatrolWork() {
  const waypoint = WAYPOINTS[patrol.waypointIndex];
  patrol.waypointIndex = (patrol.waypointIndex + 1) % WAYPOINTS.length;
  if (patrol.waypointIndex === 0) patrol.lapsCompleted++;
  patrol.battery = Math.max(5, patrol.battery - Math.random() * 0.4);

  const anomaly =
    Math.random() < 0.12
      ? ["motion detected", "door ajar", "unexpected heat source"][Math.floor(Math.random() * 3)]
      : null;

  return {
    waypointId: waypoint.id,
    waypointName: waypoint.name,
    lat: +(waypoint.lat + (Math.random() - 0.5) * 1e-4).toFixed(6),
    lng: +(waypoint.lng + (Math.random() - 0.5) * 1e-4).toFixed(6),
    batteryPct: +patrol.battery.toFixed(1),
    temperatureC: +(24 + Math.random() * 6).toFixed(1),
    anomaly,
    lap: patrol.lapsCompleted,
    recordedAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------------------ signing

function signReceipt(wallet, chainId, contractAddress, receipt) {
  const hash = ethers.solidityPackedKeccak256(
    ["uint256", "address", "address", "uint256", "uint256", "bytes32", "uint256"],
    [
      chainId,
      contractAddress,
      receipt.device,
      receipt.nonce,
      receipt.workUnits,
      receipt.dataHash,
      receipt.timestamp,
    ]
  );
  return wallet.signMessage(ethers.getBytes(hash)); // adds the EIP-191 prefix
}

function decodeRevert(iface, err) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      const parsed = iface.parseError(data);
      if (parsed) return parsed.name;
    } catch {}
  }
  if (err?.revert?.name) return err.revert.name;
  return err?.shortMessage || err?.message || "unknown revert";
}

// --------------------------------------------------------------------- main

async function main() {
  if (!env.CONTRACT_ADDRESS) {
    console.error("CONTRACT_ADDRESS missing in .env — run `npm run deploy` first.");
    process.exit(1);
  }
  if (!env.RELAYER_PRIVATE_KEY) {
    console.error("RELAYER_PRIVATE_KEY missing in .env (can be the same key as the deployer).");
    process.exit(1);
  }

  let devicePrivateKey = env.DEVICE_PRIVATE_KEY;
  if (!devicePrivateKey) {
    const generated = ethers.Wallet.createRandom();
    saveEnvVar("DEVICE_PRIVATE_KEY", generated.privateKey);
    devicePrivateKey = generated.privateKey;
    console.log(
      `[device] No DEVICE_PRIVATE_KEY found — generated one and saved it to .env (not shown here).\n` +
        `[device] NOTE: the on-chain registration from deploy is tied to the OLD device address, ` +
        `so if you deployed already, re-run the deploy or register ${generated.address} manually.`
    );
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const relayer = new ethers.Wallet(env.RELAYER_PRIVATE_KEY, provider);
  const deviceWallet = new ethers.Wallet(devicePrivateKey);
  const contract = new ethers.Contract(env.CONTRACT_ADDRESS, ABI, relayer);
  const chainId = (await provider.getNetwork()).chainId;

  initAuditChain();

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  PatrolPay device simulator — machine payroll online  ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  Chain:    ${chainId} @ ${RPC_URL}`);
  console.log(`  Contract: ${env.CONTRACT_ADDRESS}`);
  console.log(`  Device:   ${deviceWallet.address}`);
  console.log(`  Relayer:  ${relayer.address}`);
  console.log(`  Tick:     every ${TICK_MS / 1000}s — every ${FORGE_EVERY}th receipt is FORGED (attack demo)\n`);

  auditAppend({ kind: "session_start", device: deviceWallet.address, contract: env.CONTRACT_ADDRESS, chainId: Number(chainId) });

  let tick = 0;
  let running = false;

  async function patrolTick() {
    if (running) return; // don't overlap slow ticks
    running = true;
    tick++;
    const forged = tick % FORGE_EVERY === 0;

    try {
      const sensorData = doPatrolWork();
      const dataHash = "0x" + crypto.createHash("sha256").update(JSON.stringify(sensorData)).digest("hex");
      const nonce = await contract.expectedNonce(deviceWallet.address);
      const receipt = {
        device: deviceWallet.address,
        nonce,
        workUnits: 1n,
        dataHash,
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
      };

      let signer = deviceWallet;
      if (forged) {
        signer = ethers.Wallet.createRandom(); // attacker's key — signature won't recover to the device
        console.log(`\n[#${tick}] ⚠️  ATTACK DEMO — submitting FORGED receipt (signed by random key, not the device)`);
      } else {
        console.log(
          `\n[#${tick}] 🤖 Patrol: reached ${sensorData.waypointName} (${sensorData.waypointId})` +
            ` | battery ${sensorData.batteryPct}% | ${sensorData.temperatureC}°C` +
            (sensorData.anomaly ? ` | 🚨 ${sensorData.anomaly}` : "")
        );
      }

      const signature = await signReceipt(signer, chainId, env.CONTRACT_ADDRESS, receipt);
      const args = [receipt.device, receipt.nonce, receipt.workUnits, receipt.dataHash, receipt.timestamp, signature];

      auditAppend({
        kind: forged ? "forged_receipt_created" : "receipt_created",
        receipt: {
          device: receipt.device,
          nonce: receipt.nonce.toString(),
          workUnits: receipt.workUnits.toString(),
          dataHash: receipt.dataHash,
          timestamp: receipt.timestamp.toString(),
        },
        sensorData,
        signature,
      });

      // Pre-flight to capture the exact contract verdict (custom error name).
      let verdict = "OK";
      try {
        await contract.submitReceipt.staticCall(...args);
      } catch (err) {
        verdict = decodeRevert(contract.interface, err);
      }

      if (verdict === "OK") {
        const tx = await contract.submitReceipt(...args);
        console.log(`[#${tick}]    submitted tx ${tx.hash} — waiting for confirmation...`);
        const rcpt = await tx.wait();
        console.log(`[#${tick}] ✅ PAID — receipt #${receipt.nonce} verified on-chain in block ${rcpt.blockNumber}`);
        console.log(`[#${tick}]    ${EXPLORER}/tx/${tx.hash}`);
        auditAppend({ kind: "paid", nonce: receipt.nonce.toString(), txHash: tx.hash, block: rcpt.blockNumber });
      } else {
        // Send it anyway with a fixed gas limit so the rejection is visible
        // on-chain (a reverted tx on the explorer — the demo's money shot).
        let txHash = null;
        try {
          const tx = await contract.submitReceipt(...args, { gasLimit: 300000 });
          txHash = tx.hash;
          await tx.wait();
        } catch (err) {
          txHash = txHash || err?.receipt?.hash || null;
        }
        const label = forged ? "🛑 FORGERY REJECTED" : "🛑 REJECTED";
        console.log(`[#${tick}] ${label} — contract reverted with ${verdict}${txHash ? `\n[#${tick}]    on-chain revert: ${EXPLORER}/tx/${txHash}` : ""}`);
        auditAppend({ kind: forged ? "forged_rejected" : "rejected", nonce: receipt.nonce.toString(), error: verdict, txHash });
      }
    } catch (err) {
      console.error(`[#${tick}] ❌ error: ${err.shortMessage || err.message}`);
      auditAppend({ kind: "error", error: String(err.shortMessage || err.message) });
    } finally {
      running = false;
    }
  }

  await patrolTick();
  setInterval(patrolTick, TICK_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
