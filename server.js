const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Request logging — emit one line per completed request with method, path,
// status and duration. Registered first so it observes every request, and
// routed to the console stream matching the status class.
app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const line = `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`;
        if (res.statusCode >= 500) console.error(line);
        else if (res.statusCode >= 400) console.warn(line);
        else console.log(line);
    });
    next();
});

// Parse JSON request bodies
app.use(express.json());

// Serve static frontend files from public/. index:false so "/" falls through
// to the route below, which injects cache-busting versions into asset URLs.
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { index: false }));

// Scryfall-compatible CORS headers
app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a route handler so thrown errors are caught and returned as
 * Scryfall-style error objects.
 */
function wrap(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Append a cache-busting `?v=<mtime>` to local CSS/JS asset URLs in an HTML
 * string, based on each referenced file's last-modified time. Whenever a file
 * changes, its version token changes and browsers re-fetch it instead of
 * serving a stale cached copy. Missing assets are left untouched.
 */
function addAssetVersions(html) {
    return html.replace(
        /((?:href|src)=")(\/[^"?#]+\.(?:css|js))"/g,
        (match, prefix, url) => {
            try {
                const stat = fs.statSync(path.join(PUBLIC_DIR, url));
                const version = Math.floor(stat.mtimeMs).toString(36);
                return `${prefix}${url}?v=${version}"`;
            } catch (e) {
                return match; // asset not found on disk — leave the URL as-is
            }
        }
    );
}

/**
 * Read an HTML file, apply optional [from, to] string replacements, and add
 * cache-busting versions to its asset references.
 */
function renderHtmlPage(absPath, replacements) {
    let html = fs.readFileSync(absPath, "utf-8");
    if (replacements) {
        for (const [from, to] of replacements) {
            html = html.replace(from, to);
        }
    }
    return addAssetVersions(html);
}

// Absolute paths to the HTML pages served with cache-busted assets.
const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");
const ADMIN_HTML = path.join(__dirname, "views", "admin.html");

/**
 * Return a Scryfall-style error response.
 */
function sendError(res, status, details) {
    res.status(status).json({
        object: "error",
        code: status,
        status: status,
        details,
    });
}

/**
 * Gate admin routes behind HTTP Basic Auth checked against ADMIN_PASSWORD.
 * The username is ignored; only the password must match. Fails closed: if
 * ADMIN_PASSWORD is not configured, access is refused rather than left open.
 * Once the browser prompt is satisfied, it re-sends the credentials on the
 * page's fetch() calls automatically, so the API routes are covered too.
 */
function requireAdmin(req, res, next) {
    const configured = process.env.ADMIN_PASSWORD;
    if (!configured) {
        return sendError(res, 503, "Admin access is not configured (set ADMIN_PASSWORD).");
    }

    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
        const decoded = Buffer.from(encoded, "base64").toString("utf8");
        const password = decoded.slice(decoded.indexOf(":") + 1);
        const given = Buffer.from(password);
        const expected = Buffer.from(configured);
        // Constant-time comparison; the length guard avoids timingSafeEqual throwing.
        if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
            return next();
        }
    }

    res.setHeader("WWW-Authenticate", 'Basic realm="SurveilFall Admin", charset="UTF-8"');
    return sendError(res, 401, "Authentication required.");
}

/**
 * Fetch the full card JSON (the `data` column) for a list of card ids in a
 * single query. Returns a Map of id -> data string. Callers preserve their own
 * ordering by iterating their id list and looking up the map.
 */
async function fetchCardData(ids) {
    const map = new Map();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    const [rows] = await pool.query(
        `SELECT id, data FROM cards WHERE id IN (${placeholders})`,
        ids
    );
    for (const row of rows) {
        map.set(row.id, row.data);
    }
    return map;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * GET /healthz
 * Lightweight liveness probe for container orchestration. Reports that the
 * HTTP server is up; it deliberately does not touch the database so a transient
 * DB blip doesn't cause the container to be killed.
 */
app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
});

