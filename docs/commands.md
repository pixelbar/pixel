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

Lights, switches and doors in the space. You only ever see the devices you're allowed to see, and Pixel checks again whatever autocomplete offered.

<PxCommandTray query="/ha" :selected="2" caption="Typing /ha shows the four Home Assistant commands." />

<PxCommand :level="4" sig="/ha list" tier="friend" reply="private">

The devices you may use, and their state.

</PxCommand>

<PxCommand :level="4" sig="/ha status device:" tier="friend" reply="private" autocomplete :options="{ 'device:': 'Which device.' }">

One device's live state, when it last changed and a few details for its kind.

</PxCommand>

<PxCommand :level="4" sig="/ha set device: state:" tier="friend" reply="private" autocomplete :caps="['ha-lights', 'ha-switches', 'ha-doors', 'ha-admin']" :options="{ 'device:': 'Which device. Only the ones you may change are offered.', 'state:': 'What to set it to, such as on or off. Only the actions that device allows are offered.' }">

Changes a device, such as switching a light on or off. Needs the capability for that kind of device, or `ha-admin`.

</PxCommand>

<PxCommand :level="4" sig="/ha open door:" tier="member" reply="private" autocomplete :caps="['ha-doors', 'ha-admin']" :options="{ 'door:': 'Which door.' }">

Unlocks a door. Members only, with `ha-doors` or `ha-admin`. It only ever unlocks.

</PxCommand>

### Scheduled posts

Messages and polls that Pixel posts in a channel, once or on a repeat. These need the `schedule-posts` capability, and you can only schedule in channels you can post in yourself. Times are in Europe/Amsterdam.

<PxCommand :level="4" sig="/schedule" tier="member" reply="private" :caps="['schedule-posts']">

Opens your scheduled posts. Everything else is buttons, menus and forms in Pixel's reply, so there's nothing to remember:

- **The list** shows every scheduled post, soonest first, with its channel, next post and repeat. Pick one from the menu to see it. **New message** and **New poll** make one.
- **Making one:** a form asks for the channel, when (such as `wed 1900`, `14 oct 19:00`, `tomorrow 9am`, `now` or `now+1h`), how often it repeats, and the text (or a poll's question and answers, one per line). Pixel then shows a **draft**: the time it understood, and exactly what it will post, with date tokens like <code v-pre>{{date}}</code> filled in. Choose the days for a weekly repeat, how long a poll stays open, whether it allows several answers, a poll's **Reminders** (a channel and a time of day: while the poll is open, Pixel reminds people there every day, with a link to it), and whether pings are on (only where you could ping everyone yourself). Nothing is saved until you press **Schedule**. If something's wrong, the draft says what and **Edit details** reopens the form with what you typed.
- **One schedule** shows what it will post next and its next few times. If you made it, you can **Edit** it (the same form and draft, with **Save changes**), **Pause** or **Resume** it, and **Delete** it (Pixel asks first). Someone else's is read-only.

The buttons stop working after 15 minutes or when Pixel restarts: run `/schedule` again.

</PxCommand>

### Parking

Getting a parking spot at the gate. These need the `parking` capability. Every reply is private, and every booking ends at 23:59.

<PxCommand :level="4" sig="/park [for:]" tier="member" reply="private" autocomplete :caps="['parking']" :options="{ '[for:]': 'How long, such as 30m, 2h, 2h30 or rest of day. Books straight away. Leave it out to choose on buttons.' }">

Opens your parking panel, with who's in which spot and until when. Everything else is buttons:

- **Not parked:** pick how long (**Park for 1h**, **Park until 23:59**, … from the durations an admin set; ones that won't fit right now are greyed out), or **Another length…** for any other. Pixel gives you a spot that's free for that whole time, opens the gate, and says where to park: Pixelbar's own spot first, then the borrowed spot that fits most tightly. If nothing fits, the gate stays shut and Pixel offers the longest stay that would.
- **Parked:** **Open the gate** (if it didn't open, or you need it again), **Leave** when you go, ways to stay longer (**Stay 1h longer**, **Stay until 17:00**, never past the spot's close or 23:59), and **Someone's in my spot**. That shows what Pixel will do before it does it: move you to another free spot for the rest of your time, or, if none is free, end your booking and report it to the board. Either way the taken spot is closed until the end of the day, so nobody else is sent there.

`/park for:` books straight away, for when you're at the gate and know how long. Pixel DMs you 15 minutes before your time is up, saying how much longer you could stay, and ends your booking 5 minutes after it if you haven't left or extended, so keep DMs from server members on.

</PxCommand>

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

Opens the parking panel: every spot, whether it's open now and later today, who's in it, and the settings. Everything else is menus and buttons:

- **Manage a spot…** shows one spot with what you can do to it: **Open…** a borrowed spot for a while (a form asks from and until when; empty means now and 23:59) or **Close for today**; **Close…** our own spot until a time, or **Open again**; **Edit…** where it is and whether it's permanent; **Remove…**; **Free the spot…** when someone's in it; and **Give it to someone…**, for when someone parked in the wrong spot (pick who's there, and for how long; any booking they had elsewhere ends, a "reported taken" closure is lifted, and they get a DM).
- **Open spots…** and **Close spots…** do several spots at once. Pixel only asks for times when they apply.
- **Add a spot** asks for its name (lowercase words joined by `-`), where it is, and whether it's **permanent** (Pixelbar's own, open every day) or **borrowed** (closed until it's opened).
- **Settings** changes the reminder, how long after someone's end Pixel ends their booking, the daily reset and the durations `/park` offers.

Anything that would end someone's booking says whose, and asks first. Pixel DMs them when it does.

</PxCommand>
