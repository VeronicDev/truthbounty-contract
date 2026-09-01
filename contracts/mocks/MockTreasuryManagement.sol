// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../treasury/ITreasuryManagement.sol";

/**
 * @title MockTreasuryManagement
 * @dev Lightweight test double for ITreasuryManagement that records calls
 *      without enforcing token-flow invariants. Used by unit-test fixtures
 *      that deploy protocol modules but do not need real treasury accounting.
 */
contract MockTreasuryManagement is ITreasuryManagement {
    // ============ Tracking State ============

    mapping(TreasuryPool => uint256) public poolBalances;
    uint256 public totalAssetsRecorded;
    uint256 public totalDeposits;
    uint256 public totalWithdrawals;

    mapping(address => bool) public authorisedModules;

    // Record tracking
    uint256 public recordCount;

    // ============ Deposit Tracking ============

    function recordStakeDeposit(address user, uint256 amount) external {
        poolBalances[TreasuryPool.STAKING_RESERVE] += amount;
        totalAssetsRecorded += amount;
        totalDeposits += amount;
        recordCount++;
    }

    function recordFeeDeposit(address source, uint256 amount) external {
        poolBalances[TreasuryPool.PROTOCOL_FEES] += amount;
        totalAssetsRecorded += amount;
        totalDeposits += amount;
        recordCount++;
    }

    function recordSlashDeposit(address verifier, uint256 amount) external {
        // Slash: staking → slashing (internal transfer)
        poolBalances[TreasuryPool.STAKING_RESERVE] -= amount;
        poolBalances[TreasuryPool.SLASHING_RESERVE] += amount;
        recordCount++;
    }

    function recordGovernanceDeposit(address source, uint256 amount) external {
        poolBalances[TreasuryPool.GOVERNANCE_RESERVE] += amount;
        totalAssetsRecorded += amount;
        totalDeposits += amount;
        recordCount++;
    }

    // ============ Withdrawal Tracking ============

    function recordRewardWithdrawal(address recipient, uint256 amount) external {
        poolBalances[TreasuryPool.REWARDS_POOL] -= amount;
        totalAssetsRecorded -= amount;
        totalWithdrawals += amount;
        recordCount++;
    }

    function recordSettlementWithdrawal(address recipient, uint256 amount) external {
        poolBalances[TreasuryPool.PROTOCOL_FEES] -= amount;
        totalAssetsRecorded -= amount;
        totalWithdrawals += amount;
        recordCount++;
    }

    // ============ ITreasuryManagement Stubs ============

    function depositToPool(TreasuryPool pool, uint256 amount) external {
        poolBalances[pool] += amount;
        totalAssetsRecorded += amount;
        totalDeposits += amount;
        recordCount++;
    }

    function withdrawFromPool(TreasuryPool pool, address recipient, uint256 amount) external {
        poolBalances[pool] -= amount;
        totalAssetsRecorded -= amount;
        totalWithdrawals += amount;
        recordCount++;
    }

    function emergencyWithdrawal(address recipient, uint256 amount) external {
        totalAssetsRecorded -= amount;
        totalWithdrawals += amount;
        recordCount++;
    }

    function transferBetweenPools(
        TreasuryPool fromPool,
        TreasuryPool toPool,
        uint256 amount,
        string calldata reason
    ) external {
        poolBalances[fromPool] -= amount;
        poolBalances[toPool] += amount;
        recordCount++;
    }

    // ============ View Stubs ============

    function getPoolBalance(TreasuryPool pool) external view returns (PoolBalance memory) {
        return PoolBalance({
            currentBalance: poolBalances[pool],
            totalDeposited: 0,
            totalWithdrawn: 0,
            lastUpdatedBlock: block.number,
            lastUpdatedTimestamp: block.timestamp
        });
    }

    function getAllPoolBalances() external view returns (PoolBalance[7] memory balances) {
        for (uint256 i = 0; i < 7; i++) {
            balances[i].currentBalance = poolBalances[TreasuryPool(i)];
        }
    }

    function getTotalAssets() external view returns (uint256) {
        return totalAssetsRecorded;
    }

    function getRecord(uint256 index) external pure returns (TreasuryRecord memory) {
        return TreasuryRecord({
            recordId: bytes32(0),
            from: address(0),
            to: address(0),
            amount: 0,
            fromPool: TreasuryPool.STAKING_RESERVE,
            toPool: TreasuryPool.STAKING_RESERVE,
            operationType: "",
            timestamp: 0,
            blockNumber: 0
        });
    }

    function getRecords(uint256 offset, uint256 limit) external pure returns (TreasuryRecord[] memory) {
        return new TreasuryRecord[](0);
    }

    function getRecordCount() external view returns (uint256) {
        return recordCount;
    }

    function getConfig() external pure returns (TreasuryConfig memory) {
        return TreasuryConfig({
            maxWithdrawalBPS: 10000,
            emergencyWithdrawalLimit: type(uint256).max,
            minReserveRatioBPS: 0,
            maxAllocationBPS: 10000,
            withdrawalsEnabled: true,
            depositsEnabled: true
        });
    }

    function isAuthorisedModule(address module) external view returns (bool) {
        return authorisedModules[module];
    }

    function createSnapshot() external returns (uint256) {
        return 0;
    }

    function getSnapshot(uint256) external pure returns (PoolBalance[7] memory, uint256, uint256) {
        PoolBalance[7] memory empty;
        return (empty, 0, 0);
    }
}
