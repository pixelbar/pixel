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

Messages, polls and attendance polls that Pixel posts in a channel, once or on a repeat. These need the `schedule-posts` capability, and you can only schedule in channels you can post in yourself. Times are in Europe/Amsterdam.

<PxCommand :level="4" sig="/schedule" tier="member" reply="private" :caps="['schedule-posts']">

Opens your scheduled posts. Everything else is buttons, menus and forms in Pixel's reply, so there's nothing to remember. The buttons stop working after 15 minutes or when Pixel restarts: run `/schedule` again.

</PxCommand>

Every scheduled post is in the menu, soonest first, with its channel, its next post and how often it repeats. Pick one to see it, or make a new one.

<PxPanel
	command="/schedule"
	:embeds="[{ title: 'Scheduled posts', lines: ['**3** scheduled · **2** yours · **1** paused', 'Choose one to see what it will post, change it or delete it.', 'Times are in Europe/Amsterdam.'] }]"
	:rows="[[{ select: 'Choose a schedule…' }], [{ label: 'New message', style: 'primary' }, { label: 'New poll' }, { label: 'New attendance poll' }]]"
	caption="The list: a menu of every scheduled post, and New message, New poll and New attendance poll."
/>

**New message**, **New poll** and **New attendance poll** open a form. When is a day, a time or both, such as `wed 1900`, `14 oct 19:00`, `tomorrow 9am`, `now` or `now+1h`. A poll's form asks for the question and its answers, one per line (2 to 10), instead of the message. Date tokens like <code v-pre>{{date}}</code> are filled in when it's posted.

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

#### Attendance polls

An **attendance poll** is for "who's coming?". A Discord poll always ends by announcing a winner ("the winner is No with 30%"). Pixel counts an attendance poll itself, so it ends with how many are coming instead. Its form asks for the question and 1 to 5 answers, one per line, such as `Coming` and `Not coming`, or just `I'm coming`. Each answer becomes a button.

On the draft, choose **which answers count as coming** (the first one does to begin with) and how long it's open. **Results** picks a channel for the totals: the totals so far at a time on the day it closes (say `17:00` for a poll open until midnight), and the final totals when it closes. You write what they say, with <code v-pre>{{count}}</code>, <code v-pre>{{names}}</code>, <code v-pre>{{question}}</code>, <code v-pre>{{link}}</code> and the date tokens, for example <code v-pre>Poll is closed - {{count}} people are coming to the Pixelbar!</code> In the poll's own channel they're posted as replies to the poll; in another channel, use <code v-pre>{{link}}</code> to point back to it. Leave Results off and the totals only show on the poll. Reminders work as for a poll.

<PxPanel
	command="/schedule"
	:content="['🗳️ **Who\'s coming on Friday?**', '', '**Coming**: 3 · Ada, Sam and Kim', '**Not coming**: 1 · Robin', '', 'Open until Fri 6 Nov 2026, 23:59. Press an answer to pick it, and again to take it back.']"
	:rows="[[{ label: 'Coming' }, { label: 'Not coming' }]]"
	caption="The poll in the channel: each answer's total and who picked it, with a button per answer."
/>

Anyone in the server can answer, once: pressing another answer switches, and pressing yours again takes it back. Pixel tells you privately what you picked. Your name shows on the poll and in its results, like a Discord poll's voters. The buttons keep working when Pixel restarts, and go when the poll closes.

### Parking

Getting a parking spot at the gate. These need the `parking` capability. Every reply is private, and every booking ends at 23:59.

<PxCommand :level="4" sig="/park [for:]" tier="member" reply="private" autocomplete :caps="['parking']" :options="{ '[for:]': 'How long, such as 30m, 2h, 2h30 or rest of day. Books straight away. Leave it out to choose on buttons.' }">

Opens your parking panel. Everything else is buttons. `/park for:` books straight away, for when you're at the gate and know how long.

</PxCommand>

When you're not parked, pick how long. The lengths come from the parking settings, and ones that won't fit right now are greyed out. **Another length…** takes any other. Pixel gives you a spot that's free for that whole time, opens the gate and says where to park: Pixelbar's own spot first, then the borrowed spot that fits most tightly. If nothing fits, the gate stays shut and Pixel offers the longest stay that would. Every panel shows who's in which spot.

<PxPanel
	command="/park"
	:embeds="[{ title: 'Parking', lines: ['How long do you need? Pixel finds a spot that\'s free for that whole time, opens the gate and says where to park.'] }, { title: 'Free', lines: ['**ours** (Next to the gate): free · open until 23:59 (13h 59m left)'] }, { title: 'Taken', lines: ['**neighbour-1**: taken by Another member since 09:30, until about 11:30 · open until 14:00 (4h left)'] }]"
	:rows="[[{ label: 'Park for 30m' }, { label: 'Park for 1h' }, { label: 'Park for 2h' }, { label: 'Park for 4h' }, { label: 'Park until 23:59' }], [{ label: 'Another length…' }], [{ label: 'Refresh' }]]"
	caption="Not parked: a button for each length, and which spots are free, taken or closed."
/>

Once you're parked, the panel says where. **Open the gate** opens it again, if it didn't open or you need it again. **Leave** frees your spot when you go. The **Stay … longer** buttons only offer what fits before the spot closes, or 23:59.

