import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { CONTROL_BODY_LIMIT } from "./constants.mjs";

function authorized(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function loopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function jsonResponse(response, status, value) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

export async function startControlServer(context) {
  const server = http.createServer((request, response) => {
    if (!loopback(request.socket.remoteAddress)) return jsonResponse(response, 403, { ok: false, error: "loopback only" });
    const header = request.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!authorized(token, context.token)) return jsonResponse(response, 401, { ok: false, error: "unauthorized" });
    if (request.method !== "POST") return jsonResponse(response, 405, { ok: false, error: "method not allowed" });
    const action = new URL(request.url, "http://127.0.0.1").pathname.slice(1);
    if (!["ping", "send", "steer", "cancel"].includes(action)) return jsonResponse(response, 404, { ok: false, error: "unknown action" });
    let size = 0;
    const chunks = [];
    request.on("data", chunk => {
      size += chunk.length;
      if (size > CONTROL_BODY_LIMIT) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", async () => {
      if (size > CONTROL_BODY_LIMIT) return jsonResponse(response, 413, { ok: false, error: "request too large" });
      let payload = {};
      try { if (chunks.length) payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return jsonResponse(response, 400, { ok: false, error: "invalid JSON" }); }
      try {
        const handler = context.handlers?.[action];
        const value = handler ? await handler(payload) : {};
        jsonResponse(response, 200, { ok: true, ...value });
      } catch (error) {
        jsonResponse(response, 500, { ok: false, error: error.message });
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  return { server, port, close: () => new Promise(resolve => server.close(resolve)) };
}

export function sendControl(job, action, payload = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = job?.worker;
    if (!worker?.port || !worker?.token) return reject(new Error("Worker control endpoint unavailable"));
    const body = JSON.stringify(payload);
    const request = http.request({
      host: "127.0.0.1", port: worker.port, path: `/${action}`, method: "POST",
      headers: { authorization: `Bearer ${worker.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: options.timeoutMs || 1000,
    }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => {
        let value;
        try { value = JSON.parse(text); } catch { value = { ok: false, error: text || `HTTP ${response.statusCode}` }; }
        if (response.statusCode < 200 || response.statusCode >= 300 || !value.ok) reject(new Error(`${response.statusCode}: ${value.error || "control request failed"}`));
        else resolve(value);
      });
    });
    request.once("timeout", () => request.destroy(new Error("Control request timed out")));
    request.once("error", reject);
    request.end(body);
  });
}

export async function isWorkerReachable(job, options = {}) {
  try { return Boolean((await sendControl(job, "ping", {}, options)).ok); } catch { return false; }
}