/**
 * GET /
 * Serve the main search page with cache-busted asset URLs. (express.static is
 * configured with index:false so this handler owns "/".)
 */
app.get("/", (_req, res) => {
    res.send(renderHtmlPage(INDEX_HTML));
});

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * GET /cards/autocomplete
 * Returns card name suggestions for the autocomplete dropdown.
 * Queries the indexed card_search table for fast prefix matching.
 */
app.get(
    "/cards/autocomplete",
    wrap(async (req, res) => {
        const query = (req.query.q || "").trim();

        if (!query) {
            return res.json({ object: "list", data: [] });
        }

        // Find distinct card names matching the query.
        // Split multi-word queries so each word must match somewhere in the name.
        // MariaDB's default (utf8mb4_*_ci) collation makes LIKE case-insensitive,
        // so no explicit COLLATE is needed.
        const words = query.split(/\s+/).filter(Boolean);
        let sql;
        let params;
        if (words.length === 1) {
            sql = `SELECT DISTINCT cs.name FROM card_search cs
                   WHERE cs.name LIKE ?
                   ORDER BY
                     CASE WHEN cs.name LIKE ? THEN 0 ELSE 1 END,
                     cs.name ASC
                   LIMIT 10`;
            params = ["%" + query + "%", query + "%"];
        } else {
            // Multiple words: each word must appear somewhere in the name
            const conditions = words.map(() => "cs.name LIKE ?");
            sql = `SELECT DISTINCT cs.name FROM card_search cs
                   WHERE ${conditions.join(" AND ")}
                   ORDER BY cs.name ASC
                   LIMIT 10`;
            params = words.map((w) => "%" + w + "%");
        }
        const [rows] = await pool.query(sql, params);

        // For each matching name, fetch the most recent printing's set + collector number
        // so the frontend can link directly to the card detail page.
        const names = rows.map((r) => r.name);
        const data = [];
        for (const name of names) {
            const [bestRows] = await pool.query(
                `SELECT cs.set_code, cs.collector_number
                 FROM card_search cs
                 WHERE cs.name = ?
                 ORDER BY cs.released_at DESC, cs.set_name ASC
                 LIMIT 1`,
                [name]
            );
            if (bestRows.length > 0) {
                data.push({
                    object: "card_name",
                    name,
                    set: bestRows[0].set_code,
                    collector_number: bestRows[0].collector_number,
                });
            } else {
                data.push({ object: "card_name", name });
            }
        }

        res.json({ object: "list", data });
    })
);

/**
 * GET /cards/search
 * Scryfall-compatible card search.  Supports ?q= and ?order= parameters.
 * Defined BEFORE /cards/:id so "search" isn't captured as an id param.
 *
 * Results are grouped by card name.  If the query is an exact (case-insensitive)
 * match for a card name, the client is redirected to that card's detail page.
 */
