# 0022. OpenR doors and the parking gate: one Pixel account, kept alive by Pixel

* Status: accepted
* Date: 2026-10-26
* Issue: #154 (part of #150)

## Context

The building's doors and the parking gate are run by OpenR. It has no API for bots: its web dashboard (`dashboard.openr.nl`) calls a JSON API (`/api/v4`), and [rensr](https://github.com/NinjaLikesCheez/rensr-discord-bot) showed that a script can make the same calls. Logging in takes an email and password, then a one-time code that OpenR **emails** to the account. The session is two cookies: an access cookie that opens doors and lasts about 15 minutes, and a refresh cookie that lasts about 6 months from the login. `POST /me/current_session/refresh` with only the refresh cookie sets both again and gives their expiry as Unix times (confirmed by hand; rensr never got as far as refreshing). A door opens with `POST /buildings/<building>/doors/<door>/open`.

rensr logged each Discord user in with their own OpenR account and kept their sessions in a JSON file. Pixel already decides who may do what itself (tiers, capabilities, the dispatcher), and only members with an OpenR account could use per-person logins.

## Decision

- **One OpenR account for Pixel.** Pixel logs in as its own account (`OPENR_EMAIL`, `OPENR_PASSWORD`, app-group secrets `openr-email` and `openr-password`, [ADR 0017](0017-one-writer-for-app-secrets.md)). OpenR only sees that account. Who may open which door is decided in Pixel, like everything else: `/openr open` needs a member with the `openr` capability, and the gate opens only for someone `/park` has just given a spot. Pixel never sends OpenR who asked.
- **An admin does the login.** `/admin openr login` starts it and `/admin openr code` passes on the emailed code. Whoever reads that account's mail completes the login, so control of the mailbox is part of the security of the doors.
- **Pixel keeps the session alive by itself,** refreshing it shortly before its access expires, and ends it when OpenR refuses a refresh; Sentry then says an admin must log in again. `/admin status` shows the session.
- **The session is saved** in `PIXEL_DATA_DIR/openr-session.json` (atomic, deleted when it ends, owner-only where the filesystem allows; on Azure the share's access control is the fence), so a deploy or a crash doesn't need a person. It holds the cookies, never the email or password, and the share mirrors (`just pull`) never copy it.
- **The doors come from config,** not from OpenR: `OPENR_DOORS` lists the names and IDs `/openr open` offers, and `OPENR_GATE_DOOR` is the gate, which is never among them. An account that can open more doors still only opens those.
- **Fail closed:** one call per opening, under one deadline that covers a refresh too. No retries, no queueing, one opening at a time per door. `/admin doors off` stops OpenR's doors and the gate along with Home Assistant's.

## Consequences

- Anyone who can read the data share can open the doors until the session ends. That share already holds `members.yaml`, where a capability can be granted, so it doesn't widen who can open them through Pixel; but the file must not be copied anywhere else. Log out (`/admin openr logout`) to end the session at once.
- OpenR's API is undocumented and may change. Requests copy the dashboard's headers, including its version (`APP_VERSION` in `adapters/openr/client.ts`); a dashboard update is the first thing to check when OpenR starts refusing Pixel.
- Refreshing doesn't extend the refresh cookie, so an admin logs in again about every 6 months. `/admin openr status` shows when the session ends and warns in the last two weeks.
- OpenR's own logs show Pixel's account for every opening; Pixel's logs (`openr.door_opened`, `parking.gate_opened`) say who it was for.
- Per-person OpenR logins, if they're ever wanted, would be a separate decision: they'd move the "who may" decision to OpenR and need account linking.
