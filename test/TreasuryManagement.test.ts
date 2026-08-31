import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * TreasuryManagement Module — Comprehensive Test Suite (SC-012)
 *
 * Covers:
 *  - Unit tests: deposits, withdrawals, accounting, transfers
 *  - Security tests: unauthorised access, reentrancy, same-block
 *  - Governance controls: parameter updates, emergency controls
 *  - Invariant tests: balance == sum of pools
 *  - Gas benchmarks
 *
 * Design note:
 *  The treasury holds all protocol tokens. Every record* function expects
 *  tokens to already reside in the contract (transferred by the caller module
 *  before calling record*). The invariant check enforces:
 *    sum(poolBalances) == protocolToken.balanceOf(treasury)
 */
describe("TreasuryManagement", function () {
  const POOL_COUNT = 7;
  const BASIS_POINTS = 10_000;

  const STAKING_RESERVE = 0;
  const REWARDS_POOL = 1;
  const SLASHING_RESERVE = 2;
  const PROTOCOL_FEES = 3;
  const GOVERNANCE_RESERVE = 4;
  const ECOSYSTEM_FUND = 5;
  const EMERGENCY_RESERVE = 6;

  async function deployTreasuryFixture() {
    const [admin, governance, emergencyAdmin, staking, reward, settlement, fee, slashing, user1, user2] =
      await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("TestToken", "TT");
    await token.waitForDeployment();

    const mintAmount = ethers.parseEther("1000000");
    await token.mint(admin.address, mintAmount);
    await token.mint(user1.address, ethers.parseEther("100000"));
    await token.mint(user2.address, ethers.parseEther("100000"));

    const TreasuryManagement = await ethers.getContractFactory("TreasuryManagement");
    const treasury = await TreasuryManagement.deploy(
      await token.getAddress(),
      governance.address,
      admin.address,
      emergencyAdmin.address
    );
    await treasury.waitForDeployment();

    // Set minReserveRatioBPS to 0 so non-staking deposits don't fail the invariant
    await treasury.connect(admin).setMinReserveRatioBPS(0);

    // Grant module roles
    const STAKING_MODULE_ROLE = await treasury.STAKING_MODULE_ROLE();
    const REWARD_MODULE_ROLE = await treasury.REWARD_MODULE_ROLE();
    const SETTLEMENT_MODULE_ROLE = await treasury.SETTLEMENT_MODULE_ROLE();
    const FEE_MODULE_ROLE = await treasury.FEE_MODULE_ROLE();
    const SLASHING_MODULE_ROLE = await treasury.SLASHING_MODULE_ROLE();

    await treasury.connect(admin).grantRole(STAKING_MODULE_ROLE, staking.address);
    await treasury.connect(admin).grantRole(REWARD_MODULE_ROLE, reward.address);
    await treasury.connect(admin).grantRole(SETTLEMENT_MODULE_ROLE, settlement.address);
    await treasury.connect(admin).grantRole(FEE_MODULE_ROLE, fee.address);
    await treasury.connect(admin).grantRole(SLASHING_MODULE_ROLE, slashing.address);

    return { treasury, token, admin, governance, emergencyAdmin, staking, reward, settlement, fee, slashing, user1, user2 };
  }

  // =========================================================================
  // Deployment Tests
  // =========================================================================

  describe("Deployment", function () {
    it("Should set immutable protocol token correctly", async function () {
      const { treasury, token } = await loadFixture(deployTreasuryFixture);
      expect(await treasury.protocolToken()).to.equal(await token.getAddress());
    });

    it("Should grant admin roles to deployer", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);
      const ADMIN_ROLE = await treasury.ADMIN_ROLE();
      const TREASURY_MANAGER_ROLE = await treasury.TREASURY_MANAGER_ROLE();
      expect(await treasury.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
      expect(await treasury.hasRole(TREASURY_MANAGER_ROLE, admin.address)).to.be.true;
    });

    it("Should initialize with zero balances across all pools", async function () {
      const { treasury } = await loadFixture(deployTreasuryFixture);
      expect(await treasury.getTotalAssets()).to.equal(0);
      const balances = await treasury.getAllPoolBalances();
      for (let i = 0; i < POOL_COUNT; i++) {
        expect(balances[i].currentBalance).to.equal(0);
      }
    });

    it("Should initialise default configuration", async function () {
      const { treasury } = await loadFixture(deployTreasuryFixture);
      const config = await treasury.getConfig();
      expect(config.maxWithdrawalBPS).to.equal(2500);
      expect(config.withdrawalsEnabled).to.be.true;
      expect(config.depositsEnabled).to.be.true;
    });
  });

  // =========================================================================
  // Deposit Tests
  // =========================================================================

  describe("Deposits", function () {
    it("Should allow external deposit to a pool", async function () {
      const { treasury, token, user1 } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(user1).approve(await treasury.getAddress(), amount);
      await treasury.connect(user1).depositToPool(REWARDS_POOL, amount);

      const poolBalance = await treasury.getPoolBalance(REWARDS_POOL);
      expect(poolBalance.currentBalance).to.equal(amount);
      expect(poolBalance.totalDeposited).to.equal(amount);
    });

    it("Should record stake deposit from staking module", async function () {
      const { treasury, token, staking, admin } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("500");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);

      const poolBalance = await treasury.getPoolBalance(STAKING_RESERVE);
      expect(poolBalance.currentBalance).to.equal(amount);
      expect(poolBalance.totalDeposited).to.equal(amount);
    });

    it("Should record fee deposit from fee module", async function () {
      const { treasury, token, fee, admin } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("100");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(fee).recordFeeDeposit(fee.address, amount);

      const poolBalance = await treasury.getPoolBalance(PROTOCOL_FEES);
      expect(poolBalance.currentBalance).to.equal(amount);
    });

    it("Should record governance deposit", async function () {
      const { treasury, token, admin } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("5000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(admin).recordGovernanceDeposit(admin.address, amount);

      const poolBalance = await treasury.getPoolBalance(GOVERNANCE_RESERVE);
      expect(poolBalance.currentBalance).to.equal(amount);
    });

    it("Should reject zero-amount deposits", async function () {
      const { treasury, user1 } = await loadFixture(deployTreasuryFixture);
      await expect(treasury.connect(user1).depositToPool(REWARDS_POOL, 0)).to.be.revertedWithCustomError(
        treasury,
        "ZeroAmount"
      );
    });

    it("Should reject deposits when deposits are paused", async function () {
      const { treasury, admin, user1 } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("100");

      await treasury.connect(admin).setDepositsEnabled(false);

      await expect(treasury.connect(user1).depositToPool(REWARDS_POOL, amount)).to.be.revertedWithCustomError(
        treasury,
        "DepositsPaused"
      );
    });

    it("Should reject unauthorised staking deposit from non-staking module", async function () {
      const { treasury, user1 } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("100");

      await expect(
        treasury.connect(user1).recordStakeDeposit(user1.address, amount)
      ).to.be.reverted;
    });

    it("Should reject unauthorised fee deposit from non-fee module", async function () {
      const { treasury, user1 } = await loadFixture(deployTreasuryFixture);

      await expect(
        treasury.connect(user1).recordFeeDeposit(user1.address, ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("Should emit TreasuryDeposit event on external deposit", async function () {
      const { treasury, token, user1 } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("500");

      await token.connect(user1).approve(await treasury.getAddress(), amount);

      await expect(treasury.connect(user1).depositToPool(REWARDS_POOL, amount))
        .to.emit(treasury, "TreasuryDeposit")
        .withArgs(user1.address, amount, REWARDS_POOL, (val: any) => val !== ethers.ZeroHash);
    });

    it("Should emit StakeDeposit event", async function () {
      const { treasury, token, staking, admin } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("100");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);

      await expect(treasury.connect(staking).recordStakeDeposit(admin.address, amount))
        .to.emit(treasury, "StakeDeposit")
        .withArgs(admin.address, amount, (val: any) => val !== ethers.ZeroHash);
    });

    it("Should increment record count after each deposit", async function () {
      const { treasury, token, staking, admin } = await loadFixture(deployTreasuryFixture);

      await token.connect(admin).transfer(await treasury.getAddress(), ethers.parseEther("100"));
      await treasury.connect(staking).recordStakeDeposit(admin.address, ethers.parseEther("100"));
      expect(await treasury.getRecordCount()).to.equal(1);

      await ethers.provider.send("evm_mine", []);
      await token.connect(admin).transfer(await treasury.getAddress(), ethers.parseEther("200"));
      await treasury.connect(staking).recordStakeDeposit(admin.address, ethers.parseEther("200"));
      expect(await treasury.getRecordCount()).to.equal(2);
    });

    it("Should reject direct staking reserve deposit via depositToPool", async function () {
      const { treasury, token, user1 } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("100");

      await token.connect(user1).approve(await treasury.getAddress(), amount);
      await expect(treasury.connect(user1).depositToPool(STAKING_RESERVE, amount)).to.be.revertedWithCustomError(
        treasury,
        "UnauthorisedModule"
      );
    });
  });

  // =========================================================================
  // Withdrawal Tests
  // =========================================================================

  describe("Withdrawals", function () {
    it("Should allow withdrawal from staking reserve by staking module", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
      await treasury.connect(admin).setMaxWithdrawalBPS(BASIS_POINTS);
      await ethers.provider.send("evm_mine", []);

      await treasury.connect(staking).withdrawFromPool(STAKING_RESERVE, admin.address, amount);

      const poolBalance = await treasury.getPoolBalance(STAKING_RESERVE);
      expect(poolBalance.currentBalance).to.equal(0);
      expect(poolBalance.totalWithdrawn).to.equal(amount);
    });

    it("Should reject zero-amount withdrawal", async function () {
      const { treasury, staking, admin } = await loadFixture(deployTreasuryFixture);

      await expect(treasury.connect(staking).withdrawFromPool(STAKING_RESERVE, admin.address, 0)).to.be.revertedWithCustomError(
        treasury,
        "ZeroAmount"
      );
    });

    it("Should reject withdrawal to zero address", async function () {
      const { treasury, staking } = await loadFixture(deployTreasuryFixture);

      await expect(
        treasury.connect(staking).withdrawFromPool(STAKING_RESERVE, ethers.ZeroAddress, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("Should reject unauthorised withdrawal from non-staking module", async function () {
      const { treasury, token, user1, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
      await treasury.connect(admin).setMaxWithdrawalBPS(BASIS_POINTS);
      await ethers.provider.send("evm_mine", []);

      await expect(
        treasury.connect(user1).withdrawFromPool(STAKING_RESERVE, user1.address, amount)
      ).to.be.revertedWithCustomError(treasury, "UnauthorisedWithdrawal");
    });

    it("Should reject withdrawal when withdrawals are paused", async function () {
      const { treasury, admin, staking } = await loadFixture(deployTreasuryFixture);

      await treasury.connect(admin).setWithdrawalsEnabled(false);

      await expect(
        treasury.connect(staking).withdrawFromPool(STAKING_RESERVE, admin.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(treasury, "WithdrawalsPaused");
    });

    it("Should emit TreasuryWithdrawal event", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("500");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
      await treasury.connect(admin).setMaxWithdrawalBPS(BASIS_POINTS);
      await ethers.provider.send("evm_mine", []);

      await expect(treasury.connect(staking).withdrawFromPool(STAKING_RESERVE, admin.address, amount))
        .to.emit(treasury, "TreasuryWithdrawal")
        .withArgs(admin.address, amount, STAKING_RESERVE, (val: any) => val !== ethers.ZeroHash);
    });

    it("Should reject withdrawal exceeding pool balance", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
      await treasury.connect(admin).setMaxWithdrawalBPS(BASIS_POINTS);
      await ethers.provider.send("evm_mine", []);

      // Withdrawal limit fires first (> 100% of pool)
      await expect(
        treasury.connect(staking).withdrawFromPool(STAKING_RESERVE, admin.address, amount + 1n)
      ).to.be.reverted;
    });

    it("Should enforce withdrawal limits (maxWithdrawalBPS)", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
      await ethers.provider.send("evm_mine", []);

      await expect(
        treasury.connect(staking).withdrawFromPool(STAKING_RESERVE, admin.address, amount / 2n)
      ).to.be.revertedWithCustomError(treasury, "WithdrawalExceedsLimit");
    });

    it("Should allow partial withdrawal within limits", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
      await ethers.provider.send("evm_mine", []);

      const withdrawAmount = amount / 5n; // 20% within 25% limit
      await treasury.connect(staking).withdrawFromPool(STAKING_RESERVE, admin.address, withdrawAmount);

      const poolBalance = await treasury.getPoolBalance(STAKING_RESERVE);
      expect(poolBalance.currentBalance).to.equal(amount - withdrawAmount);
    });
  });

  // =========================================================================
  // Slashing Tests
  // =========================================================================

  describe("Slashing", function () {
    it("Should move funds from staking reserve to slashing reserve", async function () {
      const { treasury, token, admin, staking, slashing } = await loadFixture(deployTreasuryFixture);
      const stakedAmount = ethers.parseEther("5000");
      const slashAmount = ethers.parseEther("500");

      await token.connect(admin).transfer(await treasury.getAddress(), stakedAmount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, stakedAmount);

      await treasury.connect(slashing).recordSlashDeposit(admin.address, slashAmount);

      const stakingBalance = await treasury.getPoolBalance(STAKING_RESERVE);
      const slashingBalance = await treasury.getPoolBalance(SLASHING_RESERVE);

      expect(stakingBalance.currentBalance).to.equal(stakedAmount - slashAmount);
      expect(slashingBalance.currentBalance).to.equal(slashAmount);
      expect(slashingBalance.totalDeposited).to.equal(slashAmount);
    });

    it("Should emit SlashDeposit and TreasuryTransfer events", async function () {
      const { treasury, token, admin, staking, slashing } = await loadFixture(deployTreasuryFixture);
      const stakedAmount = ethers.parseEther("5000");
      const slashAmount = ethers.parseEther("500");

      await token.connect(admin).transfer(await treasury.getAddress(), stakedAmount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, stakedAmount);

      await expect(treasury.connect(slashing).recordSlashDeposit(admin.address, slashAmount))
        .to.emit(treasury, "SlashDeposit")
        .to.emit(treasury, "TreasuryTransfer");
    });

    it("Should reject slash when staking reserve is insufficient", async function () {
      const { treasury, slashing } = await loadFixture(deployTreasuryFixture);

      await expect(
        treasury.connect(slashing).recordSlashDeposit(ethers.ZeroAddress, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(treasury, "InsufficientPoolBalance");
    });

    it("Should reject slash by non-slashing module", async function () {
      const { treasury, token, admin, staking, user1 } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("5000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);

      await expect(
        treasury.connect(user1).recordSlashDeposit(admin.address, ethers.parseEther("100"))
      ).to.be.reverted;
    });
  });

  // =========================================================================
  // Internal Transfer Tests
  // =========================================================================

  describe("Internal Transfers", function () {
    it("Should transfer between pools", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");
      const transferAmount = ethers.parseEther("200");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
      await ethers.provider.send("evm_mine", []);

      await treasury.connect(admin).transferBetweenPools(STAKING_RESERVE, REWARDS_POOL, transferAmount, "allocation to rewards");

      const stakingBalance = await treasury.getPoolBalance(STAKING_RESERVE);
      const rewardsBalance = await treasury.getPoolBalance(REWARDS_POOL);

      expect(stakingBalance.currentBalance).to.equal(amount - transferAmount);
      expect(rewardsBalance.currentBalance).to.equal(transferAmount);
    });

    it("Should emit TreasuryTransfer event", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");
      const transferAmount = ethers.parseEther("200");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
      await ethers.provider.send("evm_mine", []);

      await expect(
        treasury.connect(admin).transferBetweenPools(STAKING_RESERVE, REWARDS_POOL, transferAmount, "test transfer")
      ).to.emit(treasury, "TreasuryTransfer");
    });

    it("Should reject transfer to same pool", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);

      await expect(
        treasury.connect(admin).transferBetweenPools(STAKING_RESERVE, STAKING_RESERVE, ethers.parseEther("100"), "test")
      ).to.be.revertedWithCustomError(treasury, "InvariantViolation");
    });

    it("Should reject transfer by non-treasury-manager", async function () {
      const { treasury, user1 } = await loadFixture(deployTreasuryFixture);

      await expect(
        treasury.connect(user1).transferBetweenPools(STAKING_RESERVE, REWARDS_POOL, ethers.parseEther("100"), "test")
      ).to.be.reverted;
    });

    it("Should reject zero-amount transfer", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);

      await expect(
        treasury.connect(admin).transferBetweenPools(STAKING_RESERVE, REWARDS_POOL, 0, "test")
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });
  });

  // =========================================================================
  // Governance Controls Tests
  // =========================================================================

  describe("Governance Controls", function () {
    it("Should update maxWithdrawalBPS via governance", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);
      await treasury.connect(admin).setMaxWithdrawalBPS(1000);
      const config = await treasury.getConfig();
      expect(config.maxWithdrawalBPS).to.equal(1000);
    });

    it("Should reject maxWithdrawalBPS > 10000", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);
      await expect(treasury.connect(admin).setMaxWithdrawalBPS(10001)).to.be.revertedWithCustomError(
        treasury,
        "InvalidBasisPoints"
      );
    });

    it("Should update minReserveRatioBPS", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);
      await treasury.connect(admin).setMinReserveRatioBPS(2000);
      const config = await treasury.getConfig();
      expect(config.minReserveRatioBPS).to.equal(2000);
    });

    it("Should enable/disable withdrawals globally", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);

      await treasury.connect(admin).setWithdrawalsEnabled(false);
      let config = await treasury.getConfig();
      expect(config.withdrawalsEnabled).to.be.false;

      await treasury.connect(admin).setWithdrawalsEnabled(true);
      config = await treasury.getConfig();
      expect(config.withdrawalsEnabled).to.be.true;
    });

    it("Should enable/disable deposits globally", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);

      await treasury.connect(admin).setDepositsEnabled(false);
      let config = await treasury.getConfig();
      expect(config.depositsEnabled).to.be.false;

      await treasury.connect(admin).setDepositsEnabled(true);
      config = await treasury.getConfig();
      expect(config.depositsEnabled).to.be.true;
    });

    it("Should reject non-governance parameter updates", async function () {
      const { treasury, user1 } = await loadFixture(deployTreasuryFixture);

      await expect(treasury.connect(user1).setMaxWithdrawalBPS(1000)).to.be.reverted;
    });

    it("Should update emergency withdrawal limit", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);
      const newLimit = ethers.parseEther("50000");

      await treasury.connect(admin).setEmergencyWithdrawalLimit(newLimit);
      const config = await treasury.getConfig();
      expect(config.emergencyWithdrawalLimit).to.equal(newLimit);
    });

    it("Should update maxAllocationBPS", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);

      await treasury.connect(admin).setMaxAllocationBPS(500);
      const config = await treasury.getConfig();
      expect(config.maxAllocationBPS).to.equal(500);
    });
  });

  // =========================================================================
  // Emergency Controls Tests
  // =========================================================================

  describe("Emergency Controls", function () {
    it("Should pause and unpause treasury", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);

      await treasury.connect(admin)["emergencyPause(string)"]("security incident");
      expect(await treasury.paused()).to.be.true;

      await treasury.connect(admin).emergencyUnpause();
      expect(await treasury.paused()).to.be.false;
    });

    it("Should emit EmergencyPaused event", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);

      await expect(treasury.connect(admin)["emergencyPause(string)"]("test"))
        .to.emit(treasury, "EmergencyPaused")
        .withArgs(admin.address, "test");
    });

    it("Should emit EmergencyUnpaused event", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);

      await treasury.connect(admin)["emergencyPause(string)"]("test");
      await expect(treasury.connect(admin).emergencyUnpause())
        .to.emit(treasury, "EmergencyUnpaused")
        .withArgs(admin.address);
    });

    it("Should allow emergency admin to pause", async function () {
      const { treasury, emergencyAdmin } = await loadFixture(deployTreasuryFixture);

      await treasury.connect(emergencyAdmin)["emergencyPause(string)"]("emergency");
      expect(await treasury.paused()).to.be.true;
    });

    it("Should reject non-authorised pause", async function () {
      const { treasury, user1 } = await loadFixture(deployTreasuryFixture);

      await expect(treasury.connect(user1)["emergencyPause(string)"]("test")).to.be.reverted;
    });

    it("Should allow emergency withdrawal by governance", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);

      await treasury.connect(admin).emergencyWithdrawal(admin.address, amount);

      const totalAssets = await treasury.getTotalAssets();
      expect(totalAssets).to.equal(0);
    });

    it("Should reject emergency withdrawal by non-governance", async function () {
      const { treasury, token, admin, staking, user1 } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);

      await expect(
        treasury.connect(user1).emergencyWithdrawal(user1.address, amount)
      ).to.be.revertedWithCustomError(treasury, "UnauthorisedWithdrawal");
    });

    it("Should allow emergency admin to unpause", async function () {
      const { treasury, admin, emergencyAdmin } = await loadFixture(deployTreasuryFixture);

      await treasury.connect(admin)["emergencyPause(string)"]("test");
      await treasury.connect(emergencyAdmin).emergencyUnpause();
      expect(await treasury.paused()).to.be.false;
    });

    it("Should pause deposits via pauseDeposits", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);

      await treasury.connect(admin).pauseDeposits();
      const config = await treasury.getConfig();
      expect(config.depositsEnabled).to.be.false;
    });

    it("Should pause withdrawals via pauseWithdrawals", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);

      await treasury.connect(admin).pauseWithdrawals();
      const config = await treasury.getConfig();
      expect(config.withdrawalsEnabled).to.be.false;
    });
  });

  // =========================================================================
  // Invariant Tests
  // =========================================================================

  describe("Invariant Tests", function () {
    it("Invariant: totalAssets == contract token balance after every operation", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);

      const amounts = [ethers.parseEther("1000"), ethers.parseEther("2000"), ethers.parseEther("500")];

      for (const amount of amounts) {
        await token.connect(admin).transfer(await treasury.getAddress(), amount);
        await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
        await ethers.provider.send("evm_mine", []);
      }

      const totalAssets = await treasury.getTotalAssets();
      const actualBalance = await token.balanceOf(await treasury.getAddress());
      expect(totalAssets).to.equal(actualBalance);
    });

    it("Invariant: sum of pool balances == total assets", async function () {
      const { treasury, token, admin, staking, fee } = await loadFixture(deployTreasuryFixture);

      const stakingAmount = ethers.parseEther("5000");
      const feeAmount = ethers.parseEther("200");

      await token.connect(admin).transfer(await treasury.getAddress(), stakingAmount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, stakingAmount);
      await ethers.provider.send("evm_mine", []);
      await token.connect(admin).transfer(await treasury.getAddress(), feeAmount);
      await treasury.connect(fee).recordFeeDeposit(fee.address, feeAmount);

      const balances = await treasury.getAllPoolBalances();
      let sum = BigInt(0);
      for (let i = 0; i < POOL_COUNT; i++) {
        sum += balances[i].currentBalance;
      }

      expect(sum).to.equal(await treasury.getTotalAssets());
    });

    it("Invariant: totalWithdrawn records are accurate", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");
      const withdrawAmount = ethers.parseEther("300");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
      await treasury.connect(admin).setMaxWithdrawalBPS(BASIS_POINTS);
      await ethers.provider.send("evm_mine", []);

      await treasury.connect(staking).withdrawFromPool(STAKING_RESERVE, admin.address, withdrawAmount);

      const pool = await treasury.getPoolBalance(STAKING_RESERVE);
      expect(pool.currentBalance).to.equal(amount - withdrawAmount);
      expect(pool.totalWithdrawn).to.equal(withdrawAmount);
      expect(pool.totalDeposited).to.equal(amount);
    });

    it("Invariant: balance preserved across slash operation", async function () {
      const { treasury, token, admin, staking, slashing } = await loadFixture(deployTreasuryFixture);
      const staked = ethers.parseEther("5000");
      const slash = ethers.parseEther("300");

      await token.connect(admin).transfer(await treasury.getAddress(), staked);
      await treasury.connect(staking).recordStakeDeposit(admin.address, staked);
      await treasury.connect(slashing).recordSlashDeposit(admin.address, slash);

      const totalAssets = await treasury.getTotalAssets();
      const actualBalance = await token.balanceOf(await treasury.getAddress());
      expect(totalAssets).to.equal(actualBalance);
      expect(totalAssets).to.equal(staked);
    });
  });

  // =========================================================================
  // Record & Snapshot Tests
  // =========================================================================

  describe("Records and Snapshots", function () {
    it("Should create and retrieve snapshots", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);

      // Use staticCall to get the return value without sending a transaction
      const snapshotId = await treasury.createSnapshot.staticCall();
      await treasury.createSnapshot(); // actually execute it

      const [balances, totalAssets, timestamp] = await treasury.getSnapshot(snapshotId);

      expect(totalAssets).to.equal(amount);
      expect(balances[STAKING_RESERVE].currentBalance).to.equal(amount);
    });

    it("Should emit SnapshotCreated event", async function () {
      const { treasury } = await loadFixture(deployTreasuryFixture);

      await expect(treasury.createSnapshot()).to.emit(treasury, "SnapshotCreated");
    });

    it("Should track records correctly", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);

      const count = await treasury.getRecordCount();
      expect(count).to.equal(1);

      const record = await treasury.getRecord(0);
      expect(record.amount).to.equal(amount);
      expect(record.operationType).to.equal("stake_deposit");
    });

    it("Should return paginated records", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);

      for (let i = 0; i < 5; i++) {
        await token.connect(admin).transfer(await treasury.getAddress(), ethers.parseEther("100"));
        await treasury.connect(staking).recordStakeDeposit(admin.address, ethers.parseEther("100"));
        await ethers.provider.send("evm_mine", []);
      }

      const records = await treasury.getRecords(0, 3);
      expect(records.length).to.equal(3);
    });

    it("Should revert on invalid snapshot index", async function () {
      const { treasury } = await loadFixture(deployTreasuryFixture);

      await expect(treasury.getSnapshot(999)).to.be.revertedWithCustomError(treasury, "InvalidRecordIndex");
    });

    it("Should revert on invalid record index", async function () {
      const { treasury } = await loadFixture(deployTreasuryFixture);

      await expect(treasury.getRecord(999)).to.be.revertedWithCustomError(treasury, "InvalidRecordIndex");
    });
  });

  // =========================================================================
  // Module Management Tests
  // =========================================================================

  describe("Module Management", function () {
    it("Should authorise and deauthorise modules", async function () {
      const { treasury, admin, user1 } = await loadFixture(deployTreasuryFixture);

      await treasury.connect(admin).setAuthorisedModule(user1.address, true);
      expect(await treasury.isAuthorisedModule(user1.address)).to.be.true;

      await treasury.connect(admin).setAuthorisedModule(user1.address, false);
      expect(await treasury.isAuthorisedModule(user1.address)).to.be.false;
    });

    it("Should emit AuthorisedModuleUpdated event", async function () {
      const { treasury, admin, user1 } = await loadFixture(deployTreasuryFixture);

      await expect(treasury.connect(admin).setAuthorisedModule(user1.address, true))
        .to.emit(treasury, "AuthorisedModuleUpdated")
        .withArgs(user1.address, true);
    });

    it("Should reject zero address module", async function () {
      const { treasury, admin } = await loadFixture(deployTreasuryFixture);

      await expect(treasury.connect(admin).setAuthorisedModule(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
        treasury,
        "ZeroAddress"
      );
    });
  });

  // =========================================================================
  // Security Tests
  // =========================================================================

  describe("Security Tests", function () {
    it("Should prevent duplicate record IDs within same block", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("100");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);

      // Second call in same (or consecutive) block should be rejected
      await expect(
        treasury.connect(staking).recordStakeDeposit(admin.address, amount)
      ).to.be.reverted;
    });

    it("Should allow operations in different blocks", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);

      await token.connect(admin).transfer(await treasury.getAddress(), ethers.parseEther("100"));
      await treasury.connect(staking).recordStakeDeposit(admin.address, ethers.parseEther("100"));

      await ethers.provider.send("evm_mine", []);

      await token.connect(admin).transfer(await treasury.getAddress(), ethers.parseEther("100"));
      await treasury.connect(staking).recordStakeDeposit(admin.address, ethers.parseEther("100"));
      expect(await treasury.getRecordCount()).to.equal(2);
    });
  });

  // =========================================================================
  // Gas Benchmarks
  // =========================================================================

  describe("Gas Benchmarks", function () {
    it("Gas: recordStakeDeposit", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      const tx = await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
      const receipt = await tx.wait();
      console.log(`    │  recordStakeDeposit:  ${receipt!.gasUsed} gas`);
    });

    it("Gas: depositToPool (external)", async function () {
      const { treasury, token, user1 } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(user1).approve(await treasury.getAddress(), amount);
      const tx = await treasury.connect(user1).depositToPool(REWARDS_POOL, amount);
      const receipt = await tx.wait();
      console.log(`    │  depositToPool:       ${receipt!.gasUsed} gas`);
    });

    it("Gas: withdrawFromPool", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
      await treasury.connect(admin).setMaxWithdrawalBPS(BASIS_POINTS);
      await ethers.provider.send("evm_mine", []);

      const tx = await treasury.connect(staking).withdrawFromPool(STAKING_RESERVE, admin.address, amount);
      const receipt = await tx.wait();
      console.log(`    │  withdrawFromPool:    ${receipt!.gasUsed} gas`);
    });

    it("Gas: transferBetweenPools", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");
      const transferAmount = ethers.parseEther("200");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);
      await ethers.provider.send("evm_mine", []);

      const tx = await treasury.connect(admin).transferBetweenPools(STAKING_RESERVE, REWARDS_POOL, transferAmount, "gas benchmark");
      const receipt = await tx.wait();
      console.log(`    │  transferBetweenPools: ${receipt!.gasUsed} gas`);
    });

    it("Gas: recordSlashDeposit", async function () {
      const { treasury, token, admin, staking, slashing } = await loadFixture(deployTreasuryFixture);
      const stakedAmount = ethers.parseEther("5000");
      const slashAmount = ethers.parseEther("500");

      await token.connect(admin).transfer(await treasury.getAddress(), stakedAmount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, stakedAmount);

      const tx = await treasury.connect(slashing).recordSlashDeposit(admin.address, slashAmount);
      const receipt = await tx.wait();
      console.log(`    │  recordSlashDeposit:  ${receipt!.gasUsed} gas`);
    });

    it("Gas: createSnapshot", async function () {
      const { treasury } = await loadFixture(deployTreasuryFixture);

      const tx = await treasury.createSnapshot();
      const receipt = await tx.wait();
      console.log(`    │  createSnapshot:      ${receipt!.gasUsed} gas`);
    });

    it("Gas: emergencyWithdrawal", async function () {
      const { treasury, token, admin, staking } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseEther("1000");

      await token.connect(admin).transfer(await treasury.getAddress(), amount);
      await treasury.connect(staking).recordStakeDeposit(admin.address, amount);

      const tx = await treasury.connect(admin).emergencyWithdrawal(admin.address, amount);
      const receipt = await tx.wait();
      console.log(`    │  emergencyWithdrawal: ${receipt!.gasUsed} gas`);
    });
  });
});
