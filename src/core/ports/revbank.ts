/** Personal RevBank data. The private service owns links and authorisation. */
export type RevbankLink = {
	state: "unlinked" | "pending" | "linked";
	requestId?: string;
	nick?: string;
	expiresAt?: string;
};

export type RevbankBalance = {
	balanceCents: number;
	updatedAt: string;
};

export type RevbankTransaction = {
	id: string;
	at: string;
	amountCents: number;
	balanceCents: number;
	/** Public catalogue description or a generic label; never raw log text. */
	description: string;
};

export type RevbankHistory = {
	updatedAt: string;
	transactions: RevbankTransaction[];
};

export type Revbank = {
	status(actor: string): Promise<RevbankLink>;
	request(actor: string, nick: string): Promise<RevbankLink>;
	unlink(actor: string): Promise<void>;
	balance(actor: string): Promise<RevbankBalance>;
	history(actor: string): Promise<RevbankHistory>;
	review(actor: string, target: string): Promise<RevbankLink>;
	decide(actor: string, target: string, requestId: string, approve: boolean): Promise<void>;
	revoke(actor: string, target: string): Promise<void>;
};

export type RevbankErrorCode = "unavailable" | "not-linked" | "denied" | "conflict";

/** No upstream body, address, credentials, nickname or financial data in errors. */
export class RevbankError extends Error {
	constructor(readonly code: RevbankErrorCode) {
		super(`RevBank: ${code}`);
	}
}
