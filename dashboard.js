// PatrolPay dashboard — zero-dependency node:http server on port 3000.
//
// Polls the chain via raw JSON-RPC (eth_getLogs / eth_call / eth_getBalance)
// and tails audit-log.jsonl. Serves a single dark-theme HTML page showing the
// live receipts feed (green = paid, red = rejected forgery/replay), device
// earnings, remaining contract budget, and an audit-chain integrity check.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { loadEnv } = require("./lib/env");

const env = loadEnv();
const RPC_URL = env.RPC_URL || "https://rpc.bohr.life";
const EXPLORER = "https://scan.bohr.life";
const PORT = Number(env.PORT || 3000);
const AUDIT_LOG = path.join(__dirname, "audit-log.jsonl");
const CONTRACT = (env.CONTRACT_ADDRESS || "").toLowerCase();

// Precomputed constants (node:crypto has no keccak256, so these are baked in):
//   TOPIC_RECEIPT_PAID = keccak256("ReceiptPaid(address,uint256,uint256,bytes32,uint256)")
//   SEL_DEVICES        = keccak256("devices(address)")[0:4]
const TOPIC_RECEIPT_PAID = "0x414d23aba2fb1e43262f7ab4d6e2085ecfc857c1ad8176efe458cbc95cc6b852";
const SEL_DEVICES = "0xe7b4cac6";

