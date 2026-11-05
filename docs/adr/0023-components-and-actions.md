# 0023. Buttons, select menus and forms run registered actions through the dispatcher

* Status: accepted
* Date: 2026-11-02

## Context

Slash commands with many options are hard to use, and some options only make sense together (`/schedule message … repeat: days:`). Discord's components (buttons, select menus, and modals with radio groups, checkboxes and channel pickers) let a command show only the choices that make sense right now ([the guide](../discord-components.md)). Pixel's rules still have to hold for every click: one place decides access, people are identified by their immutable ID, nothing a person sends is trusted, and the core knows nothing about Discord.

The guide first proposed that every control run an existing slash command with its options filled in. That breaks down when a command moves to components entirely: `/schedule` becomes one command with no subcommands, so there would be nothing left to run.

## Decision

- **Features register actions.** `Feature.actions` holds `ActionDefinition`s (`core/ui.ts`): a name like `schedule.pause`, an `access` (required, checked by the registry exactly like a command's), declared options, and a handler. They aren't slash commands: people reach them only through controls Pixel showed them.
- **Replies carry neutral controls.** `Reply.controls` is up to 5 rows of buttons, links and selects. Each button or select names an `ActionCall` (an action and its arguments). An action returns either a reply that replaces the message, or a `Form` (title, fields, and the `ActionCall` to run on submit).
- **Every use is `Dispatcher.act`.** Rate limit, identity, the action's access (tier, capability, context), argument validation against its declared options, then the handler, with the same logging (`action.executed`, `action.denied`) and error mapping as `dispatch`. The actor is whoever used the control, by ID.
- **What a control runs stays on the server.** The Discord adapter holds each reply's `ActionCall`s, and each form, under a random token in the `custom_id` (`controls.ts`), for the person the reply was for, for 15 minutes from when it was shown. A click says only which control was used and what was chosen; chosen values must be among those offered, and a submitted form must match the form shown (its fields, lengths and choices). Anything else, someone else's control, or an expired one gets "That's expired" or "That isn't yours" privately, without reaching the dispatcher. A channel picked in a form carries what the submitter may do there, as a `channel` option does.
- **Legacy components, not Components V2,** for now: content and embeds as today, with action rows under them. It reuses the existing renderer and its limits, and avoids V2's one-way switch on a message. A layout that needs V2 can move later behind the same core types.
- **No stateless controls yet.** Held controls don't survive a restart, so long-lived public panels aren't supported; that needs its own decision. [ADR 0025](0025-attendance-poll-buttons.md) makes one exception, for attendance polls.

## Consequences

- A button can never do more than its action allows, and the action is checked on every use, so a reply that was right when it was shown can't be used after access is revoked.
- Every deploy expires open panels. People run the command again; nothing is lost but the click.
- Held state is bounded (500 entries, oldest dropped first) and in memory, which fits a single replica ([ADR 0004](0004-azure-container-apps.md)).
- `core/ui*`, `adapters/discord/controls*` and `adapters/discord/ui-handlers*` decide what a click may run, so they need tests and a human reviewer, like the dispatcher (AGENTS.md rule 14).
