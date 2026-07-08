const https = require("https");
const fs = require("fs");
const path = require("path");

process.loadEnvFile();

const BULK_DATA_URL = "https://api.scryfall.com/bulk-data";
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

const REQUEST_HEADERS = {
    "User-Agent": process.env.USER_AGENT || "SurveilFall/1.0",
    "Accept": "application/json",
};

/**
 * Fetch JSON from a URL via HTTPS GET.
 */
function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https
            .get(url, { headers: REQUEST_HEADERS, timeout: 30_000 }, (res) => {
                let body = "";
                res.on("data", (chunk) => (body += chunk));
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (err) {
                        reject(new Error(`Failed to parse JSON from ${url}: ${err.message}`));
                    }
                });
            })
            .on("error", reject)
            .on("timeout", function () {
                this.destroy();
                reject(new Error(`Timeout fetching ${url}`));
            });
    });
}

/**
 * Download a file from `url` to `destPath` using HTTPS GET.
 * Returns the destination path on success.
 */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https
            .get(url, { headers: REQUEST_HEADERS, timeout: 300_000 }, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
                    return;
                }
                res.pipe(file);
                file.on("finish", () => {
                    file.close();
                    resolve(destPath);
                });
            })
            .on("error", (err) => {
                file.close();
                fs.unlink(destPath, () => {});
                reject(err);
            })
            .on("timeout", function () {
                this.destroy();
                file.close();
                fs.unlink(destPath, () => {});
                reject(new Error(`Timeout downloading ${url}`));
            });
    });
}

/**
 * Given a Scryfall bulk-data item, derive a local filename from the
 * download_uri (e.g. "oracle-cards-20260609090224.json").
 */
function localFilename(item) {
    return path.basename(new URL(item.download_uri).pathname);
}

async function main() {
    // 1. Ensure downloads directory exists
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

    // 2. Fetch the list of available bulk data sets
    console.log("Fetching available bulk data from Scryfall…");
    const catalog = await fetchJSON(BULK_DATA_URL);
    if (catalog.object === "error") {
        console.error("Scryfall API error:", catalog.details);
        process.exit(1);
    }
    const items = catalog.data;

    console.log(`Found ${items.length} bulk data sets.\n`);

    // 3. Check each one and download if missing or size mismatch
    for (const item of items) {
        const filename = localFilename(item);
        const destPath = path.join(DOWNLOADS_DIR, filename);
        const expectedSize = item.size;

        if (fs.existsSync(destPath)) {
            const diskSize = fs.statSync(destPath).size;
            const ratio = diskSize / expectedSize;
            if (ratio >= 0.95 && ratio <= 1.05) {
                console.log(`[SKIP]  ${item.type} — ${filename} (size within 5%)`);
                continue;
            }
            console.log(`[REPL]  ${item.type} — ${filename} (disk ${diskSize} vs expected ${expectedSize}, ratio ${ratio.toFixed(3)})`);
            fs.unlinkSync(destPath);
        }

        console.log(`[DL]    ${item.type} — ${filename} (${(expectedSize / 1e6).toFixed(1)} MB)`);
        try {
            await downloadFile(item.download_uri, destPath);
            console.log(`[DONE]  ${item.type}`);
        } catch (err) {
            console.error(`[FAIL]  ${item.type}: ${err.message}`);
        }
    }

    console.log("\nAll done.");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
