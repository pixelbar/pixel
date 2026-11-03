---
outline: [2, 4]
pageClass: px-commands-page
---

# Commands

Every command Pixel answers in Discord, grouped by who can use it. Each card shows the lowest tier it needs, how it replies, and any capability it needs on top.

Required options end in a colon, like `device:`. Optional ones are in brackets, like `[topic:]`. Discord lists the options as you type.

## For everyone

<PxCommand sig="/help" tier="guest" reply="private">

The commands you can use. It only lists the ones your tier and capabilities allow.

</PxCommand>

<PxCommand sig="/status" tier="guest" reply="public">

Whether Pixelbar is open right now, and for how long. Pixel reads the switch in the space through the SpaceAPI.

</PxCommand>

<PxCommand sig="/events" tier="guest" reply="public">

What's coming up at Pixelbar, from the Discord server's scheduled events. Times are in the space's time zone.

</PxCommand>

<PxCommand sig="/info [topic:]" tier="guest" reply="public" :options="{ '[topic:]': 'Pick a topic, such as address, contact, membership, rules or visiting. Leave it out to see the list, which only you see.' }">

Short answers about Pixelbar: where it is, visiting, membership, the house rules and how to get in touch. Each answer links to the full page on pixelbar.nl.

</PxCommand>

<PxCommand sig="/whoami" tier="guest" reply="private">

What Pixel knows about you: your tier and your Discord ID.

</PxCommand>

<PxCommand sig="/ping" tier="guest" reply="public">

Checks that Pixel is alive.

</PxCommand>

<PxCommand sig="/feedback message:" tier="guest" reply="private" :options="{ 'message:': 'What you\'d like to tell the maintainers, 3 to 1000 characters.' }">

Sends a message to Pixel's maintainers, with your Discord name and ID so they can follow up. Your message and username may be made public, so don't include anything private. You can send a few at once, then one every ten minutes. What Pixel keeps is in the [privacy notice](/privacy).

</PxCommand>

### Fishbot

A little QuakeNet nostalgia. Pixel keeps the original Fishbot replies, including their old-school language. These commands answer publicly; help and unknown phrases are private. Pixel only answers slash commands and does not read the channel's conversation.

<PxCommand :level="4" sig="/fishbot say [phrase:]" tier="guest" reply="public" autocomplete :options="{ '[phrase:]': 'A classic phrase, such as fish, hello fishbot, spoon or moo?. Start typing for suggestions; leave empty for private help.' }">

Try a classic Fishbot phrase. Matching ignores case and extra spaces, but requires the whole phrase. Fish go m00!

</PxCommand>

<PxCommand :level="4" sig="/fishbot trout user:" tier="guest" reply="public" :options="{ 'user:': 'Pick the person (or bot) to trout. Nobody gets pinged.' }">

Slap someone around a bit with a large trout. Purely theatrical.

</PxCommand>

<PxCommand :level="4" sig="/fishbot feed" tier="guest" reply="public">

Feed Fishbot hundreds and thousands.

</PxCommand>

<PxCommand :level="4" sig="/fishbot pet" tier="guest" reply="public">

Give Fishbot a friendly stroke.

</PxCommand>

<PxCommand :level="4" sig="/fishbot cookie" tier="guest" reply="public">

Sneak a cookie away from Fishbot.

</PxCommand>

## Members

For paid members. Commands marked Friend also work with a friend membership.

<PxCommand sig="/closing-time" tier="member" reply="private">

Posts the closing-time reminder in the closing-time channel. Pixel also posts it by itself when the space closes.

</PxCommand>

### Home Assistant

Lights, switches and doors in the space. You only ever see the devices you're allowed to see, and you only get buttons for what you may change. Pixel checks again on every press, whatever the panel showed.

<PxCommand :level="4" sig="/ha [device:]" tier="friend" reply="private" autocomplete :caps="['ha-lights', 'ha-switches', 'ha-doors', 'ha-admin']" :options="{ '[device:]': 'Go straight to one device. Only the ones you may see are offered. Leave it out to choose from the list.' }">

Opens the Home Assistant devices you may see, with their state. Changing one needs the capability for that kind of device, or `ha-admin`. Doors are for members only, and only lock and unlock.

</PxCommand>

The list groups the devices by kind, with each one's state as Home Assistant reports it right now. Pick one from the menu to see more, or to change it.

