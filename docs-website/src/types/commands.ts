export type AccessTier = 'guest' | 'friend' | 'member' | 'admin';

export type ReplyVisibility = 'public' | 'private';

export interface CommandDefinition {
  name: string;
  description: string;
  tier: AccessTier;
  replyVisibility: ReplyVisibility;
  subcommands?: SubcommandDefinition[];
  capability?: string;
  options?: CommandOption[];
}

export interface SubcommandDefinition {
  name: string;
  description: string;
  tier?: AccessTier;
  replyVisibility?: ReplyVisibility;
  capability?: string;
  options?: CommandOption[];
}

export interface CommandOption {
  name: string;
  description: string;
  required: boolean;
  type: 'string' | 'boolean' | 'channel' | 'number';
  autocomplete?: boolean;
  form?: boolean;
}