// ------------------------------------------------------------------ JSON-RPC

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const hexToBigInt = (h) => (h && h !== "0x" ? BigInt(h) : 0n);
const word = (data, i) => "0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64); // i-th 32-byte word
const topicToAddress = (t) => "0x" + t.slice(26);
const formatEther = (wei) => {
  const s = wei.toString().padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18, -14)}`; // 4 decimal places
};

// ------------------------------------------------------------- chain polling

const state = {
  contract: CONTRACT,
  explorer: EXPLORER,
  rpcOk: false,
  budgetWei: "0",
  device: null, // { address, totalEarnedWei, totalReceipts, nextNonce, ratePerReceiptWei, active }
  paidEvents: [], // from eth_getLogs (authoritative on-chain record)
  feed: [], // unified chronological feed built from the audit log
  audit: { entries: 0, intact: null, lastError: null },
  deviceLastSeen: null,
  updatedAt: null,
};

let fromBlock = 0n;

async function pollChain() {
  if (!CONTRACT) return;
  try {
    if (fromBlock === 0n) {
      // First poll: look back ~20k blocks (~4h at 0.75s blocks).
      const latest = hexToBigInt(await rpc("eth_blockNumber", []));
      fromBlock = latest > 20000n ? latest - 20000n : 0n;
    }

    const logs = await rpc("eth_getLogs", [
      {
        address: CONTRACT,
        topics: [TOPIC_RECEIPT_PAID],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "latest",
      },
    ]);
    for (const log of logs) {
      // ReceiptPaid(address indexed device, uint256 indexed nonce,
      //             uint256 workUnits, bytes32 dataHash, uint256 amount)
      state.paidEvents.push({
        device: topicToAddress(log.topics[1]),
        nonce: hexToBigInt(log.topics[2]).toString(),
        workUnits: hexToBigInt(word(log.data, 0)).toString(),
        dataHash: word(log.data, 1),
        amountWei: hexToBigInt(word(log.data, 2)).toString(),
        txHash: log.transactionHash,
        block: Number(hexToBigInt(log.blockNumber)),
      });
      const next = hexToBigInt(log.blockNumber) + 1n;
      if (next > fromBlock) fromBlock = next;
    }
    if (state.paidEvents.length > 200) state.paidEvents = state.paidEvents.slice(-200);

    state.budgetWei = hexToBigInt(await rpc("eth_getBalance", [CONTRACT, "latest"])).toString();

    // devices(deviceAddress) — decode the 9-word struct return.
    const deviceAddr = state.deviceLastSeen?.address || state.paidEvents.at(-1)?.device;
    if (deviceAddr) {
      const data = SEL_DEVICES + deviceAddr.slice(2).toLowerCase().padStart(64, "0");
      const ret = await rpc("eth_call", [{ to: CONTRACT, data }, "latest"]);
      if (ret && ret.length >= 2 + 9 * 64) {
        state.device = {
          address: deviceAddr,
          registered: hexToBigInt(word(ret, 0)) === 1n,
          active: hexToBigInt(word(ret, 1)) === 1n,
          ratePerReceiptWei: hexToBigInt(word(ret, 2)).toString(),
          nextNonce: hexToBigInt(word(ret, 4)).toString(),
          totalEarnedWei: hexToBigInt(word(ret, 7)).toString(),
          totalReceipts: hexToBigInt(word(ret, 8)).toString(),
        };
      }
    }
    state.rpcOk = true;
  } catch (err) {
    state.rpcOk = false;
    console.error(`[chain] poll failed: ${err.message}`);
  }
  state.updatedAt = new Date().toISOString();
}

// ----------------------------------------------------------- audit log tail

function pollAuditLog() {
  if (!fs.existsSync(AUDIT_LOG)) {
    state.audit = { entries: 0, intact: null, lastError: "no audit log yet" };
    return;
  }
  const lines = fs.readFileSync(AUDIT_LOG, "utf8").split("\n").filter(Boolean);
  let prevHash = "0".repeat(64);
  let intact = true;
  const feed = [];
  let lastSeen = null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      intact = false;
      break;
    }
    // Recompute the chain: hash = sha256(prevHash + JSON(entry without hash)).
    // A restarted device starts a new segment (prevHash of all zeros), which
    // we accept but note — mid-file tampering still breaks the chain.
    const expected = crypto
      .createHash("sha256")
      .update(entry.prevHash + JSON.stringify({ ...entry, hash: undefined }))
      .digest("hex");
    if (entry.hash !== expected || (entry.prevHash !== prevHash && entry.prevHash !== "0".repeat(64))) {
      intact = false;
    }
    prevHash = entry.hash;

    if (entry.kind === "paid") {
      feed.push({
        ts: entry.ts,
        kind: "paid",
        nonce: entry.nonce,
        txHash: entry.txHash || null,
        block: entry.block ?? null,
      });
    } else if (entry.kind === "rejected" || entry.kind === "forged_rejected") {
      feed.push({
        ts: entry.ts,
        kind: "rejected",
        forged: entry.kind === "forged_rejected",
        nonce: entry.nonce,
        error: entry.error,
        txHash: entry.txHash || null,
      });
    }
    if (entry.kind === "receipt_created" || entry.kind === "forged_receipt_created") {
      lastSeen = { ts: entry.ts, address: entry.receipt?.device };
    } else if (entry.kind === "session_start") {
      lastSeen = { ts: entry.ts, address: entry.device };
    }
  }

  state.audit = { entries: lines.length, intact, lastError: null };
  state.feed = feed.slice(-100);
  if (lastSeen) state.deviceLastSeen = lastSeen;
}

// ------------------------------------------------------------------- server

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PatrolPay — machine payroll on BOT Chain</title>
<script>
  // Apply the saved theme before first paint to avoid a flash of wrong theme.
  try {
    if (localStorage.getItem("patrolpay-theme") === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    }
  } catch (e) {}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --bg: #0c0e11;
    --panel: #14171d;
    --panel2: #191d24;
    --line: rgba(255,255,255,.07);
    --line-strong: rgba(255,255,255,.14);
    --text: #e9ebee; --dim: #99a1ab; --faint: #656d78;
    --amber: #ffb020;      /* accent surfaces: tape, logo, bars */
    --link: #ffb020;       /* accent text/links (darkened in light mode for contrast) */
    --green: #35d07f; --red: #ff5d5d;
    --tape-dark: #111014;
    --hazard: repeating-linear-gradient(45deg, var(--amber) 0 10px, var(--tape-dark) 10px 20px);
    --header-bg: rgba(12,14,17,.82);
    --logo-ink: #0c0e11;
    --green-tint: rgba(53,208,127,.08); --green-line: rgba(53,208,127,.32);
    --amber-tint: rgba(255,176,32,.07); --amber-line: rgba(255,176,32,.32);
    --red-tint: rgba(255,93,93,.07);    --red-line: rgba(255,93,93,.32);
    --red-row: rgba(255,93,93,.035);    --red-stripe: rgba(255,93,93,.05);
    --pulse: rgba(53,208,127,.45);
    --bar-track: rgba(255,255,255,.06);
    --perf-dot: rgba(255,255,255,.17);
    --code-bg: rgba(255,255,255,.06);
    --sans: "Space Grotesk", -apple-system, "Segoe UI", system-ui, Roboto, sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace;
  }
  [data-theme="light"] {
    color-scheme: light;
    /* "paper payslip" — warm paper, payslip-white panels, darker amber for contrast */
    --bg: #f4f3ef;
    --panel: #ffffff;
    --panel2: #faf9f6;
    --line: #e3e0d8;
    --line-strong: #cfcbc0;
    --text: #21252b; --dim: #6b7280; --faint: #7c838c;
    --amber: #d98e00;
    --link: #b37400;
    --green: #1d9e5f; --red: #d64545;
    --tape-dark: #2a2a26;
    --header-bg: rgba(244,243,239,.85);
    --green-tint: rgba(29,158,95,.09);  --green-line: rgba(29,158,95,.4);
    --amber-tint: rgba(217,142,0,.09);  --amber-line: rgba(179,116,0,.45);
    --red-tint: rgba(214,69,69,.08);    --red-line: rgba(214,69,69,.4);
    --red-row: rgba(214,69,69,.04);     --red-stripe: rgba(214,69,69,.06);
    --pulse: rgba(29,158,95,.4);
    --bar-track: #e9e6dd;
    --perf-dot: #cfcbc0;
    --code-bg: #efede6;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 15px/1.5 var(--sans); min-height: 100vh; }
  a { color: var(--link); text-decoration: none; }
  :focus-visible { outline: 2px solid var(--link); outline-offset: 2px; border-radius: 4px; }
  .wrap { max-width: 1060px; margin: 0 auto; padding: 0 18px 40px; }

  /* ---- hazard tape ---- */
  .hazard-tape { height: 6px; background: var(--hazard); }

  /* ---- header ---- */
  header {
    position: sticky; top: 0; z-index: 10;
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    background: var(--header-bg); border-bottom: 1px solid var(--line);
  }
  .header-in { max-width: 1060px; margin: 0 auto; padding: 12px 18px; display: flex; align-items: center; gap: 12px; }
  .logo { width: 34px; height: 34px; border-radius: 7px; background: var(--amber); display: grid; place-items: center; flex: none; }
  .logo svg { width: 19px; height: 19px; }
  .logo svg path { fill: var(--logo-ink); }
  .wordmark { font-size: 17px; font-weight: 700; letter-spacing: .4px; }
  .wordmark small { display: block; font-size: 10px; font-weight: 600; color: var(--dim); letter-spacing: 2px; text-transform: uppercase; }
  .chip { font: 500 11.5px var(--mono); color: var(--dim); border: 1px solid var(--line-strong); border-radius: 6px; padding: 4px 11px; white-space: nowrap; background: var(--panel); }
  .spacer { flex: 1; }
  .rpc-chip { display: flex; align-items: center; gap: 7px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
  .dot.live { background: var(--green); box-shadow: 0 0 0 0 var(--pulse); animation: pulse 2s infinite; }
  .dot.down { background: var(--red); }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--pulse); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  .theme-btn {
    width: 34px; height: 34px; border-radius: 50%; padding: 0; flex: none;
    border: 1px solid var(--line-strong); background: var(--panel); color: var(--dim);
    display: grid; place-items: center; cursor: pointer;
  }
  .theme-btn:hover { color: var(--link); border-color: var(--link); }
  .theme-btn svg { width: 16px; height: 16px; }
  .icon-moon { display: none; }
  [data-theme="light"] .icon-sun { display: none; }
  [data-theme="light"] .icon-moon { display: block; }

  /* ---- hero: equipment plaque ---- */
  .hero { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; margin: 26px 0 18px; }
  .device-id { display: flex; align-items: center; gap: 13px; }
  .avatar { width: 46px; height: 46px; border-radius: 8px; background: var(--panel); border: 1px solid var(--line-strong); display: grid; place-items: center; font-size: 22px; }
  .device-id h1 { font-size: 17px; font-weight: 700; text-transform: uppercase; letter-spacing: 3.5px; border-left: 3px solid var(--amber); padding-left: 10px; }
  .addr { font: 12px var(--mono); color: var(--dim); word-break: break-all; padding-left: 13px; }
  .pill { display: inline-flex; align-items: center; gap: 7px; font: 700 11.5px var(--mono); letter-spacing: 1.6px; border-radius: 6px; padding: 6px 13px; text-transform: uppercase; }
  .pill.on  { color: var(--green); background: var(--green-tint); border: 1px solid var(--green-line); }
  .pill.idle{ color: var(--link);  background: var(--amber-tint); border: 1px solid var(--amber-line); }
  .pill.off { color: var(--red);   background: var(--red-tint);   border: 1px solid var(--red-line); }
  .contract-chip { margin-left: auto; font: 11.5px var(--mono); color: var(--dim); border: 1px solid var(--line-strong); background: var(--panel); border-radius: 6px; padding: 7px 12px; }
  .contract-chip b { color: var(--text); font-weight: 500; }

  /* ---- stats ---- */
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 12px; }
  .stat {
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    padding: 16px 18px; position: relative; overflow: hidden;
  }
  .stat::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; opacity: 0; }
  .stat.earn::before { opacity: 1; background: var(--amber); }
  .stat.block::before { opacity: 1; background: var(--red); }
  .stat.block { background-image: repeating-linear-gradient(-45deg, var(--red-stripe) 0 8px, transparent 8px 16px); }
  .stat .label { font-size: 10.5px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: var(--dim); }
  .stat .value { font: 700 26px/1.25 var(--mono); font-variant-numeric: tabular-nums; margin-top: 6px; }
  .stat .value .unit { font-size: 13px; font-weight: 500; color: var(--dim); margin-left: 4px; }
  .stat .sub { font: 11.5px var(--mono); font-variant-numeric: tabular-nums; color: var(--faint); margin-top: 3px; }
  .stat.earn .value { color: var(--link); }
  .stat.block .value { color: var(--red); }
  .bar { height: 7px; border-radius: 3px; background: var(--bar-track); margin-top: 10px; overflow: hidden; }
  .bar > i { display: block; height: 100%; border-radius: 3px; background: repeating-linear-gradient(45deg, var(--amber) 0 6px, var(--tape-dark) 6px 12px); transition: width .6s ease; }

  /* ---- audit strip ---- */
  .audit-strip {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    padding: 11px 16px; margin-bottom: 20px; font: 12.5px var(--mono); color: var(--dim);
  }
  .audit-strip .state { font-weight: 700; letter-spacing: 1px; }
  .audit-strip .state.ok { color: var(--green); } .audit-strip .state.bad { color: var(--red); }

  /* ---- payroll ledger ---- */
  .feed { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .feed-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 13px 18px; border-bottom: 1px solid var(--line); }
  .feed-head h2 { font-size: 12.5px; font-weight: 700; letter-spacing: 2.5px; text-transform: uppercase; }
  .legend { display: flex; gap: 14px; font: 11px var(--mono); letter-spacing: .5px; color: var(--dim); margin-left: auto; }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; }
  .legend .g i { background: var(--green); } .legend .r i { background: var(--red); }
  .row { display: flex; align-items: center; gap: 14px; padding: 12px 18px 12px 30px; border-bottom: 1px dashed var(--line-strong); position: relative; animation: slidein .25s ease; }
  .row:last-child { border-bottom: none; }
  /* perforated stub edge */
  .row::before {
    content: ""; position: absolute; left: 10px; top: 7px; bottom: 7px; width: 4px;
    background-image: radial-gradient(circle, var(--perf-dot) 1.3px, transparent 1.6px);
    background-size: 4px 9px; background-repeat: repeat-y;
  }
  /* transform-only: rows must stay visible even if animations are paused */
  @keyframes slidein { from { transform: translateY(-4px); } to { transform: none; } }
  .stamp {
    font: 700 10.5px var(--mono); letter-spacing: 2.5px; text-transform: uppercase;
    padding: 4px 9px; border: 2px solid currentColor; border-radius: 4px; flex: none;
  }
  .row.paid .stamp { color: var(--green); transform: rotate(-5deg); }
  .row.rejected .stamp { color: var(--red); transform: rotate(4deg); }
  .row.rejected { background: var(--red-row); }
  .row .body { min-width: 0; }
  .row .title { font-size: 13.5px; font-weight: 600; }
  .row.rejected .title { color: var(--red); }
  .row .amount { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--green); font-weight: 600; }
  .row .meta { font: 11.5px var(--mono); font-variant-numeric: tabular-nums; color: var(--faint); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tx-link { margin-left: auto; flex: none; font: 11.5px var(--mono); border: 1px solid var(--line-strong); border-radius: 5px; padding: 4px 10px; color: var(--link); }
  .tx-link:hover { border-color: var(--link); background: var(--amber-tint); }
  .empty { padding: 42px 18px; text-align: center; color: var(--dim); font-size: 13.5px; }
  .empty code { font-family: var(--mono); color: var(--text); background: var(--code-bg); padding: 2px 7px; border-radius: 5px; }

  footer { color: var(--faint); font: 11.5px var(--mono); margin-top: 16px; text-align: center; }

  @media (max-width: 860px) { .stats { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 480px) {
    .wrap { padding: 0 12px 30px; }
    .stats { gap: 9px; } .stat { padding: 13px 14px; } .stat .value { font-size: 21px; }
    .contract-chip { margin-left: 0; width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .legend { margin-left: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.live { animation: none; }
    .row { animation: none; }
    .bar > i { transition: none; }
  }
</style>
</head>
<body>
<div class="hazard-tape"></div>
<header>
  <div class="header-in">
    <div class="logo">
      <svg viewBox="0 0 24 24" fill="none"><path d="M13.2 2 4.8 13.4h5.6L9 22l8.4-11.4h-5.6L13.2 2z"/></svg>
    </div>
    <div class="wordmark">PatrolPay<small>machine payroll</small></div>
    <span class="chip">BOT CHAIN · TESTNET 968</span>
    <div class="spacer"></div>
    <span class="chip rpc-chip"><span class="dot" id="rpc-dot"></span><span id="rpc-text">connecting</span></span>
    <button class="theme-btn" id="theme-toggle" type="button" aria-label="Toggle light/dark theme">
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M19.4 4.6l-1.8 1.8M6.4 17.6l-1.8 1.8"/></svg>
      <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
    </button>
  </div>
</header>

<div class="wrap">
  <div class="hero">
    <div class="device-id">
      <div class="avatar">🤖</div>
      <div>
        <h1>Patrol Unit 01</h1>
        <div class="addr" id="device-addr">—</div>
      </div>
    </div>
    <span class="pill off" id="status-pill"><span class="dot" id="status-dot"></span><span id="status-text">OFFLINE</span></span>
    <a class="contract-chip" id="contract-link" target="_blank" href="#">contract <b id="contract-addr">—</b> ↗</a>
  </div>

  <div class="stats">
    <div class="stat earn">
      <div class="label">Device earnings</div>
      <div class="value"><span id="earnings">0.0000</span><span class="unit">BOT</span></div>
      <div class="sub" id="rate-sub">—</div>
    </div>
    <div class="stat">
      <div class="label">Receipts settled</div>
      <div class="value" id="receipts">0</div>
      <div class="sub" id="nonce-sub">next nonce —</div>
    </div>
    <div class="stat block">
      <div class="label">Forgeries blocked</div>
      <div class="value" id="forgeries">0</div>
      <div class="sub">rejected by ecrecover on-chain</div>
    </div>
    <div class="stat">
      <div class="label">Budget remaining</div>
      <div class="value"><span id="budget">0.0000</span><span class="unit">BOT</span></div>
      <div class="bar"><i id="budget-bar" style="width:0%"></i></div>
      <div class="sub" id="runway-sub">—</div>
    </div>
  </div>

  <div class="audit-strip">
    <span>🔗 AUDIT CHAIN</span>
    <span class="state" id="audit-state">—</span>
    <span id="audit-entries">0 entries</span>
    <span style="margin-left:auto">SHA-256 hash-chained log · recomputed every refresh</span>
  </div>

  <div class="feed">
    <div class="feed-head">
      <h2>Payroll ledger</h2>
      <div class="legend">
        <span class="g"><i></i>PAID — settled on-chain</span>
        <span class="r"><i></i>VOID — rejected</span>
      </div>
    </div>
    <div id="feed"><div class="empty">Nothing on the ledger yet — start the robot with <code>npm run device</code></div></div>
  </div>

  <footer>PatrolPay · per-receipt trustless settlement on BOT Chain · refreshes every 3s · <span id="updated"></span></footer>
</div>

<script>
const fmt = (wei) => {
  const s = BigInt(wei).toString().padStart(19, "0");
  return s.slice(0, -18) + "." + s.slice(-18, -14);
};
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const shortAddr = (a) => a ? a.slice(0, 8) + "…" + a.slice(-6) : "—";

// theme toggle: dark is the default (no attribute); light sets data-theme="light"
document.getElementById("theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const toLight = root.getAttribute("data-theme") !== "light";
  if (toLight) root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
  try { localStorage.setItem("patrolpay-theme", toLight ? "light" : "dark"); } catch (e) {}
});

function setPill(mode, label) {
  const pill = document.getElementById("status-pill");
  pill.className = "pill " + mode;
  document.getElementById("status-text").textContent = label;
  document.getElementById("status-dot").className = "dot" + (mode === "on" ? " live" : mode === "off" ? " down" : "");
}

async function refresh() {
  let s;
  try { s = await (await fetch("/api/state")).json(); } catch { return; }

  // header / hero
  document.getElementById("rpc-dot").className = "dot " + (s.rpcOk ? "live" : "down");
  document.getElementById("rpc-text").textContent = s.rpcOk ? "RPC LIVE" : "RPC DOWN";
  const link = document.getElementById("contract-link");
  document.getElementById("contract-addr").textContent = s.contract ? shortAddr(s.contract) : "not deployed";
  if (s.contract) link.href = s.explorer + "/address/" + s.contract;
  const deviceAddr = (s.device && s.device.address) || (s.deviceLastSeen && s.deviceLastSeen.address);
  document.getElementById("device-addr").textContent = deviceAddr || "waiting for device…";

  const lastSeen = s.deviceLastSeen ? new Date(s.deviceLastSeen.ts) : null;
  if (lastSeen && Date.now() - lastSeen.getTime() < 30000) setPill("on", "PATROLLING");
  else if (lastSeen) setPill("idle", "IDLE");
  else setPill("off", "OFFLINE");

  // stats
  const earned = s.device ? BigInt(s.device.totalEarnedWei) : 0n;
  const budget = BigInt(s.budgetWei || "0");
  const rate = s.device ? BigInt(s.device.ratePerReceiptWei) : 0n;
  document.getElementById("earnings").textContent = fmt(earned);
  document.getElementById("receipts").textContent = s.device ? s.device.totalReceipts : "0";
  document.getElementById("nonce-sub").textContent = s.device ? "next nonce " + s.device.nextNonce : "next nonce —";
  document.getElementById("rate-sub").textContent = rate ? "+" + fmt(rate) + " BOT per verified receipt" : "—";
  document.getElementById("forgeries").textContent = s.feed.filter(e => e.kind === "rejected" && e.forged).length;
  document.getElementById("budget").textContent = fmt(budget);
  const total = earned + budget;
  document.getElementById("budget-bar").style.width = total > 0n ? Number(budget * 100n / total) + "%" : "0%";
  document.getElementById("runway-sub").textContent = rate > 0n ? (budget / rate) + " receipts of runway" : "—";

  // audit strip
  const st = document.getElementById("audit-state");
  if (s.audit.intact === null) { st.className = "state"; st.textContent = "waiting for log"; }
  else if (s.audit.intact) { st.className = "state ok"; st.textContent = "✓ INTACT"; }
  else { st.className = "state bad"; st.textContent = "✗ BROKEN — log was tampered"; }
  document.getElementById("audit-entries").textContent = s.audit.entries + " entries";
  document.getElementById("updated").textContent = "last update " + new Date(s.updatedAt).toLocaleTimeString();

  // feed (audit log is chronological → newest first)
  const rows = s.feed.map(e => {
    const when = new Date(e.ts).toLocaleTimeString();
    if (e.kind === "paid") {
      return '<div class="row paid"><span class="stamp">PAID</span><div class="body">' +
        '<div class="title">Receipt #' + esc(e.nonce) + ' verified · <span class="amount">+' + (rate ? fmt(rate) : "") + ' BOT</span></div>' +
        '<div class="meta">' + (e.block ? "block " + esc(e.block) + " · " : "") + when + (e.txHash ? " · " + esc(e.txHash.slice(0, 18)) + "…" : "") + '</div></div>' +
        (e.txHash ? '<a class="tx-link" target="_blank" href="' + s.explorer + '/tx/' + esc(e.txHash) + '">tx ↗</a>' : "") + '</div>';
    }
    return '<div class="row rejected"><span class="stamp">VOID</span><div class="body">' +
      '<div class="title">' + (e.forged ? "Forged receipt #" + esc(e.nonce) + " blocked" : "Receipt #" + esc(e.nonce) + " rejected") + '</div>' +
      '<div class="meta">reverted: ' + esc(e.error) + ' · ' + when + '</div></div>' +
      (e.txHash ? '<a class="tx-link" target="_blank" href="' + s.explorer + '/tx/' + esc(e.txHash) + '">failed tx ↗</a>' : "") + '</div>';
  });
  if (rows.length) {
    document.getElementById("feed").innerHTML = rows.slice(-60).reverse().join("");
  }
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/api/state") {
    pollAuditLog(); // cheap, read on demand
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(state));
  } else if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
  } else {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`PatrolPay dashboard → http://localhost:${PORT}`);
  if (!CONTRACT) console.log("NOTE: CONTRACT_ADDRESS not set in .env — deploy first for live chain data.");
  pollAuditLog();
  pollChain();
  setInterval(pollChain, 4000);
});
