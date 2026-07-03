// Deploys PatrolPay, registers the device, deposits the initial budget.
// Usage: npx hardhat run scripts/deploy.js --network botTestnet
//
// Prints the contract address and tx hashes (needed for hackathon submission)
// and persists CONTRACT_ADDRESS (and a generated DEVICE_PRIVATE_KEY, if none
// existed) to .env. Private keys are never printed.
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");
const { loadEnv, saveEnvVar } = require("../lib/env");

async function main() {
  const env = loadEnv();
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No deployer account. Set DEPLOYER_PRIVATE_KEY in .env (fund it via https://faucet.botchain.ai/basic)."
    );
  }

  const ratePerReceipt = ethers.parseEther(env.RATE_PER_RECEIPT || "0.001");
  const maxReceiptsPerHour = BigInt(env.MAX_RECEIPTS_PER_HOUR || "720");
  const initialBudget = ethers.parseEther(env.INITIAL_BUDGET || "0.5");

  console.log(`Network:  ${network.name} (chainId ${network.config.chainId ?? "local"})`);
  console.log(`Deployer: ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${ethers.formatEther(balance)} native tokens\n`);

  // --- device key: reuse from .env or generate (written to .env, never printed)
  let deviceAddress;
  if (env.DEVICE_PRIVATE_KEY) {
    deviceAddress = new ethers.Wallet(env.DEVICE_PRIVATE_KEY).address;
    console.log(`Device:   ${deviceAddress} (key loaded from .env)`);
  } else {
    const deviceWallet = ethers.Wallet.createRandom();
    saveEnvVar("DEVICE_PRIVATE_KEY", deviceWallet.privateKey);
    deviceAddress = deviceWallet.address;
    console.log(`Device:   ${deviceAddress} (new key generated and saved to .env)`);
  }

  // --- deploy
  console.log("\nDeploying PatrolPay...");
  const contract = await (await ethers.getContractFactory("PatrolPay")).deploy();
  const deployTx = contract.deploymentTransaction();
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  // --- register device
  console.log("Registering device...");
  const registerTx = await contract.registerDevice(
    deviceAddress,
    ratePerReceipt,
    maxReceiptsPerHour
  );
  await registerTx.wait();

  // --- deposit budget
  console.log("Depositing initial budget...");
  const depositTx = await contract.deposit({ value: initialBudget });
  await depositTx.wait();

  saveEnvVar("CONTRACT_ADDRESS", contractAddress);

  const info = {
    network: network.name,
    chainId: Number(network.config.chainId ?? 31337),
    contractAddress,
    deployTxHash: deployTx.hash,
    registerTxHash: registerTx.hash,
    depositTxHash: depositTx.hash,
    deviceAddress,
    ratePerReceipt: ethers.formatEther(ratePerReceipt),
    maxReceiptsPerHour: Number(maxReceiptsPerHour),
    initialBudget: ethers.formatEther(initialBudget),
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(__dirname, "..", "deployment.json"),
    JSON.stringify(info, null, 2)
  );

  const explorer = network.name === "botTestnet" ? "https://scan.bohr.life" : null;
  console.log("\n================= DEPLOYMENT COMPLETE =================");
  console.log(`CONTRACT ADDRESS: ${contractAddress}`);
  console.log(`DEPLOY TX HASH:   ${deployTx.hash}`);
  console.log(`Register tx:      ${registerTx.hash}`);
  console.log(`Deposit tx:       ${depositTx.hash}`);
  console.log(`Device address:   ${deviceAddress}`);
  console.log(`Rate/receipt:     ${ethers.formatEther(ratePerReceipt)}`);
  console.log(`Budget:           ${ethers.formatEther(initialBudget)}`);
  if (explorer) {
    console.log(`\nExplorer: ${explorer}/address/${contractAddress}`);
    console.log(`          ${explorer}/tx/${deployTx.hash}`);
  }
  console.log("=======================================================");
  console.log("\nCONTRACT_ADDRESS saved to .env — next: `npm run device` and `npm run dashboard`.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
