/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

let currentQuery = "";
let currentOrder = "name";
let currentView = "grid";

/* ------------------------------------------------------------------ */
/* DOM refs                                                           */
/* ------------------------------------------------------------------ */

const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const cardGrid = document.getElementById("card-grid");
const resultsHeader = document.getElementById("results-header");
const resultCount = document.getElementById("result-count");
const sortSelect = document.getElementById("sort-select");
const loadingEl = document.getElementById("loading");
const noResultsEl = document.getElementById("no-results");
const viewGridBtn = document.getElementById("view-grid");
const viewListBtn = document.getElementById("view-list");

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function manaSymbols(manaCost) {
    if (!manaCost) return "";
    // Convert {W}{U}{B}{R}{G} etc. to colored circles
    return manaCost.replace(/\{([^}]+)\}/g, (_, sym) => {
        const colors = {
            W: "#f8e3a0",
            U: "#a0c8f0",
            B: "#a0a0a0",
            R: "#f0a080",
            G: "#80c080",
        };
        const color = colors[sym] || "#c0c0c0";
        return `<span style="display:inline-block;width:1.1em;height:1.1em;border-radius:50%;background:${color};text-align:center;line-height:1.1;font-size:0.75em;font-weight:700;color:#1a1a2e;margin:0 1px">${sym}</span>`;
    });
}

function cardImageUrl(card) {
    if (card.image_uris && card.image_uris.small) {
        return card.image_uris.small;
    }
    // Double-faced cards store images in card_faces
    if (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris) {
        return card.card_faces[0].image_uris.small;
    }
    return null;
}

function cardTypeLine(card) {
    return card.type_line || "";
}

function cardName(card) {
    return card.name || "Unknown";
}

function slugify(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

function cardPageUrl(card) {
    return "/card/" + card.set + "/" + card.collector_number + "/" + slugify(card.name);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

function renderCards(cards) {
    cardGrid.innerHTML = "";

    if (cards.length === 0) {
        noResultsEl.classList.remove("hidden");
        resultsHeader.classList.add("hidden");
        return;
    }

    noResultsEl.classList.add("hidden");
    resultsHeader.classList.remove("hidden");
    resultCount.textContent = `${cards.length} card${cards.length !== 1 ? "s" : ""} found`;

    cardGrid.className = "card-grid" + (currentView === "list" ? " list-view" : "");

    for (const card of cards) {
        const imgUrl = cardImageUrl(card);
        const el = document.createElement("div");
        el.className = "card-item";

        if (imgUrl) {
            const img = document.createElement("img");
            img.className = "card-image";
            img.src = imgUrl;
            img.alt = cardName(card);
            img.loading = "lazy";
            el.appendChild(img);
        } else {
            const placeholder = document.createElement("div");
            placeholder.className = "card-image-placeholder";
            placeholder.textContent = "No image";
            el.appendChild(placeholder);
        }

        const info = document.createElement("div");
        info.className = "card-info";

        const nameEl = document.createElement("div");
        nameEl.className = "card-name";
        nameEl.textContent = cardName(card);
        info.appendChild(nameEl);

        const typeEl = document.createElement("div");
        typeEl.className = "card-type";
        typeEl.textContent = cardTypeLine(card);
        info.appendChild(typeEl);

        if (card.mana_cost) {
            const manaEl = document.createElement("div");
            manaEl.className = "card-mana";
            manaEl.innerHTML = manaSymbols(card.mana_cost);
            info.appendChild(manaEl);
        }

        // Set info
        const setEl = document.createElement("div");
        setEl.className = "card-set-line";
        setEl.textContent = card.set_name + " (" + card.set.toUpperCase() + ") #" + card.collector_number;
        info.appendChild(setEl);

        el.appendChild(info);

        // Add-to-list button
        var listBtn = document.createElement("button");
        listBtn.className = "card-list-btn";
        listBtn.textContent = "+ List";
        listBtn.title = "Add to card list";
        listBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            CardList.add(card, false);
            updateListBadge();
            renderListPanel();
            // Auto-expand the panel
            listBody.classList.remove("hidden");
            listToggle.textContent = "▼";
            listBtn.textContent = "✓ Added";
            setTimeout(function () { listBtn.textContent = "+ List"; }, 1500);
        });
        el.appendChild(listBtn);

        // Click to open local card detail page
        el.addEventListener("click", () => {
            window.location.href = cardPageUrl(card);
        });

        cardGrid.appendChild(el);
    }
}

/* ------------------------------------------------------------------ */
/* Fetching                                                           */
/* ------------------------------------------------------------------ */

