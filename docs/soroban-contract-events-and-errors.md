# Soroban contract events and error codes

Reference for every event a CrowdPay Soroban contract publishes and every typed
error it can return. It is derived from the contract source under
`contracts/soroban/contracts/*/src/lib.rs`. If you change a contract, update this
file in the same PR.

## How to read this document

- **Events** are published with `env.events().publish((topic, ...), data)`. The
  first topic is the event name (a `Symbol`). The second topic, when present, is
  an indexable value (an address or an index). `data` is the event body.
- **Typed errors** are `#[contracterror]` enums. A function returning
  `Result<_, XError>` fails with a numeric contract error code, which Soroban
  surfaces to clients as `Error(Contract, #<code>)`.
- **Panics** are `panic!("...")` calls. These abort the invocation with a host
  trap and no contract error code, only the panic message in diagnostic events.
  Several contracts use panics for most validation, so a declared error variant
  is not always the one a caller sees. Each contract section below lists both.
- Events are only emitted when the invocation succeeds. A reverted call emits
  nothing.

## Escrow (`escrow`)

### Events

| Topic 0 | Topic 1 | Data | Emitted by |
|---|---|---|---|
| `campaign_failed` | `admin: Address` | `()` | `mark_campaign_failed` |
| `deposit` | `from: Address` | `amount: i128` | `deposit` |
| `approve_withdrawal` | `to: Address` | `release_amount: i128` | `approve_withdrawal`, `approve_milestone_withdrawal` |
| `withdrawal` | `to: Address` | `(release_amount, net_amount, fee_amount)` | `execute_withdrawal` |
| `admin_override_withdrawal` | `to: Address` | `(release_amount, second_signer)` | `admin_override_withdrawal` |
| `fee_proposed` | `admin: Address` | `new_fee_bps: u32` | `propose_fee_change` |
| `fee_changed` | `admin: Address` | `new_fee_bps: u32` | `confirm_fee_change` |
| `fee_cancelled` | `admin: Address` | `()` | `cancel_fee_change` |
| `refund` | `contributor: Address` | `payout: i128` | `refund` |

`approve_withdrawal` is shared by two functions, so a consumer cannot tell a
plain approval from a milestone approval by the event alone.

### Typed errors (`EscrowError`)

| Code | Variant | Returned today? |
|---|---|---|
| 1 | `AlreadyInitialized` | No (declared; `initialize` panics instead) |
| 2 | `NotInitialized` | Yes, whenever stored config is missing |
| 3 | `InvalidAmount` | No (declared; amount checks panic) |
| 4 | `CampaignClosed` | No |
| 5 | `DeadlinePassed` | No |
| 6 | `WithdrawalBlocked` | No |
| 7 | `TargetNotMet` | No |
| 8 | `FeeAboveCap` | No |
| 9 | `NoPendingFeeChange` | No |
| 10 | `InsufficientApproval` | No |
| 11 | `InsufficientBalance` | No |
| 12 | `InvalidSigner` | No |
| 13 | `RefundsUnavailable` | No |
| 14 | `NoContribution` | No |
| 15 | `Unauthorized` | No |

