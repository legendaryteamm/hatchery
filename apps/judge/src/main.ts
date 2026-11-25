import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const app = buildServer(config);
await app.listen({ host: config.host, port: config.port });
