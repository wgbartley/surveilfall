/* ------------------------------------------------------------------ */
/* Card detail page                                                   */
/* ------------------------------------------------------------------ */

(function () {
    var loadingEl = document.getElementById("card-loading");
    var contentEl = document.getElementById("card-content");
    var notFoundEl = document.getElementById("card-not-found");
    var cardDetail = document.getElementById("card-detail");

    // If no card data is embedded, this is the search page — do nothing.
    if (!CARD_DATA) {
        return;
    }

    // This is a card detail view — hide search results UI, show card detail
    var resultsHeader = document.getElementById("results-header");
    var cardGrid = document.getElementById("card-grid");
    var noResults = document.getElementById("no-results");
    if (resultsHeader) resultsHeader.classList.add("hidden");
    if (cardGrid) cardGrid.classList.add("hidden");
    if (noResults) noResults.classList.add("hidden");
    cardDetail.classList.remove("hidden");

    renderCard(CARD_DATA);

    /* -------------------------------------------------------------- */
    /* Helpers                                                        */
    /* -------------------------------------------------------------- */

    function manaSymbols(manaCost) {
        if (!manaCost) return "";
        return manaCost.replace(/\{([^}]+)\}/g, function (_, sym) {
            var colors = {
                W: "#f8e3a0",
                U: "#a0c8f0",
                B: "#a0a0a0",
                R: "#f0a080",
                G: "#80c080",
            };
            var color = colors[sym] || "#c0c0c0";
            return (
                '<span style="display:inline-block;width:1.2em;height:1.2em;border-radius:50%;background:' +
                color +
                ";text-align:center;line-height:1.2;font-size:0.8em;font-weight:700;color:#1a1a2e;margin:0 1px\">" +
                sym +
                "</span>"
            );
        });
    }

    function cardImageUrl(card, size) {
        size = size || "large";
        if (card.image_uris && card.image_uris[size]) {
            return card.image_uris[size];
        }
        if (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris) {
            return card.card_faces[0].image_uris[size];
        }
        return null;
    }

    function slugify(name) {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
    }

    /* -------------------------------------------------------------- */
    /* Render                                                         */
    /* -------------------------------------------------------------- */

    function renderCard(card) {
        loadingEl.classList.add("hidden");
        contentEl.classList.remove("hidden");

        var imgUrl = cardImageUrl(card, "large") || cardImageUrl(card, "normal");

        // Build the image column
        var imageCol = document.createElement("div");
        imageCol.className = "card-image-column";

        if (imgUrl) {
            var img = document.createElement("img");
            img.className = "card-art";
            img.src = imgUrl;
            img.alt = card.name;
            imageCol.appendChild(img);
        } else {
            var placeholder = document.createElement("div");
            placeholder.className = "card-art-placeholder";
            placeholder.textContent = "No image";
            imageCol.appendChild(placeholder);
        }

        // Build the info column — contains details + printings sidebar
        var infoCol = document.createElement("div");
        infoCol.className = "card-info-column";

        // --- Card details (left sub-column) ---
        var detailsCol = document.createElement("div");
        detailsCol.className = "card-details";

        // Name
        var nameEl = document.createElement("div");
        nameEl.className = "card-name";
        nameEl.textContent = card.name;
        detailsCol.appendChild(nameEl);

        // Mana cost
        if (card.mana_cost) {
            var manaEl = document.createElement("div");
            manaEl.className = "card-mana-cost";
            manaEl.innerHTML = manaSymbols(card.mana_cost);
            detailsCol.appendChild(manaEl);
        }

        // Type line
        if (card.type_line) {
            var typeEl = document.createElement("div");
            typeEl.className = "card-type-line";
            typeEl.textContent = card.type_line;
            detailsCol.appendChild(typeEl);
        }

        // Set info
        var setInfo = document.createElement("div");
        setInfo.className = "card-set-info";
        setInfo.innerHTML =
            '<a href="/card/' +
            card.set +
            "/" +
            card.collector_number +
            "/" +
            slugify(card.name) +
            '">' +
            card.set_name +
            " (" +
            card.set.toUpperCase() +
            ") #" +
            card.collector_number +
            " · " +
            (card.rarity || "common") +
            "</a>";
        detailsCol.appendChild(setInfo);

        // Text box (oracle text + flavor)
        var textBox = document.createElement("div");
        textBox.className = "card-text-box";

        if (card.oracle_text) {
            var oracleEl = document.createElement("div");
            oracleEl.className = "oracle-text";
            oracleEl.textContent = card.oracle_text;
            textBox.appendChild(oracleEl);
        }

        if (card.flavor_text) {
            var flavorEl = document.createElement("div");
            flavorEl.className = "flavor-text";
            flavorEl.textContent = card.flavor_text;
            textBox.appendChild(flavorEl);
        }

        detailsCol.appendChild(textBox);

        // Stats (power/toughness/loyalty/cmc)
        var statsEl = document.createElement("div");
        statsEl.className = "card-stats";

        if (card.cmc !== undefined && card.cmc !== null) {
            var cmcSpan = document.createElement("span");
            cmcSpan.textContent = "CMC: " + card.cmc;
            statsEl.appendChild(cmcSpan);
        }

        if (card.power !== undefined && card.power !== null && card.power !== "") {
            var ptSpan = document.createElement("span");
            ptSpan.textContent = card.power + "/" + (card.toughness || "?");
            statsEl.appendChild(ptSpan);
        }

        if (card.loyalty !== undefined && card.loyalty !== null) {
            var loySpan = document.createElement("span");
            loySpan.textContent = "Loyalty: " + card.loyalty;
            statsEl.appendChild(loySpan);
        }

        if (statsEl.children.length > 0) {
            detailsCol.appendChild(statsEl);
        }

        // Artist
        if (card.artist) {
            var artistEl = document.createElement("div");
            artistEl.className = "card-artist";
            artistEl.innerHTML =
                'Illustrated by <a href="/search?q=a:' +
                encodeURIComponent('"' + card.artist + '"') +
                '">' +
                card.artist +
                "</a>";
            detailsCol.appendChild(artistEl);
        }

        // Add-to-list buttons — only show finishes the card supports
        var finishes = card.finishes || ["nonfoil"];
        var listActions = document.createElement("div");
        listActions.className = "card-list-actions";

        if (finishes.indexOf("nonfoil") !== -1) {
            var addBtn = document.createElement("button");
            addBtn.className = "card-list-add-btn";
            addBtn.textContent = "Add to List";
            addBtn.addEventListener("click", function () {
                CardList.add(card, false);
                updateListBadge();
                renderListPanel();
                listBody.classList.remove("hidden");
                listToggle.textContent = "\u25bc";
                addBtn.textContent = "\u2713 Added";
                setTimeout(function () { addBtn.textContent = "Add to List"; }, 1500);
            });
            listActions.appendChild(addBtn);
        }

        if (finishes.indexOf("foil") !== -1) {
            var addFoilBtn = document.createElement("button");
            addFoilBtn.className = "card-list-add-btn foil";
            addFoilBtn.textContent = "Add Foil";
            addFoilBtn.addEventListener("click", function () {
                CardList.add(card, true);
                updateListBadge();
                renderListPanel();
                listBody.classList.remove("hidden");
                listToggle.textContent = "\u25bc";
                addFoilBtn.textContent = "\u2713 Added";
                setTimeout(function () { addFoilBtn.textContent = "Add Foil"; }, 1500);
            });
            listActions.appendChild(addFoilBtn);
        }

        detailsCol.appendChild(listActions);

        infoCol.appendChild(detailsCol);

        // --- Printings sidebar (right sub-column) ---
        if (PRINTS_DATA && PRINTS_DATA.length > 1) {
            var sidebar = document.createElement("div");
            sidebar.className = "card-printings-sidebar";

            var sidebarTitle = document.createElement("h3");
            sidebarTitle.textContent = "Printings (" + PRINTS_DATA.length + ")";
            sidebar.appendChild(sidebarTitle);

            // Filters
            var filterDiv = document.createElement("div");
            filterDiv.className = "printings-filters";

            var setFilter = document.createElement("input");
            setFilter.type = "text";
            setFilter.className = "print-filter";
            setFilter.placeholder = "Set name…";
            filterDiv.appendChild(setFilter);

            var codeFilter = document.createElement("input");
            codeFilter.type = "text";
            codeFilter.className = "print-filter";
            codeFilter.placeholder = "Code…";
            filterDiv.appendChild(codeFilter);

            var numFilter = document.createElement("input");
            numFilter.type = "text";
            numFilter.className = "print-filter";
            numFilter.placeholder = "#…";
            filterDiv.appendChild(numFilter);

            sidebar.appendChild(filterDiv);

            // Table
            var table = document.createElement("table");
            table.className = "printings-table";

            var thead = document.createElement("thead");
            var headerRow = document.createElement("tr");
            ["Set", "Code", "#"].forEach(function (label) {
                var th = document.createElement("th");
                th.textContent = label;
                headerRow.appendChild(th);
            });
            thead.appendChild(headerRow);
            table.appendChild(thead);

            var tbody = document.createElement("tbody");
            table.appendChild(tbody);
            sidebar.appendChild(table);

            // Render rows
            function renderPrintings() {
                var qSet = setFilter.value.toLowerCase().trim();
                var qCode = codeFilter.value.toLowerCase().trim();
                var qNum = numFilter.value.toLowerCase().trim();

                tbody.innerHTML = "";

                for (var p = 0; p < PRINTS_DATA.length; p++) {
                    var print = PRINTS_DATA[p];

                    // Apply filters
                    if (qSet && !print.set_name.toLowerCase().includes(qSet)) continue;
                    if (qCode && !print.set.toLowerCase().includes(qCode)) continue;
                    if (qNum && !print.collector_number.replace(/^0+/, "").toLowerCase().includes(qNum.replace(/^0+/, ""))) continue;

                    var tr = document.createElement("tr");
                    if (print.id === card.id) {
                        tr.className = "active";
                    }

                    var setTd = document.createElement("td");
                    setTd.className = "print-set-name";
                    setTd.textContent = print.set_name;
                    tr.appendChild(setTd);

                    var codeTd = document.createElement("td");
                    codeTd.className = "print-set-code";
                    codeTd.textContent = print.set.toUpperCase();
                    tr.appendChild(codeTd);

                    var numTd = document.createElement("td");
                    numTd.className = "print-number";
                    numTd.textContent = print.collector_number;
                    tr.appendChild(numTd);

                    tr.addEventListener("click", (function (p) {
                        return function () {
                            window.location.href =
                                "/card/" + p.set + "/" + p.collector_number + "/" + slugify(p.name);
                        };
                    })(print));

                    tbody.appendChild(tr);
                }
            }

            // Filter on input
            setFilter.addEventListener("input", renderPrintings);
            codeFilter.addEventListener("input", renderPrintings);
            numFilter.addEventListener("input", renderPrintings);

            renderPrintings();

            infoCol.appendChild(sidebar);
        }

        // Assemble
        contentEl.appendChild(imageCol);
        contentEl.appendChild(infoCol);

        // Update page title
        document.title = "SurveilFall — " + card.name;
    }

    /* -------------------------------------------------------------- */
    /* Card list panel                                                */
    /* -------------------------------------------------------------- */

    var listPanel = document.getElementById("list-panel");
    var listToggle = document.getElementById("list-toggle");
    var listBody = document.getElementById("list-body");
    var listCount = document.getElementById("list-count");
    var listEntries = document.getElementById("list-entries");
    var listExportBtn = document.getElementById("list-export-btn");
    var listClearBtn = document.getElementById("list-clear-btn");
    var listExportText = document.getElementById("list-export-text");

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
            qtySpan.textContent = entry.qty + "\u00d7";
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
            removeBtn.textContent = "\u2212";
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

    listToggle.addEventListener("click", function () {
        var isHidden = listBody.classList.toggle("hidden");
        listToggle.textContent = isHidden ? "\u25b6" : "\u25bc";
    });

    listExportBtn.addEventListener("click", function () {
        var text = CardList.exportText();
        listExportText.value = text;
        listExportText.classList.remove("hidden");
        listExportText.select();
    });

    updateListBadge();

    // Attach autocomplete to the search input in the header
    var searchInput = document.querySelector(".site-header .search-bar input");
    if (searchInput) {
        Autocomplete.attach(searchInput);
    }
})();
