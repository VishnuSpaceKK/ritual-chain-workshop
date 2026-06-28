## The Problem This Solves

The original `AIJudge` contract stored every submitted answer in plaintext, immediately,
on-chain. Anyone watching the chain (or even just calling `getSubmission`) could read
every answer the moment it was submitted — including other participants, before the
bounty's deadline even passed. That meant a later submitter could simply copy an
earlier answer, tweak it slightly, and resubmit an "improved" version with no original
thought required.

This version fixes that using a **commit-reveal scheme**: participants submit only a
cryptographic hash of their answer during the submission window. The actual answer
stays completely hidden — even from other participants and the bounty owner — until a
separate, later reveal phase. By the time anyone can read your answer, the window for
submitting new entries has already closed, so there's nothing left to copy from you.

## Lifecycle

A bounty moves through four phases, in order:

### 1. Create
`createBounty(title, rubric, commitDeadline, revealDeadline)` — bounty owner deposits
the reward (in native currency) and sets two deadlines:
- `commitDeadline` — the last moment to submit a commitment
- `revealDeadline` — the last moment to reveal an answer (must be later than `commitDeadline`)

### 2. Commit phase (`block.timestamp < commitDeadline`)
Each participant calls:
```solidity
submitCommitment(bountyId, commitment)
```
where `commitment = keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId))`.

The `salt` is a random secret only the participant knows — without it, nobody (not
even the contract) can reverse the hash back into the original answer. Including
`msg.sender` and `bountyId` in the hash means a commitment can't be replayed by someone
else or reused across a different bounty.

At this stage, **only the hash is stored on-chain** (`Submission.answer` stays empty).
No one — including the bounty owner — can see what was submitted.

### 3. Reveal phase (`commitDeadline ≤ block.timestamp < revealDeadline`)
Each participant who committed now calls:
```solidity
revealAnswer(bountyId, answer, salt)
```
The contract recomputes `keccak256(answer, salt, msg.sender, bountyId)` and checks it
matches the commitment submitted earlier. If it matches, the plaintext answer is now
stored and visible. If it doesn't match — wrong answer, wrong salt, or someone trying
to claim a commitment that isn't theirs — the transaction reverts.

By the time reveals start, the **commit window is already closed**, so nobody can
react to anyone else's revealed answer by submitting a new, "improved" entry of their
own — there's no submission phase left to exploit.

### 4. Judge
Once `revealDeadline` has passed, the bounty owner calls:
```solidity
judgeAll(bountyId, llmInput)
```
This sends all **revealed** answers to Ritual's on-chain LLM inference precompile for
evaluation, and stores the AI's review on-chain. Unrevealed commitments are simply
excluded — if you didn't reveal in time, your answer is never judged.

### 5. Finalize
```solidity
finalizeWinner(bountyId, winnerIndex)
```
The bounty owner picks the winning index from the judged, revealed submissions, and the
reward is paid out automatically. The contract enforces that the winner must be a
submission that was actually revealed — you cannot win with an unrevealed commitment.

## Key Security Properties

| Property | How it's enforced |
|---|---|
| Answers can't be read before reveal | Only the hash is stored during the commit phase; `answer` field stays empty |
| Can't copy someone else's idea | By the time any answer is visible, the commit window for new entries is already closed |
| Can't impersonate another submitter | `msg.sender` is baked into the commitment hash |
| Can't replay a commitment across bounties | `bountyId` is baked into the commitment hash |
| Can't submit twice | `submitCommitment` reverts if the sender already has an entry for this bounty |
| Can't reveal twice | `revealAnswer` reverts if `submission.revealed` is already true |
| Can't win without revealing | `finalizeWinner` requires the chosen index to have `revealed == true` |
| Judging can't happen early | `judgeAll` requires `block.timestamp >= revealDeadline` |

## Known Limitations (honest, not hidden)

- **The salt only protects against the public/other participants — it doesn't protect against the bounty owner colluding with a node operator to read pending mempool transactions before they're mined.** This contract makes data *unreadable by reading chain state*, but it doesn't address mempool-level privacy. The Advanced Track (Ritual-native TEE submissions) addresses this gap — see `ARCHITECTURE.md`.
- If a participant loses their `salt`, their answer can never be revealed or verified — there's no recovery mechanism by design, since recovery would require storing the salt somewhere, defeating its purpose.
- `MAX_SUBMISSIONS = 10` and `MAX_ANSWER_LENGTH = 2,000` are unchanged from the original contract — these are gas/storage safety limits, not security features.