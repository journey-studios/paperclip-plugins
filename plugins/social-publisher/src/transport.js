import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

const API_HOSTS = new Set([
  "graph.facebook.com",
  "graph.instagram.com",
  "api.instagram.com",
  "graph.threads.net",
  "api.x.com",
  "upload.twitter.com",
]);

export function makeFetch(ctx) {
  if (typeof ctx.http?.fetch !== "function") throw new Error("OUTBOUND_HTTP_UNAVAILABLE");
  return (url, init) => {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      !API_HOSTS.has(target.hostname) ||
      target.username ||
      target.password ||
      target.port
    ) {
      throw new Error("OUTBOUND_HOST_NOT_ALLOWED");
    }
    return ctx.http.fetch(target.href, init);
  };
}

export function isPublicAddress(address) {
  const value = address.toLowerCase();
  if (isIP(value) === 4) {
    const parts = value.split(".").map(Number);
    const [a, b] = parts;
    if ([0, 10, 127].includes(a) || a >= 224) return false;
    if ((a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
      return false;
    if ((a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19, 51].includes(b))) return false;
    if ((a === 192 && [0, 2].includes(b)) || (a === 203 && b === 0)) return false;
    return true;
  }
  // Only global unicast IPv6; mapped, local, documentation and transition addresses fail closed.
  if (isIP(value) === 6) return /^[23]/.test(value) && !/^(?:2001:|2002:|3fff:)/.test(value);
  return false;
}

/** The SDK serializes response bodies as text. Media needs a bounded binary transport with pinned DNS. */
export function makeMediaFetch(allowedHosts, dependencies = {}) {
  const resolve = dependencies.lookup ?? lookup;
  const send = dependencies.request ?? request;
  return async (rawUrl) => {
    const target = new URL(rawUrl);
    if (
      target.protocol !== "https:" ||
      target.port ||
      target.username ||
      target.password ||
      !allowedHosts.includes(target.hostname) ||
      isIP(target.hostname)
    )
      throw new Error("MEDIA_HOST_NOT_ALLOWED");
    const addresses = await resolve(target.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address)))
      throw new Error("MEDIA_ADDRESS_NOT_PUBLIC");
    const selected = addresses[0];
    return new Promise((accept, reject) => {
      const req = send(
        target,
        {
          method: "GET",
          servername: target.hostname,
          lookup: (_hostname, options, callback) => {
            if (options?.all) callback(null, [selected]);
            else callback(null, selected.address, selected.family);
          },
          timeout: 20_000,
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error("MEDIA_FETCH_FAILED"));
            return;
          }
          const size = Number(response.headers["content-length"] ?? 0);
          if (size > 25 * 1024 * 1024) {
            response.destroy();
            reject(new Error("MEDIA_TOO_LARGE"));
            return;
          }
          const chunks = [];
          let bytes = 0;
          response.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 25 * 1024 * 1024) {
              response.destroy();
              reject(new Error("MEDIA_TOO_LARGE"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", () => reject(new Error("MEDIA_FETCH_FAILED")));
          response.on("end", () =>
            accept(
              new Response(Buffer.concat(chunks), {
                status: 200,
                headers: {
                  "content-type": response.headers["content-type"] ?? "application/octet-stream",
                },
              }),
            ),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error("MEDIA_FETCH_TIMEOUT")));
      req.on("error", () => reject(new Error("MEDIA_FETCH_FAILED")));
      req.end();
    });
  };
}
