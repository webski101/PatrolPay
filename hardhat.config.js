require("@nomicfoundation/hardhat-toolbox");
const { loadEnv } = require("./lib/env");

const env = loadEnv();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // "paris" avoids PUSH0 in case the target chain's EVM predates Shanghai.
      evmVersion: "paris",
    },
  },
  networks: {
    botTestnet: {
      url: env.RPC_URL || "https://rpc.bohr.life",
      chainId: 968,
      accounts: env.DEPLOYER_PRIVATE_KEY ? [env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};