app.get(
    "/cards/search",
    wrap(async (req, res) => {
        const query = (req.query.q || "").trim();
        const order = req.query.order || "name";

        if (!query) {
            return res.json({ object: "list", total_cards: 0, has_more: false, data: [] });
        }

        // Build WHERE clause
        let where;
        const params = [];

        const nameMatch = query.match(/name\s*:\s*"([^"]+)"/) || query.match(/name\s*:\s*([^\s]+)/);
        const searchTerm = nameMatch ? nameMatch[1] : query;

        where = "WHERE cs.name LIKE ?";
        params.push(`%${searchTerm}%`);

        // Check for exact match first — redirect to card page.
        // (Default _ci collation makes `=` case-insensitive.)
        // Skip exact match if query starts or ends with "*" (wildcard)
        if (!query.startsWith("*") && !query.endsWith("*")) {
            const [exactRows] = await pool.query(
                `SELECT cs.id, cs.set_code, cs.collector_number, cs.name FROM card_search cs
                 WHERE cs.name = ?
                 LIMIT 1`,
                [query]
            );
            const exactRow = exactRows[0];

            if (exactRow) {
                const slug = exactRow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                return res.json({
                    object: "redirect",
                    redirect: `/card/${exactRow.set_code}/${exactRow.collector_number}/${slug}`,
                });
            }

            // Not an exact match — try smart redirects:
            // If query ends with a 3-letter set code like "thriving moor ncc"
            const setCodeMatch = query.match(/^(.+?)\s+([a-z0-9]{3})$/i);
            if (setCodeMatch) {
                const cardName = setCodeMatch[1].trim();
                const setCode = setCodeMatch[2].toLowerCase();
                const [smartRows] = await pool.query(
                    `SELECT cs.id, cs.set_code, cs.collector_number, cs.name FROM card_search cs
                     WHERE cs.name = ?
                       AND cs.set_code = ?
                     LIMIT 1`,
                    [cardName, setCode]
                );
                const smartRow = smartRows[0];
                if (smartRow) {
                    const slug = smartRow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                    return res.json({
                        object: "redirect",
                        redirect: `/card/${smartRow.set_code}/${smartRow.collector_number}/${slug}`,
                    });
                }
            }

            // If query ends with a 1-4 digit number like "thriving moor 443"
            const numMatch = query.match(/^(.+?)\s+(\d{1,4})$/);
            if (numMatch) {
                const cardName = numMatch[1].trim();
                const cardNum = numMatch[2].replace(/^0+/, ""); // Strip leading zeros
                const [smartRows] = await pool.query(
                    `SELECT cs.id, cs.set_code, cs.collector_number, cs.name FROM card_search cs
                     WHERE cs.name = ?
                       AND cs.collector_number = ?
                     LIMIT 1`,
                    [cardName, cardNum]
                );
                const smartRow = smartRows[0];
                if (smartRow) {
                    const slug = smartRow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                    return res.json({
                        object: "redirect",
                        redirect: `/card/${smartRow.set_code}/${smartRow.collector_number}/${slug}`,
                    });
                }
            }
        }

        // Fetch matching rows from card_search (fast, indexed)
        const [searchRows] = await pool.query(
            `SELECT cs.* FROM card_search cs ${where} LIMIT 500`,
            params
        );

        // Group by card name
        const groups = new Map();
        for (const row of searchRows) {
            const name = row.name;
            if (!groups.has(name)) {
                groups.set(name, []);
            }
            groups.get(name).push(row);
        }

        // Batch-fetch the full card JSON for every matching print in one query.
        const dataById = await fetchCardData(searchRows.map((r) => r.id));

        // Build result: representative per group, with all its prints attached.
        const result = [];
        for (const [, prints] of groups) {
            // Pick the "best" representative — prefer the most recent set
            prints.sort((a, b) => (b.released_at || "").localeCompare(a.released_at || ""));
            const repData = dataById.get(prints[0].id);
            if (!repData) continue;
            const rep = JSON.parse(repData);

            // Attach the full JSON for every printing of this card.
            rep.prints = prints
                .map((p) => dataById.get(p.id))
                .filter(Boolean)
                .map((d) => JSON.parse(d));

            result.push(rep);
        }

        // Sort results
        switch (order) {
            case "cmc":
                result.sort((a, b) => (a.cmc ?? 999) - (b.cmc ?? 999));
                break;
            case "power": {
                result.sort((a, b) => {
                    const pa = parseFloat(a.power) || -1;
                    const pb = parseFloat(b.power) || -1;
                    return pb - pa;
                });
                break;
            }
            case "toughness": {
                result.sort((a, b) => {
                    const ta = parseFloat(a.toughness) || -1;
                    const tb = parseFloat(b.toughness) || -1;
                    return tb - ta;
                });
                break;
            }
            case "name":
            default:
                result.sort((a, b) => a.name.localeCompare(b.name));
                break;
        }

        res.json({
            object: "list",
            total_cards: result.length,
            has_more: false,
            data: result,
        });
    })
);

/**
 * GET /cards/:id
 * Return a single card by its Scryfall ID (the primary key in our DB).
 */
