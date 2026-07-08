// ---------------------------------------------------------------------------
// MariaDB connection pool
// ---------------------------------------------------------------------------
//
// Connection details are read from the environment (see .env):
//   DB_HOST, DB_PORT (optional, default 3306), DB_NAME, DB_USER, DB_PASS
//
// The pool is shared across the app; mysql2's promise API is used so route
// handlers can `await` queries.

const mysql = require("mysql2/promise");

// Load .env using Node's built-in loader (matches download-data-files.js).
try {
    process.loadEnvFile();
} catch {
    // .env is optional (e.g. when the vars are already in the environment).
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    charset: "utf8mb4",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

module.exports = pool;
