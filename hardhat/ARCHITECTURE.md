## Why Commit-Reveal Isn't Enough

The Required Track's commit-reveal scheme hides answers from *other participants and
the public* — but it has one honest gap: a node operator with mempool visibility could
theoretically see a `revealAnswer` transaction's plaintext arguments the moment it's
broadcast, before it's even mined. For most bounties this risk is negligible, but it's
worth naming rather than glossing over.

This design removes that gap entirely by never putting plaintext on-chain, in the
mempool, or in front of any human — not even the bounty owner — at any point. Plaintext
only ever exists for a few milliseconds, inside a hardware-isolated secure enclave
(TEE), during the single moment it's being judged.

## Where Plaintext Exists (and Where It Never Does)

| Location | Plaintext present? |
|---|---|
| Participant's own device, before encrypting | Yes (theirs only) |
| Submission transaction (calldata, mempool, block) | **No** — only ciphertext |
| Contract storage | **No** — only ciphertext |
| Node operators' view of the chain | **No** |
| Bounty owner's view | **No** — they only ever see the AI's final verdict |
| Inside the TEE, during `judgeAll` execution | **Yes** — decrypted only in isolated enclave memory, for the duration of one inference call |
| TEE's own operator/host machine | **No** — that's the entire point of a TEE: even the machine running it can't read its protected memory |

This mirrors exactly what we already saw work in practice with the Sovereign Agent
example: secrets are ECIES-encrypted client-side before submission, and only decrypted
inside the executor's attested enclave.

## On-Chain vs Off-Chain

**On-chain:**
- `bountyId`, `submitter` address, `submissionDeadline`, `rubric`, `reward` — same as before, all public, none of it sensitive
- The **ciphertext** of each answer (ECIES-encrypted to the current executor's public key) — safe to store on-chain in plaintext-of-storage terms, because it's unreadable without the enclave's private key
- The async job request (Phase 1 submission) and the final delivered AI review (Phase 2 callback) — both public, but neither ever contains a raw answer

**Off-chain:**
- Nothing answer-related needs to live off-chain at all in this design — unlike the Sovereign Agent example (which used a Hugging Face dataset for conversation history), bounty answers are short enough to store as ciphertext directly on-chain, which removes a dependency on any external storage host
- The only off-chain step is the participant's own browser/wallet performing the ECIES encryption locally, before ever sending a transaction

## How Submission Works

1. Participant reads the current attested executor's public key from Ritual's
   `TEEServiceRegistry` (a read-only call, no transaction needed)
2. Their wallet/dApp ECIES-encrypts `(answer, bountyId, submitter)` locally, entirely
   client-side
3. They submit only the ciphertext on-chain:
```solidity
   submitEncryptedAnswer(uint256 bountyId, bytes calldata ciphertext)
```
4. No separate reveal step exists in this design — submission and "reveal" collapse
   into one action, because the data was never visible in the first place. There's
   nothing later to leak.

## How Batch Judging Works (the actual Ritual-native part)

This is the key requirement: **one LLM call judges all submissions together**, not one
call per answer — both for cost efficiency and so the model can compare answers
relative to each other (better for ranking quality than judging each in isolation).

1. After the submission deadline, the bounty owner calls `judgeAll(bountyId)`
2. The contract submits a single async request to the **Sovereign Agent precompile**
   (`0x080C`), passing the rubric and the full array of stored ciphertexts as input
3. Inside the executor's TEE:
   - Each ciphertext is decrypted using the enclave's private key (the only place this
     private key ever exists)
   - All decrypted answers are assembled into **one combined prompt**, structured
     something like: *"Rubric: {rubric}. Submission 1: {answer1}. Submission 2:
     {answer2}. ... Rank all submissions and return the index of the strongest one
     with justification."*
   - **One single call** to the LLM inference precompile processes the entire batch at
     once
4. The enclave discards the decrypted plaintext from memory immediately after
   inference — it was never persisted anywhere, even temporarily
5. The result (ranking + justification) is returned via the same async Phase 1 →
   Phase 2 pattern already used in the Sovereign Agent example, and delivered back to
   the contract through `SovereignAgentResultDelivered`
6. `finalizeWinner` then proceeds exactly as in the Required Track — pays out the
   reward to the winning index

## Comparison: Required Track vs Advanced Track

| | Commit-Reveal (Required) | TEE-Encrypted (Advanced) |
|---|---|---|
| Hidden from other participants | ✅ | ✅ |
| Hidden from bounty owner | ✅ (until judged) | ✅ (forever — owner only sees AI's verdict) |
| Hidden from node operators / mempool | ❌ (reveal tx is plaintext in calldata) | ✅ (only ciphertext ever appears) |
| Requires a separate reveal step | Yes | No — submission *is* the final state |
| Trust assumption | None beyond the EVM itself | Trusts the TEE's hardware isolation and attestation |
| Complexity | Lower | Higher — depends on Ritual's executor/TEE infrastructure being live and correctly attested |

## Honest Caveat on This Design

This is presented as an **architecture design**, not a fully implemented and tested
contract, given the added complexity of integrating live TEE attestation and the
Sovereign Agent precompile's async batch-input encoding — both of which would benefit
from direct testing against Ritual's live testnet (as we did for the standalone
Sovereign Agent example) rather than a local Hardhat simulation, since the precompile
addresses don't exist on a vanilla local chain. A natural next step beyond this
assignment would be prototyping `submitEncryptedAnswer` and a batch-aware `judgeAll`
directly against `rpc.ritualfoundation.org`, reusing the executor-discovery and
ECIES-encryption helpers from `ritual-dapp-skills/examples/sovereign-agent/helpers.py`.
