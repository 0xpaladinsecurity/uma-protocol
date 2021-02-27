// TODO: Import `merkle-distributor` modules via package.json
const { MerkleTree } = require("../../../merkle-distributor/src/merkleTree");

const SamplePayouts = require("./SamplePayout.json");
const truffleAssert = require("truffle-assertions");
const { toBN, toWei, utf8ToHex } = web3.utils;
const { MAX_UINT_VAL, didContractThrow } = require("@uma/common");
const { assert } = require("chai");

// Tested Contract
const MerkleDistributor = artifacts.require("MerkleDistributor");
const Timer = artifacts.require("Timer");
const Token = artifacts.require("ExpandedERC20");

// Contract instances
let merkleDistributor;
let timer;
let rewardToken;
let rewardToken2;

// Test variables
let rewardRecipients;
let merkleTree;
let rewardLeafs;
let leaf;
let claimerProof;
let windowIndex;
let windowStart;
let windowEnd;

// For a recipient object, create the leaf to be part of the merkle tree. The leaf is simply a hash of the packed
// account and the amount.
const createLeaf = recipient => {
  assert.isTrue(
    Object.keys(recipient).every(val => ["account", "amount"].includes(val)),
    "recipient does not contain required keys"
  );
  return web3.utils.soliditySha3({ t: "address", v: recipient.account }, { t: "uint256", v: recipient.amount });
};

// Generate payouts to be used in tests using the SamplePayouts file. SamplePayouts is read in from a JsonFile.
const createRewardRecipientsFromSampleData = SamplePayouts => {
  return Object.keys(SamplePayouts.exampleRecipients).map(recipientAddress => {
    return { account: recipientAddress, amount: SamplePayouts.exampleRecipients[recipientAddress] };
  });
};

