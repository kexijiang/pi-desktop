# Session Message Routing

Piora routes every externally initiated prompt through one session-scoped command
inbox. The inbox is the concurrency boundary for a Pi session: commands for the
same session are FIFO, while different sessions may run concurrently.

## Local routing model

`lib/session-message-router.ts` is the single dispatch path used by the normal
agent API and Room chat/coordinator work. Callers provide a target session id,
message content, source, and an idempotency key. The router validates the target,
message size, and expiry before accepting the command.

`next_turn` is the default delivery mode. It waits for the target session to be
idle, then starts one tracked prompt. `steer` is intentionally separate: it is
accepted only when the target is already running and is delivered to that active
run. A steer never silently becomes a queued next-turn prompt.

Each command has a durable command id and status journal. The journal records
the full command needed for recovery, but secrets are never written there. Event
journals use a per-session monotonic cursor and are suitable for replay after an
SSE reconnect. Terminal command records can be compacted after the configured
retention window; non-terminal records remain recoverable.

The router restores accepted/queued/dispatching commands after process restart.
A persisted running command is marked `interrupted` unless a live wrapper owns
the same run id. Recovery is explicit and idempotent, so a reconnect or duplicate
request does not execute a command twice.

## Rooms

Room chat and coordinator dispatch use the same router with `source: "room"` and
stable keys derived from room, message/task, target session, and attempt. Room
coordination keeps its existing leases, dependency checks, worktree protections,
and `maxConcurrency`; the router adds per-session FIFO ordering underneath.
Room batches dispatch to distinct members concurrently, but two commands aimed at
one member are still serialized by that member's inbox.

The main regression coverage is in
`lib/session-message-router.test.mjs`: same-session FIFO, cross-session overlap,
idempotent duplicate delivery, and queued-command recovery after router restart.