<PxPanel
	command="/park"
	:embeds="[{ title: 'Parking', lines: ['Park in **ours** (Next to the gate). It\'s yours until 12:00.', 'The gate is opening.', 'I\'ll DM you 15 minutes before it ends (that needs DMs from server members on).', 'Press **Leave** when you go.'] }, { title: 'Free', lines: ['**neighbour-1**: free · open until 14:00 (4h left)'] }, { title: 'Taken', lines: ['**ours** (Next to the gate): taken by Example member since 10:00, until about 12:00 · open until 23:59 (13h 59m left)'] }]"
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

<PxCommand sig="/admin" tier="admin" reply="private">

Opens the admin panel: Pixel's health, with sections for people and their access levels, capabilities, Discord roles, announcements, the closing-time reminder, doors, OpenR and parking.

</PxCommand>

`/admin` has no subcommands or options. Everything is buttons, menus and forms in its reply. The first panel shows Pixel's version, where it runs, its uptime, how many admins, members and friends there are, and the state of Discord roles, Home Assistant, OpenR and door control. From there:

- **Go to…** opens one of the sections below.
- **Reload the access lists** re-reads the member and admin lists and the Home Assistant devices after someone edited them by hand, and says what changed.
- **Refresh** shows the status again.

Changes that are hard to undo ask first. Changes to a person's level or capabilities, and to what a level gets, ask for an optional reason for the audit log. **← Admin** in every section goes back to the first panel.

### People {#admin-people}

One person's level, capabilities and Discord roles. **Look someone up…** asks who, then shows their level, where it comes from, what they hold and their roles.

- **Change level…**: make them a member, a friend or a guest. Guest keeps their entry but gives no access. Admins can't be changed from Discord.
- **Grant capabilities…** and **Revoke capabilities…**: menus of the capabilities they don't hold, and the ones they do. Revoking one they get from their level takes it away from them alone. Pixel DMs them about a grant or revoke.
- **Grant every capability…**: every capability in one change.
- **Sync their Discord roles**: sets their roles to match their level.
- **Capabilities in detail**: the capabilities they hold, in full.

### Capabilities {#admin-capabilities}

Every capability, what it is for, how many people hold it and which levels get it. **What friends get** and **What members get** show what a level grants, with menus to grant a capability to everyone at that level, or take it back. What friends get, members get too. A level change DMs nobody.

### Discord roles {#admin-roles}

Whether Pixel's levels are mirrored to Discord roles. **Sync everyone** sets the roles to match Pixel's lists for everyone in them. People who hold a role but aren't listed aren't touched.

### Announcements {#admin-announcements}

The channels where Pixel announces that the space opened or closed, and whether each is posting. **Add a channel…** picks a channel you can post in and a style:

- **Live**: one post per opening, edited when it closes.
- **Timeline**: a new post for every open and close.
- **Single**: only the latest; the old post is deleted.

**Stop announcing in…** removes a channel. Changes take effect at once.

### Closing time {#admin-closing-time}

The reminder Pixel posts when the space closes, and by `/closing-time`. **Change the message…** opens the text, prefilled with the saved one. Markdown and date tokens like <code v-pre>{{date}}</code> work. With no message set, Pixel posts its own. It's posted in public, so never put door codes or other secrets in it.

### Doors {#admin-doors}

Door control from Pixel, on or off. **Switch door control off…** (Pixel asks first) stops every door action from Pixel at once, for everyone: Home Assistant's doors, OpenR's doors and the parking gate. **Switch door control on** brings it back. It stays as set across restarts. It doesn't lock a physical door.

### OpenR {#admin-openr}

Only shown where OpenR is set up. Whether Pixel is logged in to OpenR, and each door's status.

- **Log in**: Pixel logs in, and OpenR emails a code.
- **Enter the code…**: finishes logging in with that code. It's never logged.
- **Log out…** (Pixel asks first): nobody can open a door through OpenR until an admin logs in again.

### Parking {#admin-parking}

Every spot, whether it's open, until when, and who's in it, 25 spots to a page.

- **Manage a spot…**: opens one spot, below.
- **Open spots…**: opens borrowed spots, from and until a time (now until the reset, unless you change it).
- **Close spots…**: ends a borrowed spot's opening for today, or closes Pixelbar's own spot until a time you pick.
- **Add a spot**: a name, a description shown to people who park, and its kind: **Permanent** (Pixelbar's own, open every day until the reset) or **Borrowed** (closed until an admin opens it).
- **Settings**: how many minutes before the end Pixel reminds people, how long after the end it ends a booking, the daily reset when every booking ends, and the lengths `/park` offers.

One spot's panel has:

- **Open…** and **Close for today** for a borrowed spot, or **Close…** and **Open again** for Pixelbar's own.
- **Edit…**: where it is (shown to people who park) and its kind.
- **Remove…** (Pixel asks first): the spot and its opening times go. This can't be undone.
- **Free the spot…**: ends the booking of someone who left without pressing **Leave**.
- **Give it to someone…**: books it for the person who is parked there, for how long you say (such as `2h` or `rest of day`), or until the spot closes if you leave it empty. They get a DM, and a booking they had elsewhere ends. Pixel won't take a spot from someone still booked into it unless you go ahead when it asks.

How to use these day to day is in the [runbook](/maintainers/runbook).
