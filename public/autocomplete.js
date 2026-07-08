/* ------------------------------------------------------------------ */
/* Autocomplete for search inputs                                     */
/* Fetches suggestions from /cards/autocomplete. Tab to accept.       */
/* ------------------------------------------------------------------ */

var Autocomplete = (function () {
    var activeInput = null;
    var activeDropdown = null;
    var activeIndex = -1;
    var activeSuggestions = [];
    var debounceTimer = null;

    function createDropdown(input) {
        var dropdown = document.createElement("div");
        dropdown.className = "autocomplete-dropdown";
        dropdown.style.position = "absolute";
        dropdown.style.zIndex = "300";
        // Position below the input
        var rect = input.getBoundingClientRect();
        dropdown.style.left = rect.left + "px";
        dropdown.style.top = (rect.bottom) + "px";
        dropdown.style.width = rect.width + "px";
        document.body.appendChild(dropdown);
        return dropdown;
    }

    function positionDropdown(input, dropdown) {
        var rect = input.getBoundingClientRect();
        dropdown.style.left = rect.left + "px";
        dropdown.style.top = (rect.bottom) + "px";
        dropdown.style.width = rect.width + "px";
    }

    function renderSuggestions(suggestions) {
        if (!activeDropdown) return;
        activeDropdown.innerHTML = "";

        if (suggestions.length === 0) {
            activeDropdown.classList.add("hidden");
            return;
        }

        activeDropdown.classList.remove("hidden");

        for (var i = 0; i < suggestions.length; i++) {
            var item = document.createElement("div");
            item.className = "autocomplete-item";
            item.textContent = suggestions[i].name;
            item.dataset.index = i;

            item.addEventListener("click", (function (suggestion) {
                return function () {
                    acceptSuggestion(suggestion);
                };
            })(suggestions[i]));

            item.addEventListener("mouseenter", function () {
                highlightItem(parseInt(this.dataset.index));
            });

            activeDropdown.appendChild(item);
        }

        activeIndex = -1;
    }

    function highlightItem(index) {
        if (!activeDropdown) return;
        var items = activeDropdown.querySelectorAll(".autocomplete-item");
        items.forEach(function (el, i) {
            el.classList.toggle("highlighted", i === index);
        });
        activeIndex = index;
    }

    function acceptSuggestion(suggestion) {
        if (!activeInput) return;
        hideDropdown();

        // Navigate directly to the card detail page if we have set info
        if (suggestion.set && suggestion.collector_number) {
            var slug = suggestion.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "");
            window.location.href = "/card/" + suggestion.set + "/" + suggestion.collector_number + "/" + slug;
        } else {
            // Fallback: fill input and submit the form
            activeInput.value = suggestion.name;
            var form = activeInput.closest("form");
            if (form) form.requestSubmit();
        }
    }

    function hideDropdown() {
        if (activeDropdown) {
            activeDropdown.classList.add("hidden");
            activeDropdown.innerHTML = "";
        }
        activeSuggestions = [];
        activeIndex = -1;
    }

    function fetchSuggestions(query) {
        if (query.length < 2) {
            if (activeDropdown) activeDropdown.classList.add("hidden");
            return;
        }

        var currentQuery = query;
        fetch("/cards/autocomplete?q=" + encodeURIComponent(query))
            .then(function (res) { return res.json(); })
            .then(function (body) {
                if (!activeInput) return;
                // Verify the input still starts with what we queried
                if (activeInput.value.trim().indexOf(currentQuery) !== 0) return;
                activeSuggestions = body.data || [];
                renderSuggestions(activeSuggestions);
                positionDropdown(activeInput, activeDropdown);
            })
            .catch(function () {
                // Silently fail
            });
    }

    function onInput(e) {
        var val = this.value.trim();

        if (debounceTimer) clearTimeout(debounceTimer);

        if (val.length < 2) {
            hideDropdown();
            return;
        }

        debounceTimer = setTimeout(function () {
            fetchSuggestions(val);
        }, 150);
    }

    function onKeyDown(e) {
        if (!activeDropdown || activeDropdown.classList.contains("hidden")) return;

        var items = activeDropdown.querySelectorAll(".autocomplete-item");

        if (e.key === "Tab") {
            if (activeIndex >= 0 && activeIndex < items.length) {
                e.preventDefault();
                var suggestion = activeSuggestions[activeIndex];
                acceptSuggestion(suggestion);
            }
            return;
        }

        if (e.key === "ArrowDown") {
            e.preventDefault();
            var next = activeIndex + 1;
            if (next >= items.length) next = 0;
            highlightItem(next);
            return;
        }

        if (e.key === "ArrowUp") {
            e.preventDefault();
            var prev = activeIndex - 1;
            if (prev < 0) prev = items.length - 1;
            highlightItem(prev);
            return;
        }

        if (e.key === "Escape") {
            hideDropdown();
            return;
        }

        if (e.key === "Enter") {
            if (activeIndex >= 0 && activeIndex < items.length) {
                e.preventDefault();
                var suggestion = activeSuggestions[activeIndex];
                acceptSuggestion(suggestion);
            }
            return;
        }
    }

    function onBlur() {
        // Delay hiding so click on dropdown item registers first
        setTimeout(function () {
            hideDropdown();
        }, 200);
    }

    /** Attach autocomplete behavior to an input element */
    function attach(input) {
        // Create dropdown container
        var dropdown = createDropdown(input);
        dropdown.classList.add("hidden");

        // Store references
        input.addEventListener("focus", function () {
            activeInput = input;
            activeDropdown = dropdown;
            // Re-fetch suggestions for the current value
            var val = input.value.trim();
            if (val.length >= 2) {
                fetchSuggestions(val);
            } else if (activeSuggestions.length > 0) {
                // If there are existing suggestions, keep showing them
                renderSuggestions(activeSuggestions);
                positionDropdown(input, dropdown);
            }
        });

        input.addEventListener("input", onInput);
        input.addEventListener("keydown", onKeyDown);
        input.addEventListener("blur", onBlur);

        // Clean up on window resize
        window.addEventListener("resize", function () {
            if (activeInput === input && activeDropdown) {
                positionDropdown(input, dropdown);
            }
        });
    }

    return {
        attach: attach
    };
})();
