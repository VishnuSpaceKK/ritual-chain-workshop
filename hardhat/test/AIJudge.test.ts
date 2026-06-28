import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { keccak256, encodePacked, parseEther, toHex, zeroHash } from "viem";

describe("AIJudge - Commit-Reveal", async function () {
  const { viem, networkHelpers } = await network.create();

  let aiJudge: any;
  let owner: any, alice: any, bob: any;
  let commitDeadline: bigint;
  let revealDeadline: bigint;

  function buildCommitment(
    answer: string,
    salt: `0x${string}`,
    submitterAddr: `0x${string}`,
    bountyId: bigint
  ) {
    return keccak256(
      encodePacked(
        ["string", "bytes32", "address", "uint256"],
        [answer, salt, submitterAddr, bountyId]
      )
    );
  }

  beforeEach(async function () {
    [owner, alice, bob] = await viem.getWalletClients();

    aiJudge = await viem.deployContract("AIJudge");

    const now = BigInt(await networkHelpers.time.latest());
    commitDeadline = now + 3600n; // +1 hour
    revealDeadline = commitDeadline + 3600n; // +1 more hour

    await aiJudge.write.createBounty(
      ["Best Privacy Idea", "Judge based on technical feasibility", commitDeadline, revealDeadline],
      { value: parseEther("1.0") }
    );
  });

  describe("submitCommitment", function () {
    it("accepts a valid commitment before the commit deadline", async function () {
      const salt = keccak256(toHex("salt1"));
      const commitment = buildCommitment("my answer", salt, alice.account.address, 1n);

      await viem.assertions.emitWithArgs(
        aiJudge.write.submitCommitment([1n, commitment], { account: alice.account }),
        aiJudge,
        "CommitmentSubmitted",
        [1n, 0n, alice.account.address, commitment]
      );
    });

    it("rejects a duplicate commitment from the same address", async function () {
      const salt = keccak256(toHex("salt1"));
      const commitment = buildCommitment("answer", salt, alice.account.address, 1n);

      await aiJudge.write.submitCommitment([1n, commitment], { account: alice.account });

      await viem.assertions.revertWith(
        aiJudge.write.submitCommitment([1n, commitment], { account: alice.account }),
        "already committed"
      );
    });

    it("rejects an empty (zero) commitment", async function () {
      await viem.assertions.revertWith(
        aiJudge.write.submitCommitment([1n, zeroHash], { account: alice.account }),
        "empty commitment"
      );
    });

    it("rejects commitments after the commit deadline has passed", async function () {
      await networkHelpers.time.increase(3601);

      const salt = keccak256(toHex("salt1"));
      const commitment = buildCommitment("late answer", salt, alice.account.address, 1n);

      await viem.assertions.revertWith(
        aiJudge.write.submitCommitment([1n, commitment], { account: alice.account }),
        "commitment phase closed"
      );
    });
  });

  describe("revealAnswer", function () {
    let salt: `0x${string}`;
    let answer: string;
    let commitment: `0x${string}`;

    beforeEach(async function () {
      salt = keccak256(toHex("alice-salt"));
      answer = "Use TEEs to encrypt submissions until reveal";
      commitment = buildCommitment(answer, salt, alice.account.address, 1n);

      await aiJudge.write.submitCommitment([1n, commitment], { account: alice.account });
    });

    it("rejects reveal attempts before the commit deadline", async function () {
      await viem.assertions.revertWith(
        aiJudge.write.revealAnswer([1n, answer, salt], { account: alice.account }),
        "reveal phase not started"
      );
    });

    it("accepts a correct reveal once the reveal window opens", async function () {
      await networkHelpers.time.increase(3601);

      await viem.assertions.emitWithArgs(
        aiJudge.write.revealAnswer([1n, answer, salt], { account: alice.account }),
        aiJudge,
        "AnswerRevealed",
        [1n, 0n, alice.account.address]
      );

      const submission = await aiJudge.read.getSubmission([1n, 0n]);
      assert.equal(submission[2], answer); // answer field
      assert.equal(submission[3], true); // revealed field
    });

    it("rejects a reveal where the answer doesn't match the commitment", async function () {
      await networkHelpers.time.increase(3601);

      await viem.assertions.revertWith(
        aiJudge.write.revealAnswer([1n, "a different answer entirely", salt], { account: alice.account }),
        "commitment mismatch"
      );
    });

    it("rejects a reveal with the wrong salt", async function () {
      await networkHelpers.time.increase(3601);

      const wrongSalt = keccak256(toHex("wrong-salt"));
      await viem.assertions.revertWith(
        aiJudge.write.revealAnswer([1n, answer, wrongSalt], { account: alice.account }),
        "commitment mismatch"
      );
    });

    it("rejects revealing twice", async function () {
      await networkHelpers.time.increase(3601);

      await aiJudge.write.revealAnswer([1n, answer, salt], { account: alice.account });

      await viem.assertions.revertWith(
        aiJudge.write.revealAnswer([1n, answer, salt], { account: alice.account }),
        "already revealed"
      );
    });

    it("rejects reveals after the reveal deadline has passed", async function () {
      await networkHelpers.time.increase(7201); // past both deadlines

      await viem.assertions.revertWith(
        aiJudge.write.revealAnswer([1n, answer, salt], { account: alice.account }),
        "reveal phase closed"
      );
    });

    it("rejects a reveal from an address with no prior commitment", async function () {
      await networkHelpers.time.increase(3601);

      await viem.assertions.revertWith(
        aiJudge.write.revealAnswer([1n, "I never committed", salt], { account: bob.account }),
        "no commitment found for sender"
      );
    });

    it("prevents copying: a second submitter can't reuse Alice's commitment with her salt", async function () {
      const bobSalt = keccak256(toHex("bob-salt"));
      const bobCommitment = buildCommitment(answer, bobSalt, bob.account.address, 1n);

      await aiJudge.write.submitCommitment([1n, bobCommitment], { account: bob.account });

      await networkHelpers.time.increase(3601);

      // Bob tries revealing with Alice's salt, as if he'd copied her commitment hash
      await viem.assertions.revertWith(
        aiJudge.write.revealAnswer([1n, answer, salt], { account: bob.account }),
        "commitment mismatch"
      );
    });
  });

  describe("judgeAll guard conditions (pre-precompile checks)", function () {
    it("rejects judging before the reveal deadline has passed", async function () {
      const salt = keccak256(toHex("salt1"));
      const commitment = buildCommitment("answer", salt, alice.account.address, 1n);
      await aiJudge.write.submitCommitment([1n, commitment], { account: alice.account });

      await viem.assertions.revertWith(
        aiJudge.write.judgeAll([1n, "0x"]),
        "reveal phase not over"
      );
    });

    it("rejects judging if nobody revealed", async function () {
      await networkHelpers.time.increase(7201);

      await viem.assertions.revertWith(
        aiJudge.write.judgeAll([1n, "0x"]),
        "no revealed submissions"
      );
    });

    it("rejects judgeAll from a non-owner", async function () {
      await viem.assertions.revertWith(
        aiJudge.write.judgeAll([1n, "0x"], { account: alice.account }),
        "not bounty owner"
      );
    });

    // TODO: mock the LLM_INFERENCE_PRECOMPILE address (0x0802) using
    // a hardhat_setCode-style cheatcode so we can test the full judgeAll
    // success path + finalizeWinner without the live Ritual chain.
  });
});
