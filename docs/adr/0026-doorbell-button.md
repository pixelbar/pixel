# 0026. The doorbell's Answer button: the second public, long-lived button

* Status: accepted
* Date: 2026-11-18

## Context

[pixel-phone](https://github.com/pixelbar/pixel-phone) answers the Pixelbar doorbell. OpenR's intercom calls a phone number; pixel-phone rings the siren in the space and picks up only once someone accepts, with the button in the space or from Discord. Otherwise the call rings out and the intercom tries the next number. Pixel reads each call's events from pixel-phone's Storage queue (pixel#211) and accepts through pixel-phone's accept API with its own key.

The doorbell post needs an **Answer** button that anyone in the channel can see, pressed by whoever goes to the door. [ADR 0023](0023-components-and-actions.md)'s controls are held in memory, for one person, for 15 minutes, so they don't fit. [ADR 0025](0025-attendance-poll-buttons.md) made attendance polls the one exception and said any later long-lived public button should follow its pattern. This is the second.

## Decision

- **The button carries only the call.** Its custom ID is `pixel-doorbell:<callId>`, pixel-phone's call ID (`YYYYMMDD-` and 12 random hex characters). It isn't secret or personal. It's drawn and parsed only in `adapters/discord/doorbell-buttons.ts`, with one exact regular expression; anything else is refused privately without reaching the dispatcher.
- **Every click is one fixed action through the dispatcher.** The adapter always runs `doorbell.answer` through `Dispatcher.act` for whoever clicked, by immutable ID, with the call as its one declared option. Its access is **`friend` plus the `doorbell` capability**. Admins grant it to a whole level with `/admin` → Capabilities ([ADR 0019](0019-level-capabilities.md)), which also reaches members, so it's admin-configurable with no new mechanism.
- **pixel-phone decides, not Pixel.** The handler calls the accept API with `by: discord:<clicker's ID>` and answers privately: `202` "You're on it", `409` "Already answered by …", `410`/`404` "Too late", anything else "Couldn't reach the doorbell" (reported to Sentry). pixel-phone has the call's state and decides who was first. Pixel's key is what pixel-phone trusts; `by` is recorded, not trusted.
- **One attempt, no retries.** Accepting answers a phone call. The accept client sends one request under a 5-second deadline, refuses redirects (the key would follow them), and treats anything unexpected as failed. A late or repeated accept could answer a call nobody is going to.
- **The post follows the call, from events.** On `accepted`, `missed`, `busy` and `ended`, the feature edits the post (who answered, or that nobody did) and removes the button. Events aren't ordered, so an accept always wins and is never replaced, and a `ringing` that arrives after its call settled is ignored. Edits are serialised per call. If no event settles a call within 30 seconds after it stops ringing, the button goes anyway.
- **Only the channel is saved.** Admins pick it with `/admin` → Doorbell; it's kept in `data/doorbell.yaml`. Which post belongs to which call is kept in memory: a call lasts seconds and pixel-phone keeps its state. Unlike attendance polls, there's no state file per call.

## Consequences

- A forged custom ID can at most ask pixel-phone to accept a call, as the clicker, through the dispatcher: the same as pressing a real button. pixel-phone refuses a call that isn't ringing.
- After a restart, a button on a post still works (it names only the call), but that post is no longer edited; it says what it said. A call lasts seconds, so this rarely matters.
- Who answered is public in the channel (their display name, escaped, never a ping), and pixel-phone records their Discord ID. The privacy notice says so.
- `adapters/discord/doorbell-buttons*` and `adapters/pixel-phone/accept*` decide what a click may do and where Pixel's key goes, so they need tests and a human reviewer (AGENTS.md rule 14).
