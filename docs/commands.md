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

<PxCommandTray query="/schedule" :selected="0" caption="Typing /schedule lists what you can do with scheduled posts." />

<PxCommand :level="4" sig="/schedule message channel: when: [repeat:] [days:] [mentions:] [name:]" tier="member" reply="private" form :caps="['schedule-posts']" :options="{ 'channel:': 'Where to post it.', 'when:': 'When to post, such as wed 1900, 14 oct 19:00, tomorrow 9am, now or now+1h.', '[repeat:]': 'once, weekly, fortnightly, monthly or every-2-months. Once if left out.', '[days:]': 'For weekly and fortnightly: which days, such as wed sat.', '[mentions:]': 'Let @everyone, @here and role mentions ping. Off if left out.', '[name:]': 'A name to find it by later. The start of the text if left out.' }">

Schedules a message. A form opens for the text. Date tokens like <code v-pre>{{date}}</code> are filled in when it's posted.

</PxCommand>

<PxCommand :level="4" sig="/schedule poll channel: when: [repeat:] [days:] [duration:] [multiple:] [name:]" tier="member" reply="private" form :caps="['schedule-posts']" :options="{ 'channel:': 'Where to post it.', 'when:': 'When to post it.', '[repeat:]': 'How often. Once if left out.', '[days:]': 'For weekly and fortnightly: which days.', '[duration:]': 'How long people can vote, from 1 hour to 2 weeks. 1 day if left out.', '[multiple:]': 'Let people pick more than one answer.', '[name:]': 'A name to find it by later.' }">

Schedules a native Discord poll. A form opens for the question and the answers, one per line (2 to 10).

</PxCommand>

<PxCommand :level="4" sig="/schedule list" tier="member" reply="private" :caps="['schedule-posts']">

Every scheduled post, with where and when it goes out next.

</PxCommand>

<PxCommand :level="4" sig="/schedule edit schedule: [when:] [repeat:] [days:] [duration:] [name:]" tier="member" reply="private" autocomplete form :caps="['schedule-posts']" :options="{ 'schedule:': 'Which of your schedules. Only your own upcoming ones are offered.', '[duration:]': 'For a poll: how long people can vote, from 1 hour to 2 weeks. Unchanged if left out; refused on a message.' }">

Changes one of your own scheduled posts before it goes out: its content, and optionally when, how often and, for a poll, how long it stays open. A new time or repeat counts from now, so nothing it would have posted before the edit goes out late. Turning a repeat into a one-off needs a new `when`.

</PxCommand>

<PxCommand :level="4" sig="/schedule preview schedule:" tier="member" reply="private" autocomplete :caps="['schedule-posts']" :options="{ 'schedule:': 'Which schedule.' }">

Shows exactly what a scheduled post will look like.

</PxCommand>

<PxCommand :level="4" sig="/schedule pause schedule:" tier="member" reply="private" autocomplete :caps="['schedule-posts']" :options="{ 'schedule:': 'Which schedule.' }">

Stops a schedule from posting until it's resumed.

</PxCommand>

<PxCommand :level="4" sig="/schedule resume schedule:" tier="member" reply="private" autocomplete :caps="['schedule-posts']" :options="{ 'schedule:': 'Which schedule.' }">

Starts a paused schedule again. Nothing missed while paused is posted. A one-off whose time passed while it was paused can't be resumed: delete it.

</PxCommand>

<PxCommand :level="4" sig="/schedule delete schedule:" tier="member" reply="private" autocomplete :caps="['schedule-posts']" :options="{ 'schedule:': 'Which schedule.' }">

Deletes a schedule.

</PxCommand>

### Parking

Getting a parking spot at the gate. These need the `parking` capability. Every reply is private, and every booking ends at 23:59.

<PxCommand :level="4" sig="/park for:" tier="member" reply="private" autocomplete :caps="['parking']" :options="{ 'for:': 'How long, such as 30m, 2h, 2h30 or rest of day.' }">

Gives you a spot that's free for that whole time, opens the gate, and says where to park. Pixel DMs you 15 minutes before your time is up (with `/parking extend` if the spot has more time), and ends your booking 5 minutes after it if you haven't left or extended, so keep DMs from server members on. Pixelbar's own spot comes first, then the borrowed spot that fits most tightly. If nothing is free for that long, the gate stays shut and Pixel says the longest stay that would fit. Running it again while you're parked opens the gate again and doesn't book another spot.

</PxCommand>

<PxCommand :level="4" sig="/parking list" tier="member" reply="private" :caps="['parking']">

Which spots are open, who's in each, since when and until about when, and how long each spot stays open.

</PxCommand>

<PxCommand :level="4" sig="/parking extend for:" tier="member" reply="private" autocomplete :caps="['parking']" :options="{ 'for:': 'How much longer, such as 30m, 1h or rest of day.' }">