app.get(
    "/cards/:id",
    wrap(async (req, res) => {
        const { id } = req.params;
        const [rows] = await pool.query("SELECT data FROM cards WHERE id = ?", [id]);
        const row = rows[0];
        if (!row) {
            return sendError(res, 404, `Card with id '${id}' not found.`);
        }
        res.json(JSON.parse(row.data));
    })
);

// ---------------------------------------------------------------------------
// Card detail page (HTML)
// ---------------------------------------------------------------------------

/**
 * GET /card/:set/:collectorNumber/:slug
 * Serve the card detail HTML page. The card data and all other printings
 * of the same card name are embedded as JSON in the page.
 */
app.get(
    "/card/:set/:collectorNumber/:slug",
    wrap(async (req, res) => {
        // card_search.set_code is stored lower-cased at import time.
        const setCode = req.params.set.toLowerCase();
        const { collectorNumber } = req.params;

        // Look up the card by set code and collector number.
        // If the collector number starts with "0", also try without leading zeros
        // so "036" matches "36".
        const collectorNumbers = [collectorNumber];
        const stripped = collectorNumber.replace(/^0+/, "");
        if (stripped !== collectorNumber) {
            collectorNumbers.push(stripped);
        }

        // Resolve the card id via the indexed card_search table.
        const [idRows] = await pool.query(
            `SELECT id FROM card_search
             WHERE set_code = ?
               AND collector_number IN (${collectorNumbers.map(() => "?").join(",")})
             LIMIT 1`,
            [setCode, ...collectorNumbers]
        );

        if (idRows.length === 0) {
            return res.status(404).send(renderHtmlPage(INDEX_HTML));
        }

        const [cardRows] = await pool.query(
            "SELECT data FROM cards WHERE id = ?",
            [idRows[0].id]
        );
        if (cardRows.length === 0) {
            return res.status(404).send(renderHtmlPage(INDEX_HTML));
        }

        const card = JSON.parse(cardRows[0].data);

        // Fetch all printings of the same card name using the indexed search table
        const [printSearchRows] = await pool.query(
            `SELECT id FROM card_search
             WHERE name = ?
             ORDER BY released_at DESC, set_name ASC`,
            [card.name]
        );

        // Batch-fetch full JSON, then rebuild in the SQL-ordered sequence.
        const dataById = await fetchCardData(printSearchRows.map((r) => r.id));
        const prints = printSearchRows
            .map((r) => dataById.get(r.id))
            .filter(Boolean)
            .map((d) => JSON.parse(d));

        // Serve the card detail page with card data + all printings embedded
        const html = renderHtmlPage(INDEX_HTML, [
            ["var CARD_DATA = null;", "var CARD_DATA = " + JSON.stringify(card) + ";"],
            ["var PRINTS_DATA = null;", "var PRINTS_DATA = " + JSON.stringify(prints) + ";"],
        ]);
        res.send(html);
    })
);

// ---------------------------------------------------------------------------
// Bulk-data
// ---------------------------------------------------------------------------

/**
 * GET /bulk-data
 * Return the list of available bulk data sets (mirrors Scryfall's response).
 */
