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

<PxCommand :level="4" sig="/schedule message channel: when: [repeat:] [days:] [mentions:] [name:]" tier="member" reply="private" form :caps="['schedule-posts']" :options="{ 'channel:': 'Where to post it.', 'when:': 'When to post, such as wed 1900, 14 oct 19:00 or tomorrow 9am.', '[repeat:]': 'once, weekly, fortnightly, monthly or every-2-months. Once if left out.', '[days:]': 'For weekly and fortnightly: which days, such as wed sat.', '[mentions:]': 'Let @everyone, @here and role mentions ping. Off if left out.', '[name:]': 'A name to find it by later. The start of the text if left out.' }">

Schedules a message. A form opens for the text. Date tokens like <code v-pre>{{date}}</code> are filled in when it's posted.

</PxCommand>

<PxCommand :level="4" sig="/schedule poll channel: when: [repeat:] [days:] [duration:] [multiple:] [name:]" tier="member" reply="private" form :caps="['schedule-posts']" :options="{ 'channel:': 'Where to post it.', 'when:': 'When to post it.', '[repeat:]': 'How often. Once if left out.', '[days:]': 'For weekly and fortnightly: which days.', '[duration:]': 'How long people can vote, from 1 hour to 2 weeks. 1 day if left out.', '[multiple:]': 'Let people pick more than one answer.', '[name:]': 'A name to find it by later.' }">

Schedules a native Discord poll. A form opens for the question and the answers, one per line (2 to 10).

</PxCommand>

<PxCommand :level="4" sig="/schedule list" tier="member" reply="private" :caps="['schedule-posts']">

Every scheduled post, with where and when it goes out next.

</PxCommand>

<PxCommand :level="4" sig="/schedule edit schedule: [when:] [repeat:] [days:] [name:]" tier="member" reply="private" autocomplete form :caps="['schedule-posts']" :options="{ 'schedule:': 'Which of your schedules. Only your own upcoming ones are offered.' }">

Changes one of your own scheduled posts before it goes out: its content, and optionally when and how often. A new time or repeat counts from now, so nothing it would have posted before the edit goes out late. Turning a repeat into a one-off needs a new `when`.

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

Makes someone a member or friend, or sets them back to guest.

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

Switches door control from Pixel off for everyone, at once.

</PxCommand>

<PxCommand sig="/admin doors on" tier="admin" reply="private">

Switches door control from Pixel back on.

</PxCommand>