<PxPanel
	command="/ha"
	:embeds="[{ title: 'Devices', lines: ['Choose a device below to see more, or to change it.'], fields: [{ name: 'Lights · 2', value: 'example-light on · example-sign off' }, { name: 'Door · 1', value: 'example-door locked' }, { name: 'Sensor · 1', value: 'example-temperature 21.5 °C' }] }]"
	:rows="[[{ select: 'Choose a device…' }], [{ label: 'Refresh' }]]"
	caption="The list: the devices you may see, grouped by kind, with a menu to pick one."
/>

A device shows its live state, when it last changed and a few details for its kind. There's a button for each thing you may do to it. The one it's already at is greyed out.

<PxPanel
	command="/ha"
	:embeds="[{ title: 'example-light', lines: ['The light over the workbench'], fields: [{ name: 'State', value: 'on', inline: true }, { name: 'Kind', value: 'Light', inline: true }, { name: 'Last changed', value: '2h 0m ago', inline: true }, { name: 'Brightness', value: '50%', inline: true }] }]"
	:rows="[[{ label: 'On', style: 'primary', disabled: true }, { label: 'Off', style: 'primary' }, { label: 'Toggle', style: 'primary' }], [{ label: '← All devices' }, { label: 'Refresh' }]]"
	caption="A light that's on, for someone who may switch lights: On is greyed out, Off and Toggle are there."
/>

Pressing one sends it once, then says what really happened above the device's fresh state: done, already there, still working, nothing changed, or that it couldn't confirm. Pixel never sends it again by itself.

<PxPanel
	command="/ha"
	:embeds="[{ title: 'Done', lines: ['**example-light** is now off (it was on).'] }, { title: 'example-light', lines: ['The light over the workbench'], fields: [{ name: 'State', value: 'off', inline: true }, { name: 'Kind', value: 'Light', inline: true }, { name: 'Last changed', value: '0m ago', inline: true }] }]"
	:rows="[[{ label: 'On', style: 'primary' }, { label: 'Off', style: 'primary', disabled: true }, { label: 'Toggle', style: 'primary' }], [{ label: '← All devices' }, { label: 'Refresh' }]]"
	caption="After pressing Off: what happened, then the light's state now."
/>

A door has **Lock** and **Unlock**, for members with `ha-doors` or `ha-admin`. Pixel never unlatches a door. While admins have switched door control off, a door shows no buttons and says why.

<PxPanel
	command="/ha"
	:embeds="[{ title: 'example-door', lines: ['The front door'], fields: [{ name: 'State', value: 'locked', inline: true }, { name: 'Kind', value: 'Door', inline: true }, { name: 'Last changed', value: '3h 0m ago', inline: true }] }]"
	:rows="[[{ label: 'Lock', style: 'primary', disabled: true }, { label: 'Unlock', style: 'primary' }], [{ label: '← All devices' }, { label: 'Refresh' }]]"
	caption="A locked door, for a member with ha-doors: Unlock is the only thing to do."
/>

### Scheduled posts

Messages and polls that Pixel posts in a channel, once or on a repeat. These need the `schedule-posts` capability, and you can only schedule in channels you can post in yourself. Times are in Europe/Amsterdam.

<PxCommand :level="4" sig="/schedule" tier="member" reply="private" :caps="['schedule-posts']">

Opens your scheduled posts. Everything else is buttons, menus and forms in Pixel's reply, so there's nothing to remember. The buttons stop working after 15 minutes or when Pixel restarts: run `/schedule` again.

</PxCommand>

Every scheduled post is in the menu, soonest first, with its channel, its next post and how often it repeats. Pick one to see it, or make a new one.

<PxPanel
	command="/schedule"
	:embeds="[{ title: 'Scheduled posts', lines: ['**3** scheduled · **2** yours · **1** paused', 'Choose one to see what it will post, change it or delete it.', 'Times are in Europe/Amsterdam.'] }]"
	:rows="[[{ select: 'Choose a schedule…' }], [{ label: 'New message', style: 'primary' }, { label: 'New poll' }]]"
	caption="The list: a menu of every scheduled post, and New message and New poll."
/>

**New message** and **New poll** open a form. When is a day, a time or both, such as `wed 1900`, `14 oct 19:00`, `tomorrow 9am`, `now` or `now+1h`. A poll's form asks for the question and its answers, one per line (2 to 10), instead of the message. Date tokens like <code v-pre>{{date}}</code> are filled in when it's posted.

