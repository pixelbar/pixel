import type { CommandDefinition } from '../types/commands';

export const COMMANDS: CommandDefinition[] = [
  // Guest commands
  {
    name: 'help',
    description: 'List the commands you can use',
    tier: 'guest',
    replyVisibility: 'private',
  },
  {
    name: 'ping',
    description: 'Check that Pixel is alive',
    tier: 'guest',
    replyVisibility: 'public',
  },
  {
    name: 'status',
    description: 'Is Pixelbar open right now?',
    tier: 'guest',
    replyVisibility: 'public',
  },
  {
    name: 'events',
    description: "See what's coming up at Pixelbar",
    tier: 'guest',
    replyVisibility: 'public',
  },
  {
    name: 'info',
    description: 'Find out about Pixelbar: where, how to join, house rules and more',
    tier: 'guest',
    replyVisibility: 'public',
    options: [
      {
        name: 'topic',
        description: 'What do you want to know about? Leave empty to see the list',
        required: false,
        type: 'string',
        autocomplete: true,
      },
    ],
  },
  {
    name: 'whoami',
    description: 'See what Pixel knows about you',
    tier: 'guest',
    replyVisibility: 'private',
  },
  {
    name: 'feedback',
    description: 'Send feedback about Pixel to its maintainers',
    tier: 'guest',
    replyVisibility: 'private',
    options: [
      {
        name: 'message',
        description: "What you'd like to tell us (3–1000 characters)",
        required: true,
        type: 'string',
      },
    ],
  },

  // Friend commands
  {
    name: 'ha',
    description: 'See the Home Assistant devices you may use',
    tier: 'friend',
    replyVisibility: 'private',
    subcommands: [
      {
        name: 'list',
        description: 'The devices you may use, and their state',
        tier: 'friend',
        replyVisibility: 'private',
      },
      {
        name: 'status',
        description: 'The live state of one device',
        tier: 'friend',
        replyVisibility: 'private',
        options: [
          {
            name: 'device',
            description: 'Which device',
            required: true,
            type: 'string',
            autocomplete: true,
          },
        ],
      },
      {
        name: 'set',
        description: 'Change a device, such as switching a light on or off',
        tier: 'friend',
        replyVisibility: 'private',
        options: [
          {
            name: 'device',
            description: 'Which device',
            required: true,
            type: 'string',
            autocomplete: true,
          },
          {
            name: 'state',
            description: 'What to set it to, such as on or off',
            required: true,
            type: 'string',
            autocomplete: true,
          },
        ],
      },
      {
        name: 'open',
        description: 'Unlock a door',
        tier: 'member',
        replyVisibility: 'private',
        options: [
          {
            name: 'door',
            description: 'Which door',
            required: true,
            type: 'string',
            autocomplete: true,
          },
        ],
      },
    ],
  },

  // Member commands
  {
    name: 'schedule',
    description: 'Schedule messages and polls',
    tier: 'member',
    replyVisibility: 'private',
    capability: 'schedule-posts',
    subcommands: [
      {
        name: 'message',
        description: 'Schedule a message',
        capability: 'schedule-posts',
        options: [
          {
            name: 'channel',
            description: 'Where to post it',
            required: true,
            type: 'channel',
          },
          {
            name: 'when',
            description: 'When to post (Europe/Amsterdam), e.g. wed 1900, 14 oct 19:00, tomorrow 9am',
            required: true,
            type: 'string',
          },
          {
            name: 'text',
            description: 'Message',
            required: true,
            type: 'string',
            form: true,
          },
          {
            name: 'repeat',
            description: 'How often (default: once)',
            required: false,
            type: 'string',
            autocomplete: true,
          },
          {
            name: 'days',
            description: 'For weekly and fortnightly: which days, e.g. wed sat',
            required: false,
            type: 'string',
            autocomplete: true,
          },
          {
            name: 'mentions',
            description: 'Let @everyone, @here and role mentions ping (default: off)',
            required: false,
            type: 'boolean',
          },
          {
            name: 'name',
            description: 'A name to find it by later (default: the start of the text)',
            required: false,
            type: 'string',
          },
        ],
      },
      {
        name: 'poll',
        description: 'Schedule a poll',
        capability: 'schedule-posts',
        options: [
          {
            name: 'channel',
            description: 'Where to post it',
            required: true,
            type: 'channel',
          },
          {
            name: 'when',
            description: 'When to post (Europe/Amsterdam), e.g. wed 1900, 14 oct 19:00, tomorrow 9am',
            required: true,
            type: 'string',
          },
          {
            name: 'question',
            description: 'Question',
            required: true,
            type: 'string',
            form: true,
          },
          {
            name: 'answers',
            description: 'Answers, one per line (2 to 10)',
            required: true,
            type: 'string',
            form: true,
          },
          {
            name: 'repeat',
            description: 'How often (default: once)',
            required: false,
            type: 'string',
            autocomplete: true,
          },
          {
            name: 'days',
            description: 'For weekly and fortnightly: which days, e.g. wed sat',
            required: false,
            type: 'string',
            autocomplete: true,
          },
          {
            name: 'duration',
            description: 'How long people can vote (default: 1 day)',
            required: false,
            type: 'string',
            autocomplete: true,
          },
          {
            name: 'multiple',
            description: 'Let people pick more than one answer',
            required: false,
            type: 'boolean',
          },
          {
            name: 'name',
            description: 'A name to find it by later (default: the start of the text)',
            required: false,
            type: 'string',
          },
        ],
      },
      {
        name: 'list',
        description: 'See every scheduled post',
        capability: 'schedule-posts',
      },
      {
        name: 'edit',
        description: 'Edit one of your scheduled posts before it goes out',
        capability: 'schedule-posts',
        options: [
          {
            name: 'schedule',
            description: 'Which of your schedules',
            required: false,
            type: 'string',
            autocomplete: true,
          },
        ],
      },
      {
        name: 'preview',
        description: 'See exactly what a scheduled post will look like',
        capability: 'schedule-posts',
        options: [
          {
            name: 'schedule',
            description: 'Which schedule',
            required: true,
            type: 'string',
            autocomplete: true,
          },
        ],
      },
      {
        name: 'pause',
        description: 'Stop a schedule from posting until it\'s resumed',
        capability: 'schedule-posts',
        options: [
          {
            name: 'schedule',
            description: 'Which schedule',
            required: true,
            type: 'string',
            autocomplete: true,
          },
        ],
      },
      {
        name: 'resume',
        description: 'Start a paused schedule again',
        capability: 'schedule-posts',
        options: [
          {
            name: 'schedule',
            description: 'Which schedule',
            required: true,
            type: 'string',
            autocomplete: true,
          },
        ],
      },
      {
        name: 'delete',
        description: 'Delete a schedule',
        capability: 'schedule-posts',
        options: [
          {
            name: 'schedule',
            description: 'Which schedule',
            required: true,
            type: 'string',
            autocomplete: true,
          },
        ],
      },
    ],
  },

  // Admin commands
  {
    name: 'admin',
    description: 'Manage Pixel and its configuration',
    tier: 'admin',
    replyVisibility: 'private',
    subcommands: [
      {
        name: 'capabilities',
        description: 'Grant or revoke capabilities',
      },
      {
        name: 'members',
        description: 'Manage the member access list',
      },
      {
        name: 'roles',
        description: 'Sync Discord roles with access tiers',
      },
      {
        name: 'doors',
        description: 'Emergency switch for door controls',
      },
      {
        name: 'info',
        description: 'Show Pixel version and runtime details',
      },
    ],
  },
];

export const TIER_INFO = {
  guest: {
    label: 'Guest',
    description: 'Anyone can use these commands',
    color: '#9CA3AF',
  },
  friend: {
    label: 'Friend',
    description: 'For Pixelbar friends (paid membership)',
    color: '#60A5FA',
  },
  member: {
    label: 'Member',
    description: 'For Pixelbar members (paid membership)',
    color: '#A78BFA',
  },
  admin: {
    label: 'Admin',
    description: 'For Pixelbar administrators',
    color: '#F87171',
  },
};
