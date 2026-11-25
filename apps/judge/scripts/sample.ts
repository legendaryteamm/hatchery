/** Sends the sample fixture proof to a running judge service. `pnpm judge:sample` */
import { readFile } from "node:fs/promises";

const url = process.env.JUDGE_URL ?? "http://127.0.0.1:4100";
const source = await readFile(new URL("../../../lean/Proofs/L_fixture_001.lean", import.meta.url), "utf8");
const statement = await readFile(new URL("../../../lean/Statements/L_fixture_001.lean", import.meta.url), "utf8");
const headers: Record<string, string> = { "content-type": "application/json" };
if (process.env.JUDGE_API_TOKEN) headers.authorization = `Bearer ${process.env.JUDGE_API_TOKEN}`;
const res = await fetch(`${url}/check`, { method: "POST", headers, body: JSON.stringify({ lemmaId: "L-fixture-001", source, statements: [{ lemmaId: "L-fixture-001", source: statement }] }) });
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
process.exit(res.ok && body.verdict === "pass" ? 0 : 1);
