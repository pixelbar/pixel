# Hiding Pixel's commands in Discord

Discord shows every registered slash command to everyone in the server. Pixel's dispatcher still refuses anyone who isn't allowed, but a person who can see `/admin` can try it, and everyone's command list gets longer. This guide hides commands from the people who shouldn't see them.

**Visibility is a convenience, not security.** The dispatcher checks the caller's tier on every run, whatever Discord shows. Never rely on hiding alone.

## What Pixel does for you

When commands are registered (`just register`), every command with `access.minTier: admin` is registered with *default permissions: nobody*. Discord then shows it only to server Administrators. Everyone else, including members, doesn't see it in the command picker.

The catch: people in `config/admins.yaml` who are **not** Discord server Administrators can't see it either, until you allow them (below).

## Letting your Pixel admins see admin commands

A server Administrator (or someone with *Manage Server*) does this once per command:

1. **Server Settings → Integrations → Pixel**.
2. Click the command, for example `/admin`.
3. Under **Roles & Members**, add the people (or a role) who should see it. Adding specific **members** is fine and doesn't need a role.
4. Leave **Channels** as you like.

This only affects what Discord shows. A person you add who is not in `config/admins.yaml` is still refused by Pixel.

## Hiding other commands from some roles

Commands below admin tier (`/status`, `/events`, `/info`, `/help`, `/ping`, `/whoami`) are visible to everyone by default, which is usually what you want. To hide one from a role:

1. **Server Settings → Integrations → Pixel**.
2. Click the command.
3. Under **Roles & Members**, turn off **@everyone** and add the roles that should see it. Or add a deny for a specific role.

Discord roles can't tell Pixel's `member` from `friend` when there is one role for everyone, so hiding by role is only as fine-grained as your Discord roles.

## Things to know

- Each command is set up separately. A new command (or a renamed one) needs the steps repeated. Subcommands such as `/admin status` follow their group.
- After running `just register`, check the Integrations page once: Discord may reset a command's overrides when it is re-registered, and a **new** admin-tier command always starts hidden.
- Administrators and the server owner always see every command.
- Discord only lets a *user* (not a bot) change these overrides, so Pixel can't do step 2 for you.
- Secret commands (such as the future door control) should be admin-tier or hidden this way **and** protected by a capability. The name is still discoverable by anyone who can see it.
