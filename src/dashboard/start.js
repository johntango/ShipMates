export async function startDashboardWithFallback(server, { attempts = 10 } = {}) {
  if (!server || typeof server.start !== "function" || !Number.isSafeInteger(server.port)) {
    throw new TypeError("Dashboard fallback requires a dashboard server with a port");
  }
  const requestedPort = server.port;
  for (let offset = 0; offset < attempts; offset += 1) {
    server.port = requestedPort + offset;
    try {
      return {
        url: await server.start(),
        requestedPort,
        port: server.port,
        fallback: offset > 0,
      };
    } catch (error) {
      if (error?.code !== "EADDRINUSE" || offset === attempts - 1) throw error;
    }
  }
  throw new Error("No dashboard port was available");
}
