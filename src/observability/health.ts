import { createServer, type Server } from "node:http";

/**
 * Liveness and readiness probes for the container platform.
 *   /healthz — the process is up
 *   /readyz  — the bot is connected and serving
 */
export function startHealthServer(port: number, isReady: () => boolean): Server {
	const server = createServer((req, res) => {
		const status =
			req.url === "/healthz" ? 200 : req.url === "/readyz" ? (isReady() ? 200 : 503) : 404;
		res.writeHead(status, { "content-type": "text/plain" }).end(String(status));
	});
	server.listen(port);
	return server;
}