app.get("/bulk-data", (req, res) => {
    res.json({
        object: "list",
        has_more: false,
        data: [
            {
                object: "bulk_data",
                id: "00000000-0000-0000-0000-000000000001",
                type: "oracle_cards",
                updated_at: new Date().toISOString(),
                uri: `${req.protocol}://${req.get("host")}/bulk-data/oracle_cards`,
                name: "Oracle Cards",
                description:
                    "A JSON file containing one Scryfall card object for each Oracle ID on Scryfall. The chosen sets for the cards are an attempt to return the most up-to-date recognizable version of the card.",
                size: 0,
                download_uri: `${req.protocol}://${req.get("host")}/bulk-data/oracle_cards`,
                content_type: "application/json",
                content_encoding: "gzip",
            },
            {
                object: "bulk_data",
                id: "00000000-0000-0000-0000-000000000002",
                type: "unique_artwork",
                updated_at: new Date().toISOString(),
                uri: `${req.protocol}://${req.get("host")}/bulk-data/unique_artwork`,
                name: "Unique Artwork",
                description:
                    "A JSON file of Scryfall card objects that together contain all unique artworks. The chosen cards promote the best image scans.",
                size: 0,
                download_uri: `${req.protocol}://${req.get("host")}/bulk-data/unique_artwork`,
                content_type: "application/json",
                content_encoding: "gzip",
            },
            {
                object: "bulk_data",
                id: "00000000-0000-0000-0000-000000000003",
                type: "default_cards",
                updated_at: new Date().toISOString(),
                uri: `${req.protocol}://${req.get("host")}/bulk-data/default_cards`,
                name: "Default Cards",
                description:
                    "A JSON file containing every card object on Scryfall in English or the printed language if the card is only available in one language.",
                size: 0,
                download_uri: `${req.protocol}://${req.get("host")}/bulk-data/default_cards`,
                content_type: "application/json",
                content_encoding: "gzip",
            },
            {
                object: "bulk_data",
                id: "00000000-0000-0000-0000-000000000004",
                type: "all_cards",
                updated_at: new Date().toISOString(),
                uri: `${req.protocol}://${req.get("host")}/bulk-data/all_cards`,
                name: "All Cards",
                description:
                    "A JSON file containing every card object on Scryfall in every language.",
                size: 0,
                download_uri: `${req.protocol}://${req.get("host")}/bulk-data/all_cards`,
                content_type: "application/json",
                content_encoding: "gzip",
            },
            {
                object: "bulk_data",
                id: "00000000-0000-0000-0000-000000000005",
                type: "rulings",
                updated_at: new Date().toISOString(),
                uri: `${req.protocol}://${req.get("host")}/bulk-data/rulings`,
                name: "Rulings",
                description:
                    "A JSON file containing all Rulings on Scryfall. Each ruling refers to cards via an `oracle_id`.",
                size: 0,
                download_uri: `${req.protocol}://${req.get("host")}/bulk-data/rulings`,
                content_type: "application/json",
                content_encoding: "gzip",
            },
            {
                object: "bulk_data",
                id: "00000000-0000-0000-0000-000000000006",
                type: "art_tags",
                updated_at: new Date().toISOString(),
                uri: `${req.protocol}://${req.get("host")}/bulk-data/art_tags`,
                name: "Art Tags",
                description:
                    "A JSON file containing all art (illustration) tags sourced from Tagger, the Scryfall community tagging project.",
                size: 0,
                download_uri: `${req.protocol}://${req.get("host")}/bulk-data/art_tags`,
                content_type: "application/json",
                content_encoding: "gzip",
            },
            {
                object: "bulk_data",
                id: "00000000-0000-0000-0000-000000000007",
                type: "oracle_tags",
                updated_at: new Date().toISOString(),
                uri: `${req.protocol}://${req.get("host")}/bulk-data/oracle_tags`,
                name: "Oracle Tags",
                description:
                    "A JSON file containing all Oracle tags sourced from Tagger, the Scryfall community tagging project.",
                size: 0,
                download_uri: `${req.protocol}://${req.get("host")}/bulk-data/oracle_tags`,
                content_type: "application/json",
                content_encoding: "gzip",
            },
        ],
    });
});

/**
 * GET /bulk-data/:type
 * Return the actual bulk data file for a given type by reading from the DB.
 */
app.get(
    "/bulk-data/:type",
    wrap(async (req, res) => {
        const { type } = req.params;

        let rows;
        switch (type) {
            case "oracle_cards":
                // One card per oracle_id — pick the most recently released print.
                // (Window functions require MariaDB 10.2+.)
                [rows] = await pool.query(
                    `SELECT data FROM (
                         SELECT data,
                                ROW_NUMBER() OVER (
                                    PARTITION BY JSON_UNQUOTE(JSON_EXTRACT(data, '$.oracle_id'))
                                    ORDER BY JSON_UNQUOTE(JSON_EXTRACT(data, '$.released_at')) DESC
                                ) AS rn
                         FROM cards
                         WHERE JSON_EXTRACT(data, '$.oracle_id') IS NOT NULL
                     ) t
                     WHERE t.rn = 1`
                );
                break;
            case "default_cards":
                [rows] = await pool.query("SELECT data FROM cards");
                break;
            default:
                return sendError(res, 404, `Bulk data type '${type}' not found.`);
        }

        const cards = rows.map((r) => JSON.parse(r.data));
        res.json(cards);
    })
);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/**
 * GET /admin
 * Serve the admin page.
 */
