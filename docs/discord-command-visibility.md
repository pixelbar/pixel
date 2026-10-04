# Hiding Pixel's commands in Discord

Discord shows every registered slash command to everyone in the server. Pixel's dispatcher still refuses anyone who isn't allowed, but a person who can see `/admin` can try it, and everyone's command list gets longer. This guide hides commands from the people who shouldn't see them.

**Visibility is a convenience, not security.** The dispatcher checks the caller's tier on every run, whatever Discord shows. Never rely on hiding alone.

## What Pixel does for you

When commands are registered (`just register`), every command with `access.minTier: admin` is registered with *default permissions: nobody*. Discord then shows it only to server Administrators. Everyone else, including members, doesn't see it in the command picker.

The catch: people in `config/admins.yaml` who are **not** Discord server Administrators can't see it either, until you allow them (below).

## Letting your Pixel admins see admin commands

Run `just command-access` after `just register`. It allows everyone in `config/admins.yaml` (by Discord ID) to see each admin-tier command, replacing whatever overrides those commands had.

**One-time setup:** in the [Developer Portal](https://discord.com/developers/applications), open Pixel → OAuth2 → Redirects and add `http://localhost:53682/callback`.

**Each run:**

1. `just command-access` prints a link and waits (5 minutes).
2. Open the link logged in as someone who manages the server (an Administrator, or with Manage Server) and approve it.
3. Discord sends the token to a tiny page the script serves on `localhost`, which passes it to the script. The token stays in memory. It isn't printed, logged or saved, and it isn't in the repo. The script prints one line per command when it's done.

Why the sign-in: Discord only lets a *user's* token (scope `applications.commands.permissions.update`) change command permissions. A bot token is refused. That token lasts about a week, but the script gets a fresh one every run, so nothing is stored.

If you'd rather do it by hand: **Server Settings → Integrations → Pixel**, click the command, and under **Roles & Members** add the people or a role.

Either way, this only affects what Discord shows. A person you allow who isn't in `config/admins.yaml` is still refused by Pixel. Admins are still added only in that file.

## Hiding other commands from some roles

Commands below admin tier (`/status`, `/events`, `/info`, `/help`, `/ping`, `/whoami`) are visible to everyone by default, which is usually what you want. `/ha` (Home Assistant) is refused to guests by Pixel, but Discord shows it to everyone unless you hide it, so you may want to hide it from the roles that aren't members or friends. To hide one from a role:

1. **Server Settings → Integrations → Pixel**.
2. Click the command.
3. Under **Roles & Members**, turn off **@everyone** and add the roles that should see it. Or add a deny for a specific role.

Discord roles can't tell Pixel's `member` from `friend` when there is one role for everyone, so hiding by role is only as fine-grained as your Discord roles.

## Things to know

- Each command is set up separately. A new command (or a renamed one) needs the steps repeated. Subcommands such as `/admin status` follow their group.
- Re-running `just register` may reset a command's overrides (Discord's docs don't say), so run `just command-access` after it. A **new** admin-tier command always starts hidden.
- Administrators and the server owner always see every command.
- Secret commands (such as the future door control) should be admin-tier or hidden this way **and** protected by a capability. The name is still discoverable by anyone who can see it.
