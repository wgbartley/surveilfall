#!/usr/bin/env node

const fs = require("fs");
const readline = require("readline");

const pool = require("./db");

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
    if (process.argv.length < 3) {
        log("Usage: node import-bulk-cards.js <path-to-bulk-json-file>");
        process.exit(1);
    }

    const filePath = process.argv[2];

    if (!fs.existsSync(filePath)) {
        log(`Error: File not found: ${filePath}`);
        process.exit(1);
    }

    // Clear existing card data
    log("Clearing existing card data from database...");
    await pool.query("DROP TABLE cards");
    await pool.query("DROP TABLE card_search");

    // Create the cards table with a primary key on the Scryfall ID.
    // (LONGTEXT keeps the raw JSON as a string so the app can JSON.parse it.)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cards (
            id VARCHAR(64) NOT NULL PRIMARY KEY,
            data LONGTEXT NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Create a search-optimized lookup table with key fields extracted.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS card_search (
            id VARCHAR(64) NOT NULL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            set_code VARCHAR(16) NOT NULL,
            set_name VARCHAR(255) NOT NULL,
            collector_number VARCHAR(32) NOT NULL,
            released_at VARCHAR(20),
            cmc DOUBLE,
            power VARCHAR(16),
            toughness VARCHAR(16),
            INDEX idx_card_search_name (name),
            INDEX idx_card_search_set_code (set_code),
            INDEX idx_card_search_collector_number (collector_number)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    log(`Importing card data from: ${filePath}`);

    const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity,
    });

    let cardCount = 0;
    let lineCount = 0;
    let batch = [];
    const startTime = Date.now();
    const BATCH_SIZE = 1000;

    // Insert a batch of cards using multi-row INSERTs (one round trip each).
    async function insertBatch(cards) {
        const cardRows = cards.map((card) => [card.id, JSON.stringify(card)]);
        const searchRows = cards.map((card) => [
            card.id,
            card.name || "",
            (card.set || "").toLowerCase(),
            card.set_name || "",
            card.collector_number || "",
            card.released_at || null,
            card.cmc ?? null,
            card.power || null,
            card.toughness || null,
        ]);

        await pool.query("INSERT INTO cards (id, data) VALUES ?", [cardRows]);
        await pool.query(
            `INSERT INTO card_search
                (id, name, set_code, set_name, collector_number, released_at, cmc, power, toughness)
             VALUES ?`,
            [searchRows]
        );
    }

    for await (const line of rl) {
        lineCount++;
        let trimmed = line.trim();

        // Remove trailing comma if present (JSON array format)
        if (trimmed.endsWith(",")) {
            trimmed = trimmed.slice(0, -1);
        }

        // Skip empty lines, brackets
        if (!trimmed || trimmed === "[" || trimmed === "]") {
            continue;
        }

        try {
            const card = JSON.parse(trimmed);
            if (card && typeof card === "object" && card.id) {
                batch.push(card);
                cardCount++;

                if (batch.length >= BATCH_SIZE) {
                    await insertBatch(batch);
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    log(`[IMPORT] Imported ${cardCount} cards (${elapsed}s)...`);
                    batch = [];
                }
            }
        } catch {
            // Skip lines that don't parse as JSON
        }

        if (lineCount % 5000 === 0) {
            process.stdout.write(`\r[PARSE] Processed ${lineCount} lines...`);
        }
    }

    // Flush remaining batch
    if (batch.length > 0) {
        await insertBatch(batch);
    }

    console.log();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`✓ Import complete!`);
    log(`  Total cards imported: ${cardCount}`);
    log(`  Time elapsed: ${elapsed}s`);

    await pool.end();
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
