require("dotenv").config();
// تشغيل هذا الملف ينشئ قاعدة البيانات والجداول تلقائياً
// node setup-db.js
require("./db");
setTimeout(() => process.exit(0), 2000);