Stays longer in your spot, as long as it's open that long and it's before 23:59. It adds to your end (or to now, if that's passed), and Pixel reminds you again before the new end. If the spot doesn't have that much time, Pixel says how much it has.

</PxCommand>

<PxCommand :level="4" sig="/parking taken [confirm:]" tier="member" reply="private" :caps="['parking']" :options="{ '[confirm:]': 'Move to the spot Pixel offers. Without it, Pixel only shows you the spot.' }">

Someone else is in your spot. If another spot is free for the rest of your time, Pixel shows it, and `confirm:True` moves you there. If nothing else is free, Pixel ends your booking, asks you to leave and reports it to the board. Either way, your spot is closed until the end of the day and the admins are told.

</PxCommand>

<PxCommand :level="4" sig="/parking leave" tier="member" reply="private" :caps="['parking']">

Frees your spot.

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

Whether Pixel is logged in to OpenR, when its session ends, and the doors it can open.

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

<PxCommand sig="/admin parking status" tier="admin" reply="private">

The parking spots, whether each is open now and later today, who's parked in them, and the parking settings.

</PxCommand>

<PxCommand sig="/admin parking open spots: [from:] [until:] [evict:]" tier="admin" reply="private" :options="{ 'spots:': 'One spot, or several separated by spaces.', '[from:]': 'Borrowed spots: when it opens. Default: now.', '[until:]': 'Borrowed spots: when it closes, such as 17:00 or now+2h. Default: the reset (23:59).', '[evict:]': 'End the booking of anyone parked where this cuts in. Without it, the change is refused.' }">

Opens borrowed spots for a while, replacing any opening they have that day. For a permanent spot, lifts its closure. Nothing runs past the reset.

</PxCommand>

<PxCommand sig="/admin parking close spots: [until:] [evict:]" tier="admin" reply="private" :options="{ 'spots:': 'One spot, or several separated by spaces.', '[until:]': 'Permanent spots: when it opens again, such as 17:00 or now+2h. Default: the reset (23:59).', '[evict:]': 'End the booking of anyone parked there. Without it, the change is refused.' }">

Closes spots: a borrowed spot until it's opened again, a permanent one for a while.

</PxCommand>

<PxCommand sig="/admin parking assign user: spot: [for:] [evict:]" tier="admin" reply="private" :options="{ 'user:': 'Who is parked there.', 'spot:': 'The spot they are in.', '[for:]': 'How long, such as 2h or rest of day. Default: until the spot closes.', '[evict:]': 'End the booking of whoever still holds the spot. Without it, Pixel refuses while someone holds it.' }">

Gives someone the spot they're parked in, for when someone parked in the wrong spot. Any booking they had elsewhere ends and a "reported taken" closure on the spot is lifted. Pixel doesn't move whoever was booked into it: they get a new spot themselves with `/parking taken`. If they still hold it, Pixel refuses unless `evict:True` ends their booking. Everyone affected gets a DM.

</PxCommand>

<PxCommand sig="/admin parking free spot:" tier="admin" reply="private" :options="{ 'spot:': 'The spot.' }">

Ends the booking in a spot, for someone who left without `/parking leave`. Pixel DMs them that an admin ended it.

</PxCommand>

<PxCommand sig="/admin parking add-spot name: [description:] [permanent:]" tier="admin" reply="private" :options="{ 'name:': 'Lowercase words joined by -, such as neighbour-1.', '[description:]': 'Where it is, shown to people.', '[permanent:]': 'Pixelbar\'s own spot, open every day with no opening needed. Default: no (borrowed).' }">

Adds a parking spot. A borrowed spot is closed until it's opened.

</PxCommand>

<PxCommand sig="/admin parking edit-spot spot: [description:] [permanent:] [evict:]" tier="admin" reply="private" :options="{ 'spot:': 'The spot.', '[description:]': 'A new description, or - to remove it.', '[permanent:]': 'Whether it\'s Pixelbar\'s own spot.', '[evict:]': 'End the booking of anyone parked there if this cuts in.' }">

Changes a spot. Changing whether it's permanent drops the openings or closures that no longer apply.

</PxCommand>

<PxCommand sig="/admin parking remove-spot spot: [evict:]" tier="admin" reply="private" :options="{ 'spot:': 'The spot.', '[evict:]': 'End the booking of anyone parked there. Without it, a booked spot isn\'t removed.' }">

Removes a spot and its opening times.

</PxCommand>

<PxCommand sig="/admin parking settings [remind:] [grace:] [reset:] [durations:]" tier="admin" reply="private" :options="{ '[remind:]': 'Minutes before someone\'s end to remind them (0–120).', '[grace:]': 'Minutes after it to end their booking (0–60).', '[reset:]': 'When every booking ends each day, such as 23:59.', '[durations:]': 'The durations offered, separated by commas, such as 30m, 1h, 2h30, rest of day.' }">

Shows the parking settings, or changes them.

</PxCommand>
