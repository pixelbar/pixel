# 0025. Attendance polls: public buttons that survive a restart

* Status: accepted
* Date: 2026-11-05

## Context

The weekly "who's coming" poll is a native Discord poll today. Discord always announces a winner when one closes ("the winner is No with 30%"), which is the wrong message for an attendance poll, and Pixel can't stop it. People wanted a poll that ends with "5 people are coming to the Pixelbar!", and the totals so far posted at a set time (17:00) while it stays open until midnight (#199).

So Pixel has to count the votes itself, which means a message with a button per answer that anyone in the server can press, for as long as the poll is open, often more than a day. [ADR 0023](0023-components-and-actions.md) holds what each control runs in memory, for one person, for 15 minutes, and says long-lived public panels need their own decision. This is that decision.

## Decision

- **A third kind of scheduled post, `attendance`,** next to messages and native polls (`core/channel-posts.ts`). The creator writes 1 to 5 answers and picks which count as coming. Native polls are unchanged.
- **The buttons carry only the poll and the answer.** Their custom ID is `pixel-attend:<poll>:<answer>`: the poll's random ID (12 lowercase hex characters from `randomBytes`) and the answer's position (0 to 4). Neither is secret or personal. They're drawn and parsed only in `adapters/discord/attendance-buttons.ts`. Parsing is one exact regular expression, and anything else is refused privately without reaching the dispatcher.
- **Every click is one fixed action through the dispatcher.** The adapter never reads an action name from the custom ID. It always runs `schedule.attend` through `Dispatcher.act` for whoever clicked, by immutable ID, with the poll and answer as its two declared options. So each click gets the same rate limit, identity, access and argument checks as any control. The action's access is `guest`: anyone who can see the channel may answer. The handler checks again that the poll exists, is still open and has that answer.
- **Votes are kept in a file,** `data/attendance.yaml` (`services/attendance.ts`). It holds each poll as posted, and each vote as the voter's ID, display name (for the totals) and answer. One answer per person: pressing another one switches, and pressing yours again takes it back. The file is validated strictly and fails closed, like the schedules file. Closed polls are dropped a week after they close.
- **A click is answered privately, and the message is edited separately.** Pressing a button gets an ephemeral "You're down as …". The feature then edits the poll's message with the new totals, one edit at a time per poll, with clicks in the meantime folded into one more edit. When the poll closes, the runner edits the message one last time without buttons.
- **Results are optional, and copied when the poll goes out.** A schedule can name a results channel, with an optional time of day for the totals so far on the day it closes, plus two templates. The templates are filled at post time through the interpolator, using per-post values (`{{count}}`, `{{names}}`, `{{question}}`, `{{link}}`) alongside the date tokens. In the poll's own channel they reply to the poll (Discord can't reply across channels). They follow the reminder's rules: once each, skipped when more than an hour late, only while the creator may still schedule, and never pinging anyone.

## Consequences

- An attendance poll keeps working across deploys and restarts, unlike every other control. That's possible because the custom ID only names an answer and the action is fixed: a forged ID can, at most, cast the clicker's own vote on a poll that's open.
- Names are public. The totals on the message and in the results posts list who picked each answer, as a native poll does. Names are escaped and mentions are off, so a display name can't format text or ping anyone. People who don't want to be listed shouldn't vote; the privacy notice says so.
- Deleting `data/attendance.yaml` while a poll is open loses its votes, and its buttons then say the poll isn't running. It belongs in the backups next to `schedules.yaml`.
- `adapters/discord/attendance-buttons*` decides what a click may run, so it needs tests and a human reviewer, like the controls (AGENTS.md rule 14).
- Any later long-lived public button should follow this pattern: a fixed action, a custom ID with no secrets or personal data, parsed exactly, and the state kept server-side in a file. It shouldn't loosen the in-memory controls.
