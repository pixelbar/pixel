# 0021. Parking state is three files, one per rate of change

* Status: accepted
* Date: 2026-10-24
* Issue: #150 (#151)

## Context

Pixel assigns parking spots at the gate (`/park`). Pixelbar has one spot of its own and borrows others whose availability changes from day to day, and people park in them for an hour or two. Three kinds of state change at very different rates: the list of spots (rarely), when the borrowed ones are open (daily), and who is parked where (on every `/park`). There is no database ([ADR 0003](0003-no-database.md)), and everything should be changeable at runtime.

## Decision

- **Three YAML files in `PIXEL_DATA_DIR`**, each with its own store and failure mode:
  - `parking-spots.yaml` (`services/parking-spots.ts`): the spots (name, description, `permanent`) and the parking settings (reminder, grace period, daily reset, the durations offered). Changed with `/admin parking add-spot | edit-spot | remove-spot | settings`. If it's invalid, parking is off and the file is never overwritten until someone fixes it, like `schedules.yaml`.
  - `parking-windows.yaml` (`services/parking-windows.ts`): `windows`, when a borrowed spot is open, and `blocks`, when a permanent spot is closed. Changed with `/admin parking open | close`. Nothing runs past the reset on the day it starts, and entries are pruned once they end, so the file only holds today's and later. If it's invalid, every borrowed spot is closed (permanent spots still work) until an admin's next `open` or `close`, which moves the broken file aside to `parking-windows.yaml.broken` and starts again: its content would have expired by the end of the day anyway.
  - `parking-bookings.yaml` (#152): who is parked where. A booking is deleted when it ends, so there's no parking history. If it's invalid, no new bookings are made, because a spot could be given out twice.
- **Settings live with the spots, not in environment variables,** so admins change them without a deploy. Spot names and durations are offered through autocomplete, not fixed choices, so changing them needs no re-registration.
- **Times are instants** (ISO UTC) in the files and shown in `PIXEL_TIMEZONE`. The daily reset (`resetAt`, 23:59 by default) is wall clock in that zone.
- **Spot names and times are logged** with who changed them (`actorLogFields`). They describe the building, not a person. Descriptions are not logged.

## Consequences

- A bad hand edit of one file never loses the others: the spots survive a broken windows file, and today's openings survive a broken spots file (though parking is off until it's fixed).
- None of the three is safe to delete: deleting the spots file deletes the spots and settings, deleting the windows file closes the borrowed spots for the day, and deleting the bookings file frees spots that have cars in them.
- Each write rewrites one small file (temp file and rename). One replica means no locking: a store change is one synchronous call, so two commands can't interleave inside it.
