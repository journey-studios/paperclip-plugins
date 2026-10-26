# Telegram approval queue in 0.2.5

Paperclip expires pending `ask_user_questions` cards from the same author and
kind when a newer card is created on that conversation. Social Publisher must
therefore serialize its questions instead of assuming native cards form a queue.

A request first renders and validates its complete native preview. A permanent
presentation error, such as an oversized preview, leaves a new post in `draft`
instead of reserving the queue. A valid request enters `pending_approval` with its immutable version, content
hash, destinations, and fixed local deadline. If any valid native question is
pending, Social returns `delivery.status="queued"` and keeps
`approvalRequestId=null`; it does not call `askUserQuestions`. A question from
another plugin blocks this queue too. The oldest queued post is chosen by
`created_at,id`, so ties remain deterministic across worker restarts. The
deadline starts at the original approval request and is not silently extended
while waiting.

Before submitting a native question, Social saves a durable intent containing
the company, conversation, post, version, content hash, destinations, deadline,
idempotency key, and digest of the exact preview and choices. Retries recover the
same native question after a crash before its state acknowledgement or database
receipt. Recovery checks the native author, company/conversation, founder
addressee, `human_only` resolver policy, and the complete normalized payload.
Alternative `questionSet` presentations, option descriptions, `freeText`, and
custom submit labels are covered by the digest. Native trimming is applied
before saving the request; null optional text without a presentation is treated
as absent.

The queue tick first applies genuine answers from the configured founder or
records administrative expiration. A cancelled, expired, superseded, withdrawn,
or locally overdue pending approval becomes `approval_expired`, with a system
audit entry and no invented human decision. It cannot publish or be requested
again as the same version; `revise` creates a new version requiring a fresh
decision. Delayed callbacks for the old version cannot approve the revision.
After reconciliation, the tick submits queued posts when the conversation is
free. Legacy queued posts whose preview preparation permanently fails expire
with a system audit entry, allowing the next valid queued post to proceed.
Transient preparation failures defer submission without aborting the remaining
company queue tick. Native submission acknowledgement is not a Telegram delivery receipt.

A pending Social card can be treated as obsolete only when its durable binding
proves the company/conversation and exact version/destinations, and its post is
already cancelled, superseded, or `approval_expired`. Unknown ownership blocks
the queue. The plugin does not impersonate a human to cancel native cards.

The conversation mutex serializes Social's own list/create calls. The current
SDK offers no atomic compare-and-create against writes by other plugins. An
external ask created after Social's ask can expire Social's card; reconciliation
then expires that post explicitly and requires a revision. An external ask
created between Social's empty-list check and its create call can itself be
superseded by the host. The plugin cannot undo that native expiration or promise
global exclusion without a host API change. Both orders are covered by tests;
neither authorizes social publication without the exact founder decision.
