const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dbPath = path.resolve("data/collector.db");
console.log("DB_TARGET=" + dbPath);

const db = new Database(dbPath, { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);

console.log("Tables count:", tables.length);
for (const t of tables) {
  const count = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
  console.log(`  - ${t}: ${count} rows`);
}
const stat = fs.statSync(dbPath);
console.log("File size:", stat.size, "bytes");
