/** Formats a duration compactly, e.g. "2h 15m" or "3d 4h 0m". Under a minute is "0m". */
export function formatDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}
