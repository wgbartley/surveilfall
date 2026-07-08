/* ------------------------------------------------------------------ */
/* Client-side card list                                              */
/* Stores card entries in localStorage. Each entry has:
/*   - card: the full Scryfall card object
/*   - foil: boolean
/*   - qty: number
/* ------------------------------------------------------------------ */

var CardList = (function () {
    var STORAGE_KEY = "surveilfall_card_list";

    function load() {
        try {
            var data = localStorage.getItem(STORAGE_KEY);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            return [];
        }
    }

    function save(list) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    }

    // Returns the index of an existing entry matching card id + foil status, or -1
    function findIndex(list, cardId, foil) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].card.id === cardId && list[i].foil === !!foil) {
                return i;
            }
        }
        return -1;
    }

    return {
        /** Get all entries */
        getAll: function () {
            return load();
        },

        /** Add a card (or increment qty if same card+foil already in list) */
        add: function (card, foil) {
            foil = !!foil;
            var list = load();
            var idx = findIndex(list, card.id, foil);
            if (idx !== -1) {
                list[idx].qty += 1;
            } else {
                list.push({ card: card, foil: foil, qty: 1 });
            }
            save(list);
        },

        /** Remove one qty (or entire entry if qty reaches 0) */
        remove: function (cardId, foil) {
            foil = !!foil;
            var list = load();
            var idx = findIndex(list, cardId, foil);
            if (idx !== -1) {
                list[idx].qty -= 1;
                if (list[idx].qty <= 0) {
                    list.splice(idx, 1);
                }
                save(list);
            }
        },

        /** Remove all entries */
        clear: function () {
            localStorage.removeItem(STORAGE_KEY);
        },

        /** Get total number of entries (unique card+foil combos) */
        count: function () {
            return load().length;
        },

        /** Get total quantity across all entries */
        totalQty: function () {
            var list = load();
            var total = 0;
            for (var i = 0; i < list.length; i++) {
                total += list[i].qty;
            }
            return total;
        },

        /** Export list as text lines: {Qty} {CardName} ({SetAbbrev}) {F} */
        exportText: function () {
            var list = load();
            var lines = [];
            for (var i = 0; i < list.length; i++) {
                var entry = list[i];
                var c = entry.card;
                var line = entry.qty + " " + c.name + " (" + c.set.toUpperCase() + ")";
                if (entry.foil) {
                    line += " F";
                }
                lines.push(line);
            }
            return lines.join("\n");
        }
    };
})();
