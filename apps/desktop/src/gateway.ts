import { createServer, request as upstreamRequest, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";

export interface DesktopGateway {
  url: string;
  close: () => Promise<void>;
}

/** The desktop equivalent of the server edition's edge gateway. */
export async function startDesktopGateway(apiUrl: string, webUrl: string, port: number): Promise<DesktopGateway> {
  const sockets = new Set<Socket>();
  let authority = "";
  const headersFor = (headers: IncomingHttpHeaders): IncomingHttpHeaders => ({
    ...Object.fromEntries(Object.entries(headers).filter(([key]) => !key.startsWith("x-forwarded-") && key !== "forwarded")),
    host: authority,
    "x-forwarded-host": authority,
    "x-forwarded-proto": "http",
    "x-forwarded-for": "127.0.0.1",
  });
  const server = createServer((request, response) => {
    if (request.headers.host !== authority || !request.url?.startsWith("/") || request.url.startsWith("//")) {
      response.writeHead(400).end();
      return;
    }
    const target = new URL(request.url, webUrl);
    if (target.origin !== new URL(webUrl).origin) {
      response.writeHead(400).end();
      return;
    }
    const upstream = upstreamRequest(target, { method: request.method, headers: headersFor(request.headers) }, (received) => {
      response.writeHead(received.statusCode ?? 502, received.headers);
      received.pipe(response);
      received.on("error", () => response.destroy());
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const path = request.url?.split("?")[0];
    if (request.headers.host !== authority || (path !== "/agent/ws" && path !== "/terminal/ws")) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = upstreamRequest(new URL(request.url ?? "/", apiUrl), { headers: headersFor(request.headers) });
    upstream.on("upgrade", (response, remote, extra) => {
      let handshake = `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`;
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        handshake += `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`;
      }
      socket.write(`${handshake}\r\n`);
      if (extra.length) socket.write(extra);
      if (head.length) remote.write(head);
      socket.on("error", () => remote.destroy());
      remote.on("error", () => socket.destroy());
      socket.on("close", () => remote.destroy());
      remote.on("close", () => socket.destroy());
      socket.pipe(remote).pipe(socket);
    });
    upstream.on("response", response => {
      socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`);
      response.resume();
    });
    upstream.on("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.end();
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); accept(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing desktop gateway address");
  authority = `127.0.0.1:${address.port}`;
  return {
    url: `http://${authority}`,
    close: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
    },
  };
}
