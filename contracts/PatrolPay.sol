// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PatrolPay — trustless per-receipt settlement for DePIN work
/// @notice Devices sign "work receipts" off-chain with their secp256k1 key.
///         Anyone (a relayer) can submit a receipt; the contract verifies the
///         device's signature on-chain, rejects replays / forgeries / stale
///         receipts, and pays the device instantly per verified receipt.
///         Viable only on chains with sub-second blocks and near-zero fees.
contract PatrolPay {
    // ---------------------------------------------------------------- state

    address public owner;
    bool public paused;

    struct Device {
        bool registered;
        bool active;
        uint256 ratePerReceipt; // wei paid per verified receipt
        uint256 maxReceiptsPerHour; // hourly rate limit
        uint256 nextNonce; // expected nonce of the next receipt
        uint256 windowStart; // start of the current rate-limit window
        uint256 receiptsInWindow; // receipts paid in the current window
        uint256 totalEarned; // lifetime wei earned
        uint256 totalReceipts; // lifetime receipts paid
    }

    mapping(address => Device) public devices;

    uint256 public constant TIMESTAMP_TOLERANCE = 10 minutes;

    // --------------------------------------------------------------- errors

    error NotOwner();
    error ContractPaused();
    error DeviceNotRegistered();
    error InvalidSignature();
    error ReplayedNonce();
    error StaleTimestamp();
    error RateLimitExceeded();
    error InsufficientBudget();
    error TransferFailed();
    error InvalidParams();

    // --------------------------------------------------------------- events

    event DeviceRegistered(
        address indexed device,
        uint256 ratePerReceipt,
        uint256 maxReceiptsPerHour
    );
    event DeviceDeactivated(address indexed device);
    event ReceiptPaid(
        address indexed device,
        uint256 indexed nonce,
        uint256 workUnits,
        bytes32 dataHash,
        uint256 amount
    );
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event PauseSet(bool paused);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // -------------------------------------------------------------- funding

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function deposit() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external onlyOwner {
        (bool ok, ) = owner.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(owner, amount);
    }

    function budget() external view returns (uint256) {
        return address(this).balance;
    }

    // ------------------------------------------------------- owner controls

    function registerDevice(
        address deviceAddr,
        uint256 ratePerReceipt,
        uint256 maxReceiptsPerHour
    ) external onlyOwner {
        if (deviceAddr == address(0) || ratePerReceipt == 0 || maxReceiptsPerHour == 0) {
            revert InvalidParams();
        }
        Device storage d = devices[deviceAddr];
        d.registered = true;
        d.active = true;
        d.ratePerReceipt = ratePerReceipt;
        d.maxReceiptsPerHour = maxReceiptsPerHour;
        emit DeviceRegistered(deviceAddr, ratePerReceipt, maxReceiptsPerHour);
    }

    function deactivateDevice(address deviceAddr) external onlyOwner {
        devices[deviceAddr].active = false;
        emit DeviceDeactivated(deviceAddr);
    }

    function pause() external onlyOwner {
        paused = true;
        emit PauseSet(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PauseSet(false);
    }

    // ------------------------------------------------------ receipt settling

    /// @notice Verify a device-signed work receipt and pay the device.
    /// @dev The signature is an EIP-191 personal-sign over
    ///      keccak256(abi.encodePacked(chainid, address(this), device, nonce,
    ///      workUnits, dataHash, timestamp)). Binding the chain id and this
    ///      contract's address into the digest prevents cross-chain and
    ///      cross-contract replay; the sequential nonce prevents same-contract
    ///      replay.
    function submitReceipt(
        address device,
        uint256 nonce,
        uint256 workUnits,
        bytes32 dataHash,
        uint256 timestamp,
        bytes calldata signature
    ) external {
        if (paused) revert ContractPaused();

        Device storage d = devices[device];
        if (!d.registered || !d.active) revert DeviceNotRegistered();
        if (nonce != d.nextNonce) revert ReplayedNonce();
        if (
            timestamp + TIMESTAMP_TOLERANCE < block.timestamp ||
            timestamp > block.timestamp + TIMESTAMP_TOLERANCE
        ) revert StaleTimestamp();

        // Hourly rate limit: fixed windows anchored at the first receipt
        // after each expiry.
        if (block.timestamp >= d.windowStart + 1 hours) {
            d.windowStart = block.timestamp;
            d.receiptsInWindow = 0;
        }
        if (d.receiptsInWindow >= d.maxReceiptsPerHour) revert RateLimitExceeded();

        bytes32 messageHash = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                device,
                nonce,
                workUnits,
                dataHash,
                timestamp
            )
        );
        bytes32 ethSignedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        if (_recover(ethSignedHash, signature) != device) revert InvalidSignature();

        uint256 amount = d.ratePerReceipt;
        if (address(this).balance < amount) revert InsufficientBudget();

        // Effects before interaction (payment).
        d.nextNonce = nonce + 1;
        d.receiptsInWindow += 1;
        d.totalEarned += amount;
        d.totalReceipts += 1;

        (bool ok, ) = device.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit ReceiptPaid(device, nonce, workUnits, dataHash, amount);
    }

    /// @notice Nonce the device must use for its next receipt.
    function expectedNonce(address device) external view returns (uint256) {
        return devices[device].nextNonce;
    }

    // -------------------------------------------------------------- helpers

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert InvalidSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignature();
        // Reject malleable (high-s) signatures.
        if (
            uint256(s) >
            0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
        ) revert InvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}
