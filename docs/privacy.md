# Pixel privacy notice

This notice is about **Pixel**, the Pixelbar assistant bot. It says what Pixel stores about people, why, where, and for how long, and how to ask for a copy or deletion.

It lives in this public repository so anyone can read it (Discord `/help` links here). It is **not** a decision about who the data controller is (the association or the board), and it does **not** replace or extend any other Pixelbar privacy policy unless the board says so. Those questions are still for the board.

**Contact:** [bestuur@pixelbar.nl](mailto:bestuur@pixelbar.nl)

## What Pixel stores, and why

Pixel stores as little as it can. It has no database. It identifies people only by their immutable Discord user ID. Display names and handles are stored only so operators can recognise someone; Pixel never authorises on a name.

| What | Why |
| --- | --- |
| Discord user ID, membership tier, optional note, and any named capabilities | Access control: so Pixel knows which commands you may use |
| Creator ID and display name, channel, and the text of a scheduled message or poll | To post it later, if you used `/schedule` |
| Discord ID, display name, handle, and what you did (command name and outcome, not the words you typed) | Moderation and debugging |
| Errors, with the same identity fields when they happened during a command | Debugging |
| A `/feedback` message, with your Discord name, handle and ID | So maintainers can follow up. This is the only place Pixel keeps words you typed |

`/whoami` shows you the Discord ID and access level Pixel has for you.

## What Pixel does not store

- Ordinary Discord message content, and command arguments (except `/feedback`)
- Votes on polls Pixel posts (Discord counts those)
- Anything Discord itself holds about your account or messages. That is Discord's data: see [Discord's privacy policy](https://discord.com/privacy)

Pixel never logs secrets. Token-shaped strings are scrubbed from logs and Sentry. When someone sets the space open or closed with `/spacestate`, Sentry also receives what Pixel sent to the space's state API and what it answered (status and a short copy of the reply), with the credentials removed.

## Where it is kept, and for how long

| Where | How long |
| --- | --- |
| Access lists (`config/members.yaml`, `config/admins.yaml`) on the host, and the previous `members.yaml.bak` | Until you are removed. Admin IDs also live in Azure Key Vault |
| Scheduled posts (`data/schedules.yaml`) | Until that schedule is deleted |
| Azure Files backups of those files (when Pixel runs in Azure) | 14 days |
| Pixel's rotating log file | About 14 days |
| Azure Log Analytics (cloud console logs) | 30 days (already set in Terraform; Azure's minimum) |
| Sentry (errors, Logs, User Feedback) | **30 days, intended.** Not yet applied in the Sentry project — operators must set it (see the runbook) |

These periods are what the code and Azure stack use today. The board still needs to sign them off.

## Your rights

You can ask for a copy of what Pixel holds about you, or ask for it to be deleted. Email [bestuur@pixelbar.nl](mailto:bestuur@pixelbar.nl). Say it is a Pixel privacy request and include the Discord account it is about. Operators confirm it is you (the ID must be yours), then follow the [runbook](runbook.md#privacy-requests). Under GDPR they have **one month** to respond.

Deletion removes you from Pixel's access lists and scheduled posts. Logs and Sentry entries then age out under the periods above, or operators delete them sooner when they can. Discord's own data is not Pixel's to delete.

## See also

- [Identity and access](identity-and-access.md) (why Pixel stores IDs, and how authorisation works)
- [Operations runbook](runbook.md#privacy-requests) (how operators handle a request)


## Optional RevBank integration

When configured, `/revbank` sends your Discord ID and requested action to a private RevBank gateway. A link request also sends the nickname you enter. The gateway stores pending requests (up to 24 hours), approved account links until unlinked/revoked, and a bounded management audit; its operator controls backup retention. Link managers verify ownership before approving a specific request. They can inspect link metadata but cannot use Pixel to read another person's financial history.

Pixel displays your balance or last ten confirmed bookings in a private Discord reply and does not persist the financial response, nickname, or request body in its logs or Sentry. Standard command names, outcomes and caller identity are logged as described above. Discord receives the private reply and handles it under its own policy. The gateway removes raw terminal input, counterparties and free-form booking descriptions; catalogue labels may be shown.

`/revbank unlink` removes the current link and pending request from the gateway. It does not delete RevBank's original financial records, old state backups, management audit entries or Discord's copy of replies. Contact the board for those requests. This optional integration needs the same operator/board review of retention as the rest of this notice.
