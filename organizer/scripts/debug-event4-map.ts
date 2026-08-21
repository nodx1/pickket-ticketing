import { getPool } from "../src/lib/db/pool";
import fs from "node:fs";

const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

async function main() {
  const pool = getPool();
  const mapId = "ae3c8822-b833-4986-aa82-ef93c0006970";
  const { rows } = await pool.query(`SELECT map_data FROM seat_maps WHERE id = $1`, [mapId]);
  const md = rows[0]?.map_data;
  if (md && Array.isArray(md.sections)) {
    console.log("--- figma sections ---");
    for (const s of md.sections) {
      console.log(
        `  name=${s.name ?? s.label ?? "?"}  kind=${s.kind ?? "?"}  tierId=${s.tierId ?? s.tier_id ?? "(none)"}  rows=${s.rows ?? "?"} cols=${s.cols ?? "?"}`,
      );
    }
  } else {
    console.log("map_data structure:");
    console.log(Object.keys(md ?? {}));
    console.log(JSON.stringify(md, null, 2).slice(0, 800));
  }
  await pool.end();
}
void main();