contract("MerkleDistributor.js", function(accounts) {
  let contractCreator = accounts[0];
  let rando = accounts[1];

  beforeEach(async () => {
    timer = await Timer.deployed();
    merkleDistributor = await MerkleDistributor.new(timer.address);

    rewardToken = await Token.new("UMA KPI Options July 2021", "uKIP-JUL", 18, { from: contractCreator });
    await rewardToken.addMember(1, contractCreator, { from: contractCreator });
    await rewardToken.mint(contractCreator, toWei("10000000"), { from: contractCreator });
    await rewardToken.approve(merkleDistributor.address, MAX_UINT_VAL, { from: contractCreator });

    rewardToken2 = await Token.new("UMA Dev Mining", "UMA", 18, { from: contractCreator });
    await rewardToken2.addMember(1, contractCreator, { from: contractCreator });
    await rewardToken2.mint(contractCreator, toWei("10000000"), { from: contractCreator });
    await rewardToken2.approve(merkleDistributor.address, MAX_UINT_VAL, { from: contractCreator });
  });
  describe("Basic lifecycle", function() {
    it("Can create a single, simple tree, seed the distributor and claim rewards", async function() {
      const currentTime = await timer.getCurrentTime();
      const _rewardRecipients = [
        // [ recipient, rewardAmount ]
        [accounts[3], toBN(toWei("100"))],
        [accounts[4], toBN(toWei("200"))],
        [accounts[5], toBN(toWei("300"))]
      ];
      let totalRewardAmount = toBN(0);
      rewardRecipients = _rewardRecipients.map(_rewardObj => {
        totalRewardAmount = totalRewardAmount.add(_rewardObj[1]);
        return { account: _rewardObj[0], amount: _rewardObj[1].toString() };
      });

      // Generate leafs for each recipient. This is simply the hash of each component of the payout from above.
      rewardLeafs = rewardRecipients.map(item => ({ ...item, leaf: createLeaf(item) }));

      // Build the merkle tree from an array of hashes from each recipient.
      merkleTree = new MerkleTree(rewardLeafs.map(item => item.leaf));

      // Set start == end to disable vesting.
      windowStart = currentTime;
      windowEnd = windowStart;
      // Expect this merkle root to be at the first index.
      windowIndex = 0;

      // Seed the merkleDistributor with the root of the tree and additional information.
      const seedTxn = await merkleDistributor.setWindowMerkleRoot(
        totalRewardAmount,
        windowStart,
        windowEnd,
        rewardToken.address,
        merkleTree.getRoot()
      );

      // Check event logs.
      truffleAssert.eventEmitted(seedTxn, "SeededWindow", ev => {
        return (
          ev.windowIndex.toString() === windowIndex.toString() &&
          ev.amount.toString() === totalRewardAmount.toString() &&
          ev.windowStart.toString() === windowStart.toString() &&
          ev.windowEnd.toString() === windowEnd.toString() &&
          ev.rewardToken === rewardToken.address
        );
      });

      // Check on chain Window state:
      const windowState = await merkleDistributor.merkleWindows(windowIndex);
      assert.equal(windowState.start.toString(), windowStart.toString());
      assert.equal(windowState.end.toString(), windowEnd.toString());
      assert.equal(windowState.merkleRoot, merkleTree.getRoot());
      assert.equal(windowState.rewardToken, rewardToken.address);
      assert.equal(windowState.totalRewardsDistributed.toString(), totalRewardAmount.toString());

      // Check that latest seed index has incremented.
      assert.equal((await merkleDistributor.lastSeededIndex()).toString(), (windowIndex + 1).toString());

      // Claim for all accounts:
      for (let i = 0; i < rewardLeafs.length; i++) {
        leaf = rewardLeafs[i];
        claimerProof = merkleTree.getProof(leaf.leaf);
        const claimerBalanceBefore = await rewardToken.balanceOf(leaf.account);
        const contractBalanceBefore = await rewardToken.balanceOf(merkleDistributor.address);

        // // Claim the rewards, providing the information needed to re-build the tree & verify the proof.
        // Note: Anyone can claim on behalf of anyone else.
        const claimTxn = await merkleDistributor.claimWindow(
          { windowIndex: windowIndex, account: leaf.account, amount: leaf.amount, merkleProof: claimerProof },
          { from: contractCreator }
        );
        // Check event logs.
        truffleAssert.eventEmitted(claimTxn, "Claimed", ev => {
          return (
            ev.caller === contractCreator &&
            ev.windowIndex.toString() === windowIndex.toString() &&
            ev.account === leaf.account &&
            ev.totalClaimAmount.toString() === leaf.amount.toString() &&
            ev.amountVestedNetPreviousClaims.toString() === leaf.amount.toString() &&
            ev.claimAmountRemaining.toString() === "0" &&
            ev.rewardToken == rewardToken.address
          );
        });
        // Claimer balance should have increased by the amount of the reward.
        assert.equal(
          (await rewardToken.balanceOf(leaf.account)).toString(),
          claimerBalanceBefore.add(toBN(leaf.amount)).toString()
        );
        // Contract balance should have decreased by reward amount.
        assert.equal(
          (await rewardToken.balanceOf(merkleDistributor.address)).toString(),
          contractBalanceBefore.sub(toBN(leaf.amount)).toString()
        );
        // User should have claimed their full allocation for this distribution window.
        assert.equal(
          (await merkleDistributor.amountClaimedFromWindow(windowIndex, leaf.account)).toString(),
          leaf.amount.toString()
        );
      }
    });
  });
  describe("(claimWindow): No vesting", function() {
    // For each test in the single window, load in the SampleMerklePayouts, generate a tree and set it in the distributor.
    beforeEach(async function() {
      // Window should be the first in the contract.
      windowIndex = 0;
      const currentTime = await timer.getCurrentTime();
      // Start window at T+1, and disable vesting.
      windowStart = Number(currentTime.toString()) + 1;
      windowEnd = windowStart;

      rewardRecipients = createRewardRecipientsFromSampleData(SamplePayouts);

      // Generate leafs for each recipient. This is simply the hash of each component of the payout from above.
      rewardLeafs = rewardRecipients.map(item => ({ ...item, leaf: createLeaf(item) }));
      merkleTree = new MerkleTree(rewardLeafs.map(item => item.leaf));

      // Seed the merkleDistributor with the root of the tree and additional information.
      await merkleDistributor.setWindowMerkleRoot(
        SamplePayouts.totalRewardsDistributed,
        windowStart,
        windowEnd,
        rewardToken.address,
        merkleTree.getRoot()
      );

      leaf = rewardLeafs[0];
      claimerProof = merkleTree.getProof(leaf.leaf);
    });
    it("Cannot claim until window start", async function() {
      assert(
        await didContractThrow(
          merkleDistributor.claimWindow({
            windowIndex: windowIndex,
            account: leaf.account,
            amount: leaf.amount,
            merkleProof: claimerProof
          })
        )
      );

      // Advance time to window start and claim successfully.
      await merkleDistributor.setCurrentTime(windowStart.toString());
      await merkleDistributor.claimWindow({
        windowIndex: windowIndex,
        account: leaf.account,
        amount: leaf.amount,
        merkleProof: claimerProof
      });
    });
    it("Can claim after window end", async function() {
      await merkleDistributor.setCurrentTime(windowEnd + 1);
      await merkleDistributor.claimWindow({
        windowIndex: windowIndex,
        account: leaf.account,
        amount: leaf.amount,
        merkleProof: claimerProof
      });
    });
    describe("Current time > window start", function() {
      beforeEach(async function() {
        await merkleDistributor.setCurrentTime(windowStart.toString());
      });
      it("Cannot claim for invalid window index", async function() {
        assert(
          await didContractThrow(
            merkleDistributor.claimWindow({
              windowIndex: windowIndex + 1,
              account: leaf.account,
              amount: leaf.amount,
              merkleProof: claimerProof
            })
          )
        );
      });
      it("Can claim on another account's behalf", async function() {
        const claimerBalanceBefore = await rewardToken.balanceOf(leaf.account);
        const claimTx = await merkleDistributor.claimWindow(
          { windowIndex: windowIndex, account: leaf.account, amount: leaf.amount, merkleProof: claimerProof },
          { from: rando }
        );
        assert.equal(
          (await rewardToken.balanceOf(leaf.account)).toString(),
          claimerBalanceBefore.add(toBN(leaf.amount)).toString()
        );

        truffleAssert.eventEmitted(claimTx, "Claimed", ev => {
          return (
            ev.caller.toLowerCase() == rando.toLowerCase() &&
            ev.windowIndex == windowIndex.toString() &&
            ev.account.toLowerCase() == leaf.account.toLowerCase() &&
            ev.totalClaimAmount.toString() == leaf.amount.toString() &&
            ev.amountVestedNetPreviousClaims.toString() == leaf.amount.toString() &&
            ev.claimAmountRemaining.toString() == "0" &&
            ev.rewardToken.toLowerCase() == rewardToken.address.toLowerCase()
          );
        });
      });
      it("Cannot double claim rewards", async function() {
        await merkleDistributor.claimWindow({
          windowIndex: windowIndex,
          account: leaf.account,
          amount: leaf.amount,
          merkleProof: claimerProof
        });
        assert(
          await didContractThrow(
            merkleDistributor.claimWindow({
              windowIndex: windowIndex,
              account: leaf.account,
              amount: leaf.amount,
              merkleProof: claimerProof
            })
          )
        );
      });
      it("(verifyClaim): Invalid merkle proof", async function() {
        // `claimerProof` must match the hashed { account, amount } in the root exactly, test cases where either is incorrect.
        // Correct proof and claim:
        assert.isTrue(
          await merkleDistributor.verifyClaim({
            windowIndex: windowIndex,
            account: leaf.account,
            amount: leaf.amount,
            merkleProof: claimerProof
          })
        );

        // Helper method that checks that `verifyClaim` returns false and `claimWindow` reverts.
        const verifyClaimFails = async claim => {
          assert.isNotTrue(await merkleDistributor.verifyClaim(claim));
          assert(await didContractThrow(merkleDistributor.claimWindow(claim)));
        };

        // Incorrect account:
        await verifyClaimFails({
          windowIndex: windowIndex,
          account: rando,
          amount: leaf.amount,
          merkleProof: claimerProof
        });

        // Incorrect amount:
        const invalidAmount = "1";
        await verifyClaimFails({
          windowIndex: windowIndex,
          account: leaf.account,
          amount: invalidAmount,
          merkleProof: claimerProof
        });

        // Invalid merkle proof:
        const invalidProof = [utf8ToHex("0x")];
        await verifyClaimFails({
          windowIndex: windowIndex,
          account: leaf.account,
          amount: leaf.amount,
          merkleProof: invalidProof
        });
      });
    });
  });
  describe("(claimWindow): Vesting over a window", function() {
    beforeEach(async function() {
      // Assume that this is first merkle root in contract.
      windowIndex = 0;
      const currentTime = await timer.getCurrentTime();
      // Start window at currentTime and vest over 100 seconds from the current time.
      windowStart = currentTime;
      windowEnd = currentTime.addn(100);

      rewardRecipients = createRewardRecipientsFromSampleData(SamplePayouts);

      // Generate leafs for each recipient. This is simply the hash of each component of the payout from above.
      rewardLeafs = rewardRecipients.map(item => ({ ...item, leaf: createLeaf(item) }));
      merkleTree = new MerkleTree(rewardLeafs.map(item => item.leaf));

      // Seed the merkleDistributor with the root of the tree and additional information.
      await merkleDistributor.setWindowMerkleRoot(
        SamplePayouts.totalRewardsDistributed,
        windowStart,
        windowEnd,
        rewardToken.address,
        merkleTree.getRoot()
      );

      leaf = rewardLeafs[0];
      claimerProof = merkleTree.getProof(leaf.leaf);
    });
    it("Can claim linear-vested amount", async function() {
      // The contract will vest rewards linearly over the vesting window. If we are 10 seconds into the vesting window
      // then we should get 10% of the rewards vested.
      await timer.setCurrentTime(windowStart.addn(10));
      let claimerBalanceBefore = await rewardToken.balanceOf(leaf.account);

      let claimTxn = await merkleDistributor.claimWindow({
        windowIndex: windowIndex,
        account: leaf.account,
        amount: leaf.amount,
        merkleProof: claimerProof
      });

      // The claimer balance should have increased by the 10% of the original reward amount.
      const vestedClaimAmount1 = toBN(leaf.amount)
        .muln(10)
        .divn(100);
      assert.equal(
        (await rewardToken.balanceOf(leaf.account)).toString(),
        claimerBalanceBefore.add(vestedClaimAmount1).toString()
      );

      // Check event logs
      truffleAssert.eventEmitted(claimTxn, "Claimed", ev => {
        return (
          ev.caller === contractCreator &&
          ev.windowIndex.toString() === windowIndex.toString() &&
          ev.account.toLowerCase() === leaf.account.toLowerCase() &&
          ev.totalClaimAmount.toString() === leaf.amount.toString() &&
          ev.amountVestedNetPreviousClaims.toString() === vestedClaimAmount1.toString() &&
          ev.claimAmountRemaining.toString() ===
            toBN(leaf.amount)
              .sub(vestedClaimAmount1)
              .toString() &&
          ev.rewardToken === rewardToken.address
        );
      });

      // No additional tokens should be released without more time traversed through vesting. Claim call should revert.
      assert(
        await didContractThrow(
          merkleDistributor.claimWindow({
            windowIndex: windowIndex,
            account: leaf.account,
            amount: leaf.amount,
            merkleProof: claimerProof
          })
        )
      );

      // Contract should track amount claimed so far.
      assert.equal(
        (await merkleDistributor.amountClaimedFromWindow(windowIndex, leaf.account)).toString(),
        vestedClaimAmount1.toString()
      );

      // Advance half way though the window and claim the vested tokens again.
      await timer.setCurrentTime(windowStart.addn(50));
      claimTxn = await merkleDistributor.claimWindow({
        windowIndex: windowIndex,
        account: leaf.account,
        amount: leaf.amount,
        merkleProof: claimerProof
      });

      // The claimer balance should have increased by the amount of the rewards vested, equal to 50% of the claim reward.
      const vestedClaimAmount2 = toBN(leaf.amount)
        .muln(50)
        .divn(100);
      assert.equal(
        (await rewardToken.balanceOf(leaf.account)).toString(),
        claimerBalanceBefore.add(vestedClaimAmount2).toString()
      );

      truffleAssert.eventEmitted(claimTxn, "Claimed", ev => {
        return (
          ev.caller === contractCreator &&
          ev.windowIndex.toString() === windowIndex.toString() &&
          ev.account.toLowerCase() === leaf.account.toLowerCase() &&
          ev.totalClaimAmount.toString() === leaf.amount.toString() &&
          ev.amountVestedNetPreviousClaims.toString() === vestedClaimAmount2.sub(vestedClaimAmount1).toString() &&
          ev.claimAmountRemaining.toString() ===
            toBN(leaf.amount)
              .sub(vestedClaimAmount2)
              .toString() &&
          ev.rewardToken === rewardToken.address
        );
      });

      // Contract should track amount claimed so far.
      assert.equal(
        (await merkleDistributor.amountClaimedFromWindow(windowIndex, leaf.account)).toString(),
        vestedClaimAmount2.toString()
      );

      // Now advance past window time and the remaining balance should be fully vested
      await timer.setCurrentTime(windowEnd.addn(10));
      claimTxn = await merkleDistributor.claimWindow({
        windowIndex: windowIndex,
        account: leaf.account,
        amount: leaf.amount,
        merkleProof: claimerProof
      });

      // The claimer balance should have increased by the full amount of the claim.
      assert.equal(
        (await rewardToken.balanceOf(leaf.account)).toString(),
        claimerBalanceBefore.add(toBN(leaf.amount)).toString()
      );

      truffleAssert.eventEmitted(claimTxn, "Claimed", ev => {
        return (
          ev.caller === contractCreator &&
          ev.windowIndex.toString() === windowIndex.toString() &&
          ev.account.toLowerCase() === leaf.account.toLowerCase() &&
          ev.totalClaimAmount.toString() === leaf.amount.toString() &&
          ev.amountVestedNetPreviousClaims.toString() ===
            toBN(leaf.amount)
              .sub(vestedClaimAmount2)
              .toString() &&
          ev.claimAmountRemaining.toString() === "0" &&
          ev.rewardToken === rewardToken.address
        );
      });

      // Contract show full amount claimed
      assert.equal(
        (await merkleDistributor.amountClaimedFromWindow(windowIndex, leaf.account)).toString(),
        leaf.amount.toString()
      );

      // No additional tokens should be released without more time traversed through vesting. Claim call should revert.
      assert(
        await didContractThrow(
          merkleDistributor.claimWindow({
            windowIndex: windowIndex,
            account: leaf.account,
            amount: leaf.amount,
            merkleProof: claimerProof
          })
        )
      );

      // Another account who has not claimed any tokens can now claim their full vested amount.
      leaf = rewardLeafs[1];
      claimerProof = merkleTree.getProof(leaf.leaf);
      claimerBalanceBefore = await rewardToken.balanceOf(leaf.account);
      claimTxn = await merkleDistributor.claimWindow({
        windowIndex: windowIndex,
        account: leaf.account,
        amount: leaf.amount,
        merkleProof: claimerProof
      });
      assert.equal(
        (await rewardToken.balanceOf(leaf.account)).toString(),
        claimerBalanceBefore.add(toBN(leaf.amount)).toString()
      );
      truffleAssert.eventEmitted(claimTxn, "Claimed", ev => {
        return (
          ev.caller === contractCreator &&
          ev.windowIndex.toString() === windowIndex.toString() &&
          ev.account.toLowerCase() === leaf.account.toLowerCase() &&
          ev.totalClaimAmount.toString() === leaf.amount.toString() &&
          // Full claim amount since account has not previously claimed:
          ev.amountVestedNetPreviousClaims.toString() === toBN(leaf.amount).toString() &&
          ev.claimAmountRemaining.toString() === "0" &&
          ev.rewardToken === rewardToken.address
        );
      });
      assert.equal(
        (await merkleDistributor.amountClaimedFromWindow(windowIndex, leaf.account)).toString(),
        leaf.amount.toString()
      );
      assert(
        await didContractThrow(
          merkleDistributor.claimWindow({
            windowIndex: windowIndex,
            account: leaf.account,
            amount: leaf.amount,
            merkleProof: claimerProof
          })
        )
      );
    });
  });
  describe("(calcVestedAmount)", function() {
    let testAmount = toWei("10");
    let testedTime;
    // Window is 10 seconds long
    const testStart = 10;
    const testEnd = 20;
    it("time <= windowStart, return 0", async function() {
      testedTime = 5;
      let result = await merkleDistributor.calcVestedAmount(testAmount, testedTime, windowStart, windowEnd);
      assert.equal(result.toString(), "0");
      testedTime = windowStart;
      result = await merkleDistributor.calcVestedAmount(testAmount, testedTime, windowStart, windowEnd);
      assert.equal(result.toString(), "0");
    });
    it("time >= windowStart, return full amount", async function() {
      testedTime = windowEnd;
      let result = await merkleDistributor.calcVestedAmount(testAmount, testedTime, testStart, testEnd);
      assert.equal(result.toString(), testAmount);
      testedTime = 25;
      result = await merkleDistributor.calcVestedAmount(testAmount, testedTime, testStart, testEnd);
      assert.equal(result.toString(), testAmount);
    });
    it("windowEnd <= windowStart, return full amount", async function() {
      testedTime = 15;
      let result = await merkleDistributor.calcVestedAmount(testAmount, testedTime, testStart, testStart);
      assert.equal(result.toString(), testAmount);
    });
    it("windowStart <= time <= windowEnd, return interpolated amount", async function() {
      testedTime = 17;
      let result = await merkleDistributor.calcVestedAmount(testAmount, testedTime, testStart, testEnd);
      assert.equal(result.toString(), toWei("7"));
      testedTime = 12;
      result = await merkleDistributor.calcVestedAmount(testAmount, testedTime, testStart, testEnd);
      assert.equal(result.toString(), toWei("2"));
    });
  });
  describe("(claimWindows): multiple reward tokens", function() {
    let rewardRecipients1, rewardRecipients2;
    let rewardLeafs1, rewardLeafs2;
    let merkleTree1, merkleTree2;
    beforeEach(async function() {
      // Assume we start at first windowIndex. Disable vesting.
      windowIndex = 0;
      const currentTime = await timer.getCurrentTime();
      windowStart = currentTime;
      windowEnd = windowStart;

      rewardRecipients1 = createRewardRecipientsFromSampleData(SamplePayouts);

      // Generate another set of reward recipients, as the same set as number 1 but double the rewards.
      rewardRecipients2 = rewardRecipients1.map(recipient => {
        return {
          account: recipient.account,
          amount: toBN(recipient.amount)
            .muln(2)
            .toString()
        };
      });

      // Generate leafs for each recipient. This is simply the hash of each component of the payout from above.
      rewardLeafs1 = rewardRecipients1.map(item => ({ ...item, leaf: createLeaf(item) }));
      rewardLeafs2 = rewardRecipients2.map(item => ({ ...item, leaf: createLeaf(item) }));

      merkleTree1 = new MerkleTree(rewardLeafs1.map(item => item.leaf));
      merkleTree2 = new MerkleTree(rewardLeafs2.map(item => item.leaf));

      // Seed the merkleDistributor with the root of the tree and additional information.
      await merkleDistributor.setWindowMerkleRoot(
        SamplePayouts.totalRewardsDistributed,
        windowStart,
        windowEnd,
        rewardToken.address,
        merkleTree1.getRoot() // Distributes to rewardLeafs1
      );

      await merkleDistributor.setWindowMerkleRoot(
        SamplePayouts.totalRewardsDistributed,
        windowStart,
        windowEnd,
        rewardToken2.address,
        merkleTree2.getRoot() // Distributes to rewardLeafs2
      );
    });
    it("Can make multiple claims in one transaction", async function() {
      // Claim from different accounts, with different amounts, and different reward tokens.
      const leaf1 = rewardLeafs1[0];
      const leaf2 = rewardLeafs1[1];
      const leaf3 = rewardLeafs2[0];
      const leaf4 = rewardLeafs2[1];

      // Leaf1 and Leaf3 should pay account 0
      const accountBalanceBeforeAccount0RewardToken1 = await rewardToken.balanceOf(leaf1.account);
      const accountBalanceBeforeAccount0RewardToken2 = await rewardToken.balanceOf(leaf3.account);

      // Leaf2 and Leaf4 should pay account 1 rewardToken 2
      const accountBalanceBeforeAccount1RewardToken1 = await rewardToken.balanceOf(leaf2.account);
      const accountBalanceBeforeAccount1RewardToken2 = await rewardToken2.balanceOf(leaf4.account);

      const claims = [
        {
          windowIndex: windowIndex,
          account: leaf1.account,
          amount: leaf1.amount,
          merkleProof: merkleTree1.getProof(leaf1.leaf)
        },
        {
          windowIndex: windowIndex,
          account: leaf2.account,
          amount: leaf2.amount,
          merkleProof: merkleTree1.getProof(leaf2.leaf)
        },
        {
          windowIndex: windowIndex + 1,
          account: leaf3.account,
          amount: leaf3.amount,
          merkleProof: merkleTree2.getProof(leaf3.leaf)
        },
        {
          windowIndex: windowIndex + 1,
          account: leaf4.account,
          amount: leaf4.amount,
          merkleProof: merkleTree2.getProof(leaf4.leaf)
        }
      ];
      await merkleDistributor.claimWindows(claims);

      // Check account 0's balances:
      assert.equal(
        (await rewardToken.balanceOf(leaf1.account)).toString(),
        accountBalanceBeforeAccount0RewardToken1.add(toBN(leaf1.amount)).toString()
      );
      assert.equal(
        (await rewardToken2.balanceOf(leaf3.account)).toString(),
        accountBalanceBeforeAccount0RewardToken2.add(toBN(leaf3.amount)).toString()
      );
      // Check account 1's balances:
      assert.equal(
        (await rewardToken.balanceOf(leaf2.account)).toString(),
        accountBalanceBeforeAccount1RewardToken1.add(toBN(leaf2.amount)).toString()
      );
      assert.equal(
        (await rewardToken2.balanceOf(leaf4.account)).toString(),
        accountBalanceBeforeAccount1RewardToken2.add(toBN(leaf4.amount)).toString()
      );

      // Count # of Claimed events emitted.
      const claimEvents = await merkleDistributor.getPastEvents("Claimed");
      assert.equal(claimEvents.length, claims.length);
    });
    it("Cannot include invalid proof", async function() {
      // If one of the claims is invalid, then the multi claim method will fail.
      const leaf1 = rewardLeafs1[0];
      const leaf2 = rewardLeafs1[1];
      const leaf3 = rewardLeafs2[0];

      const invalidClaims = [
        {
          windowIndex: windowIndex,
          account: leaf1.account,
          amount: leaf1.amount,
          merkleProof: merkleTree1.getProof(leaf1.leaf)
        },
        {
          windowIndex: windowIndex,
          account: rando, // Invalid account for second claim
          amount: leaf2.amount,
          merkleProof: merkleTree1.getProof(leaf2.leaf)
        }
      ];

      assert(await didContractThrow(merkleDistributor.claimWindows(invalidClaims)));

      // This time, make a single claim for leaf1, and then try to run multi claim. This time
      // the multi claim will fail because the leaf1 was already claimed.
      await merkleDistributor.claimWindow(invalidClaims[0]);
      let validClaims = invalidClaims;
      validClaims[1] = {
        windowIndex: windowIndex,
        account: leaf2.account, // Correct account for second claim.
        amount: leaf2.amount,
        merkleProof: merkleTree1.getProof(leaf2.leaf)
      };

      assert(await didContractThrow(merkleDistributor.claimWindows(validClaims)));

      // This time, make two valid claims successfully and then try to call it again. This should revert
      // because the claims were already executed.
      validClaims[0] = {
        // Replace the first (already used) claim with another valid claim.
        windowIndex: windowIndex + 1,
        account: leaf3.account,
        amount: leaf3.amount,
        merkleProof: merkleTree2.getProof(leaf3.leaf)
      };
      await merkleDistributor.claimWindows(validClaims);
      assert(await didContractThrow(merkleDistributor.claimWindows(validClaims)));
    });
  });
  describe("(setWindowMerkleRoot)", function() {
    beforeEach(async function() {
      const currentTime = await timer.getCurrentTime();
      // Start window at current time, disable vesting
      windowStart = currentTime;
      windowEnd = windowStart;

      rewardRecipients = createRewardRecipientsFromSampleData(SamplePayouts);

      // Generate leafs for each recipient. This is simply the hash of each component of the payout from above.
      rewardLeafs = rewardRecipients.map(item => ({ ...item, leaf: createLeaf(item) }));
      merkleTree = new MerkleTree(rewardLeafs.map(item => item.leaf));
    });
    it("Only owner can call", async function() {
      assert(
        await didContractThrow(
          merkleDistributor.setWindowMerkleRoot(
            SamplePayouts.totalRewardsDistributed,
            windowStart,
            windowEnd,
            rewardToken.address,
            merkleTree.getRoot(),
            { from: rando }
          )
        )
      );
    });
    it("Owner's balance is transferred to contract", async function() {
      let ownerBalanceBefore = await rewardToken.balanceOf(contractCreator);

      await merkleDistributor.setWindowMerkleRoot(
        SamplePayouts.totalRewardsDistributed,
        windowStart,
        windowEnd,
        rewardToken.address,
        merkleTree.getRoot(),
        { from: contractCreator }
      );

      assert.equal(
        ownerBalanceBefore.sub(toBN(SamplePayouts.totalRewardsDistributed)).toString(),
        (await rewardToken.balanceOf(contractCreator)).toString()
      );
    });
    it("(lastSeededIndex): starts at 1 and increments on each seed", async function() {
      assert.equal((await merkleDistributor.lastSeededIndex()).toString(), "0");

      await merkleDistributor.setWindowMerkleRoot(
        SamplePayouts.totalRewardsDistributed,
        windowStart,
        windowEnd,
        rewardToken.address,
        merkleTree.getRoot(),
        { from: contractCreator }
      );

      assert.equal((await merkleDistributor.lastSeededIndex()).toString(), "1");
    });
  });
  describe("Emergency admin functions", function() {
    // We test out methods that shouldn't be called unless the Owner has made a mistake
    // seeding the contract. We create multiple windows containing different Merkle roots
    // to test that admin functionality can be isolated to specific windows.
    let rewardRecipients1, rewardRecipients2;
    let rewardLeafs1, rewardLeafs2;
    let merkleTree1, merkleTree2;
    let leaf1, leaf2;
    let claimProof1, claimProof2;
    beforeEach(async function() {
      // Assume we start at first windowIndex. Disable vesting.
      windowIndex = 0;
      const currentTime = await timer.getCurrentTime();
      windowStart = currentTime;
      windowEnd = windowStart;

      rewardRecipients1 = createRewardRecipientsFromSampleData(SamplePayouts);

      // Generate another set of reward recipients, as the same set as number 1 but double the rewards.
      rewardRecipients2 = rewardRecipients1.map(recipient => {
        return {
          account: recipient.account,
          amount: toBN(recipient.amount)
            .muln(2)
            .toString()
        };
      });

      // Generate leafs for each recipient. This is simply the hash of each component of the payout from above.
      rewardLeafs1 = rewardRecipients1.map(item => ({ ...item, leaf: createLeaf(item) }));
      rewardLeafs2 = rewardRecipients2.map(item => ({ ...item, leaf: createLeaf(item) }));

      merkleTree1 = new MerkleTree(rewardLeafs1.map(item => item.leaf));
      merkleTree2 = new MerkleTree(rewardLeafs2.map(item => item.leaf));

      // Seed the merkleDistributor with the root of the tree and additional information.
      await merkleDistributor.setWindowMerkleRoot(
        SamplePayouts.totalRewardsDistributed,
        windowStart,
        windowEnd,
        rewardToken.address,
        merkleTree1.getRoot() // Distributes to rewardLeafs1
      );

      await merkleDistributor.setWindowMerkleRoot(
        SamplePayouts.totalRewardsDistributed,
        windowStart,
        windowEnd,
        rewardToken2.address,
        merkleTree2.getRoot() // Distributes to rewardLeafs2
      );

      leaf1 = rewardLeafs1[0];
      leaf2 = rewardLeafs2[0];
      claimProof1 = merkleTree1.getProof(leaf1.leaf);
      claimProof2 = merkleTree2.getProof(leaf2.leaf);
    });
    describe("(setWindowLock)", function() {
      it("Only owner can call", async function() {
        assert(await didContractThrow(merkleDistributor.setWindowLock(windowIndex, true, { from: rando })));
      });
      it("Blocks claim for window until lock removed", async function() {
        // Lock window 0
        await merkleDistributor.setWindowLock(windowIndex, true, { from: contractCreator });
        assert(
          await didContractThrow(
            merkleDistributor.claimWindow({
              windowIndex: windowIndex,
              account: leaf1.account,
              amount: leaf1.amount,
              merkleProof: claimProof1
            })
          )
        );
        // Window 1 is not locked.
        await merkleDistributor.claimWindow({
          windowIndex: windowIndex + 1,
          account: leaf2.account,
          amount: leaf2.amount,
          merkleProof: claimProof2
        });

        // Unlock window 0
        await merkleDistributor.setWindowLock(windowIndex, false, { from: contractCreator });
        await merkleDistributor.claimWindow({
          windowIndex: windowIndex,
          account: leaf1.account,
          amount: leaf1.amount,
          merkleProof: claimProof1
        });
      });
    });
    describe("(withdrawRewards)", function() {
      it("Only owner can call", async function() {
        assert(
          await didContractThrow(merkleDistributor.withdrawRewards(rewardToken.address, toWei("1"), { from: rando }))
        );
      });
      it("Sends rewards to owner", async function() {
        let ownerBalanceBefore = await rewardToken.balanceOf(contractCreator);
        let contractBalanceBefore = await rewardToken.balanceOf(merkleDistributor.address);

        await merkleDistributor.withdrawRewards(rewardToken.address, toWei("1"), { from: contractCreator });

        assert.equal(
          ownerBalanceBefore.add(toBN(toWei("1"))).toString(),
          (await rewardToken.balanceOf(contractCreator)).toString()
        );
        assert.equal(
          contractBalanceBefore.sub(toBN(toWei("1"))).toString(),
          (await rewardToken.balanceOf(merkleDistributor.address)).toString()
        );
      });
    });
    describe("(depositRewards)", function() {
      it("Only owner can call", async function() {
        assert(
          await didContractThrow(merkleDistributor.depositRewards(rewardToken.address, toWei("1"), { from: rando }))
        );
      });
      it("Sends rewards to contract", async function() {
        let ownerBalanceBefore = await rewardToken.balanceOf(contractCreator);
        let contractBalanceBefore = await rewardToken.balanceOf(merkleDistributor.address);

        await merkleDistributor.depositRewards(rewardToken.address, toWei("1"), { from: contractCreator });

        assert.equal(
          ownerBalanceBefore.sub(toBN(toWei("1"))).toString(),
          (await rewardToken.balanceOf(contractCreator)).toString()
        );
        assert.equal(
          contractBalanceBefore.add(toBN(toWei("1"))).toString(),
          (await rewardToken.balanceOf(merkleDistributor.address)).toString()
        );
      });
    });
    describe("(resetWindowMerkleRoot)", function() {
      // Reset the second merkle root to the same root as window 1.
      const windowIndexToReset = "1";
      it("Only owner can call", async function() {
        assert(
          await didContractThrow(
            merkleDistributor.resetWindowMerkleRoot(
              windowIndexToReset,
              SamplePayouts.totalRewardsDistributed,
              windowStart,
              windowEnd,
              rewardToken.address,
              merkleTree1.getRoot(),
              { from: rando }
            )
          )
        );
      });
      it("Overwrites merkle root and new claims can be made", async function() {
        // Merkle Tree 2 is inserted at the window to reset so claims from Merkle Tree 1 will revert
        assert(
          await didContractThrow(
            merkleDistributor.claimWindow({
              windowIndex: windowIndexToReset,
              account: leaf1.account,
              amount: leaf1.amount,
              merkleProof: claimProof1
            })
          )
        );
        await merkleDistributor.resetWindowMerkleRoot(
          windowIndexToReset,
          SamplePayouts.totalRewardsDistributed,
          windowStart,
          windowEnd,
          rewardToken.address,
          merkleTree1.getRoot(),
          { from: contractCreator }
        );

        // Now claims from Merkle Tree 1 can be made on the reset window index.
        await merkleDistributor.claimWindow({
          windowIndex: windowIndexToReset,
          account: leaf1.account,
          amount: leaf1.amount,
          merkleProof: claimProof1
        });
      });
    });
  });
});
