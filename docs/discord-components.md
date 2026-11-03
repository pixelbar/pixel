# Discord components

How to use Discord's buttons, select menus, modals and layout components in Pixel: what each one is for, when to choose it over a slash command option, and the rules that keep them as safe as the commands they replace.

**Read this before adding a button, a select menu or a modal, or before moving a command off slash options.** The security rules in the [root `AGENTS.md`](../AGENTS.md) and [identity and access](identity-and-access.md) apply to every click exactly as they apply to every command.

## Where Pixel is today

Features can put buttons and select menus on a reply, and open forms with text, radio groups, checkboxes and channel pickers. Every one of them runs a registered action through the dispatcher ([ADR 0023](adr/0023-components-and-actions.md), and [how Pixel does it](#how-pixel-does-it) below). Commands move over one at a time.

The older forms for slash command `form` fields ([`forms.ts`](../src/adapters/discord/forms.ts)) still put an Action Row around each Text Input, which Discord now marks as deprecated. Move them to Labels when that code is next changed.

Sources: Discord's [components overview](https://docs.discord.com/developers/components/overview), [component reference](https://docs.discord.com/developers/components/reference), [using message components](https://docs.discord.com/developers/components/using-message-components), [using modal components](https://docs.discord.com/developers/components/using-modal-components) and [receiving and responding](https://docs.discord.com/developers/interactions/receiving-and-responding). The limits below were checked against those pages in November 2026, with discord.js 14.27, which has a builder for every component listed here. If Discord's page and this one disagree, Discord's page is right: fix this one.

## The components

Discord groups components into three kinds. **Layout** components arrange other components, **content** components show something, and **interactive** components send Pixel an interaction when someone uses them.

| Type | Component | Kind | Messages | Modals | What it's for |
| ---: | --- | --- | :---: | :---: | --- |
| 1 | Action Row | layout | ✓ | (deprecated) | Up to 5 buttons, or exactly 1 select menu, side by side. |
| 2 | Button | interactive | ✓ | | One action, one click. |
| 3 | String Select | interactive | ✓ | ✓ | Pick from up to 25 options Pixel lists. |
| 4 | Text Input | interactive | | ✓ | Typed text, one line or a paragraph. |
| 5 | User Select | interactive | ✓ | ✓ | Pick server members. Returns their IDs. |
| 6 | Role Select | interactive | ✓ | ✓ | Pick roles. |
| 7 | Mentionable Select | interactive | ✓ | ✓ | Pick users or roles. |
| 8 | Channel Select | interactive | ✓ | ✓ | Pick channels, optionally limited by channel type. |
| 9 | Section | layout | ✓ | | 1 to 3 Text Displays with one Button or Thumbnail beside them. |
| 10 | Text Display | content | ✓ | ✓ | Markdown text. Replaces `content` in a V2 message. |
| 11 | Thumbnail | content | ✓ | | A small image, only as a Section's accessory. |
| 12 | Media Gallery | content | ✓ | | 1 to 10 images or videos. |
| 13 | File | content | ✓ | | One uploaded file (`attachment://` only). |
| 14 | Separator | layout | ✓ | | Space between components, with or without a line. |
| 17 | Container | layout | ✓ | | A box with an optional accent colour, like an embed. |
| 18 | Label | layout | | ✓ | Wraps one input in a modal with a title (45) and description (100). |
| 19 | File Upload | interactive | | ✓ | Up to 10 files uploaded through a modal. |
| 21 | Radio Group | interactive | | ✓ | Pick exactly one of 2 to 10 options. |
| 22 | Checkbox Group | interactive | | ✓ | Pick any number of 1 to 10 options. |
| 23 | Checkbox | interactive | | ✓ | One yes/no. Can't be required. |

### Limits worth remembering

- **`custom_id`**: 1 to 100 characters, unique within its message or modal. Every interactive component has one except Link and Premium buttons.
- **Messages**: at most 40 components in total, counting nested ones. A V2 message has at most 4000 characters of text across all its components. A legacy message has at most 5 Action Rows.
- **Buttons**: labels can be 80 characters, but Discord's design guidance is about 34 characters with an emoji and 38 without. Styles are Primary (1), Secondary (2), Success (3), Danger (4), Link (5, needs a `url`, sends no interaction) and Premium (6, not for Pixel).
- **Select menus**: up to 25 options, each with a label, value and description of up to 100 characters. The placeholder can be 150 characters. `min_values` and `max_values` go from 0 to 25.
- **Modals**: a title of at most 45 characters and 1 to 5 top-level components. A Text Input holds up to 4000 characters. Its placeholder can be 100 characters. Modal components can't be `disabled`: setting it is an error.
- **Radio Group**: 2 to 10 options. **Checkbox Group**: 1 to 10. **File Upload**: up to 10 files. Uploads aren't scanned until they're posted in a message.

## Choosing the right control

Slash options are fast for someone who knows exactly what they want. Once a command needs several optional options, options that only matter when another option has a certain value, or a lookup the person has to remember, it's confusing. Components fix this by showing only the choices that make sense right now.

| The person needs to… | Use | Not |
| --- | --- | --- |
| Run something in one go with one or two values they know | Slash command options | A modal for one field |
| Pick from a list Pixel knows, up to 25 items | A String Select | An option they have to type correctly |
| Pick from a list that can be longer than 25, or search it | Slash option with autocomplete (`suggest`) | A select that silently drops item 26 |
| Pick a person, a channel or a role | User, Channel or Role Select, or a `user` / `channel` option | A string they type |
| Type long or multi-line text | A Text Input in a modal (`form` fields today) | A one-line option |
| Fill in several related fields at once | A modal with Labels | Five optional slash options |
| Choose one of a few fixed modes (`once`, `weekly`, …) | A Radio Group in a modal, or buttons on a message | A free-text option with conflicting combinations |
| Choose several of a few fixed things (days of the week) | A Checkbox Group in a modal | Typing `wed sat` |
| Do the obvious next step after a result | Buttons on the reply | Asking them to run another command |
| Confirm something hard to undo | A Danger button and a Cancel button | A `confirm:` boolean option |
| Page through a long list | Previous and Next buttons that edit the message in place | A `page:` option |
| Open a web page | A Link button | A URL pasted into text |

Keep the slash command as the way in. People find features by typing `/`, and commands are where Discord applies the server's visibility settings ([Hiding commands in Discord](discord-command-visibility.md)). Components then make the rest of the flow simpler: fewer options on the command, and buttons, selects and modals after it.

Anti-patterns to remove as commands move over:

- **Options that conflict.** `/schedule message … repeat: once days: wed` used to mix options that only make sense together. Now the repeat is a Radio Group on the form, and the days only appear on the draft when the repeat is weekly.
- **Boolean "are you sure" options.** `/parking taken confirm:` and `evict:` on the `/admin parking` commands used to ask for confirmation before the person could see what would happen. Now both show what will happen, with a Danger button.
- **Two-command flows.** `/admin openr login` followed by `/admin openr code code:` is one task split in two. A reply with an "Enter code" button that opens a modal keeps it in one place.
- **Listing, then retyping.** `/schedule list` followed by `/schedule pause schedule:` used to make the person carry a name between two commands. Now `/schedule` lists them in a select, with action buttons on the one picked.

## Patterns

### A result with next steps

The command does its job, and the reply offers the one or two things people usually do next. `/park` replies with where to park, plus **Extend** and **Leave** buttons. `/ha status` replies with the device's state and buttons for the actions the person may take on that device.

- Only show a button the clicker could actually use. Build the list from the same check the command uses (for Home Assistant, `actionableDevices` and `canActOnDevice`). The click still goes through the dispatcher, so a button shown by mistake is refused, never obeyed.
- One Primary button at most, and it's the step most people want. Everything else is Secondary.

### Confirm before acting

For anything hard to undo (evicting someone, deleting a schedule, revoking a capability), reply privately with exactly what will happen, a **Danger** button whose label is the action ("Evict and close spot 3", never "Yes"), and a Secondary **Cancel**.

- The click edits the same message (`UPDATE_MESSAGE`) into the result and removes the buttons, so it can't be clicked twice.
- Don't use a confirmation for routine actions: a light switch or `/park` shouldn't ask "are you sure".
- A door or the parking gate is never opened by a long-lived button on a public message. It opens from a click on a private reply, through `DeviceControl` or `openrGate` like the command, once.

### Pick from a list

A private reply with a String Select of what the person may act on, then buttons for what to do with it. For example, `/schedule` shows every schedule in a select. Choosing one edits the message to show it, with **Edit**, **Pause** or **Resume**, and **Delete** buttons for its owner.

- Up to 25 options. If a list can grow past 25, use autocomplete on the command, or page it, and say so. Never cut a list off without saying.
- A select's value is a key Pixel looks up again on the click (a schedule's ID). Don't put the thing itself in the value.
- Never offer something the clicker couldn't use. This is the same rule as autocomplete.

### A form in a modal

For several related fields, open a modal with one Label per field. Inside a Label there can be a Text Input, a select of any kind, a Radio Group, a Checkbox Group, a Checkbox or a File Upload. A Text Display can explain the form.

- Five top-level components at most. If a form needs more, it's two steps or two commands.
- Fields in a modal can't depend on each other: nothing appears or disappears while the person fills it in. Ask for everything that could matter, mark what's optional in its description, and check the combination when it's submitted.
- A modal can't open from a modal submit. When a submit has a mistake, reply privately with what's wrong and a **Fix it** button that reopens the modal filled in with what they typed (pass it as the prefill, like `formModal`'s `values`).
- Opening a modal has to be the first response to an interaction, within 3 seconds, and never after a defer. The access check before it must be fast, as `prepareForm` is today.
- Use the `Label` component, not an Action Row, for every input. Move `formModal` over when it's next changed.

### Paging

For a list that won't fit one message, add **Previous** and **Next** buttons that edit the message in place (`UPDATE_MESSAGE`). Disable them at the ends and show where you are ("Page 2 of 5"). Each page is read fresh when its button is clicked, not cached.

### Public panels

A message posted in a channel with buttons anyone can click, such as "What's on today" with a refresh button. Use these sparingly:

- **Anyone who can see a public message can click its buttons.** The clicker is the actor, never the person who posted it.
- They live longer than Pixel's memory (every deploy restarts Pixel), so their `custom_id` must hold everything needed to run again. See [keeping state](#keeping-state).
- They never control a door, the gate or any Home Assistant device, and never show anything more private than the channel already can.

## UX rules

- **Private by default.** Anything that leads to someone's own data, or to an action only they may take, starts as a private (ephemeral) reply. Only the person who ran the command can see and click components on a private reply. Rule 8 still applies to everything a click shows.
- **Edit in place for the same task, send a new message for a new one.** Selecting, paging, confirming and cancelling edit the message they're on. A result other people need to see goes out as a new public message, through the `Announcer` or `ChannelPosts` as today.
- **Labels say what happens.** Start with a verb in sentence case: "Extend by 1 hour", "Delete schedule", "Open front door". Never "OK", "Yes" or "Submit" when there's room to name the action. Keep to about 34 characters.
- **Colour means something.** Primary for the main next step, Secondary for the rest, Danger only for actions that destroy or evict, and Success sparingly. Don't use colour or emoji as the only way to tell buttons apart, because screen readers and colour-blind people can't see either.
- **Emoji are optional decoration.** At most one per button. The label must make sense without it.
- **Say what's going on in text.** A message with buttons still needs a sentence that explains them. Never send a message that is only buttons.
- **Remove or disable what no longer works.** After a one-time action, edit the message so its buttons are gone or disabled. A private reply's buttons stop working when Pixel restarts or their state expires. When someone clicks one anyway, say "That's expired. Run /command again" privately, as `FORM_EXPIRED_MESSAGE` does.
- **Placeholders guide the person.** A select's placeholder says what to choose ("Choose a schedule"), not "Select…". A Text Input's placeholder shows an example of the format.
- **Empty states are text, not an empty select.** If there's nothing to choose, say so and point to the command that makes one.
- **Images need alt text.** Every Thumbnail and Media Gallery item gets a `description`.

## Components V2 or legacy

Discord has two ways to put components on a message.

- **Legacy**: `content` and `embeds` as Pixel sends now, with up to 5 Action Rows of buttons or selects below them. Not deprecated, and fine for adding a few buttons to an existing reply.
- **Components V2**: set the `IS_COMPONENTS_V2` flag (`MessageFlags.IsComponentsV2`, `1 << 15`). The whole message is components: Text Displays instead of `content`, Containers instead of embeds, and Sections, Separators and media around them. Discord recommends it for new work.

V2 rules that catch people out:

- **`content` and `embeds` stop working, and so do polls and stickers.** Attachments only show through a File or media component.
- **The flag can't be removed.** Once a message is V2, every edit of it must be V2. Don't turn an existing embed message (a live open/closed announcement, for example) into V2 by editing it. Post a new one.
- **A deferred reply can't become V2 through the callback.** Defer, then send the V2 message with an edit of the original reply.
- **4000 characters of text and 40 components across the whole message.** The renderer must check the limits and truncate, as `render.ts` does for embeds.
- **Mentions still follow `allowed_mentions`.** Always send `allowedMentions: { parse: [] }`.

**Pixel's choice, for now: legacy.** Replies with controls are content and embeds as before, with up to 5 action rows under them ([ADR 0023](adr/0023-components-and-actions.md)). That reuses the existing renderer and its limits, and every step of a flow can be any reply, without V2's one-way switch. If a layout needs V2 later, a core `Reply` maps onto it simply: `text` becomes a Text Display, and each embed becomes a Container with the embed's accent colour, its title and description as Text Displays, and its fields as Text Displays (or Sections when a field has a button). Don't mix V2 and legacy in the steps of one flow, because a message can only become V2, never go back.

## How interactions work

| Interaction | Arrives as | May respond with |
| --- | --- | --- |
| Slash command (2) | `isChatInputCommand()` | Reply (4), defer (5), modal (9) |
| Autocomplete (4) | `isAutocomplete()` | Suggestions (8) only |
| Button or select click (3) | `isButton()`, `isStringSelectMenu()`, `isUserSelectMenu()`, … | Reply (4), defer (5), **update the message (7)**, **defer an update (6)**, modal (9) |
| Modal submit (5) | `isModalSubmit()` | Reply (4), defer (5), update (7) or defer an update (6) when the modal came from a component. **Never a modal.** |

- **3 seconds** to make the first response, or Discord shows "This interaction failed". The existing `respond()` defers in time. For component clicks, the first response is usually `update()` or `deferUpdate()`.
- **15 minutes** for the interaction token, after which Pixel can no longer edit or follow up on that reply. Held state for a private flow shouldn't outlive this.
- **An ephemeral message can only be edited through an interaction.** Pixel can't edit a private reply later from a timer, only in response to a click on it.
- **A component interaction carries the message it came from** (`interaction.message`), with its components. That's useful for rebuilding the message, but it's never a source of truth for authorisation.

## Security rules

These turn the [root `AGENTS.md`](../AGENTS.md) rules into rules for components. They aren't optional, and the files that carry them need tests and a human reviewer (rule 14).

1. **Every click runs a registered action through the dispatcher.** A button, select or form names an action (`Feature.actions`), and using it goes through `Dispatcher.act`: rate limit, identity, the action's access (tier, capability, context), its declared options, then the handler. Never run a handler, call `DeviceControl`, call the `DoorSystem` or change the `AccessStore` straight from a component handler. Give an action the same `minTier` and `capability` as the command it belongs to, never a looser one.
2. **The clicker is the actor.** Build the actor from `interaction.user` with `discordActor()`, by ID. Never use the person who ran the original command, whoever is named in the message, or a user ID read from the `custom_id`.
3. **Check the guild.** Refuse components from any guild other than the configured one, as the command and modal handlers do (`WRONG_GUILD_MESSAGE`).
4. **The `custom_id` is public and untrusted.** Anyone who can see the message can read it, and a modified client can send any string. Never put secrets, tokens, codes or personal data in it, including names and other people's IDs on a public message. Parse it with an exact regular expression, and refuse anything that doesn't match, has expired or belongs to someone else.
5. **Select values and submitted fields are untrusted.** Validate every value as the command would validate a typed option. A suggestion or option list is a convenience, never validation: autocomplete has the same rule.
6. **A User Select gives an immutable ID.** Act on the ID it returns, never on a name in `resolved`. A Channel Select must give the handler the same `ResolvedChannel` (with what the caller may do there) as a `channel` option. If Discord didn't send the permissions, refuse.
7. **Show only what the clicker may use.** Options, buttons and prefilled values come from the same checks as the command: `visibleDevices`, `actionableDevices`, the caller's own schedules, and so on. Anything shown by mistake is refused when clicked.
8. **One click, one action.** Physical actions (doors, the gate, Home Assistant) are never retried or queued. Remove or disable the buttons in the same response, and let the existing one-at-a-time locks refuse a second click. Check the `KindSwitch` before acting, as the commands do.
9. **Text stays safe.** User-authored text is interpolated, then `escapeMarkdown`'d, before it goes in a Text Display, a label or an option, as it would in a reply. Mentions are always disabled.
10. **Log the action, not the input.** Log the command path, the actor (`actorLogFields()`) and the outcome. Don't log a `custom_id`'s arguments, select values or anything typed in a modal, unless an ADR says so.
11. **Discord stays in the adapter.** Components are built and parsed only in `src/adapters/discord/`. Features describe controls and forms in core terms (see [how Pixel does it](#how-pixel-does-it)). Mastodon and announcement kinds never depend on a component existing, so every announcement has to make sense without its buttons.

## Keeping state

Pixel has no database, and every deploy restarts it, so state for a component either lives in its `custom_id` or in memory for a short time.

| | Held (in memory) | Stateless (in the `custom_id`) |
| --- | --- | --- |
| **How** | A random token in the `custom_id` points to what the control runs (`controls.ts`) | The `custom_id` names the action and short ID-like arguments |
| **Survives a restart** | No: the click gets "That's expired" | Yes |
| **Who can click** | Only the person it was made for (checked against the stored actor) | Anyone who can see it, as themselves |
| **Expires** | At most 15 minutes, used once where it makes sense | Never; the dispatch decides each time |
| **Use for** | Private flows, anything with typed text, anything with more than an ID or two | Public panels, and simple actions on stable IDs |
| **Built** | Yes | Not yet: it needs its own decision |

Rules for both:

- **Prefix and version.** Every Pixel `custom_id` starts with `pixel-`, then names what it is, such as `pixel-ui:<token>:<n>` for a control and `pixel-ui-form:<token>` for a form, and a version for anything stateless so an old message's format can be refused after a change. Keep it under 100 characters, checked in a test.
- **Bounded memory.** Held state has a cap and prunes expired entries (`HeldControls` keeps at most 500).
- **The click carries nothing the dispatch trusts except the choice itself.** The action and its arguments come from what's held, the actor is whoever clicked, and the dispatcher checks everything again.

## How Pixel does it

[ADR 0023](adr/0023-components-and-actions.md) has the reasons. In short:

**Features register actions and put controls on replies.** Nothing here mentions Discord:

```ts
// In a feature: what the controls run. Access is required, like a command's.
actions: [
	{
		name: "schedule.pause",
		access: ACCESS,
		options: [{ name: "id", description: "Which schedule", type: "string", required: true }],
		handler: async (ctx) => ({ reply: panelFor(ctx.args.id, ctx.principal) }),
	},
],

// In a reply: rows of buttons, links and selects, each naming an action and its arguments.
return {
	embeds: [summary],
	private: true,
	controls: [
		[
			{ kind: "button", label: "Pause", call: { action: "schedule.pause", args: { id } } },
			{ kind: "button", label: "Delete", style: "danger", call: { action: "schedule.delete", args: { id } } },
		],
	],
};
```

- An action returns `{ reply }`, which replaces the message the control was on, or `{ form }`, which opens a form. A form's `submit` names the action to run with the fields as extra arguments. A form must open within Discord's 3 seconds, so the handler that returns it should do no slow work.
- A select's chosen value fills in its `arg`. With `max` above 1, the values are joined with spaces, so they can't contain whitespace. A form's checkbox group works the same way. A channel field adds a `ResolvedChannel` to `ctx.channels`, like a `channel` option, and a user field adds a `ResolvedUser` to `ctx.users`, like a `user` option (so bots are refused unless the option allows them). A button can't carry a picked person or channel: to replay an action that had one (Go ahead after a confirmation), hold their ID in the button's arguments and pass it to a separate action, as `parking-admin.assign-confirm` does.
- Refusals (no access, a `UserFacingError`) are sent as a private reply and leave the message as it was. To show a mistake inside the panel instead, catch it in the action and return a reply that explains it.
- Limits come from `UI_LIMITS` in `core/ui.ts`: 5 rows, 5 buttons per row or one select, 25 options, 5 form fields, 2 to 10 radio options, 1 to 10 checkboxes. The adapter throws on a layout Discord would refuse, so a test catches it.

**The Discord adapter draws and checks them.** `controls.ts` renders rows as legacy action rows and forms as modals with Labels, and holds what each runs (`HeldControls`). `ui-handlers.ts` takes a click or a submitted form, checks the guild, the token, the owner, and that the values match what was shown, then calls `Dispatcher.act` and answers: `update` for a reply, `showModal` for a form, a private reply for a refusal.

## Testing

- Test a feature's actions as plain functions with a fake context, like its commands: what each returns, and which controls each reply offers to whom. The adapter's tests (`controls.test.ts`, `ui-handlers.test.ts`) already cover drawing and checking, so a feature doesn't repeat them.
- For every component handler, test the refusals: the wrong guild, an expired token, someone else's token, a malformed `custom_id`, an unknown select value, a tier or capability that's missing at click time (not just when the message was sent), and a rate limit.
- Test that a feature's replies fit the limits, for example by rendering them with `renderControls` and `renderForm` in a test. A long list must page, not throw.
- Test that what a select offers equals what the clicker could use, for each tier.
- The coverage floors apply. Keep discord.js glue thin and put decisions in plain functions.

## Moving a command over

1. Say in the PR what's confusing now and what the new flow is: the command, then each message and click.
2. Keep the command name if you can, so people don't have to relearn it. Removing options is fine. Removing a command needs the commands registered again (`just register dev`, then the release registers prod).
3. Put access on the command and on every action. Nothing new is public by accident.
4. Update [`docs/commands.md`](commands.md) and the `CHANGELOG.md` (`Changed`).
5. Try it on Pixel Dev with `just deploy dev`. Check it on mobile as well as desktop, since layouts and modal descriptions render differently.

## Candidates

The commands that would gain most, roughly in order. Each is its own PR. `/schedule`, `/park` and `/admin parking` have moved: each opens a panel, good examples to copy (`src/features/schedules/index.ts`, `src/features/parking/index.ts`, `src/features/admin/parking-panel.ts`).

| Command | Today | With components |
| --- | --- | --- |
| `/admin openr login`, `/admin openr code` | Two commands | One reply with an "Enter code" button that opens a modal |
| `/ha status`, `/ha set` | Type the device, then type the state | `/ha status`'s reply has buttons for the actions the person may take |
| `/admin announcements set`, `remove`, `list` | Three commands | `list` with a Channel Select and a style select, and Remove buttons |
