const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const RATE = ethers.parseEther("0.001");
const MAX_PER_HOUR = 5;

describe("PatrolPay", function () {
  let contract, contractAddress, owner, relayer, stranger, device, chainId;

  beforeEach(async function () {
    [owner, relayer, stranger] = await ethers.getSigners();
    // The device is a pure signing key — it never sends transactions itself.
    device = ethers.Wallet.createRandom();
    chainId = (await ethers.provider.getNetwork()).chainId;

    contract = await (await ethers.getContractFactory("PatrolPay")).deploy();
    await contract.waitForDeployment();
    contractAddress = await contract.getAddress();
  });

  async function makeReceipt(overrides = {}) {
    return {
      device: device.address,
      nonce: await contract.expectedNonce(device.address),
      workUnits: 1n,
      dataHash: ethers.keccak256(ethers.toUtf8Bytes("sensor-data")),
      timestamp: BigInt(await time.latest()),
      ...overrides,
    };
  }

  // Sign exactly what the contract reconstructs: EIP-191 personal-sign over
  // keccak256(abi.encodePacked(chainid, contract, device, nonce, workUnits,
  // dataHash, timestamp)).
  async function signReceipt(receipt, signer = device) {
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
    return signer.signMessage(ethers.getBytes(hash));
  }

  async function submit(receipt, signature) {
    return contract
      .connect(relayer)
      .submitReceipt(
        receipt.device,
        receipt.nonce,
        receipt.workUnits,
        receipt.dataHash,
        receipt.timestamp,
        signature
      );
  }

  async function registerAndFund(rate = RATE, maxPerHour = MAX_PER_HOUR, budget = "1") {
    await contract.registerDevice(device.address, rate, maxPerHour);
    await contract.deposit({ value: ethers.parseEther(budget) });
  }

  describe("deployment & owner controls", function () {
    it("sets the deployer as owner", async function () {
      expect(await contract.owner()).to.equal(owner.address);
    });

    it("registers a device and emits DeviceRegistered", async function () {
      await expect(contract.registerDevice(device.address, RATE, MAX_PER_HOUR))
        .to.emit(contract, "DeviceRegistered")
        .withArgs(device.address, RATE, MAX_PER_HOUR);
      const d = await contract.devices(device.address);
      expect(d.registered).to.be.true;
      expect(d.active).to.be.true;
      expect(d.ratePerReceipt).to.equal(RATE);
    });

    it("rejects registerDevice from non-owner", async function () {
      await expect(
        contract.connect(stranger).registerDevice(device.address, RATE, MAX_PER_HOUR)
      ).to.be.revertedWithCustomError(contract, "NotOwner");
    });

    it("rejects registerDevice with zero rate or zero rate limit", async function () {
      await expect(
        contract.registerDevice(device.address, 0, MAX_PER_HOUR)
      ).to.be.revertedWithCustomError(contract, "InvalidParams");
      await expect(
        contract.registerDevice(device.address, RATE, 0)
      ).to.be.revertedWithCustomError(contract, "InvalidParams");
    });

    it("accepts deposits and reports budget", async function () {
      await expect(contract.deposit({ value: ethers.parseEther("1") }))
        .to.emit(contract, "Deposited")
        .withArgs(owner.address, ethers.parseEther("1"));
      expect(await contract.budget()).to.equal(ethers.parseEther("1"));
    });

    it("lets the owner withdraw, and only the owner", async function () {
      await contract.deposit({ value: ethers.parseEther("1") });
      await expect(contract.withdraw(ethers.parseEther("0.4"))).to.emit(
        contract,
        "Withdrawn"
      );
      expect(await contract.budget()).to.equal(ethers.parseEther("0.6"));
      await expect(
        contract.connect(stranger).withdraw(1)
      ).to.be.revertedWithCustomError(contract, "NotOwner");
    });

    it("rejects pause from non-owner", async function () {
      await expect(contract.connect(stranger).pause()).to.be.revertedWithCustomError(
        contract,
        "NotOwner"
      );
    });
  });

  describe("submitReceipt — happy path", function () {
    it("pays the device for a valid receipt and emits ReceiptPaid", async function () {
      await registerAndFund();
      const receipt = await makeReceipt();
      const sig = await signReceipt(receipt);

      const before = await ethers.provider.getBalance(device.address);
      await expect(submit(receipt, sig))
        .to.emit(contract, "ReceiptPaid")
        .withArgs(device.address, 0n, 1n, receipt.dataHash, RATE);
      const after = await ethers.provider.getBalance(device.address);

      expect(after - before).to.equal(RATE);
      expect(await contract.expectedNonce(device.address)).to.equal(1n);
    });

    it("pays consecutive receipts with incrementing nonces and tracks totals", async function () {
      await registerAndFund();
      for (let i = 0; i < 3; i++) {
        const receipt = await makeReceipt();
        expect(receipt.nonce).to.equal(BigInt(i));
        await submit(receipt, await signReceipt(receipt));
      }
      const d = await contract.devices(device.address);
      expect(d.totalReceipts).to.equal(3n);
      expect(d.totalEarned).to.equal(RATE * 3n);
    });
  });

  describe("submitReceipt — forgery & tampering", function () {
    it("rejects a receipt signed by the wrong key", async function () {
      await registerAndFund();
      const receipt = await makeReceipt();
      const forger = ethers.Wallet.createRandom();
      const sig = await signReceipt(receipt, forger);
      await expect(submit(receipt, sig)).to.be.revertedWithCustomError(
        contract,
        "InvalidSignature"
      );
    });

    it("rejects a receipt whose payload was tampered after signing", async function () {
      await registerAndFund();
      const receipt = await makeReceipt();
      const sig = await signReceipt(receipt);
      const tampered = { ...receipt, workUnits: 999n };
      await expect(submit(tampered, sig)).to.be.revertedWithCustomError(
        contract,
        "InvalidSignature"
      );
    });

    it("rejects a garbage signature", async function () {
      await registerAndFund();
      const receipt = await makeReceipt();
      await expect(submit(receipt, "0x" + "ab".repeat(65))).to.be.revertedWithCustomError(
        contract,
        "InvalidSignature"
      );
      await expect(submit(receipt, "0x1234")).to.be.revertedWithCustomError(
        contract,
        "InvalidSignature"
      );
    });
  });

  describe("submitReceipt — replay protection", function () {
    it("rejects a replayed nonce", async function () {
      await registerAndFund();
      const receipt = await makeReceipt();
      const sig = await signReceipt(receipt);
      await submit(receipt, sig);
      // Exact same receipt + signature again.
      await expect(submit(receipt, sig)).to.be.revertedWithCustomError(
        contract,
        "ReplayedNonce"
      );
    });

    it("rejects an out-of-order (skipped) nonce", async function () {
      await registerAndFund();
      const receipt = await makeReceipt({ nonce: 5n });
      const sig = await signReceipt(receipt);
      await expect(submit(receipt, sig)).to.be.revertedWithCustomError(
        contract,
        "ReplayedNonce"
      );
    });
  });

  describe("submitReceipt — timestamp window", function () {
    it("rejects a stale timestamp (older than 10 minutes)", async function () {
      await registerAndFund();
      const receipt = await makeReceipt({
        timestamp: BigInt(await time.latest()) - 601n - 5n,
      });
      const sig = await signReceipt(receipt);
      await expect(submit(receipt, sig)).to.be.revertedWithCustomError(
        contract,
        "StaleTimestamp"
      );
    });

    it("rejects a timestamp from the future (beyond 10 minutes)", async function () {
      await registerAndFund();
      const receipt = await makeReceipt({
        timestamp: BigInt(await time.latest()) + 601n + 5n,
      });
      const sig = await signReceipt(receipt);
      await expect(submit(receipt, sig)).to.be.revertedWithCustomError(
        contract,
        "StaleTimestamp"
      );
    });
  });

  describe("submitReceipt — rate limiting", function () {
    it("rejects receipts beyond the hourly limit, then allows after the window", async function () {
      await registerAndFund(RATE, 2);
      for (let i = 0; i < 2; i++) {
        const receipt = await makeReceipt();
        await submit(receipt, await signReceipt(receipt));
      }
      const third = await makeReceipt();
      await expect(submit(third, await signReceipt(third))).to.be.revertedWithCustomError(
        contract,
        "RateLimitExceeded"
      );

      await time.increase(3601);
      const afterWindow = await makeReceipt();
      await expect(submit(afterWindow, await signReceipt(afterWindow))).to.emit(
        contract,
        "ReceiptPaid"
      );
    });
  });

  describe("submitReceipt — device registry", function () {
    it("rejects receipts from an unregistered device", async function () {
      await contract.deposit({ value: ethers.parseEther("1") });
      const receipt = await makeReceipt();
      const sig = await signReceipt(receipt);
      await expect(submit(receipt, sig)).to.be.revertedWithCustomError(
        contract,
        "DeviceNotRegistered"
      );
    });

    it("rejects receipts from a deactivated device", async function () {
      await registerAndFund();
      await expect(contract.deactivateDevice(device.address)).to.emit(
        contract,
        "DeviceDeactivated"
      );
      const receipt = await makeReceipt();
      const sig = await signReceipt(receipt);
      await expect(submit(receipt, sig)).to.be.revertedWithCustomError(
        contract,
        "DeviceNotRegistered"
      );
    });
  });

  describe("submitReceipt — pause & budget", function () {
    it("blocks receipts while paused and resumes after unpause", async function () {
      await registerAndFund();
      await contract.pause();
      const receipt = await makeReceipt();
      const sig = await signReceipt(receipt);
      await expect(submit(receipt, sig)).to.be.revertedWithCustomError(
        contract,
        "ContractPaused"
      );

      await contract.unpause();
      const fresh = await makeReceipt();
      await expect(submit(fresh, await signReceipt(fresh))).to.emit(
        contract,
        "ReceiptPaid"
      );
    });

    it("rejects a receipt when the budget cannot cover the rate", async function () {
      await contract.registerDevice(device.address, ethers.parseEther("2"), MAX_PER_HOUR);
      await contract.deposit({ value: ethers.parseEther("1") });
      const receipt = await makeReceipt();
      const sig = await signReceipt(receipt);
      await expect(submit(receipt, sig)).to.be.revertedWithCustomError(
        contract,
        "InsufficientBudget"
      );
    });

    it("pays until the budget is depleted, then rejects", async function () {
      // Budget covers exactly 2 receipts.
      await contract.registerDevice(device.address, ethers.parseEther("0.5"), MAX_PER_HOUR);
      await contract.deposit({ value: ethers.parseEther("1") });
      for (let i = 0; i < 2; i++) {
        const receipt = await makeReceipt();
        await submit(receipt, await signReceipt(receipt));
      }
      const broke = await makeReceipt();
      await expect(submit(broke, await signReceipt(broke))).to.be.revertedWithCustomError(
        contract,
        "InsufficientBudget"
      );
    });
  });
});