Only `NotInitialized` (#2) is produced by the current source. Every other
variant is declared but unused; the equivalent failures are panics (below).
Authorization failures come from `require_auth` and appear as host auth errors,
not `Unauthorized`.

### Panics

| Function | Message |
|---|---|
| `initialize` | `Contract is already initialized`; `Target must be positive`; `Platform fee BPS must not exceed MAX_FEE_BPS` |
| `set_second_signer` | `Second signer must be distinct from admin` |
| `deposit` | `Deposit amount must be positive`; `Campaign is closed for contributions`; `Campaign deadline has passed` |
| `approve_withdrawal` | `Campaign has failed or is refunding; withdrawals blocked`; `Withdrawal not allowed: target not met`; `Release amount must be positive` |
| `approve_milestone_withdrawal` | `Campaign has failed or is refunding; withdrawals blocked`; `Release amount must be positive` |
| `propose_fee_change` | `Platform fee BPS must not exceed MAX_FEE_BPS` |
| `confirm_fee_change` | `No pending fee change to confirm`; `Platform fee BPS must not exceed MAX_FEE_BPS` |
| `cancel_fee_change` | `No pending fee change to cancel` |
| `execute_withdrawal` | `Campaign has failed or is refunding; withdrawals blocked`; `Release amount must be positive`; `Insufficient approved amount for destination`; `Insufficient approved amount` |
| `admin_override_withdrawal` | `Second signer must be distinct from admin`; `Invalid second signer`; `Release amount must be positive`; `Insufficient contract balance for override withdrawal` |
| `refund` | `Deadline has not passed`; `Campaign succeeded, refunds unavailable`; `No contribution to refund` |

Constants: `MAX_FEE_BPS = 1000` (10%).

## CrowdPay (`crowdpay`)

### Events

| Topic 0 | Topic 1 | Data | Emitted by |
|---|---|---|---|
| `approve` | `milestone_index: u32` | `platform: Address` | `approve_milestone` |
| `release` | `milestone_index: u32` | `(creator, milestone_amount)` | `release_milestone` |
| `refund` | `contributor: Address` | `(amount, payout)` | `refund` |

### Typed errors (`CrowdPayError`)

| Code | Variant | Returned today? |
|---|---|---|
| 1 | `AlreadyInitialized` | No (`initialize` panics) |
| 2 | `NotInitialized` | Yes |
| 3 | `InvalidMilestone` | No |
| 4 | `CampaignFailed` | No |
| 5 | `MilestoneAlreadyReleased` | No |
| 6 | `MilestoneNotApproved` | No |
| 7 | `MilestoneTargetNotMet` | No |
| 8 | `InsufficientBalance` | No |
| 9 | `NoContribution` | No |
| 10 | `Unauthorized` | No |
| 11 | `InvalidAmount` | No |
| 12 | `DeadlinePassed` | No |

Only `NotInitialized` (#2) is produced by the current source.

### Panics

| Function | Message |
|---|---|
| `initialize` | `Already initialized`; `Creator and platform must be distinct`; `Goal must be positive`; `Milestones cannot be empty`; `Milestones must start unreleased`; `Milestone target must be positive`; `Milestone amount must be positive`; `Total milestone allocations cannot exceed goal` |
| `contribute` | `Contribution amount must be positive`; `Campaign is not accepting contributions`; `Deadline passed` |
| `approve_milestone` | `Campaign has failed`; `Milestone already released` |
| `release_milestone` | `Milestone already released`; `Campaign has failed`; `Milestone not approved`; `Milestone target not met`; `Release amount exceeds available funds`; `Insufficient contract balance` |
| `refund` | `Campaign has not failed`; `No contribution to refund` |

Campaign status is stored as a `Symbol`: `Active`, `Funded`, `Failed`.

## Fee registry (`fee_registry`)

### Events

| Topic 0 | Topic 1 | Data | Emitted by |
|---|---|---|---|
| `deposit_reclaimed` | `voter: Address` | `(proposal_id, locked_amount)` | `reclaim_vote_deposit` |

This is the only event the contract publishes. Proposal creation, votes and
execution emit no events; read them back with the contract getters.

### Typed errors (`FeeRegistryError`)

| Code | Variant | Returned today? |
|---|---|---|
| 1 | `AlreadyInitialized` | No (`initialize` panics) |
| 2 | `NotInitialized` | Yes |
| 3 | `ProposalNotFound` | Yes (`vote`, `reclaim_vote_deposit`, `execute_proposal`) |
| 4 | `Unauthorized` | No |
| 5 | `ActiveProposalExists` | No |
| 6 | `VotingNotEnded` | No |
| 7 | `NoDepositToReclaim` | No |
| 8 | `FeeExceedsCap` | No |
| 9 | `InsufficientTokens` | No |
| 10 | `AlreadyVoted` | No |
| 11 | `ProposalNotActive` | No |

### Panics

| Function | Message |
|---|---|
| `initialize` | `Already initialized`, plus fee validation below |
| fee validation (`initialize`, `propose_change`, `admin_set_fee`) | `Platform fee BPS must not exceed MAX_FEE_BPS`; `Creator share BPS must not exceed MAX_CREATOR_SHARE_BPS` |
| `propose_change` | `Proposer must hold at least 1000 governance tokens`; `There is already an active proposal` |
| `vote` | `Proposal ID does not match active proposal`; `Proposal is not active for voting`; `Voting period has ended`; `Already voted on this proposal`; `Voter must hold governance tokens` |
| `reclaim_vote_deposit` | `Voting period has not ended`; `No deposit to reclaim` |
| `execute_proposal` | `Proposal ID does not match active proposal`; `Proposal is not active`; `Voting period has not ended` |
| `admin_set_fee` | `Only the admin can set the fee` |

Constants: `MAX_FEE_BPS = 1000`, `MAX_CREATOR_SHARE_BPS = 10000`,
`PROPOSAL_VOTING_PERIOD = 7 days`, `MIN_TOKEN_BALANCE = 1000`,
`QUORUM_THRESHOLD = 1000`. See also `docs/governance-fee-registry.md`.

## Milestones v2 (`milestones_v2`)

This contract has no `#[contracterror]` enum. Every failure is a panic.

### Events

| Topic 0 | Topic 1 | Data | Emitted by |
|---|---|---|---|
| `migrated` | none | `(v1_contract_id, v1_milestone_count)` | `migrate_from_v1` |
| `submit` | `index: u32` | `evidence_hash: BytesN<32>` | `submit_milestone` |
| `release` | `index: u32` | `(creator, release_amount)` | `approve_milestone` (only when a release amount is paid out) |
| `approve` | `index: u32` | `()` | `approve_milestone` |
| `reject` | `index: u32` | `reason_hash: BytesN<32>` | `reject_milestone` |

### Panics

| Function | Message |
|---|---|
| `initialize` | `Already initialized`; `Creator and platform must be distinct`; `Milestones cannot be empty`; `Total BPS must be 10000` |
| any state-mutating call while paused | `CONTRACT_PAUSED` (toggled by `set_paused`) |
| `submit_milestone` | `Milestone already submitted or approved` |
| `approve_milestone` | `Milestone not submitted` |
| `reject_milestone` | `Milestone not submitted` |

`MilestoneStatus` values: `Pending = 0`, `Submitted = 1`, `Approved = 2`,
`Rejected = 3`.

## Campaign treasury (`campaign_treasury`)

### Events

| Topic 0 | Topic 1 | Data | Emitted by |
|---|---|---|---|
| `init` | `campaign_id` | `creator: Address` | `initialize` |
| `received` | `contributor: Address` | `amount: i128` | `receive_contribution` |
| `wpending` | `destination: Address` | `(id, amount)` | `request_withdrawal` (withdrawal parked for auditor approval) |
| `withdrawn` | `destination: Address` | `(id, amount)` | `execute` (internal), after a direct or approved withdrawal |
| `refunded` | none | `(refunded, contributor_count)` | `trigger_auto_refund` |
| `paused` | none | `reason` | `pause` |
| `unpaused` | none | `()` | `unpause` |

### Typed errors (`TreasuryError`)

| Code | Variant | Returned by | Meaning |
|---|---|---|---|
| 1 | `AlreadyInitialized` | `initialize` | Treasury already set up |
| 2 | `NotInitialized` | `require_init` | Treasury not set up |
| 3 | `HoldPeriodNotElapsed` | `request_withdrawal` | Deadline plus `min_hold_days` not reached |
| 4 | `ExceedsMaxWithdrawalPct` | `request_withdrawal` | Amount exceeds the policy share of the balance |
| 5 | `CooldownNotElapsed` | `request_withdrawal` | `withdrawal_cooldown_hours` not elapsed since the last withdrawal |
| 6 | `InsufficientBalance` | `request_withdrawal`, `approve_withdrawal` | Not enough funds held |
| 7 | `Paused` | `require_not_paused` | Withdrawals and contributions paused |
| 8 | `AuditorNotConfigured` | `request_withdrawal`, `approve_withdrawal` | Policy needs an auditor but none is set |
| 9 | `PendingNotFound` | `approve_withdrawal` | No pending withdrawal with that id |
| 10 | `InvalidPolicy` | `validate_policy` | `max_single_withdrawal_pct` is 0 or above `MAX_PCT` (100), or `require_auditor_for_above` is negative |
| 11 | `AutoRefundDisabled` | `trigger_auto_refund` | Policy has auto-refund off |
| 12 | `RefundConditionsNotMet` | `trigger_auto_refund` | Before the deadline, or the goal was met |
| 13 | `InvalidAmount` | `receive_contribution`, `request_withdrawal` | Amount is zero or negative |
| 14 | `HistoryFull` | `execute` | `MAX_HISTORY` (200) records reached |

All 14 variants are returned by the current source. This contract has no
`panic!` calls.

## Contributor identity (`contributor_identity`)

### Events

| Topic 0 | Topic 1 | Data | Emitted by |
|---|---|---|---|
| `issuer_added` | `issuer: Address` | `()` | `add_issuer` |
| `issuer_removed` | `issuer: Address` | `()` | `remove_issuer` |
| `identity_registered` | `caller: Address` | `()` | `register` |
| `attestation_added` | `subject: Address` | `attestation_type` | `add_attestation` |
| `attestation_revoked` | `subject: Address` | `attestation_index: u32` | `revoke_attestation` |
| `reputation_updated` | `subject: Address` | `updated` (the new reputation) | `update_reputation` |

### Typed errors (`IdentityError`)

| Code | Variant | Returned by |
|---|---|---|
| 1 | `AlreadyInitialized` | `initialize` |
| 2 | `NotInitialized` | functions that read the admin config |
| 3 | `IdentityNotFound` | `add_attestation`, `revoke_attestation`, `update_reputation`, `get_identity` |
| 4 | `InvalidIndex` | `revoke_attestation` (index out of range) |
| 5 | `Unauthorized` | `revoke_attestation` (caller is not the original issuer) |
| 6 | `NotApprovedIssuer` | `assert_approved_issuer` (caller is not in the issuer set) |

Constant: `MAX_REPUTATION = 1000`.

## Related: migration contract

Not in the scope above, but the backend depends on it. The `migration` contract
publishes `MigrationCompleted` with no second topic and data
`(v1_contract_id, v2_contract_id, milestone_count)` from `migrate`. Note this is
a different event from `migrated` emitted by `milestones_v2::migrate_from_v1`.

## How the backend consumes these

- `backend/src/services/sorobanService.js` is the only backend code that reads
  contract events. After a migration transaction it decodes the transaction's
  Soroban events and looks for topic `MigrationCompleted`, taking the third
  element of the data tuple (`milestone_count`). Decode failures are logged and
  skipped.
- For other calls it checks whether the simulation return value is an
  `scvError` and throws `Simulation failed: ...` or `Simulation returned error:
  ...` with the serialized result. Contract error codes are not mapped to names
  there, so a failing call surfaces as `Error(Contract, #<code>)` inside the
  message. Use the tables above to translate the code.
- `backend/src/services/ledgerMonitor.js` does not subscribe to Soroban
  contract events. It follows the Horizon payment stream and records its own
  checkpoints (`ledger_stream_cursors`, `ledger_event_receipts`); its "event
  key" is a Horizon paging token or transaction hash, not a contract event.
  For contract-mode campaigns it books contributions on the treasury contract
  through `contractTreasury.indexContribution`, which is what produces the
  `received` event above.
