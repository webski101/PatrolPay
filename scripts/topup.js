// PatrolPay — top up the contract budget by calling deposit().
// Usage:  node scripts/topup.js 0.1     (amount in BOT; defaults to 0.1)
"use strict";

const { ethers } = require("ethers");
const path = require("path");
const { loadEnv } = require(path.join(__dirname, "..", "lib", "env"));

async function main() {
  const env = loadEnv();
  const rpcUrl = env.RPC_URL || "https://rpc.bohr.life";
  const contract = env.CONTRACT_ADDRESS;
  const key = env.DEPLOYER_PRIVATE_KEY;
  if (!contract) throw new Error("CONTRACT_ADDRESS missing from .env");
  if (!key) throw new Error("DEPLOYER_PRIVATE_KEY missing from .env");

  const amountBot = process.argv[2] || "0.1";
  const value = ethers.parseEther(amountBot);

  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  const wallet = new ethers.Wallet(key, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`deployer ${wallet.address}`);
  console.log(`deployer balance: ${ethers.formatEther(balance)} BOT`);
  if (balance <= value) {
    throw new Error(
      `Not enough BOT to deposit ${amountBot} (need gas too). Claim more at https://faucet.botchain.ai/basic`
    );
  }

  const before = await provider.getBalance(contract);
  console.log(`contract budget before: ${ethers.formatEther(before)} BOT`);
  console.log(`depositing ${amountBot} BOT → ${contract} ...`);

  // deposit() — payable, selector 0xd0e30db0
  const tx = await wallet.sendTransaction({ to: contract, data: "0xd0e30db0", value });
  console.log(`tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`confirmed in block ${receipt.blockNumber} (status ${receipt.status === 1 ? "success" : "FAILED"})`);

  const after = await provider.getBalance(contract);
  console.log(`contract budget after: ${ethers.formatEther(after)} BOT`);
  console.log(`explorer: https://scan.bohr.life/tx/${tx.hash}`);
}

main().catch((err) => {
  console.error("topup failed:", err.message);
  process.exit(1);
});
