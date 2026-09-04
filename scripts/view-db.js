/**
 * CLI Database Viewer Utility
 * Usage: node scripts/view-db.js [table_name] [--limit 10]
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'collector.db');
if (!require('fs').existsSync(dbPath)) {
  console.error('? Database file not found at:', dbPath);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

function main() {
  const args = process.argv.slice(2);
  const targetTable = args[0] || 'summary';
  const limit = parseInt(args[args.indexOf('--limit') + 1] || '10', 10);

  if (targetTable === 'summary' || targetTable === 'stats') {
    console.log('\n📊 TỔNG QUAN DỮ LIỆU TRONG DATABASE (data/collector.db):');
    console.log('='.repeat(65));
    
    const tables = ['runs', 'product_current', 'daily_packed_history', 'weekly_summary', 'snapshots'];
    for (const t of tables) {
      try {
        const count = db.prepare(`SELECT COUNT(*) as total FROM ${t}`).get();
        console.log(`  • Bảng [${t}]: ${count.total.toLocaleString()} bản ghi`);
      } catch (_e) {
        console.log(`  • Bảng [${t}]: Chưa tạo hoặc rỗng`);
      }
    }
    
    console.log('='.repeat(65));
    console.log('💡 Gợi ý xem chi tiết:');
    console.log('  - node scripts/view-db.js products    (Xem sản phẩm trong product_current)');
    console.log('  - node scripts/view-db.js runs        (Xem lịch sử các lần cào)');
    console.log('  - node scripts/view-db.js history     (Xem dữ liệu quan sát theo ngày)');
    console.log('  - node scripts/view-db.js snapshots   (Xem toàn bộ snapshot raw)\n');
    return;
  }

  if (targetTable === 'products' || targetTable === 'product_current') {
    const rows = db.prepare('SELECT item_uid, platform, title, current_price, current_rating, current_likes, current_views, rank_score, status, last_crawled_at FROM product_current ORDER BY last_crawled_at DESC LIMIT ?').all(limit);
    console.log(`
?? DANH S?CH S?N PH?M M?I NH?T TRONG [product_current] (Top ${rows.length}):`);
    console.log('='.repeat(80));
    rows.forEach((r, i) => {
      console.log(`[#${i+1}] ${r.title}`);
      console.log(`     N?n t?ng: ${r.platform} | Gi?: $${r.current_price} | L??t xem: ${r.current_views} | ?i?m Rank: ${r.rank_score} | Tr?ng th?i: ${r.status}`);
      console.log(`     UID: ${r.item_uid}`);
      console.log(`     C?p nh?t l?c: ${r.last_crawled_at}
`);
    });
    return;
  }

  if (targetTable === 'runs') {
    const rows = db.prepare('SELECT id, platform, query, status, items_count, active_backend, created_at, completed_at FROM runs ORDER BY id DESC LIMIT ?').all(limit);
    console.log(`
?? L?CH S? C?C L?N C?O TRONG [runs] (Top ${rows.length}):`);
    console.log('='.repeat(80));
    rows.forEach(r => {
      console.log(`Run #${r.id} | [${r.platform.toUpperCase()}] "${r.query}" | Tr?ng th?i: ${r.status} | Thu th?p: ${r.items_count} items | Backend: ${r.active_backend || 'N/A'} | L?c: ${r.created_at}`);
    });
    console.log('');
    return;
  }

  if (targetTable === 'history' || targetTable === 'daily_packed_history') {
    const rows = db.prepare('SELECT item_uid, platform, date, observation_count, latest_price, latest_likes, latest_views, observations_json FROM daily_packed_history ORDER BY updated_at DESC LIMIT ?').all(limit);
    console.log(`
?? L?CH S? QUAN S?T THEO NG?Y TRONG [daily_packed_history] (Top ${rows.length}):`);
    console.log('='.repeat(80));
    rows.forEach(r => {
      console.log(`UID: ${r.item_uid} | Ng?y: ${r.date} | S? m?c ?o trong ng?y: ${r.observation_count} | Gi?: $${r.latest_price} | Views: ${r.latest_views}`);
    });
    console.log('');
    return;
  }

  // Generic table query
  try {
    const rows = db.prepare(`SELECT * FROM ${targetTable} LIMIT ?`).all(limit);
    console.log(`
?? D? LI?U T? B?NG [${targetTable}] (Limit ${limit}):`);
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error('? L?i truy v?n b?ng:', err.message);
  }
}

main();
