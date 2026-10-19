/**
 * Files on an env's Azure Files share (mounted at `/app/persist`), and the `az`
 * arguments to read and write them. Names come from `scripts/envs.ts`.
 */
import { ENVS, type Target } from "./envs.ts";

/** One file on one env's share. */
export type Remote = { account: string; share: string; path: string };

export function shareRemote(target: Target, path: string): Remote {
	const env = ENVS[target];
	return { account: env.storageAccount, share: env.share, path };
}

const AZ_COMMON = [
	"--auth-mode",
	"login",
	"--enable-file-backup-request-intent",
	"--only-show-errors",
];

export function azDownloadArgs(remote: Remote, dest: string): string[] {
	return [
		"storage",
		"file",
		"download",
		...AZ_COMMON,
		"--account-name",
		remote.account,
		"--share-name",
		remote.share,
		"--path",
		remote.path,
		"--dest",
		dest,
		"--no-progress",
		"--output",
		"none",
	];
}

export function azUploadArgs(remote: Remote, source: string): string[] {
	return [
		"storage",
		"file",
		"upload",
		...AZ_COMMON,
		"--account-name",
		remote.account,
		"--share-name",
		remote.share,
		"--path",
		remote.path,
		"--source",
		source,
		"--no-progress",
		"--output",
		"none",
	];
}