<PxModal
	title="New message"
	:fields="[
		{ label: 'Channel', hint: 'Where to post it. You need to be able to post there yourself.', kind: 'picker', value: '#general' },
		{ label: 'When', hint: 'In Europe/Amsterdam. A day, a time or both.', kind: 'text', value: 'wed 1900 · tomorrow 9am · 14 oct 19:00 · now+1h' },
		{ label: 'Repeat', kind: 'radio', choices: ['Once', 'Weekly', 'Every 2 weeks', 'Monthly', 'Every 2 months'], picked: 'Weekly' },
		{ label: 'Message', kind: 'paragraph', value: 'What to post. Markdown works. {{date}} and {{date+2}} fill in when it\'s posted.' },
	]"
	caption="The form for a new message: the channel, when, how often, and the text."
/>

Nothing is saved yet. Pixel shows a **draft**: the time it understood, and exactly what it will post. Settings that only sometimes apply are on the draft, and only when they do: the days for a weekly repeat; how long a poll stays open, whether it allows several answers and its daily **Reminders**; and **Pings**, only where you could ping everyone yourself. If something's wrong, the draft says what and **Edit details** opens the form again with what you typed.

<PxPanel
	command="/schedule"
	:content="['Pizza night tonight! Doors open at 19:00.']"
	:embeds="[{ title: 'New message', lines: ['Nothing is saved until you press **Schedule**.', '', '**#general** · first post **Wed 14 Oct 2026, 19:00** (Europe/Amsterdam) · weekly on Wednesday'], fields: [{ name: 'Name', value: 'Pizza night tonight! Doors open at 19:00.', inline: true }, { name: 'What', value: 'A message, pings off', inline: true }] }]"
	:rows="[[{ select: 'Which days?' }], [{ label: 'Schedule', style: 'success' }, { label: 'Edit details' }, { label: 'Rename' }, { label: 'Cancel' }]]"
	caption="A draft: the post as it will look, when it goes out, the days for a weekly repeat, and Schedule to save it."
/>

**Schedule** saves it and shows it. A schedule shows what it will post next and its next few times. If you made it, you can **Edit** it (the same form and draft, with **Save changes**), **Pause** or **Resume** it, and **Delete** it (Pixel asks first). Someone else's is read-only.

<PxPanel
	command="/schedule"
	:content="['Pizza night tonight! Doors open at 19:00.']"
	:embeds="[{ title: 'Pizza night tonight! Doors open at 19:00.', lines: ['Next post: **Wed 14 Oct 2026, 19:00** (Europe/Amsterdam).', 'Made by you.', '', 'Above is what it will post next time, with dates filled in. Pings don\'t fire here.'], fields: [{ name: 'Channel', value: '#general', inline: true }, { name: 'Repeats', value: 'Weekly on Wednesday', inline: true }, { name: 'What', value: 'A message, pings off' }] }]"
	:rows="[[{ label: 'Edit', style: 'primary' }, { label: 'Pause' }, { label: 'Delete', style: 'danger' }], [{ label: '← All schedules' }]]"
	caption="One of your schedules: what it will post next, with Edit, Pause and Delete."
/>

### Parking

Getting a parking spot at the gate. These need the `parking` capability. Every reply is private, and every booking ends at 23:59.

<PxCommand :level="4" sig="/park [for:]" tier="member" reply="private" autocomplete :caps="['parking']" :options="{ '[for:]': 'How long, such as 30m, 2h, 2h30 or rest of day. Books straight away. Leave it out to choose on buttons.' }">

Opens your parking panel. Everything else is buttons. `/park for:` books straight away, for when you're at the gate and know how long.

</PxCommand>

When you're not parked, pick how long. The lengths come from the parking settings, and ones that won't fit right now are greyed out. **Another length…** takes any other. Pixel gives you a spot that's free for that whole time, opens the gate and says where to park: Pixelbar's own spot first, then the borrowed spot that fits most tightly. If nothing fits, the gate stays shut and Pixel offers the longest stay that would. Every panel shows who's in which spot.

