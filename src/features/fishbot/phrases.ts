/**
 * Original replies from the QuakeNet Fishbot reimplementation:
 * https://github.com/sjdiego/fishbot/blob/main/triggers.go
 * IRC actions become Markdown italics. Channel lookup and the obsolete Outwar
 * URL trigger are omitted; IRC input actions have dedicated slash subcommands.
 */
export const PHRASES = [
	[
		"some people are being fangoriously devoured by a gelatinous monster",
		"Hillary's legs are being digested.",
		"^some people are being fangoriously devoured by a gelatinous monster$",
	],
	["hello fishbot", "Hi $nick", "^hello fishbot$"],
	[
		"badger badger badger badger badger badger badger badger badger badger badger badger",
		"mushroom mushroom!",
		"^badger badger badger badger badger badger badger badger badger badger badger badger$",
	],
	["snake", "Ah snake a snake! Snake, a snake! Ooooh, it's a snake!", "^snake$"],
	[
		"carrots handbags cheese.",
		"toilets russians planets hamsters weddings poets stalin KUALA LUMPUR! pygmies budgies KUALA LUMPUR!",
		"^carrots handbags cheese\\.$",
	],
	["sledgehammer", "sledgehammers go quack!", "^sledgehammer$"],
	["vinegar and aftershock.", "Ah, a true connoisseur!", "^vinegar.*?aftershock.$"],
	[
		"moo?",
		"To moo, or not to moo, that is the question. Whether 'tis nobler in the mind to suffer the slings and arrows of outrageous fish...",
		"^moo\\?$",
	],
	[
		"herring",
		"herring(n): Useful device for chopping down tall trees. Also moos (see fish).",
		"^herring$",
	],
	["hampster", "$nick: There is no 'p' in hamster you retard.", "^hampster$"],
	["ag", "Ag, ag ag ag ag ag AG AG AG!", "^ag$"],
	["fishbot owns", "Aye, I do.", "^fishbot owns$"],
	["vinegar", "Nope, too sober for vinegar. Try later.", "^vinegar$"],
	["martian", "Don't run! We are your friends!", "^martian$"],
	["just then, he fell into the sea", "Ooops!", "^just then\\, he fell into the sea$"],
	["aftershock", "mmmm, Aftershock.", "^aftershock$"],
	["why are you here?", "Same reason. I love candy.", "^why are you here\\?$"],
	["spoon", "There is no spoon.", "^spoon$"],
	["bounce", "moo", "^bounce$"],
	["crack", "Doh, there goes another bench!", "^crack$"],
	[
		"you can't just pick people at random!",
		"I can do anything I like, $nick, I'm eccentric! Rrarrrrrgh! Go!",
		"^you can\\'t just pick people at random\\!$",
	],
	["wertle", "moo", "^wertle$"],
	["flibble", "plob", "^flibble$"],
	[
		"fishbot created splidge",
		"omg no! Think I could show my face around here if I was responsible for THAT?",
		"^fishbot created splidge$",
	],
	["now there's more than one of them?", "A lot more.", "^now there\\'s more than one of them\\?$"],
	["I want everything", "Would that include a bullet from this gun?", "^I want everything$"],
	["we are getting aggravated.", "Yes, we are.", "^we are getting aggravated\\.$"],
	["how old are you, fishbot?", "*is older than time itself.*", "^how old are you, fishbot\\?$"],
	[
		"atlantis",
		"Beware the underwater headquarters of the trout and their bass henchmen. From there they plan their attacks on other continents.",
		"^atlantis$",
	],
	["oh god", "fishbot will suffice.", "^oh god$"],
	["fishbot", "Yes?", "^fishbot$"],
	[
		"what is the matrix?",
		"No-one can be told what the matrix is. You have to see it for yourself.",
		"^what is the matrix\\?$",
	],
	["what do you need?", "Guns. Lots of guns.", "^what do you need\\?$"],
	["I know Kungfu", "Show me.", "^I know Kungfu$"],
	["cake", "fish", "^cake$"],
	["trout go moo", "Aye, that's cos they're fish.", "^trout go moo$"],
	["Kangaroo", "The kangaroo is a four winged stinging insect.", "^Kangaroo$"],
	["bass", "Beware of the mutant sea bass and their laser cannons!", "^bass$"],
	["trout", "Trout are freshwater fish and have underwater weapons.", "^trout$"],
	[
		"where do you want to go today?",
		"anywhere but redmond :(.",
		"^where do you want to go today\\?$",
	],
	["fish go moo", "*notes that $nick is truly enlightened.*", "^fish go moo$"],
	["cows go moo", "$nick: only when they are impersonating fish.", "^cows go moo$"],
	["fish go blubb", "$nick LIES! Fish don't go blubb! fish go m00!", "^fish go blubb$"],
	["you know who else moos", "$nick: YA MUM!", "^you know who else moos$"],
	[
		"If there's one thing I know for sure, it's that fish don't m00.",
		"$nick: HERETIC! UNBELIEVER!",
		"^If there's one thing I know for sure, it\\'s that fish don\\'t m00\\.$",
	],
	[
		"fishbot: Muahahaha. Ph33r the dark side. :)",
		"$nick: You smell :P.",
		"^fishbot: Muahahaha\\. Ph33r the dark side\\. :\\)$",
	],
	["ammuu?", "$nick: fish go m00 oh yes they do!", "^ammuu\\?$"],
	["fish", "$nick: fish go m00!", "^fish$"],
] as const;

const matchers = PHRASES.map(([phrase, response, pattern]) => ({
	phrase,
	response,
	pattern: new RegExp(pattern, "i"),
}));

export function normalizePhrase(phrase: string): string {
	return phrase.trim().toLowerCase().replace(/\s+/g, " ");
}

export function replyForPhrase(phrase: string): string | undefined {
	return matchers.find((entry) => entry.pattern.test(phrase))?.response;
}
