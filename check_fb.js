const db = require('better-sqlite3')('./data/collector.db');
console.log(JSON.stringify(db.prepare("SELECT platform, raw_data FROM snapshots WHERE platform='facebook_posts' LIMIT 1").all(), null, 2));