<PxPanel
	command="/park"
	:embeds="[{ title: 'Parking', lines: ['How long do you need? Pixel finds a spot that\'s free for that whole time, opens the gate and says where to park.'] }, { title: 'Spots', lines: ['**ours** (Next to the gate): free · open until 23:59 (13h 59m left)', '**neighbour-1**: taken by Another member since 09:30, until about 11:30 · open until 14:00 (4h left)'] }]"
	:rows="[[{ label: 'Park for 30m' }, { label: 'Park for 1h' }, { label: 'Park for 2h' }, { label: 'Park for 4h' }, { label: 'Park until 23:59' }], [{ label: 'Another length…' }], [{ label: 'Refresh' }]]"
	caption="Not parked: a button for each length, and who's in which spot."
/>

Once you're parked, the panel says where. **Open the gate** opens it again, if it didn't open or you need it again. **Leave** frees your spot when you go. The **Stay … longer** buttons only offer what fits before the spot closes, or 23:59.

<PxPanel
	command="/park"
	:embeds="[{ title: 'Parking', lines: ['Park in **ours** (Next to the gate). It\'s yours until 12:00.', 'The gate is opening.', 'I\'ll DM you 15 minutes before it ends (that needs DMs from server members on).', 'Press **Leave** when you go.'] }, { title: 'Spots', lines: ['**ours** (Next to the gate): taken by Example member since 10:00, until about 12:00 · open until 23:59 (13h 59m left)', '**neighbour-1**: free · open until 14:00 (4h left)'] }]"
	:rows="[[{ label: 'Open the gate', style: 'primary' }, { label: 'Leave' }, { label: 'Someone\'s in my spot' }], [{ label: 'Stay 30m longer' }, { label: 'Stay 1h longer' }, { label: 'Stay 2h longer' }, { label: 'Stay 4h longer' }, { label: 'Stay until 23:59' }], [{ label: 'Refresh' }]]"
	caption="Parked: where to park, the gate, staying longer, a taken spot and leaving."
/>

If someone else is in your spot, **Someone's in my spot** shows what Pixel will do before it does it. If another spot is free for the rest of your time, it moves you there. If none is, it ends your booking and reports it to the board. Either way your spot is closed until the end of the day, so nobody else is sent there.

<PxPanel
	command="/park"
	:embeds="[{ title: 'Parking', lines: ['Sorry about that. **neighbour-1** is free for the rest of your time, until 12:00.', 'Move there, and I\'ll close **ours** until 23:59 and tell the admins.'] }]"
	:rows="[[{ label: 'Move to neighbour-1', style: 'primary' }, { label: 'Cancel' }]]"
	caption="Someone's in my spot: Pixel offers a free spot before moving you."
/>

Pixel DMs you 15 minutes before your time is up, saying how much longer you could stay, and ends your booking 5 minutes after it if you haven't left or stayed longer, so keep DMs from server members on.

### Doors

The building's doors, through OpenR. This needs the `openr` capability. The parking gate isn't here: `/park` opens it.

<PxCommand :level="4" sig="/openr open door:" tier="member" reply="private" autocomplete :caps="['openr']" :options="{ 'door:': 'Which door.' }">

Opens one of the building's doors. Pixel asks once: if it doesn't open, try again in a moment. Refused while admins have switched door control off.

</PxCommand>

### Space state

Sets whether Pixelbar shows as open or closed. This needs the `spacestate` capability.

<PxCommand :level="4" sig="/spacestate set state:" tier="member" reply="private" :caps="['spacestate']" :options="{ 'state:': 'open or close.' }">

Tells the space's state API that Pixelbar is open or closed. `/status` and the open and closed announcements follow once the change shows up on SpaceAPI. If the API doesn't accept it, Pixel says nothing changed.

</PxCommand>

## Admin

For Pixel's operators. Every reply is private, and every change is recorded. How to use them is in the [runbook](/maintainers/runbook).

<PxCommand sig="/admin status" tier="admin" reply="private">

Pixel's health and an overview of the access lists.

</PxCommand>

<PxCommand sig="/admin reload" tier="admin" reply="private">

Re-reads the admin and member lists after they were edited by hand.

</PxCommand>

<PxCommand sig="/admin level set user: level: [reason:]" tier="admin" reply="private" :options="{ 'user:': 'The person.', 'level:': 'member, friend or guest. Guest keeps their entry but gives no access.', '[reason:]': 'Why, for the audit log.' }">

Makes someone a member or friend, or sets them back to guest. If their entry has no note, their username is saved as one, so the file shows who is who.

