import http from "node:http";
import { loadLocalEnv, parsePositiveInt } from "./ops/env";

loadLocalEnv();
const port = parsePositiveInt("PROVIDER_FAULT_PORT", 18765, 65535);
const mode = process.env.PROVIDER_FAULT_MODE ?? "500";
const delayMs = parsePositiveInt("PROVIDER_FAULT_DELAY_MS", 15_000, 120_000);

const server = http.createServer((request, response) => {
  const payload = JSON.stringify({ requestId: "fault-proxy-request", messages: [], status: "fault-injected", path: request.url });
  const send = () => {
    if (mode === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{malformed");
      return;
    }
    const status = mode === "429" ? 429 : mode === "200" ? 200 : 500;
    response.writeHead(status, { "content-type": "application/json", "retry-after": "1" });
    response.end(payload);
  };
  if (mode === "timeout") setTimeout(send, delayMs);
  else send();
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}`, mode, delayMs: mode === "timeout" ? delayMs : undefined }));
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
