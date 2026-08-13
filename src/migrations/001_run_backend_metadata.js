module.exports = function up(db) {
  const tableInfo = db.prepare('PRAGMA table_info(runs)').all();
  const columnNames = tableInfo.map(c => c.name);

  function ensureColumn(colName, colDef) {
    if (!columnNames.includes(colName)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${colName} ${colDef}`);
      console.log(`[Migration] Added column ${colName} to runs table.`);
    }
  }

  ensureColumn('active_backend', 'TEXT');
  ensureColumn('backend_kind', 'TEXT');
  ensureColumn('backend_status', 'TEXT');
  ensureColumn('backend_version', 'TEXT');
  ensureColumn('backend_run_id', 'TEXT');
  ensureColumn('health_snapshot', 'TEXT');
  ensureColumn('cost_estimate', 'REAL DEFAULT 0');
};