async function searchCards(query, order) {
    loadingEl.classList.remove("hidden");
    resultsHeader.classList.add("hidden");
    noResultsEl.classList.add("hidden");
    cardGrid.innerHTML = "";

    try {
        const params = new URLSearchParams({ q: query, order });
        const res = await fetch(`/cards/search?${params}`);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const body = await res.json();
        if (body.object === "redirect") {
            window.location.href = body.redirect;
            return;
        }
        renderCards(body.data || []);
    } catch (err) {
        console.error("Search failed:", err);
        cardGrid.innerHTML = `<div class="no-results"><h2>Search failed</h2><p>${err.message}</p></div>`;
    } finally {
        loadingEl.classList.add("hidden");
    }
}

/* ------------------------------------------------------------------ */
/* Event handlers                                                     */
/* ------------------------------------------------------------------ */

searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;
    currentQuery = q;
    currentOrder = sortSelect.value;
    // Update URL without reload
    const url = new URL(window.location);
    url.searchParams.set("q", q);
    url.searchParams.set("order", currentOrder);
    window.history.pushState({}, "", url);
    searchCards(currentQuery, currentOrder);
});

sortSelect.addEventListener("change", () => {
    currentOrder = sortSelect.value;
    if (currentQuery) {
        searchCards(currentQuery, currentOrder);
    }
});

viewGridBtn.addEventListener("click", () => {
    currentView = "grid";
    viewGridBtn.classList.add("active");
    viewListBtn.classList.remove("active");
    cardGrid.className = "card-grid";
});

viewListBtn.addEventListener("click", () => {
    currentView = "list";
    viewListBtn.classList.add("active");
    viewGridBtn.classList.remove("active");
    cardGrid.className = "card-grid list-view";
});

/* ------------------------------------------------------------------ */
/* Card list panel                                                    */
/* ------------------------------------------------------------------ */

const listPanel = document.getElementById("list-panel");
const listToggle = document.getElementById("list-toggle");
const listBody = document.getElementById("list-body");
const listCount = document.getElementById("list-count");
const listEntries = document.getElementById("list-entries");
const listExportBtn = document.getElementById("list-export-btn");
const listClearBtn = document.getElementById("list-clear-btn");
const listExportText = document.getElementById("list-export-text");

function updateListBadge() {
    var total = CardList.totalQty();
    listCount.textContent = total;
}

function renderListPanel() {
    var entries = CardList.getAll();
    listEntries.innerHTML = "";

    if (entries.length === 0) {
        listEntries.innerHTML = '<div class="list-empty">List is empty.</div>';
        return;
    }

    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var c = entry.card;
        var div = document.createElement("div");
        div.className = "list-entry";

        var qtySpan = document.createElement("span");
        qtySpan.className = "list-entry-qty";
        qtySpan.textContent = entry.qty + "×";
        div.appendChild(qtySpan);

        var nameSpan = document.createElement("span");
        nameSpan.className = "list-entry-name";
        nameSpan.textContent = c.name;
        div.appendChild(nameSpan);

        var setSpan = document.createElement("span");
        setSpan.className = "list-entry-set";
        setSpan.textContent = "(" + c.set.toUpperCase() + ")";
        div.appendChild(setSpan);

        if (entry.foil) {
            var foilSpan = document.createElement("span");
            foilSpan.className = "list-entry-foil";
            foilSpan.textContent = "F";
            div.appendChild(foilSpan);
        }

        var removeBtn = document.createElement("button");
        removeBtn.className = "list-entry-remove";
        removeBtn.textContent = "−";
        removeBtn.title = "Remove one";
        removeBtn.addEventListener("click", (function (id, foil) {
            return function () {
                CardList.remove(id, foil);
                renderListPanel();
                updateListBadge();
            };
        })(c.id, entry.foil));
        div.appendChild(removeBtn);

        listEntries.appendChild(div);
    }
}

// Toggle panel body
listToggle.addEventListener("click", function () {
    var isHidden = listBody.classList.toggle("hidden");
    listToggle.textContent = isHidden ? "▶" : "▼";
});

// Export
listExportBtn.addEventListener("click", function () {
    var text = CardList.exportText();
    listExportText.value = text;
    listExportText.classList.remove("hidden");
    listExportText.select();
});

// Clear
listClearBtn.addEventListener("click", function () {
    if (confirm("Clear the entire card list?")) {
        CardList.clear();
        renderListPanel();
        updateListBadge();
        listExportText.classList.add("hidden");
    }
});

// Init badge
updateListBadge();

// Attach autocomplete to the search input
Autocomplete.attach(searchInput);

/* ------------------------------------------------------------------ */
/* Init — restore search from URL params on page load                 */
/* ------------------------------------------------------------------ */

const urlParams = new URLSearchParams(window.location.search);
const qParam = urlParams.get("q");
const orderParam = urlParams.get("order");

if (qParam) {
    searchInput.value = qParam;
    currentQuery = qParam;
    if (orderParam) {
        sortSelect.value = orderParam;
        currentOrder = orderParam;
    }
    searchCards(currentQuery, currentOrder);
}
