require("dotenv").config();
const { getAllContacts, getStats } = require("./contacts");

async function main() {
  const [list, stats] = await Promise.all([getAllContacts(), getStats()]);

  console.log(`\n📋 قائمة الزبائن — المجموع: ${stats.total} | اليوم: ${stats.today}\n`);
  console.log("━".repeat(65));

  if (list.length === 0) {
    console.log("  لا يوجد زبائن مسجلين بعد.");
  } else {
    list.forEach((c, i) => {
      const first = new Date(c.firstSeen).toLocaleDateString("fr-MA");
      const last  = new Date(c.lastSeen).toLocaleDateString("fr-MA");
      console.log(`${String(i + 1).padStart(3)}. ${c.name.padEnd(20)} +${c.phone.padEnd(15)} ${c.totalMessages} رسالة  (${first} → ${last})`);
      console.log(`     آخر رسالة: "${String(c.lastMessage || "").substring(0, 50)}"`);
      console.log();
    });
  }

  console.log("━".repeat(65));
  console.log(`\nالمجموع: ${list.length} زبون\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ خطأ:", err.message);
  process.exit(1);
});