</PxCommand>

<PxCommand sig="/admin level get user:" tier="admin" reply="private" :options="{ 'user:': 'The person.' }">

Someone's level, where it comes from, and their capabilities.

</PxCommand>

<PxCommand sig="/admin sync [user:]" tier="admin" reply="private" :options="{ '[user:]': 'Just this person. Leave it out to sync everyone in Pixel\'s lists.' }">

Sets Discord roles to match Pixel's lists, for one person or everyone listed.

</PxCommand>

<PxCommand sig="/admin capabilities grant user: capability: [reason:]" tier="admin" reply="private" :options="{ 'user:': 'The person.', 'capability:': 'Which capability.', '[reason:]': 'Why, for the audit log.' }">

Gives someone a capability.

</PxCommand>

<PxCommand sig="/admin capabilities grant-all user: [reason:]" tier="admin" reply="private" :options="{ 'user:': 'The person.', '[reason:]': 'Why, for the audit log.' }">

Gives someone every capability that exists.

</PxCommand>

<PxCommand sig="/admin capabilities revoke user: capability: [reason:]" tier="admin" reply="private" :options="{ 'user:': 'The person.', 'capability:': 'Which capability.', '[reason:]': 'Why, for the audit log.' }">

Takes a capability away.

</PxCommand>

<PxCommand sig="/admin capabilities grant-level level: capability: [reason:]" tier="admin" reply="private" :options="{ 'level:': 'member or friend. A friend grant reaches members too.', 'capability:': 'Which capability.', '[reason:]': 'Why, for the audit log.' }">

Gives everyone at a membership level a capability.

</PxCommand>

<PxCommand sig="/admin capabilities revoke-level level: capability: [reason:]" tier="admin" reply="private" :options="{ 'level:': 'member or friend.', 'capability:': 'Which capability.', '[reason:]': 'Why, for the audit log.' }">

Takes a capability away from a membership level. People granted it on their own keep it.

</PxCommand>

<PxCommand sig="/admin capabilities list [user:]" tier="admin" reply="private" :options="{ '[user:]': 'Show just this person.' }">

Which capabilities exist, or what one person has.

</PxCommand>

<PxCommand sig="/admin announcements set style: channel:" tier="admin" reply="private" :options="{ 'style:': 'live (one post, edited to closed), timeline (a new post each time) or single (only the latest status, the old post deleted).', 'channel:': 'Where to announce.' }">

Posts open/closed announcements in a channel, in a style. Any number of channels, one style each.

</PxCommand>

<PxCommand sig="/admin announcements remove channel:" tier="admin" reply="private" :options="{ 'channel:': 'The channel to stop announcing in.' }">

Stops announcing in a channel. Posts already there stay.

</PxCommand>

<PxCommand sig="/admin announcements list" tier="admin" reply="private">

Which channels get announcements, and in which style.

</PxCommand>

<PxCommand sig="/admin closing-time set" tier="admin" reply="private" form>

Sets the closing-time reminder. A form opens for the text.

</PxCommand>

<PxCommand sig="/admin doors off" tier="admin" reply="private">

Switches door control from Pixel off for everyone, at once: Home Assistant's doors, OpenR's doors and the parking gate.

</PxCommand>

<PxCommand sig="/admin doors on" tier="admin" reply="private">

Switches door control from Pixel back on.

</PxCommand>

<PxCommand sig="/admin openr status" tier="admin" reply="private">

Whether Pixel is logged in to OpenR, when its session ends, and each door's live status: online or offline, and any errors OpenR reports.

</PxCommand>

<PxCommand sig="/admin openr login" tier="admin" reply="private">

Logs Pixel in to OpenR with its own account. OpenR then emails a code to that account.

</PxCommand>

<PxCommand sig="/admin openr code code:" tier="admin" reply="private" :options="{ 'code:': 'The code from OpenR\'s email.' }">

Finishes the login with the emailed code. Pixel then keeps the session going by itself.

</PxCommand>

<PxCommand sig="/admin openr logout" tier="admin" reply="private">

Logs Pixel out of OpenR, so it can't open any door until someone logs in again.

</PxCommand>

<PxCommand sig="/admin parking" tier="admin" reply="private">

Opens a panel of the parking spots, when they're open, who's in them and the settings, with buttons and menus to manage them.

</PxCommand>