app.get("/admin", requireAdmin, (req, res) => {
    res.send(renderHtmlPage(ADMIN_HTML));
});

/**
 * GET /meta
 * Return dataset metadata (when the card data was last imported, how many
 * cards, and Scryfall's own update timestamp for the source file). Returns
 * nulls if no import has run yet.
 */
app.get(
    "/meta",
    wrap(async (_req, res) => {
        let updatedAt = null;
        let sourceUpdatedAt = null;
        let count = null;
        try {
            const [rows] = await pool.query(
                "SELECT k, v FROM meta WHERE k IN ('cards_updated_at', 'cards_count', 'source_updated_at')"
            );
            for (const row of rows) {
                if (row.k === "cards_updated_at") updatedAt = row.v || null;
                else if (row.k === "source_updated_at") sourceUpdatedAt = row.v || null;
                else if (row.k === "cards_count") count = row.v != null ? Number(row.v) : null;
            }
        } catch {
            // meta table doesn't exist yet (no import has run) — report unknown.
        }
        res.json({
            object: "meta",
            cards_updated_at: updatedAt,
            source_updated_at: sourceUpdatedAt,
            cards_count: count,
        });
    })
);

// ---------------------------------------------------------------------------
// Import job (background)
// ---------------------------------------------------------------------------
//
// The import downloads ~550 MB from Scryfall and then inserts ~115k rows, which
// takes minutes. We deliberately DO NOT stream this over a single long-lived
// HTTP response: any browser quirk, proxy, or idle timeout on that connection
// surfaces to the user as an opaque "network error". Instead the import runs as
// a background job on the server and the browser polls a tiny status endpoint.
// Short requests can't be idle-dropped, and the job survives the client
// disconnecting or the page reloading.

let importJob = null; // { running, done, error, log: [{level,text,t}], startedAt }

