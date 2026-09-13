import { get } from "node:https";

/** Resolve test publications through public DNS, including on split-DNS hosts. */
export async function publicHttp(hostname: string): Promise<{ status: number; location: string; body: string }> {
  const dns = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
    headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8_000),
  });
  const answer = await dns.json() as { Status: number; Answer?: { type: number; data: string }[] };
  const address = answer.Answer?.find(row => row.type === 1)?.data;
  if (answer.Status !== 0 || !address) throw new Error("Public DNS has not published the test hostname yet");
  return await new Promise((accept, reject) => {
    const request = get(`https://${hostname}/`, {
      family: 4, lookup: (_name, _options, callback) => callback(null, address, 4),
      signal: AbortSignal.timeout(8_000),
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 100_000) request.destroy(new Error("Unexpected test response size"));
      });
      response.once("error", reject);
      response.once("end", () => accept({ status: response.statusCode ?? 0, location: response.headers.location ?? "", body }));
    });
    request.once("error", reject);
  });
}
