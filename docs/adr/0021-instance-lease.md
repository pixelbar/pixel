# 0021. The newest instance answers, through a lease file

* Status: accepted
* Date: 2026-10-28

## Context

Two Pixel instances connected with the same bot token both get every command (#11). Container Apps in `Single` revision mode starts the new revision and only stops the old one once the new one is ready, so every deploy and every settings change (a new revision) has an overlap. On 2026-10-28 prod overlapped for about 50 seconds after `DISCORD_ROLE_SYNC` was turned on: both instances tried to acknowledge the same `/admin sync`, the old one won, and the new one was refused (Sentry PIXEL-17). The old one also marked the bot offline on its way out, after the new one had said it was online, and both ran their background work (announcements, scheduled posts, the role sync) at the same time.

Stopping the old instance first isn't something Container Apps offers for one revision, and there is no database to hold a lock (ADR 0003).

## Decision

- **A lease file on the shared volume**, `PIXEL_DATA_DIR/instance.lease`, holds the ID of the instance that answers. Every instance of an environment mounts the same Azure Files share, so they all see it.
- **An instance claims it once it is connected to Discord**, before it starts any background work, by writing its random ID (temp file, then rename). The old instance keeps answering until then, so a deploy has no gap.
- **Before handling an interaction**, the Discord adapter asks whether this instance holds the lease (one small file read). If not, it does nothing: the other instance answers.
- **An instance that has lost the lease stands by for good.** It notices on its next interaction or within 5 seconds, then stops its background work, the heartbeat and Home Assistant, and disconnects from Discord. It never claims again, so two instances can't take turns, and it posts nothing when it's finally stopped, since the newer one is online. Its liveness probe (`/healthz`) still passes, so Container Apps doesn't restart it.
- **Fails open.** If the file can't be read, the last answer stands; if it's missing or empty after a claim, it's written again; if the claim can't be written, the instance answers anyway. A broken share must never silence the bot.

## Consequences

- During a deploy, commands go to the old instance until the new one is connected, then to the new one. Background work runs on one instance at a time, except for the few seconds before the old one notices.
- The lease only covers instances that share the volume. A laptop running `just dev` on a cloud environment's token still answers twice: don't do it.
- One file read per interaction on the share (milliseconds).
- `instance.lease` is safe to delete; the instance answering writes it again.