function startImportJob() {
    const job = {
        running: true,
        done: false,
        error: null,
        log: [],
        startedAt: Date.now(),
    };
    importJob = job;

    function send(level, text) {
        job.log.push({ level, text, t: Date.now() });
    }

    // Run the import asynchronously; log lines accumulate on the job object.
    (async () => {
        const fs = require("fs");
        const readline = require("readline");

        const USER_AGENT = process.env.USER_AGENT || "SurveilFall/1.0";
        const REQUEST_HEADERS = {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
        };

        function fetchJSON(url) {
            return new Promise((resolve, reject) => {
                const https = require("https");
                https.get(url, { headers: REQUEST_HEADERS, timeout: 30_000 }, (r) => {
                    if (r.statusCode !== 200) {
                        reject(new Error("HTTP " + r.statusCode + " fetching " + url));
                        return;
                    }
                    let body = "";
                    r.on("data", (c) => (body += c));
                    r.on("end", () => {
                        try {
                            resolve(JSON.parse(body));
                        } catch (e) {
                            reject(new Error("Failed to parse JSON: " + e.message));
                        }
                    });
                }).on("error", (err) => {
                    reject(new Error("Fetch error (" + (err.code || "unknown") + "): " + err.message));
                }).on("timeout", function () {
                    this.destroy();
                    reject(new Error("Timeout fetching " + url));
                });
            });
        }

        function downloadFile(url, destPath, onProgress) {
            return new Promise((resolve, reject) => {
                const https = require("https");
                const file = fs.createWriteStream(destPath);
                file.on("error", (err) => {
                    fs.unlink(destPath, () => {});
                    reject(new Error("File write error: " + err.message));
                });
                https.get(url, { headers: REQUEST_HEADERS, timeout: 600_000 }, (r) => {
                    if (r.statusCode !== 200) {
                        file.close();
                        fs.unlink(destPath, () => {});
                        reject(new Error("HTTP " + r.statusCode + " downloading " + url));
                        return;
                    }
                    // Report progress on a throttled cadence. This doubles as a
                    // heartbeat that keeps the client's streaming response alive
                    // during the otherwise-silent download window.
                    const total = Number(r.headers["content-length"]) || 0;
                    let received = 0;
                    let lastPing = Date.now();
                    r.on("data", (chunk) => {
                        received += chunk.length;
                        const now = Date.now();
                        if (onProgress && now - lastPing >= 2000) {
                            lastPing = now;
                            onProgress(received, total);
                        }
                    });
                    r.pipe(file);
                    r.on("error", (err) => {
                        file.close();
                        fs.unlink(destPath, () => {});
                        reject(new Error("Response stream error (" + (err.code || "unknown") + "): " + err.message));
                    });
                    file.on("finish", () => {
                        file.close();
                        resolve(destPath);
                    });
                }).on("error", (err) => {
                    file.close();
                    fs.unlink(destPath, () => {});
                    reject(new Error("Request error (" + (err.code || "unknown") + "): " + err.message));
                }).on("timeout", function () {
                    this.destroy();
                    file.close();
                    fs.unlink(destPath, () => {});
                    reject(new Error("Timeout downloading file"));
                });
            });
        }

        try {
            // 1. Fetch bulk-data catalog
            send("info", "Fetching bulk data catalog from Scryfall…");
            const catalog = await fetchJSON("https://api.scryfall.com/bulk-data");
            if (catalog.object === "error") {
                throw new Error("Scryfall API error: " + catalog.details);
            }

            // 2. Find the "default_cards" entry
            const defaultItem = catalog.data.find((d) => d.type === "default_cards");
            if (!defaultItem) {
                throw new Error("No default_cards entry found in bulk data catalog.");
            }

            send("info", "Found default_cards (" + (defaultItem.size / 1e6).toFixed(1) + " MB)");

            // 3. Download to a temp file
            const downloadsDir = path.join(__dirname, "downloads");
            fs.mkdirSync(downloadsDir, { recursive: true });
            const filename = path.basename(new URL(defaultItem.download_uri).pathname);
            const destPath = path.join(downloadsDir, filename);

            send("info", "Downloading from " + defaultItem.download_uri + " …");
            send("info", "Saving to " + filename + " …");
            // Quick DNS check before attempting download
            const dns = require("dns");
            const urlObj = new URL(defaultItem.download_uri);
            try {
                const addresses = await new Promise((resolve, reject) => {
                    dns.resolve(urlObj.hostname, (err, addrs) => {
                        if (err) reject(err);
                        else resolve(addrs);
                    });
                });
                send("info", "DNS resolved " + urlObj.hostname + " to " + addresses.join(", "));
            } catch (err) {
                send("error", "DNS resolution failed for " + urlObj.hostname + ": " + err.code);
            }
            await downloadFile(defaultItem.download_uri, destPath, (received, total) => {
                const mb = (received / 1e6).toFixed(1);
                const pct = total ? " (" + ((received / total) * 100).toFixed(1) + "%)" : "";
                send("info", "Downloaded " + mb + " MB" + pct + "…");
            });
            send("ok", "Download complete.");

            // 4. Clear existing data and recreate tables
            send("info", "Clearing existing card data…");
            await pool.query("DROP TABLE IF EXISTS cards");
            await pool.query("DROP TABLE IF EXISTS card_search");

            await pool.query(`
                CREATE TABLE IF NOT EXISTS cards (
                    id VARCHAR(64) NOT NULL PRIMARY KEY,
                    data LONGTEXT NOT NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);

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

            // Persistent key/value metadata (survives re-imports; not dropped above).
            await pool.query(`
                CREATE TABLE IF NOT EXISTS meta (
                    k VARCHAR(64) NOT NULL PRIMARY KEY,
                    v TEXT
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
            send("ok", "Tables created.");

            // 5. Stream the JSON file and insert in batches
            const rl = readline.createInterface({
                input: fs.createReadStream(destPath),
                crlfDelay: Infinity,
            });

            let cardCount = 0;
            let lineCount = 0;
            let batch = [];
            const BATCH_SIZE = 1000;
            const startTime = Date.now();

            async function insertBatch(cards) {
                const cardRows = cards.map((c) => [c.id, JSON.stringify(c)]);
                const searchRows = cards.map((c) => [
                    c.id,
                    c.name || "",
                    (c.set || "").toLowerCase(),
                    c.set_name || "",
                    c.collector_number || "",
                    c.released_at || null,
                    c.cmc ?? null,
                    c.power || null,
                    c.toughness || null,
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
                if (trimmed.endsWith(",")) trimmed = trimmed.slice(0, -1);
                if (!trimmed || trimmed === "[" || trimmed === "]") continue;

                try {
                    const card = JSON.parse(trimmed);
                    if (card && typeof card === "object" && card.id) {
                        batch.push(card);
                        cardCount++;
                        if (batch.length >= BATCH_SIZE) {
                            await insertBatch(batch);
                            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                            send("info", "Imported " + cardCount + " cards (" + elapsed + "s)…");
                            batch = [];
                        }
                    }
                } catch {
                    // skip unparseable lines
                }
            }

            // Flush remaining
            if (batch.length > 0) {
                await insertBatch(batch);
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            // Record when the data was last refreshed so the UI can show it.
            const meta = [
                ["cards_updated_at", new Date().toISOString()],
                ["cards_count", String(cardCount)],
                ["source_updated_at", defaultItem.updated_at || ""],
            ];
            await pool.query(
                "INSERT INTO meta (k, v) VALUES ? ON DUPLICATE KEY UPDATE v = VALUES(v)",
                [meta]
            );

            send("ok", "Import complete! " + cardCount + " cards imported in " + elapsed + "s.");

            // 6. Clean up the downloaded file
            fs.unlink(destPath, () => {});
            send("info", "Temp file cleaned up.");
        } catch (err) {
            job.error = err.message || "Import failed";
            send("error", "Import failed: " + job.error);
            console.error("Admin import error:", err);
        } finally {
            job.running = false;
            job.done = true;
        }
    })();
}

/**
 * POST /admin/import
 * Kick off a background import of the latest "default_cards" bulk data.
 * Returns immediately; progress is polled via GET /admin/import/status.
 */
app.post("/admin/import", requireAdmin, (_req, res) => {
    if (importJob && importJob.running) {
        return res.json({ started: false, alreadyRunning: true });
    }
    startImportJob();
    res.json({ started: true });
});

/**
 * GET /admin/import/status?since=N
 * Return the current job state plus any log entries with index >= N, so the
 * client can fetch only what it hasn't seen yet.
 */
app.get("/admin/import/status", requireAdmin, (req, res) => {
    if (!importJob) {
        return res.json({ running: false, done: false, error: null, log: [], nextIndex: 0 });
    }
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    const log = importJob.log.slice(since);
    res.json({
        running: importJob.running,
        done: importJob.done,
        error: importJob.error,
        log,
        nextIndex: since + log.length,
    });
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.use((err, req, res, _next) => {
    console.error(`${new Date().toISOString()} ERROR ${req.method} ${req.originalUrl} -`, err);
    sendError(res, 500, err.message || "Internal server error");
});

// Surface otherwise-invisible failures in the logs. An uncaught exception
// leaves the process in an undefined state, so we log and exit — the container
// restart policy brings it back cleanly.
process.on("unhandledRejection", (reason) => {
    console.error(`${new Date().toISOString()} UNHANDLED REJECTION -`, reason);
});
process.on("uncaughtException", (err) => {
    console.error(`${new Date().toISOString()} UNCAUGHT EXCEPTION -`, err);
    process.exit(1);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
    console.log(`${new Date().toISOString()} SurveilFall server listening on http://localhost:${PORT}`);
});
