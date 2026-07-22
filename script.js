(function() {
var STORE_KEY = 'shinyTracker.v1';
var state = load();
function load() {
var s = null;
try {
var raw = localStorage.getItem(STORE_KEY);
if (raw) s = JSON.parse(raw);
} catch (e) {}
if (!s) s = {
hunts: [],
collection: []
};
if (!s.livingDex) s.livingDex = {};
if (!s.livingDexShiny) s.livingDexShiny = {};
if (!s.lastHuntPrefs) s.lastHuntPrefs = null;
return s;
}
function save() {
try {
localStorage.setItem(STORE_KEY, JSON.stringify(state));
} catch (e) {}
pushToCloud();
}
// Cross-device sync via Firestore. This is a single shared document (no
// login/auth - this is a personal hobby app, not multi-user), so the
// Firestore security rules need to allow read/write on this doc without
// auth. The cloud copy is treated as the source of truth once it exists:
// on load we pull it down and overwrite local state; if it doesn't exist
// yet (first time wiring this up), we push whatever's in localStorage up
// as the initial baseline. Every save() also pushes up (debounced) so
// other devices pick up changes next time they load.
var db = null;
try {
if (window.firebase && firebase.apps && firebase.apps.length) {
db = firebase.firestore();
}
} catch (e) {
console.error('Firestore unavailable', e);
}
var CLOUD_DOC = db ? db.collection('shinyTracker').doc('mydata') : null;
var _cloudSaveTimer = null;
function pushToCloud() {
if (!CLOUD_DOC) return;
clearTimeout(_cloudSaveTimer);
_cloudSaveTimer = setTimeout(function() {
CLOUD_DOC.set({
payload: JSON.stringify(state),
updatedAt: Date.now()
}).catch(function(e) {
console.error('Firestore save failed', e);
});
}, 600);
}
function syncFromCloud() {
if (!CLOUD_DOC) return;
CLOUD_DOC.onSnapshot(function(doc) {
if (!doc.exists) {
// No cloud doc yet - seed it with whatever's currently local.
pushToCloud();
return;
}
// A write we just made locally echoes back through this listener before
// it's confirmed by the server (hasPendingWrites). Our local state
// already reflects that write, so skip re-applying it to avoid clobbering
// anything the person is doing right this moment (e.g. mid-typing).
if (doc.metadata.hasPendingWrites) return;
var data = doc.data();
if (!data || !data.payload) return;
try {
var remote = JSON.parse(data.payload);
if (!remote.livingDex) remote.livingDex = {};
if (!remote.livingDexShiny) remote.livingDexShiny = {};
if (!remote.lastHuntPrefs) remote.lastHuntPrefs = null;
state = remote;
localStorage.setItem(STORE_KEY, data.payload);
renderAll();
} catch (e) {
console.error('Failed to parse cloud data', e);
}
}, function(e) {
console.error('Firestore sync error', e);
});
}
var GAMES = ["Scarlet/Violet", "Legends Arceus", "Sword/Shield", "Let's Go Pikachu/Eevee",
"Ultra Sun/Ultra Moon", "Sun/Moon", "Omega Ruby/Alpha Sapphire", "X/Y",
"Black 2/White 2", "Black/White", "HeartGold/SoulSilver", "Platinum",
"Diamond/Pearl", "FireRed/LeafGreen", "Ruby/Sapphire/Emerald", "Pokémon GO", "Other"
];
// Custom per-game icon images for the catch-confirmation card (tcg-stats
// table "Game" row). Each entry lists the version(s) bundled into that
// game option, in images/game-symbols/<name>.jpg - gameIconMarkup() below
// renders one icon per name side by side. If a file is missing, its own
// onerror just hides that icon (the other version's icon still shows);
// if a game has no mapping at all it falls back to the generic cartridge
// glyph (ICON_GAME).
// NOTE: names below match what you gave me exactly for Scarlet/Violet,
// Legends Arceus, Sword/Shield, Ultra Sun/Ultra Moon, Sun/Moon, Omega
// Ruby/Alpha Sapphire, and X/Y. The rest (Let's Go, Black 2/White 2,
// Black/White, HeartGold/SoulSilver, Platinum, Diamond/Pearl, FireRed/
// LeafGreen, Ruby/Sapphire/Emerald, Pokémon GO) are my best guess at
// matching filenames in the same style - rename these lines to match
// whatever you actually saved the images as.
var GAME_ICONS = {
"Scarlet/Violet": ["scarlet", "violet"],
"Legends Arceus": ["arceus"],
"Sword/Shield": ["sword", "shield"],
"Let's Go Pikachu/Eevee": ["letsGoPikachu", "letsGoEevee"],
"Ultra Sun/Ultra Moon": ["ultraSun", "ultraMoon"],
"Sun/Moon": ["sun", "moon"],
"Omega Ruby/Alpha Sapphire": ["omegaRuby", "alphaSapphire"],
"X/Y": ["pokemonX", "pokemonY"],
"Black 2/White 2": ["black2", "white2"],
"Black/White": ["black", "white"],
"HeartGold/SoulSilver": ["heartGold", "soulSilver"],
"Platinum": ["platinum"],
"Diamond/Pearl": ["diamond", "pearl"],
"FireRed/LeafGreen": ["fireRed", "leafGreen"],
"Ruby/Sapphire/Emerald": ["ruby", "sapphire", "emerald"],
"Pokémon GO": ["pokemonGo"],
"Other": []
};
var METHODS = ["Random Encounter", "Soft Reset", "Masuda Method", "Chain Fishing",
"Poké Radar / DexNav Chain", "SOS Chaining", "Horde Hunting", "Friend Safari",
"Dynamax Adventure", "Ultra Wormhole", "Outbreak (Mass/Massive)", "Egg / Breeding",
"Max Raid Battle", "Static Encounter", "Other"
];
/* ---------- odds auto-assignment ----------
Base odds depend on which game the hunt is in.
Method then modifies that base rate (chaining, breeding boosts, etc).
These are the commonly cited community figures - approximations
where a method's real odds vary run-to-run (chains, raids, events). */
var GAME_BASE_ODDS = {
"Scarlet/Violet": 4096,
"Legends Arceus": 4096,
"Sword/Shield": 4096,
"Let's Go Pikachu/Eevee": 4096,
"Ultra Sun/Ultra Moon": 4096,
"Sun/Moon": 4096,
"Omega Ruby/Alpha Sapphire": 4096,
"X/Y": 4096,
"Black 2/White 2": 8192,
"Black/White": 8192,
"HeartGold/SoulSilver": 8192,
"Platinum": 8192,
"Diamond/Pearl": 8192,
"FireRed/LeafGreen": 8192,
"Ruby/Sapphire/Emerald": 8192,
"Pokémon GO": 512,
"Other": 4096
};
// Each rule is a function(baseDenom) -> denom. Most methods just pass the
// game's base rate through; a few (chaining, raids, breeding boosts) use
// their own commonly-cited flat rate or scale off the base rate.
var METHOD_ODDS_RULES = {
"Random Encounter": function(base) {
return base;
},
"Soft Reset": function(base) {
return base;
},
"Static Encounter": function(base) {
return base;
},
"Egg / Breeding": function(base) {
return base;
},
"Masuda Method": function(base) {
return base >= 8192 ? Math.round(base / 5) : Math.round(base / 6);
},
"Chain Fishing": function() {
return 200;
},
"Poké Radar / DexNav Chain": function() {
return 100;
},
"SOS Chaining": function() {
return 315;
},
"Horde Hunting": function(base) {
return base;
},
"Friend Safari": function() {
return 819;
},
"Dynamax Adventure": function() {
return 300;
},
"Ultra Wormhole": function(base) {
return base;
},
"Outbreak (Mass/Massive)": function() {
return 158;
},
"Max Raid Battle": function() {
return 300;
},
"Other": function(base) {
return base;
}
};
function computeOdds(game, method, hasCharm) {
var base = GAME_BASE_ODDS.hasOwnProperty(game) ? GAME_BASE_ODDS[game] : 4096;
var rule = METHOD_ODDS_RULES.hasOwnProperty(method) ? METHOD_ODDS_RULES[method] : function(b) {
return b;
};
var denom = Math.max(1, Math.round(rule(base)));
// Shiny Charm (Gen 6+ only, requires the item to actually exist in that
// game) adds extra shiny "rolls" to every encounter regardless of
// method - commonly summarized as "roughly triples your odds", so it's
// applied as a flat /3 on top of whatever the game+method already
// computed, matching the same rough-approximation style as the method
// rules above rather than a precise roll-count formula.
if (hasCharm && SHINY_CHARM_GAMES.indexOf(game) !== -1) {
denom = Math.max(1, Math.round(denom / 3));
}
return denom;
}
var SHINY_CHARM_GAMES = ["Scarlet/Violet", "Legends Arceus", "Sword/Shield",
"Let's Go Pikachu/Eevee", "Ultra Sun/Ultra Moon", "Sun/Moon",
"Omega Ruby/Alpha Sapphire", "X/Y", "Other"
];
var TYPE_COLORS = {
"Normal": "#A8A878",
"Fire": "#F08030",
"Water": "#6890F0",
"Electric": "#F8D030",
"Grass": "#78C850",
"Ice": "#98D8D8",
"Fighting": "#C03028",
"Poison": "#A040A0",
"Ground": "#E0C068",
"Flying": "#A890F0",
"Psychic": "#F85888",
"Bug": "#A8B820",
"Rock": "#B8A038",
"Ghost": "#705898",
"Dragon": "#7038F8",
"Dark": "#705848",
"Steel": "#B8B8D0",
"Fairy": "#EE99AC"
};
// Small glyph shown inside the type-colored energy/HP circles.
// Sword/Shield-style type icons, from PokeAPI's public sprite repo
// (file names are PokeAPI's type IDs: 1=Normal ... 18=Fairy).
var TYPE_ICON_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/types/generation-viii/sword-shield/";
var TYPE_ICON_IDS = {
"Normal": 1,
"Fighting": 2,
"Flying": 3,
"Poison": 4,
"Ground": 5,
"Rock": 6,
"Bug": 7,
"Ghost": 8,
"Steel": 9,
"Fire": 10,
"Water": 11,
"Grass": 12,
"Electric": 13,
"Psychic": 14,
"Ice": 15,
"Dragon": 16,
"Dark": 17,
"Fairy": 18
};
function typeIconUrl(type) {
var id = TYPE_ICON_IDS[type];
return id ? (TYPE_ICON_BASE + id + '.png') : null;
}
function typeIconMarkup(type, size) {
var url = typeIconUrl(type);
if (!url) return '';
size = size || 16;
return '<img src="' + url + '" alt="' + escapeHtml(type) + '" width="' + size + '" height="' + size + '" style="width:' + size + 'px;height:' + size + 'px;object-fit:contain;" loading="lazy" onerror="this.style.display=\'none\'">';
}
// Crops just the square symbol chip off the left edge of the SwSh pill icon
// (the pill is a 200x44 "[symbol][TYPE NAME]" image), auto-detects the
// glyph's own bounding box (the glyph is always drawn in near-white, so we
// scan for those pixels rather than trusting a fixed crop - different types
// sit in different spots inside that 44x44 square), and bakes a tightly
// cropped, centered version onto a small canvas so it always looks centered
// regardless of size. Results are cached per type since this only needs to
// run once per type per session.
var TYPE_ICON_CROPPED_CACHE = {};
var TYPE_ICON_CROP_SIZE = 44;
var TYPE_ICON_CANVAS_OUT = 120;
function getTypeIconCroppedUrl(type, onReady) {
if (!type) { onReady(null); return; }
if (TYPE_ICON_CROPPED_CACHE[type]) { onReady(TYPE_ICON_CROPPED_CACHE[type]); return; }
var url = typeIconUrl(type);
if (!url) { onReady(null); return; }
var img = new Image();
img.crossOrigin = 'anonymous';
img.onload = function() {
try {
var n = TYPE_ICON_CROP_SIZE;
var srcCanvas = document.createElement('canvas');
srcCanvas.width = n; srcCanvas.height = n;
var sctx = srcCanvas.getContext('2d');
sctx.drawImage(img, 0, 0, n, n, 0, 0, n, n);
var data = sctx.getImageData(0, 0, n, n).data;
var minX = n, maxX = -1, minY = n, maxY = -1;
for (var y = 0; y < n; y++) {
for (var x = 0; x < n; x++) {
var i = (y * n + x) * 4;
if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) {
if (x < minX) minX = x;
if (x > maxX) maxX = x;
if (y < minY) minY = y;
if (y > maxY) maxY = y;
}
}
}
if (maxX < 0) { minX = 0; minY = 0; maxX = n - 1; maxY = n - 1; }
var pad = 2;
minX = Math.max(0, minX - pad);
minY = Math.max(0, minY - pad);
maxX = Math.min(n - 1, maxX + pad);
maxY = Math.min(n - 1, maxY + pad);
var bw = maxX - minX + 1, bh = maxY - minY + 1;

// Extract just the glyph's pixels into their own bw x bh canvas, making
// everything that isn't near-white fully transparent - otherwise drawing
// the tight bounding-box rectangle wholesale (background pixels and all)
// onto our new colored disc shows up as a visible square patch.
var glyphCanvas = document.createElement('canvas');
glyphCanvas.width = bw; glyphCanvas.height = bh;
var gctx = glyphCanvas.getContext('2d');
gctx.drawImage(img, minX, minY, bw, bh, 0, 0, bw, bh);
var glyphData = gctx.getImageData(0, 0, bw, bh);
var gd = glyphData.data;
for (var p = 0; p < gd.length; p += 4) {
if (!(gd[p] > 200 && gd[p + 1] > 200 && gd[p + 2] > 200)) {
gd[p + 3] = 0;
}
}
gctx.putImageData(glyphData, 0, 0);

var out = TYPE_ICON_CANVAS_OUT;
var outCanvas = document.createElement('canvas');
outCanvas.width = out; outCanvas.height = out;
var octx = outCanvas.getContext('2d');
octx.fillStyle = TYPE_COLORS[type] || '#999';
octx.beginPath();
octx.arc(out / 2, out / 2, out / 2, 0, Math.PI * 2);
octx.fill();
var fitScale = (out * 0.62) / Math.max(bw, bh);
var dw = bw * fitScale, dh = bh * fitScale;
var dx = (out - dw) / 2, dy = (out - dh) / 2;
octx.drawImage(glyphCanvas, 0, 0, bw, bh, dx, dy, dw, dh);
var dataUrl = outCanvas.toDataURL('image/png');
TYPE_ICON_CROPPED_CACHE[type] = dataUrl;
onReady(dataUrl);
} catch (e) {
onReady(null);
}
};
img.onerror = function() { onReady(null); };
img.src = url;
}
// Renders a placeholder circle immediately (so layout doesn't jump), then
// hydrateTypeCircleIcons() swaps in the auto-cropped, centered icon once
// it's ready. Call hydrateTypeCircleIcons() on the containing element right
// after inserting markup built with this function.
function typeCircleMarkup(type, size) {
var url = typeIconUrl(type);
if (!url) return '';
size = size || 16;
var cached = TYPE_ICON_CROPPED_CACHE[type];
var inner = cached ? ('<img src="' + cached + '" alt="' + escapeHtml(type) + '" style="width:100%;height:100%;">') : '';
return '<span class="type-circle-icon" data-type-icon="' + escapeHtml(type) + '" title="' + escapeHtml(type) + '" style="width:' + size + 'px;height:' + size + 'px;">' + inner + '</span>';
}
function hydrateTypeCircleIcons(root) {
if (!root) return;
var spans = root.querySelectorAll('[data-type-icon]');
spans.forEach(function(span) {
if (span.querySelector('img')) return;
var type = span.getAttribute('data-type-icon');
getTypeIconCroppedUrl(type, function(dataUrl) {
if (!dataUrl) return;
span.innerHTML = '<img src="' + dataUrl + '" alt="' + escapeHtml(type) + '" style="width:100%;height:100%;">';
});
});
}
// Same cropped symbol chip as typeCircleMarkup, but with no circular
// frame/border/background — just the bare icon.
function typeChipMarkup(type, size) {
var url = typeIconUrl(type);
if (!url) return '';
size = size || 16;
return '<span class="type-chip-icon" title="' + escapeHtml(type) + '" style="width:' + size + 'px;height:' + size + 'px;background-image:url(\'' + url + '\');background-size:auto ' + size + 'px;"></span>';
}
var METHOD_UNITS = {
"Random Encounter": "encounters",
"Soft Reset": "soft resets",
"Masuda Method": "eggs hatched",
"Chain Fishing": "fishing encounters",
"Poké Radar / DexNav Chain": "chain encounters",
"SOS Chaining": "SOS Encounters",
"Horde Hunting": "hordes",
"Friend Safari": "Safari encounters",
"Dynamax Adventure": "adventures",
"Ultra Wormhole": "wormhole encounters",
"Outbreak (Mass/Massive)": "outbreak encounters",
"Egg / Breeding": "eggs hatched",
"Max Raid Battle": "raids",
"Static Encounter": "encounters",
"Other": "encounters"
};
function methodUnit(method) {
return METHOD_UNITS[method] || "encounters";
}
function speciesInfo(name) {
var info = SPECIES_INFO[normName(name)];
if (!info) return null;
return {
gen: info[0],
types: [info[1], info[2]].filter(Boolean)
};
}
function typeBadges(types, size) {
if (!types || !types.length) return '<span class="type-badge type-unknown">?</span>';
return types.map(function(t) {
return '<span class="type-badge-icon" title="' + t + '">' + typeIconMarkup(t, size || 63) + '</span>';
}).join('');
}
// Simplified single-type "weak against" table, in the spirit of the classic
// TCG's simplified weakness line (not the full 18-type damage chart).
var TYPE_WEAKNESS = {
"Normal": "Fighting", "Fire": "Water", "Water": "Electric", "Electric": "Ground",
"Grass": "Fire", "Ice": "Fire", "Fighting": "Flying", "Poison": "Psychic",
"Ground": "Water", "Flying": "Electric", "Psychic": "Dark", "Bug": "Fire",
"Rock": "Fighting", "Ghost": "Dark", "Dragon": "Ice", "Dark": "Fighting",
"Steel": "Fighting", "Fairy": "Steel"
};
function weaknessValue(types) {
var primary = types && types[0];
var weak = primary ? TYPE_WEAKNESS[primary] : null;
if (!weak) return '<span class="tcg-wrr-value">None</span>';
return '<span class="type-badge-icon" title="' + weak + '">' + typeIconMarkup(weak, 63) + '</span><span class="tcg-wrr-value">&nbsp;&times;2</span>';
}
// Weakness/Resistance renders as a plain bordered container, one line of
// info apiece.
function weaknessResistanceBar(types) {
return '<div class="tcg-wr">' +
'<div class="tcg-wrr-cell"><span class="tcg-wrr-label">Weakness</span>' + weaknessValue(types) + '</div>' +
'<div class="tcg-wrr-cell"><span class="tcg-wrr-label">Resistance</span><span class="tcg-wrr-value">None</span></div>' +
'</div>';
}
// Small circular energy-cost icon used on attack rows. Optionally takes
// a type name to show that type's real icon centered inside the circle;
// without one it's just a plain colored dot (used for generic costs).
function energyIcon(color, type) {
return type ? typeCircleMarkup(type, 28) : '<span class="tcg-energy" style="background:' + color + '"></span>';
}
// Plain inline SVGs for the TCG stats table (replaces 🎮/🎯/✨) - emoji
// render as full-color glyphs from whatever font the OS picks, which
// looks inconsistent next to the rest of this hand-drawn UI. These are
// single-color line icons instead, sized/colored purely by CSS
// (.tcg-stats-icon) so they always match the surrounding chrome.
var ICON_GAME = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h8a1 1 0 0 1 1 1V6a2 2 0 0 1 0 4v3.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"/><path d="M6 4.5h1M9 4.5h1"/></svg>';
var ICON_METHOD = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><line x1="10.3" y1="10.3" x2="14.5" y2="14.5"/></svg>';
var ICON_CHARM = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 0c.5 4.8.9 6.7 1.3 7.1.4.4 2.3.8 6.7 1.3-4.4.5-6.3.9-6.7 1.3-.4.4-.8 2.3-1.3 6.7-.5-4.4-.9-6.3-1.3-6.7-.4-.4-2.3-.8-6.7-1.3C4.4 7.9 6.3 7.5 6.7 7.1 7.1 6.7 7.5 4.8 8 0Z"/></svg>';
// A broken custom game-symbol <img> just hides itself (rather than
// leaving a broken-image box) - since a game can have 2-3 version icons
// side by side, the other version's icon is enough to still show a
// custom symbol even if one file is missing.
function handleGameIconError(imgEl) {
imgEl.style.display = 'none';
}
// Builds the icon markup for the "Game" row of the catch-confirmation
// card: one small icon per version bundled into this game (from
// GAME_ICONS, images/game-symbols/<name>.jpg), side by side. Falls back
// to the generic cartridge glyph if the game has no mapping at all.
function gameIconMarkup(game) {
var files = GAME_ICONS[game];
if (!files || !files.length) return ICON_GAME;
var imgs = files.map(function(name) {
return '<img class="tcg-stats-icon-img tcg-icon-game" src="images/game-symbols/' + name + '.jpg" alt="' + escapeHtml(game) + '" onerror="handleGameIconError(this)">';
}).join('');
return '<span class="tcg-stats-icon-group">' + imgs + '</span>';
}
// Single custom-image versions of the Method / Shiny Charm row icons.
// Only one image each (unlike the Game row, which can bundle 2-3
// versions) - drop the files at images/game-symbols/method.webp and
// images/game-symbols/shinyCharm.png (rename these two lines if you
// saved them under different names). Falls back to the original line-art
// glyph if the image fails to load.
function methodIconMarkup() {
return '<img class="tcg-stats-icon-img tcg-icon-method" src="images/game-symbols/method.webp" alt="Method" onerror="this.outerHTML=ICON_METHOD;">';
}
function charmIconMarkup() {
return '<img class="tcg-stats-icon-img tcg-icon-charm" src="images/game-symbols/shinyCharm.png" alt="Shiny Charm" onerror="this.outerHTML=ICON_CHARM;">';
}
// Rarity, loosely mapped from the hunt's odds denominator, mimicking a TCG
// set's rarity marker. glyph mirrors the real convention: common circle,
// uncommon diamond, rare star, ultra-rare double star.
function rarityInfo(denom) {
if (!denom) return { glyph: '●', label: 'Common' };
if (denom >= 8000) return { glyph: '✦✦', label: 'Ultra Rare' };
if (denom >= 4000) return { glyph: '★', label: 'Rare' };
if (denom >= 1000) return { glyph: '◆', label: 'Uncommon' };
return { glyph: '●', label: 'Common' };
}
function rarityGlyphMarkup(denom) {
var info = rarityInfo(denom);
return '<span class="tcg-rarity" title="' + info.label + '">' + info.glyph + '</span>';
}
// HP box icon, styled like the attack-row energy/cost icons (a
// type-colored circle) but with the type's real icon centered inside it,
// so it's recognizable at a glance instead of a plain dot.
function hpTypeIcon(types, color) {
var type = types && types[0];
if (!type) return '<div class="tcg-hp-icon" style="background:' + color + '"></div>';
return typeCircleMarkup(type, 38);
}
// Total known species across all generations in this app's dex data,
// used for the "007/1025"-style card-number tag. Computed lazily and
// cached since GEN_DATA is a large literal.
var _totalSpeciesCache = null;
function totalSpeciesCount() {
if (_totalSpeciesCache !== null) return _totalSpeciesCache;
var total = 0;
for (var i = 0; i < GEN_DATA.length; i++) total += GEN_DATA[i].species.length;
_totalSpeciesCache = total;
return total;
}
function ordinal(n) {
var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function fmtDate(d) {
if (!d) return '—';
try {
var dt = (d instanceof Date) ? d : new Date(d);
if (isNaN(dt.getTime())) return String(d);
return dt.toISOString().slice(0, 10);
} catch (e) {
return String(d);
}
}
var GEN_DATA = [{
gen: 1,
region: "Kanto",
species: [
[1, "Bulbasaur"],
[2, "Ivysaur"],
[3, "Venusaur"],
[4, "Charmander"],
[5, "Charmeleon"],
[6, "Charizard"],
[7, "Squirtle"],
[8, "Wartortle"],
[9, "Blastoise"],
[10, "Caterpie"],
[11, "Metapod"],
[12, "Butterfree"],
[13, "Weedle"],
[14, "Kakuna"],
[15, "Beedrill"],
[16, "Pidgey"],
[17, "Pidgeotto"],
[18, "Pidgeot"],
[19, "Rattata"],
[19, "Rattata (Alolan)"],
[20, "Raticate"],
[20, "Raticate (Alolan)"],
[21, "Spearow"],
[22, "Fearow"],
[23, "Ekans"],
[24, "Arbok"],
[25, "Pikachu"],
[26, "Raichu"],
[26, "Raichu (Alolan)"],
[27, "Sandshrew"],
[27, "Sandshrew (Alolan)"],
[28, "Sandslash"],
[28, "Sandslash (Alolan)"],
[29, "Nidoran♀"],
[30, "Nidorina"],
[31, "Nidoqueen"],
[32, "Nidoran♂"],
[33, "Nidorino"],
[34, "Nidoking"],
[35, "Clefairy"],
[36, "Clefable"],
[37, "Vulpix"],
[37, "Vulpix (Alolan)"],
[38, "Ninetales"],
[38, "Ninetales (Alolan)"],
[39, "Jigglypuff"],
[40, "Wigglytuff"],
[41, "Zubat"],
[42, "Golbat"],
[43, "Oddish"],
[44, "Gloom"],
[45, "Vileplume"],
[46, "Paras"],
[47, "Parasect"],
[48, "Venonat"],
[49, "Venomoth"],
[50, "Diglett"],
[50, "Diglett (Alolan)"],
[51, "Dugtrio"],
[51, "Dugtrio (Alolan)"],
[52, "Meowth"],
[52, "Meowth (Galarian)"],
[52, "Meowth (Alolan)"],
[53, "Persian"],
[53, "Persian (Alolan)"],
[54, "Psyduck"],
[55, "Golduck"],
[56, "Mankey"],
[57, "Primeape"],
[58, "Growlithe"],
[58, "Growlithe (Hisuian)"],
[59, "Arcanine"],
[59, "Arcanine (Hisuian)"],
[60, "Poliwag"],
[61, "Poliwhirl"],
[62, "Poliwrath"],
[63, "Abra"],
[64, "Kadabra"],
[65, "Alakazam"],
[66, "Machop"],
[67, "Machoke"],
[68, "Machamp"],
[69, "Bellsprout"],
[70, "Weepinbell"],
[71, "Victreebel"],
[72, "Tentacool"],
[73, "Tentacruel"],
[74, "Geodude"],
[74, "Geodude (Alolan)"],
[75, "Graveler"],
[75, "Graveler (Alolan)"],
[76, "Golem"],
[76, "Golem (Alolan)"],
[77, "Ponyta"],
[77, "Ponyta (Galarian)"],
[78, "Rapidash"],
[78, "Rapidash (Galarian)"],
[79, "Slowpoke"],
[79, "Slowpoke (Galarian)"],
[80, "Slowbro"],
[80, "Slowbro (Galarian)"],
[81, "Magnemite"],
[82, "Magneton"],
[83, "Farfetch'd"],
[83, "Farfetch'd (Galarian)"],
[84, "Doduo"],
[85, "Dodrio"],
[86, "Seel"],
[87, "Dewgong"],
[88, "Grimer"],
[88, "Grimer (Alolan)"],
[89, "Muk"],
[89, "Muk (Alolan)"],
[90, "Shellder"],
[91, "Cloyster"],
[92, "Gastly"],
[93, "Haunter"],
[94, "Gengar"],
[95, "Onix"],
[96, "Drowzee"],
[97, "Hypno"],
[98, "Krabby"],
[99, "Kingler"],
[100, "Voltorb"],
[100, "Voltorb (Hisuian)"],
[101, "Electrode"],
[101, "Electrode (Hisuian)"],
[102, "Exeggcute"],
[103, "Exeggutor"],
[103, "Exeggutor (Alolan)"],
[104, "Cubone"],
[105, "Marowak"],
[105, "Marowak (Alolan)"],
[106, "Hitmonlee"],
[107, "Hitmonchan"],
[108, "Lickitung"],
[109, "Koffing"],
[110, "Weezing"],
[110, "Weezing (Galarian)"],
[111, "Rhyhorn"],
[112, "Rhydon"],
[113, "Chansey"],
[114, "Tangela"],
[115, "Kangaskhan"],
[116, "Horsea"],
[117, "Seadra"],
[118, "Goldeen"],
[119, "Seaking"],
[120, "Staryu"],
[121, "Starmie"],
[122, "Mr. Mime"],
[122, "Mr. Mime (Galarian)"],
[123, "Scyther"],
[124, "Jynx"],
[125, "Electabuzz"],
[126, "Magmar"],
[127, "Pinsir"],
[128, "Tauros"],
[128, "Tauros (Paldean)"],
[129, "Magikarp"],
[130, "Gyarados"],
[131, "Lapras"],
[132, "Ditto"],
[133, "Eevee"],
[134, "Vaporeon"],
[135, "Jolteon"],
[136, "Flareon"],
[137, "Porygon"],
[138, "Omanyte"],
[139, "Omastar"],
[140, "Kabuto"],
[141, "Kabutops"],
[142, "Aerodactyl"],
[143, "Snorlax"],
[144, "Articuno"],
[144, "Articuno (Galarian)"],
[145, "Zapdos"],
[145, "Zapdos (Galarian)"],
[146, "Moltres"],
[146, "Moltres (Galarian)"],
[147, "Dratini"],
[148, "Dragonair"],
[149, "Dragonite"],
[150, "Mewtwo"],
[151, "Mew"]
]
}, {
gen: 2,
region: "Johto",
species: [
[152, "Chikorita"],
[153, "Bayleef"],
[154, "Meganium"],
[155, "Cyndaquil"],
[156, "Quilava"],
[157, "Typhlosion"],
[157, "Typhlosion (Hisuian)"],
[158, "Totodile"],
[159, "Croconaw"],
[160, "Feraligatr"],
[161, "Sentret"],
[162, "Furret"],
[163, "Hoothoot"],
[164, "Noctowl"],
[165, "Ledyba"],
[166, "Ledian"],
[167, "Spinarak"],
[168, "Ariados"],
[169, "Crobat"],
[170, "Chinchou"],
[171, "Lanturn"],
[172, "Pichu"],
[173, "Cleffa"],
[174, "Igglybuff"],
[175, "Togepi"],
[176, "Togetic"],
[177, "Natu"],
[178, "Xatu"],
[179, "Mareep"],
[180, "Flaaffy"],
[181, "Ampharos"],
[182, "Bellossom"],
[183, "Marill"],
[184, "Azumarill"],
[185, "Sudowoodo"],
[186, "Politoed"],
[187, "Hoppip"],
[188, "Skiploom"],
[189, "Jumpluff"],
[190, "Aipom"],
[191, "Sunkern"],
[192, "Sunflora"],
[193, "Yanma"],
[194, "Wooper"],
[194, "Wooper (Paldean)"],
[195, "Quagsire"],
[196, "Espeon"],
[197, "Umbreon"],
[198, "Murkrow"],
[199, "Slowking"],
[199, "Slowking (Galarian)"],
[200, "Misdreavus"],
[201, "Unown"],
[202, "Wobbuffet"],
[203, "Girafarig"],
[204, "Pineco"],
[205, "Forretress"],
[206, "Dunsparce"],
[207, "Gligar"],
[208, "Steelix"],
[209, "Snubbull"],
[210, "Granbull"],
[211, "Qwilfish"],
[211, "Qwilfish (Hisuian)"],
[212, "Scizor"],
[213, "Shuckle"],
[214, "Heracross"],
[215, "Sneasel"],
[215, "Sneasel (Hisuian)"],
[216, "Teddiursa"],
[217, "Ursaring"],
[218, "Slugma"],
[219, "Magcargo"],
[220, "Swinub"],
[221, "Piloswine"],
[222, "Corsola"],
[222, "Corsola (Galarian)"],
[223, "Remoraid"],
[224, "Octillery"],
[225, "Delibird"],
[226, "Mantine"],
[227, "Skarmory"],
[228, "Houndour"],
[229, "Houndoom"],
[230, "Kingdra"],
[231, "Phanpy"],
[232, "Donphan"],
[233, "Porygon2"],
[234, "Stantler"],
[235, "Smeargle"],
[236, "Tyrogue"],
[237, "Hitmontop"],
[238, "Smoochum"],
[239, "Elekid"],
[240, "Magby"],
[241, "Miltank"],
[242, "Blissey"],
[243, "Raikou"],
[244, "Entei"],
[245, "Suicune"],
[246, "Larvitar"],
[247, "Pupitar"],
[248, "Tyranitar"],
[249, "Lugia"],
[250, "Ho-oh"],
[251, "Celebi"]
]
}, {
gen: 3,
region: "Hoenn",
species: [
[252, "Treecko"],
[253, "Grovyle"],
[254, "Sceptile"],
[255, "Torchic"],
[256, "Combusken"],
[257, "Blaziken"],
[258, "Mudkip"],
[259, "Marshtomp"],
[260, "Swampert"],
[261, "Poochyena"],
[262, "Mightyena"],
[263, "Zigzagoon"],
[263, "Zigzagoon (Galarian)"],
[264, "Linoone"],
[264, "Linoone (Galarian)"],
[265, "Wurmple"],
[266, "Silcoon"],
[267, "Beautifly"],
[268, "Cascoon"],
[269, "Dustox"],
[270, "Lotad"],
[271, "Lombre"],
[272, "Ludicolo"],
[273, "Seedot"],
[274, "Nuzleaf"],
[275, "Shiftry"],
[276, "Taillow"],
[277, "Swellow"],
[278, "Wingull"],
[279, "Pelipper"],
[280, "Ralts"],
[281, "Kirlia"],
[282, "Gardevoir"],
[283, "Surskit"],
[284, "Masquerain"],
[285, "Shroomish"],
[286, "Breloom"],
[287, "Slakoth"],
[288, "Vigoroth"],
[289, "Slaking"],
[290, "Nincada"],
[291, "Ninjask"],
[292, "Shedinja"],
[293, "Whismur"],
[294, "Loudred"],
[295, "Exploud"],
[296, "Makuhita"],
[297, "Hariyama"],
[298, "Azurill"],
[299, "Nosepass"],
[300, "Skitty"],
[301, "Delcatty"],
[302, "Sableye"],
[303, "Mawile"],
[304, "Aron"],
[305, "Lairon"],
[306, "Aggron"],
[307, "Meditite"],
[308, "Medicham"],
[309, "Electrike"],
[310, "Manectric"],
[311, "Plusle"],
[312, "Minun"],
[313, "Volbeat"],
[314, "Illumise"],
[315, "Roselia"],
[316, "Gulpin"],
[317, "Swalot"],
[318, "Carvanha"],
[319, "Sharpedo"],
[320, "Wailmer"],
[321, "Wailord"],
[322, "Numel"],
[323, "Camerupt"],
[324, "Torkoal"],
[325, "Spoink"],
[326, "Grumpig"],
[327, "Spinda"],
[328, "Trapinch"],
[329, "Vibrava"],
[330, "Flygon"],
[331, "Cacnea"],
[332, "Cacturne"],
[333, "Swablu"],
[334, "Altaria"],
[335, "Zangoose"],
[336, "Seviper"],
[337, "Lunatone"],
[338, "Solrock"],
[339, "Barboach"],
[340, "Whiscash"],
[341, "Corphish"],
[342, "Crawdaunt"],
[343, "Baltoy"],
[344, "Claydol"],
[345, "Lileep"],
[346, "Cradily"],
[347, "Anorith"],
[348, "Armaldo"],
[349, "Feebas"],
[350, "Milotic"],
[351, "Castform"],
[352, "Kecleon"],
[353, "Shuppet"],
[354, "Banette"],
[355, "Duskull"],
[356, "Dusclops"],
[357, "Tropius"],
[358, "Chimecho"],
[359, "Absol"],
[360, "Wynaut"],
[361, "Snorunt"],
[362, "Glalie"],
[363, "Spheal"],
[364, "Sealeo"],
[365, "Walrein"],
[366, "Clamperl"],
[367, "Huntail"],
[368, "Gorebyss"],
[369, "Relicanth"],
[370, "Luvdisc"],
[371, "Bagon"],
[372, "Shelgon"],
[373, "Salamence"],
[374, "Beldum"],
[375, "Metang"],
[376, "Metagross"],
[377, "Regirock"],
[378, "Regice"],
[379, "Registeel"],
[380, "Latias"],
[381, "Latios"],
[382, "Kyogre"],
[383, "Groudon"],
[384, "Rayquaza"],
[385, "Jirachi"],
[386, "Deoxys"]
]
}, {
gen: 4,
region: "Sinnoh",
species: [
[387, "Turtwig"],
[388, "Grotle"],
[389, "Torterra"],
[390, "Chimchar"],
[391, "Monferno"],
[392, "Infernape"],
[393, "Piplup"],
[394, "Prinplup"],
[395, "Empoleon"],
[396, "Starly"],
[397, "Staravia"],
[398, "Staraptor"],
[399, "Bidoof"],
[400, "Bibarel"],
[401, "Kricketot"],
[402, "Kricketune"],
[403, "Shinx"],
[404, "Luxio"],
[405, "Luxray"],
[406, "Budew"],
[407, "Roserade"],
[408, "Cranidos"],
[409, "Rampardos"],
[410, "Shieldon"],
[411, "Bastiodon"],
[412, "Burmy"],
[413, "Wormadam"],
[414, "Mothim"],
[415, "Combee"],
[416, "Vespiquen"],
[417, "Pachirisu"],
[418, "Buizel"],
[419, "Floatzel"],
[420, "Cherubi"],
[421, "Cherrim"],
[422, "Shellos"],
[423, "Gastrodon"],
[424, "Ambipom"],
[425, "Drifloon"],
[426, "Drifblim"],
[427, "Buneary"],
[428, "Lopunny"],
[429, "Mismagius"],
[430, "Honchkrow"],
[431, "Glameow"],
[432, "Purugly"],
[433, "Chingling"],
[434, "Stunky"],
[435, "Skuntank"],
[436, "Bronzor"],
[437, "Bronzong"],
[438, "Bonsly"],
[439, "Mime Jr."],
[440, "Happiny"],
[441, "Chatot"],
[442, "Spiritomb"],
[443, "Gible"],
[444, "Gabite"],
[445, "Garchomp"],
[446, "Munchlax"],
[447, "Riolu"],
[448, "Lucario"],
[449, "Hippopotas"],
[450, "Hippowdon"],
[451, "Skorupi"],
[452, "Drapion"],
[453, "Croagunk"],
[454, "Toxicroak"],
[455, "Carnivine"],
[456, "Finneon"],
[457, "Lumineon"],
[458, "Mantyke"],
[459, "Snover"],
[460, "Abomasnow"],
[461, "Weavile"],
[462, "Magnezone"],
[463, "Lickilicky"],
[464, "Rhyperior"],
[465, "Tangrowth"],
[466, "Electivire"],
[467, "Magmortar"],
[468, "Togekiss"],
[469, "Yanmega"],
[470, "Leafeon"],
[471, "Glaceon"],
[472, "Gliscor"],
[473, "Mamoswine"],
[474, "Porygon-Z"],
[475, "Gallade"],
[476, "Probopass"],
[477, "Dusknoir"],
[478, "Froslass"],
[479, "Rotom"],
[480, "Uxie"],
[481, "Mesprit"],
[482, "Azelf"],
[483, "Dialga"],
[484, "Palkia"],
[485, "Heatran"],
[486, "Regigigas"],
[487, "Giratina"],
[488, "Cresselia"],
[489, "Phione"],
[490, "Manaphy"],
[491, "Darkrai"],
[492, "Shaymin"],
[493, "Arceus"]
]
}, {
gen: 5,
region: "Unova",
species: [
[494, "Victini"],
[495, "Snivy"],
[496, "Servine"],
[497, "Serperior"],
[498, "Tepig"],
[499, "Pignite"],
[500, "Emboar"],
[501, "Oshawott"],
[502, "Dewott"],
[503, "Samurott"],
[503, "Samurott (Hisuian)"],
[504, "Patrat"],
[505, "Watchog"],
[506, "Lillipup"],
[507, "Herdier"],
[508, "Stoutland"],
[509, "Purrloin"],
[510, "Liepard"],
[511, "Pansage"],
[512, "Simisage"],
[513, "Pansear"],
[514, "Simisear"],
[515, "Panpour"],
[516, "Simipour"],
[517, "Munna"],
[518, "Musharna"],
[519, "Pidove"],
[520, "Tranquill"],
[521, "Unfezant"],
[522, "Blitzle"],
[523, "Zebstrika"],
[524, "Roggenrola"],
[525, "Boldore"],
[526, "Gigalith"],
[527, "Woobat"],
[528, "Swoobat"],
[529, "Drilbur"],
[530, "Excadrill"],
[531, "Audino"],
[532, "Timburr"],
[533, "Gurdurr"],
[534, "Conkeldurr"],
[535, "Tympole"],
[536, "Palpitoad"],
[537, "Seismitoad"],
[538, "Throh"],
[539, "Sawk"],
[540, "Sewaddle"],
[541, "Swadloon"],
[542, "Leavanny"],
[543, "Venipede"],
[544, "Whirlipede"],
[545, "Scolipede"],
[546, "Cottonee"],
[547, "Whimsicott"],
[548, "Petilil"],
[549, "Lilligant"],
[549, "Lilligant (Hisuian)"],
[550, "Basculin"],
[551, "Sandile"],
[552, "Krokorok"],
[553, "Krookodile"],
[554, "Darumaka"],
[554, "Darumaka (Galarian)"],
[555, "Darmanitan"],
[555, "Darmanitan (Galarian)"],
[556, "Maractus"],
[557, "Dwebble"],
[558, "Crustle"],
[559, "Scraggy"],
[560, "Scrafty"],
[561, "Sigilyph"],
[562, "Yamask"],
[562, "Yamask (Galarian)"],
[563, "Cofagrigus"],
[564, "Tirtouga"],
[565, "Carracosta"],
[566, "Archen"],
[567, "Archeops"],
[568, "Trubbish"],
[569, "Garbodor"],
[570, "Zorua"],
[570, "Zorua (Hisuian)"],
[571, "Zoroark"],
[571, "Zoroark (Hisuian)"],
[572, "Minccino"],
[573, "Cinccino"],
[574, "Gothita"],
[575, "Gothorita"],
[576, "Gothitelle"],
[577, "Solosis"],
[578, "Duosion"],
[579, "Reuniclus"],
[580, "Ducklett"],
[581, "Swanna"],
[582, "Vanillite"],
[583, "Vanillish"],
[584, "Vanilluxe"],
[585, "Deerling"],
[586, "Sawsbuck"],
[587, "Emolga"],
[588, "Karrablast"],
[589, "Escavalier"],
[590, "Foongus"],
[591, "Amoonguss"],
[592, "Frillish"],
[593, "Jellicent"],
[594, "Alomomola"],
[595, "Joltik"],
[596, "Galvantula"],
[597, "Ferroseed"],
[598, "Ferrothorn"],
[599, "Klink"],
[600, "Klang"],
[601, "Klinklang"],
[602, "Tynamo"],
[603, "Eelektrik"],
[604, "Eelektross"],
[605, "Elgyem"],
[606, "Beheeyem"],
[607, "Litwick"],
[608, "Lampent"],
[609, "Chandelure"],
[610, "Axew"],
[611, "Fraxure"],
[612, "Haxorus"],
[613, "Cubchoo"],
[614, "Beartic"],
[615, "Cryogonal"],
[616, "Shelmet"],
[617, "Accelgor"],
[618, "Stunfisk"],
[618, "Stunfisk (Galarian)"],
[619, "Mienfoo"],
[620, "Mienshao"],
[621, "Druddigon"],
[622, "Golett"],
[623, "Golurk"],
[624, "Pawniard"],
[625, "Bisharp"],
[626, "Bouffalant"],
[627, "Rufflet"],
[628, "Braviary"],
[628, "Braviary (Hisuian)"],
[629, "Vullaby"],
[630, "Mandibuzz"],
[631, "Heatmor"],
[632, "Durant"],
[633, "Deino"],
[634, "Zweilous"],
[635, "Hydreigon"],
[636, "Larvesta"],
[637, "Volcarona"],
[638, "Cobalion"],
[639, "Terrakion"],
[640, "Virizion"],
[641, "Tornadus"],
[642, "Thundurus"],
[643, "Reshiram"],
[644, "Zekrom"],
[645, "Landorus"],
[646, "Kyurem"],
[647, "Keldeo"],
[648, "Meloetta"],
[649, "Genesect"]
]
}, {
gen: 6,
region: "Kalos",
species: [
[650, "Chespin"],
[651, "Quilladin"],
[652, "Chesnaught"],
[653, "Fennekin"],
[654, "Braixen"],
[655, "Delphox"],
[656, "Froakie"],
[657, "Frogadier"],
[658, "Greninja"],
[659, "Bunnelby"],
[660, "Diggersby"],
[661, "Fletchling"],
[662, "Fletchinder"],
[663, "Talonflame"],
[664, "Scatterbug"],
[665, "Spewpa"],
[666, "Vivillon"],
[667, "Litleo"],
[668, "Pyroar"],
[669, "Flabébé"],
[670, "Floette"],
[671, "Florges"],
[672, "Skiddo"],
[673, "Gogoat"],
[674, "Pancham"],
[675, "Pangoro"],
[676, "Furfrou"],
[677, "Espurr"],
[678, "Meowstic"],
[679, "Honedge"],
[680, "Doublade"],
[681, "Aegislash"],
[682, "Spritzee"],
[683, "Aromatisse"],
[684, "Swirlix"],
[685, "Slurpuff"],
[686, "Inkay"],
[687, "Malamar"],
[688, "Binacle"],
[689, "Barbaracle"],
[690, "Skrelp"],
[691, "Dragalge"],
[692, "Clauncher"],
[693, "Clawitzer"],
[694, "Helioptile"],
[695, "Heliolisk"],
[696, "Tyrunt"],
[697, "Tyrantrum"],
[698, "Amaura"],
[699, "Aurorus"],
[700, "Sylveon"],
[701, "Hawlucha"],
[702, "Dedenne"],
[703, "Carbink"],
[704, "Goomy"],
[705, "Sliggoo"],
[705, "Sliggoo (Hisuian)"],
[706, "Goodra"],
[706, "Goodra (Hisuian)"],
[707, "Klefki"],
[708, "Phantump"],
[709, "Trevenant"],
[710, "Pumpkaboo"],
[711, "Gourgeist"],
[712, "Bergmite"],
[713, "Avalugg"],
[713, "Avalugg (Hisuian)"],
[714, "Noibat"],
[715, "Noivern"],
[716, "Xerneas"],
[717, "Yveltal"],
[718, "Zygarde50% Forme"],
[719, "Diancie"],
[720, "Hoopa"],
[721, "Volcanion"]
]
}, {
gen: 7,
region: "Alola",
species: [
[722, "Rowlet"],
[723, "Dartrix"],
[724, "Decidueye"],
[724, "Decidueye (Hisuian)"],
[725, "Litten"],
[726, "Torracat"],
[727, "Incineroar"],
[728, "Popplio"],
[729, "Brionne"],
[730, "Primarina"],
[731, "Pikipek"],
[732, "Trumbeak"],
[733, "Toucannon"],
[734, "Yungoos"],
[735, "Gumshoos"],
[736, "Grubbin"],
[737, "Charjabug"],
[738, "Vikavolt"],
[739, "Crabrawler"],
[740, "Crabominable"],
[741, "Oricorio"],
[742, "Cutiefly"],
[743, "Ribombee"],
[744, "Rockruff"],
[745, "Lycanroc"],
[746, "Wishiwashi"],
[747, "Mareanie"],
[748, "Toxapex"],
[749, "Mudbray"],
[750, "Mudsdale"],
[751, "Dewpider"],
[752, "Araquanid"],
[753, "Fomantis"],
[754, "Lurantis"],
[755, "Morelull"],
[756, "Shiinotic"],
[757, "Salandit"],
[758, "Salazzle"],
[759, "Stufful"],
[760, "Bewear"],
[761, "Bounsweet"],
[762, "Steenee"],
[763, "Tsareena"],
[764, "Comfey"],
[765, "Oranguru"],
[766, "Passimian"],
[767, "Wimpod"],
[768, "Golisopod"],
[769, "Sandygast"],
[770, "Palossand"],
[771, "Pyukumuku"],
[772, "Type: Null"],
[773, "Silvally"],
[774, "Minior"],
[775, "Komala"],
[776, "Turtonator"],
[777, "Togedemaru"],
[778, "Mimikyu"],
[779, "Bruxish"],
[780, "Drampa"],
[781, "Dhelmise"],
[782, "Jangmo-o"],
[783, "Hakamo-o"],
[784, "Kommo-o"],
[785, "Tapu Koko"],
[786, "Tapu Lele"],
[787, "Tapu Bulu"],
[788, "Tapu Fini"],
[789, "Cosmog"],
[790, "Cosmoem"],
[791, "Solgaleo"],
[792, "Lunala"],
[793, "Nihilego"],
[794, "Buzzwole"],
[795, "Pheromosa"],
[796, "Xurkitree"],
[797, "Celesteela"],
[798, "Kartana"],
[799, "Guzzlord"],
[800, "Necrozma"],
[801, "Magearna"],
[802, "Marshadow"],
[803, "Poipole"],
[804, "Naganadel"],
[805, "Stakataka"],
[806, "Blacephalon"],
[807, "Zeraora"],
[808, "Meltan"],
[809, "Melmetal"]
]
}, {
gen: 8,
region: "Galar / Hisui",
species: [
[810, "Grookey"],
[811, "Thwackey"],
[812, "Rillaboom"],
[813, "Scorbunny"],
[814, "Raboot"],
[815, "Cinderace"],
[816, "Sobble"],
[817, "Drizzile"],
[818, "Inteleon"],
[819, "Skwovet"],
[820, "Greedent"],
[821, "Rookidee"],
[822, "Corvisquire"],
[823, "Corviknight"],
[824, "Blipbug"],
[825, "Dottler"],
[826, "Orbeetle"],
[827, "Nickit"],
[828, "Thievul"],
[829, "Gossifleur"],
[830, "Eldegoss"],
[831, "Wooloo"],
[832, "Dubwool"],
[833, "Chewtle"],
[834, "Drednaw"],
[835, "Yamper"],
[836, "Boltund"],
[837, "Rolycoly"],
[838, "Carkol"],
[839, "Coalossal"],
[840, "Applin"],
[841, "Flapple"],
[842, "Appletun"],
[843, "Silicobra"],
[844, "Sandaconda"],
[845, "Cramorant"],
[846, "Arrokuda"],
[847, "Barraskewda"],
[848, "Toxel"],
[849, "Toxtricity"],
[850, "Sizzlipede"],
[851, "Centiskorch"],
[852, "Clobbopus"],
[853, "Grapploct"],
[854, "Sinistea"],
[855, "Polteageist"],
[856, "Hatenna"],
[857, "Hattrem"],
[858, "Hatterene"],
[859, "Impidimp"],
[860, "Morgrem"],
[861, "Grimmsnarl"],
[862, "Obstagoon"],
[863, "Perrserker"],
[864, "Cursola"],
[865, "Sirfetch'd"],
[866, "Mr. Rime"],
[867, "Runerigus"],
[868, "Milcery"],
[869, "Alcremie"],
[870, "Falinks"],
[871, "Pincurchin"],
[872, "Snom"],
[873, "Frosmoth"],
[874, "Stonjourner"],
[875, "Eiscue"],
[876, "Indeedee"],
[877, "Morpeko"],
[878, "Cufant"],
[879, "Copperajah"],
[880, "Dracozolt"],
[881, "Arctozolt"],
[882, "Dracovish"],
[883, "Arctovish"],
[884, "Duraludon"],
[885, "Dreepy"],
[886, "Drakloak"],
[887, "Dragapult"],
[888, "Zacian"],
[889, "Zamazenta"],
[890, "Eternatus"],
[891, "Kubfu"],
[892, "Urshifu"],
[893, "Zarude"],
[894, "Regieleki"],
[895, "Regidrago"],
[896, "Glastrier"],
[897, "Spectrier"],
[898, "Calyrex"],
[899, "Wyrdeer"],
[900, "Kleavor"],
[901, "Ursaluna"],
[902, "Basculegion"],
[903, "Sneasler"],
[904, "Overqwil"],
[905, "Enamorus"]
]
}, {
gen: 9,
region: "Paldea",
species: [
[906, "Sprigatito"],
[907, "Floragato"],
[908, "Meowscarada"],
[909, "Fuecoco"],
[910, "Crocalor"],
[911, "Skeledirge"],
[912, "Quaxly"],
[913, "Quaxwell"],
[914, "Quaquaval"],
[915, "Lechonk"],
[916, "Oinkologne"],
[917, "Tarountula"],
[918, "Spidops"],
[919, "Nymble"],
[920, "Lokix"],
[921, "Pawmi"],
[922, "Pawmo"],
[923, "Pawmot"],
[924, "Tandemaus"],
[925, "Maushold"],
[926, "Fidough"],
[927, "Dachsbun"],
[928, "Smoliv"],
[929, "Dolliv"],
[930, "Arboliva"],
[931, "Squawkabilly"],
[932, "Nacli"],
[933, "Naclstack"],
[934, "Garganacl"],
[935, "Charcadet"],
[936, "Armarouge"],
[937, "Ceruledge"],
[938, "Tadbulb"],
[939, "Bellibolt"],
[940, "Wattrel"],
[941, "Kilowattrel"],
[942, "Maschiff"],
[943, "Mabosstiff"],
[944, "Shroodle"],
[945, "Grafaiai"],
[946, "Bramblin"],
[947, "Brambleghast"],
[948, "Toedscool"],
[949, "Toedscruel"],
[950, "Klawf"],
[951, "Capsakid"],
[952, "Scovillain"],
[953, "Rellor"],
[954, "Rabsca"],
[955, "Flittle"],
[956, "Espathra"],
[957, "Tinkatink"],
[958, "Tinkatuff"],
[959, "Tinkaton"],
[960, "Wiglett"],
[961, "Wugtrio"],
[962, "Bombirdier"],
[963, "Finizen"],
[964, "Palafin"],
[965, "Varoom"],
[966, "Revavroom"],
[967, "Cyclizar"],
[968, "Orthworm"],
[969, "Glimmet"],
[970, "Glimmora"],
[971, "Greavard"],
[972, "Houndstone"],
[973, "Flamigo"],
[974, "Cetoddle"],
[975, "Cetitan"],
[976, "Veluza"],
[977, "Dondozo"],
[978, "Tatsugiri"],
[979, "Annihilape"],
[980, "Clodsire"],
[981, "Farigiraf"],
[982, "Dudunsparce"],
[983, "Kingambit"],
[984, "Great Tusk"],
[985, "Scream Tail"],
[986, "Brute Bonnet"],
[987, "Flutter Mane"],
[988, "Slither Wing"],
[989, "Sandy Shocks"],
[990, "Iron Treads"],
[991, "Iron Bundle"],
[992, "Iron Hands"],
[993, "Iron Jugulis"],
[994, "Iron Moth"],
[995, "Iron Thorns"],
[996, "Frigibax"],
[997, "Arctibax"],
[998, "Baxcalibur"],
[999, "Gimmighoul"],
[1000, "Gholdengo"],
[1001, "Wo-Chien"],
[1002, "Chien-Pao"],
[1003, "Ting-Lu"],
[1004, "Chi-Yu"],
[1005, "Roaring Moon"],
[1006, "Iron Valiant"],
[1007, "Koraidon"],
[1008, "Miraidon"],
[1009, "Walking Wake"],
[1010, "Iron Leaves"],
[1011, "Dipplin"],
[1012, "Poltchageist"],
[1013, "Sinistcha"],
[1014, "Okidogi"],
[1015, "Munkidori"],
[1016, "Fezandipiti"],
[1017, "Ogerpon"],
[1018, "Archaludon"],
[1019, "Hydrapple"],
[1020, "Gouging Fire"],
[1021, "Raging Bolt"],
[1022, "Iron Boulder"],
[1023, "Iron Crown"],
[1024, "Terapagos"],
[1025, "Pecharunt"]
]
}, ];
// REGION BALL CONTAINER images — one ball icon per region, shown in the
// round badge on each Living Dex generation card. Files live in
// images/region-balls/ (see matching comment on .dex-gen-badge in style.css).
var REGION_BALLS = {
"Kanto": "ball_kanto_pokeball.png",
"Johto": "ball_johto_greatball.png",
"Hoenn": "ball_hoenn_ultraball.png",
"Sinnoh": "ball_sinnoh_masterball.png",
"Unova": "ball_unova_quickball.png",
"Kalos": "ball_kalos_timerball.png",
"Alola": "ball_alola_beastball.png",
"Galar / Hisui": "ball_galar_dynamaxball.png",
"Paldea": "ball_paldea_premierball.png"
};
var SPECIES_INFO = {
"bulbasaur": [1, "Grass", "Poison"],
"ivysaur": [1, "Grass", "Poison"],
"venusaur": [1, "Grass", "Poison"],
"charmander": [1, "Fire", ""],
"charmeleon": [1, "Fire", ""],
"charizard": [1, "Fire", "Flying"],
"squirtle": [1, "Water", ""],
"wartortle": [1, "Water", ""],
"blastoise": [1, "Water", ""],
"caterpie": [1, "Bug", ""],
"metapod": [1, "Bug", ""],
"butterfree": [1, "Bug", "Flying"],
"weedle": [1, "Bug", "Poison"],
"kakuna": [1, "Bug", "Poison"],
"beedrill": [1, "Bug", "Poison"],
"pidgey": [1, "Normal", "Flying"],
"pidgeotto": [1, "Normal", "Flying"],
"pidgeot": [1, "Normal", "Flying"],
"rattata": [1, "Normal", ""],
"raticate": [1, "Normal", ""],
"spearow": [1, "Normal", "Flying"],
"fearow": [1, "Normal", "Flying"],
"ekans": [1, "Poison", ""],
"arbok": [1, "Poison", ""],
"pikachu": [1, "Electric", ""],
"raichu": [1, "Electric", ""],
"sandshrew": [1, "Ground", ""],
"sandslash": [1, "Ground", ""],
"nidoran♀": [1, "Poison", ""],
"nidoran♂": [1, "Poison", ""],
"nidorina": [1, "Poison", ""],
"nidoqueen": [1, "Poison", "Ground"],
"nidorino": [1, "Poison", ""],
"nidoking": [1, "Poison", "Ground"],
"clefairy": [1, "Fairy", ""],
"clefable": [1, "Fairy", ""],
"vulpix": [1, "Fire", ""],
"ninetales": [1, "Fire", ""],
"jigglypuff": [1, "Normal", "Fairy"],
"wigglytuff": [1, "Normal", "Fairy"],
"zubat": [1, "Poison", "Flying"],
"golbat": [1, "Poison", "Flying"],
"oddish": [1, "Grass", "Poison"],
"gloom": [1, "Grass", "Poison"],
"vileplume": [1, "Grass", "Poison"],
"paras": [1, "Bug", "Grass"],
"parasect": [1, "Bug", "Grass"],
"venonat": [1, "Bug", "Poison"],
"venomoth": [1, "Bug", "Poison"],
"diglett": [1, "Ground", ""],
"dugtrio": [1, "Ground", ""],
"meowth": [1, "Normal", ""],
"persian": [1, "Normal", ""],
"psyduck": [1, "Water", ""],
"golduck": [1, "Water", ""],
"mankey": [1, "Fighting", ""],
"primeape": [1, "Fighting", ""],
"growlithe": [1, "Fire", ""],
"arcanine": [1, "Fire", ""],
"poliwag": [1, "Water", ""],
"poliwhirl": [1, "Water", ""],
"poliwrath": [1, "Water", "Fighting"],
"abra": [1, "Psychic", ""],
"kadabra": [1, "Psychic", ""],
"alakazam": [1, "Psychic", ""],
"machop": [1, "Fighting", ""],
"machoke": [1, "Fighting", ""],
"machamp": [1, "Fighting", ""],
"bellsprout": [1, "Grass", "Poison"],
"weepinbell": [1, "Grass", "Poison"],
"victreebel": [1, "Grass", "Poison"],
"tentacool": [1, "Water", "Poison"],
"tentacruel": [1, "Water", "Poison"],
"geodude": [1, "Rock", "Ground"],
"graveler": [1, "Rock", "Ground"],
"golem": [1, "Rock", "Ground"],
"ponyta": [1, "Fire", ""],
"rapidash": [1, "Fire", ""],
"slowpoke": [1, "Water", "Psychic"],
"slowbro": [1, "Water", "Psychic"],
"magnemite": [1, "Electric", "Steel"],
"magneton": [1, "Electric", "Steel"],
"farfetch'd": [1, "Normal", "Flying"],
"doduo": [1, "Normal", "Flying"],
"dodrio": [1, "Normal", "Flying"],
"seel": [1, "Water", ""],
"dewgong": [1, "Water", "Ice"],
"grimer": [1, "Poison", ""],
"muk": [1, "Poison", ""],
"shellder": [1, "Water", ""],
"cloyster": [1, "Water", "Ice"],
"gastly": [1, "Ghost", "Poison"],
"haunter": [1, "Ghost", "Poison"],
"gengar": [1, "Ghost", "Poison"],
"onix": [1, "Rock", "Ground"],
"drowzee": [1, "Psychic", ""],
"hypno": [1, "Psychic", ""],
"krabby": [1, "Water", ""],
"kingler": [1, "Water", ""],
"voltorb": [1, "Electric", ""],
"electrode": [1, "Electric", ""],
"exeggcute": [1, "Grass", "Psychic"],
"exeggutor": [1, "Grass", "Psychic"],
"cubone": [1, "Ground", ""],
"marowak": [1, "Ground", ""],
"hitmonlee": [1, "Fighting", ""],
"hitmonchan": [1, "Fighting", ""],
"lickitung": [1, "Normal", ""],
"koffing": [1, "Poison", ""],
"weezing": [1, "Poison", ""],
"rhyhorn": [1, "Ground", "Rock"],
"rhydon": [1, "Ground", "Rock"],
"chansey": [1, "Normal", ""],
"tangela": [1, "Grass", ""],
"kangaskhan": [1, "Normal", ""],
"horsea": [1, "Water", ""],
"seadra": [1, "Water", ""],
"goldeen": [1, "Water", ""],
"seaking": [1, "Water", ""],
"staryu": [1, "Water", ""],
"starmie": [1, "Water", "Psychic"],
"mr. mime": [1, "Psychic", "Fairy"],
"scyther": [1, "Bug", "Flying"],
"jynx": [1, "Ice", "Psychic"],
"electabuzz": [1, "Electric", ""],
"magmar": [1, "Fire", ""],
"pinsir": [1, "Bug", ""],
"tauros": [1, "Normal", ""],
"magikarp": [1, "Water", ""],
"gyarados": [1, "Water", "Flying"],
"lapras": [1, "Water", "Ice"],
"ditto": [1, "Normal", ""],
"eevee": [1, "Normal", ""],
"vaporeon": [1, "Water", ""],
"jolteon": [1, "Electric", ""],
"flareon": [1, "Fire", ""],
"porygon": [1, "Normal", ""],
"omanyte": [1, "Rock", "Water"],
"omastar": [1, "Rock", "Water"],
"kabuto": [1, "Rock", "Water"],
"kabutops": [1, "Rock", "Water"],
"aerodactyl": [1, "Rock", "Flying"],
"snorlax": [1, "Normal", ""],
"articuno": [1, "Ice", "Flying"],
"zapdos": [1, "Electric", "Flying"],
"moltres": [1, "Fire", "Flying"],
"dratini": [1, "Dragon", ""],
"dragonair": [1, "Dragon", ""],
"dragonite": [1, "Dragon", "Flying"],
"mewtwo": [1, "Psychic", ""],
"mew": [1, "Psychic", ""],
"chikorita": [2, "Grass", ""],
"bayleef": [2, "Grass", ""],
"meganium": [2, "Grass", ""],
"cyndaquil": [2, "Fire", ""],
"quilava": [2, "Fire", ""],
"typhlosion": [2, "Fire", ""],
"totodile": [2, "Water", ""],
"croconaw": [2, "Water", ""],
"feraligatr": [2, "Water", ""],
"sentret": [2, "Normal", ""],
"furret": [2, "Normal", ""],
"hoothoot": [2, "Normal", "Flying"],
"noctowl": [2, "Normal", "Flying"],
"ledyba": [2, "Bug", "Flying"],
"ledian": [2, "Bug", "Flying"],
"spinarak": [2, "Bug", "Poison"],
"ariados": [2, "Bug", "Poison"],
"crobat": [2, "Poison", "Flying"],
"chinchou": [2, "Water", "Electric"],
"lanturn": [2, "Water", "Electric"],
"pichu": [2, "Electric", ""],
"cleffa": [2, "Fairy", ""],
"igglybuff": [2, "Normal", "Fairy"],
"togepi": [2, "Fairy", ""],
"togetic": [2, "Fairy", "Flying"],
"natu": [2, "Psychic", "Flying"],
"xatu": [2, "Psychic", "Flying"],
"mareep": [2, "Electric", ""],
"flaaffy": [2, "Electric", ""],
"ampharos": [2, "Electric", ""],
"bellossom": [2, "Grass", ""],
"marill": [2, "Water", "Fairy"],
"azumarill": [2, "Water", "Fairy"],
"sudowoodo": [2, "Rock", ""],
"politoed": [2, "Water", ""],
"hoppip": [2, "Grass", "Flying"],
"skiploom": [2, "Grass", "Flying"],
"jumpluff": [2, "Grass", "Flying"],
"aipom": [2, "Normal", ""],
"sunkern": [2, "Grass", ""],
"sunflora": [2, "Grass", ""],
"yanma": [2, "Bug", "Flying"],
"wooper": [2, "Water", "Ground"],
"quagsire": [2, "Water", "Ground"],
"espeon": [2, "Psychic", ""],
"umbreon": [2, "Dark", ""],
"murkrow": [2, "Dark", "Flying"],
"slowking": [2, "Water", "Psychic"],
"misdreavus": [2, "Ghost", ""],
"unown": [2, "Psychic", ""],
"wobbuffet": [2, "Psychic", ""],
"girafarig": [2, "Normal", "Psychic"],
"pineco": [2, "Bug", ""],
"forretress": [2, "Bug", "Steel"],
"dunsparce": [2, "Normal", ""],
"gligar": [2, "Ground", "Flying"],
"steelix": [2, "Steel", "Ground"],
"snubbull": [2, "Fairy", ""],
"granbull": [2, "Fairy", ""],
"qwilfish": [2, "Water", "Poison"],
"scizor": [2, "Bug", "Steel"],
"shuckle": [2, "Bug", "Rock"],
"heracross": [2, "Bug", "Fighting"],
"sneasel": [2, "Dark", "Ice"],
"teddiursa": [2, "Normal", ""],
"ursaring": [2, "Normal", ""],
"slugma": [2, "Fire", ""],
"magcargo": [2, "Fire", "Rock"],
"swinub": [2, "Ice", "Ground"],
"piloswine": [2, "Ice", "Ground"],
"corsola": [2, "Water", "Rock"],
"remoraid": [2, "Water", ""],
"octillery": [2, "Water", ""],
"delibird": [2, "Ice", "Flying"],
"mantine": [2, "Water", "Flying"],
"skarmory": [2, "Steel", "Flying"],
"houndour": [2, "Dark", "Fire"],
"houndoom": [2, "Dark", "Fire"],
"kingdra": [2, "Water", "Dragon"],
"phanpy": [2, "Ground", ""],
"donphan": [2, "Ground", ""],
"porygon2": [2, "Normal", ""],
"stantler": [2, "Normal", ""],
"smeargle": [2, "Normal", ""],
"tyrogue": [2, "Fighting", ""],
"hitmontop": [2, "Fighting", ""],
"smoochum": [2, "Ice", "Psychic"],
"elekid": [2, "Electric", ""],
"magby": [2, "Fire", ""],
"miltank": [2, "Normal", ""],
"blissey": [2, "Normal", ""],
"raikou": [2, "Electric", ""],
"entei": [2, "Fire", ""],
"suicune": [2, "Water", ""],
"larvitar": [2, "Rock", "Ground"],
"pupitar": [2, "Rock", "Ground"],
"tyranitar": [2, "Rock", "Dark"],
"lugia": [2, "Psychic", "Flying"],
"ho-oh": [2, "Fire", "Flying"],
"celebi": [2, "Psychic", "Grass"],
"treecko": [3, "Grass", ""],
"grovyle": [3, "Grass", ""],
"sceptile": [3, "Grass", ""],
"torchic": [3, "Fire", ""],
"combusken": [3, "Fire", "Fighting"],
"blaziken": [3, "Fire", "Fighting"],
"mudkip": [3, "Water", ""],
"marshtomp": [3, "Water", "Ground"],
"swampert": [3, "Water", "Ground"],
"poochyena": [3, "Dark", ""],
"mightyena": [3, "Dark", ""],
"zigzagoon": [3, "Normal", ""],
"linoone": [3, "Normal", ""],
"wurmple": [3, "Bug", ""],
"silcoon": [3, "Bug", ""],
"beautifly": [3, "Bug", "Flying"],
"cascoon": [3, "Bug", ""],
"dustox": [3, "Bug", "Poison"],
"lotad": [3, "Water", "Grass"],
"lombre": [3, "Water", "Grass"],
"ludicolo": [3, "Water", "Grass"],
"seedot": [3, "Grass", ""],
"nuzleaf": [3, "Grass", "Dark"],
"shiftry": [3, "Grass", "Dark"],
"taillow": [3, "Normal", "Flying"],
"swellow": [3, "Normal", "Flying"],
"wingull": [3, "Water", "Flying"],
"pelipper": [3, "Water", "Flying"],
"ralts": [3, "Psychic", "Fairy"],
"kirlia": [3, "Psychic", "Fairy"],
"gardevoir": [3, "Psychic", "Fairy"],
"surskit": [3, "Bug", "Water"],
"masquerain": [3, "Bug", "Flying"],
"shroomish": [3, "Grass", ""],
"breloom": [3, "Grass", "Fighting"],
"slakoth": [3, "Normal", ""],
"vigoroth": [3, "Normal", ""],
"slaking": [3, "Normal", ""],
"nincada": [3, "Bug", "Ground"],
"ninjask": [3, "Bug", "Flying"],
"shedinja": [3, "Bug", "Ghost"],
"whismur": [3, "Normal", ""],
"loudred": [3, "Normal", ""],
"exploud": [3, "Normal", ""],
"makuhita": [3, "Fighting", ""],
"hariyama": [3, "Fighting", ""],
"azurill": [3, "Normal", "Fairy"],
"nosepass": [3, "Rock", ""],
"skitty": [3, "Normal", ""],
"delcatty": [3, "Normal", ""],
"sableye": [3, "Dark", "Ghost"],
"mawile": [3, "Steel", "Fairy"],
"aron": [3, "Steel", "Rock"],
"lairon": [3, "Steel", "Rock"],
"aggron": [3, "Steel", "Rock"],
"meditite": [3, "Fighting", "Psychic"],
"medicham": [3, "Fighting", "Psychic"],
"electrike": [3, "Electric", ""],
"manectric": [3, "Electric", ""],
"plusle": [3, "Electric", ""],
"minun": [3, "Electric", ""],
"volbeat": [3, "Bug", ""],
"illumise": [3, "Bug", ""],
"roselia": [3, "Grass", "Poison"],
"gulpin": [3, "Poison", ""],
"swalot": [3, "Poison", ""],
"carvanha": [3, "Water", "Dark"],
"sharpedo": [3, "Water", "Dark"],
"wailmer": [3, "Water", ""],
"wailord": [3, "Water", ""],
"numel": [3, "Fire", "Ground"],
"camerupt": [3, "Fire", "Ground"],
"torkoal": [3, "Fire", ""],
"spoink": [3, "Psychic", ""],
"grumpig": [3, "Psychic", ""],
"spinda": [3, "Normal", ""],
"trapinch": [3, "Ground", ""],
"vibrava": [3, "Ground", "Dragon"],
"flygon": [3, "Ground", "Dragon"],
"cacnea": [3, "Grass", ""],
"cacturne": [3, "Grass", "Dark"],
"swablu": [3, "Normal", "Flying"],
"altaria": [3, "Dragon", "Flying"],
"zangoose": [3, "Normal", ""],
"seviper": [3, "Poison", ""],
"lunatone": [3, "Rock", "Psychic"],
"solrock": [3, "Rock", "Psychic"],
"barboach": [3, "Water", "Ground"],
"whiscash": [3, "Water", "Ground"],
"corphish": [3, "Water", ""],
"crawdaunt": [3, "Water", "Dark"],
"baltoy": [3, "Ground", "Psychic"],
"claydol": [3, "Ground", "Psychic"],
"lileep": [3, "Rock", "Grass"],
"cradily": [3, "Rock", "Grass"],
"anorith": [3, "Rock", "Bug"],
"armaldo": [3, "Rock", "Bug"],
"feebas": [3, "Water", ""],
"milotic": [3, "Water", ""],
"castform": [3, "Normal", ""],
"kecleon": [3, "Normal", ""],
"shuppet": [3, "Ghost", ""],
"banette": [3, "Ghost", ""],
"duskull": [3, "Ghost", ""],
"dusclops": [3, "Ghost", ""],
"tropius": [3, "Grass", "Flying"],
"chimecho": [3, "Psychic", ""],
"absol": [3, "Dark", ""],
"wynaut": [3, "Psychic", ""],
"snorunt": [3, "Ice", ""],
"glalie": [3, "Ice", ""],
"spheal": [3, "Ice", "Water"],
"sealeo": [3, "Ice", "Water"],
"walrein": [3, "Ice", "Water"],
"clamperl": [3, "Water", ""],
"huntail": [3, "Water", ""],
"gorebyss": [3, "Water", ""],
"relicanth": [3, "Water", "Rock"],
"luvdisc": [3, "Water", ""],
"bagon": [3, "Dragon", ""],
"shelgon": [3, "Dragon", ""],
"salamence": [3, "Dragon", "Flying"],
"beldum": [3, "Steel", "Psychic"],
"metang": [3, "Steel", "Psychic"],
"metagross": [3, "Steel", "Psychic"],
"regirock": [3, "Rock", ""],
"regice": [3, "Ice", ""],
"registeel": [3, "Steel", ""],
"latias": [3, "Dragon", "Psychic"],
"latios": [3, "Dragon", "Psychic"],
"kyogre": [3, "Water", ""],
"groudon": [3, "Ground", ""],
"rayquaza": [3, "Dragon", "Flying"],
"jirachi": [3, "Steel", "Psychic"],
"deoxys": [3, "Psychic", ""],
"turtwig": [4, "Grass", ""],
"grotle": [4, "Grass", ""],
"torterra": [4, "Grass", "Ground"],
"chimchar": [4, "Fire", ""],
"monferno": [4, "Fire", "Fighting"],
"infernape": [4, "Fire", "Fighting"],
"piplup": [4, "Water", ""],
"prinplup": [4, "Water", ""],
"empoleon": [4, "Water", "Steel"],
"starly": [4, "Normal", "Flying"],
"staravia": [4, "Normal", "Flying"],
"staraptor": [4, "Normal", "Flying"],
"bidoof": [4, "Normal", ""],
"bibarel": [4, "Normal", "Water"],
"kricketot": [4, "Bug", ""],
"kricketune": [4, "Bug", ""],
"shinx": [4, "Electric", ""],
"luxio": [4, "Electric", ""],
"luxray": [4, "Electric", ""],
"budew": [4, "Grass", "Poison"],
"roserade": [4, "Grass", "Poison"],
"cranidos": [4, "Rock", ""],
"rampardos": [4, "Rock", ""],
"shieldon": [4, "Rock", "Steel"],
"bastiodon": [4, "Rock", "Steel"],
"burmy": [4, "Bug", ""],
"wormadam": [4, "Bug", "Grass"],
"mothim": [4, "Bug", "Flying"],
"combee": [4, "Bug", "Flying"],
"vespiquen": [4, "Bug", "Flying"],
"pachirisu": [4, "Electric", ""],
"buizel": [4, "Water", ""],
"floatzel": [4, "Water", ""],
"cherubi": [4, "Grass", ""],
"cherrim": [4, "Grass", ""],
"shellos": [4, "Water", ""],
"gastrodon": [4, "Water", "Ground"],
"ambipom": [4, "Normal", ""],
"drifloon": [4, "Ghost", "Flying"],
"drifblim": [4, "Ghost", "Flying"],
"buneary": [4, "Normal", ""],
"lopunny": [4, "Normal", ""],
"mismagius": [4, "Ghost", ""],
"honchkrow": [4, "Dark", "Flying"],
"glameow": [4, "Normal", ""],
"purugly": [4, "Normal", ""],
"chingling": [4, "Psychic", ""],
"stunky": [4, "Poison", "Dark"],
"skuntank": [4, "Poison", "Dark"],
"bronzor": [4, "Steel", "Psychic"],
"bronzong": [4, "Steel", "Psychic"],
"bonsly": [4, "Rock", ""],
"mime jr.": [4, "Psychic", "Fairy"],
"happiny": [4, "Normal", ""],
"chatot": [4, "Normal", "Flying"],
"spiritomb": [4, "Ghost", "Dark"],
"gible": [4, "Dragon", "Ground"],
"gabite": [4, "Dragon", "Ground"],
"garchomp": [4, "Dragon", "Ground"],
"munchlax": [4, "Normal", ""],
"riolu": [4, "Fighting", ""],
"lucario": [4, "Fighting", "Steel"],
"hippopotas": [4, "Ground", ""],
"hippowdon": [4, "Ground", ""],
"skorupi": [4, "Poison", "Bug"],
"drapion": [4, "Poison", "Dark"],
"croagunk": [4, "Poison", "Fighting"],
"toxicroak": [4, "Poison", "Fighting"],
"carnivine": [4, "Grass", ""],
"finneon": [4, "Water", ""],
"lumineon": [4, "Water", ""],
"mantyke": [4, "Water", "Flying"],
"snover": [4, "Grass", "Ice"],
"abomasnow": [4, "Grass", "Ice"],
"weavile": [4, "Dark", "Ice"],
"magnezone": [4, "Electric", "Steel"],
"lickilicky": [4, "Normal", ""],
"rhyperior": [4, "Ground", "Rock"],
"tangrowth": [4, "Grass", ""],
"electivire": [4, "Electric", ""],
"magmortar": [4, "Fire", ""],
"togekiss": [4, "Fairy", "Flying"],
"yanmega": [4, "Bug", "Flying"],
"leafeon": [4, "Grass", ""],
"glaceon": [4, "Ice", ""],
"gliscor": [4, "Ground", "Flying"],
"mamoswine": [4, "Ice", "Ground"],
"porygon-z": [4, "Normal", ""],
"gallade": [4, "Psychic", "Fighting"],
"probopass": [4, "Rock", "Steel"],
"dusknoir": [4, "Ghost", ""],
"froslass": [4, "Ice", "Ghost"],
"rotom": [4, "Electric", "Ghost"],
"uxie": [4, "Psychic", ""],
"mesprit": [4, "Psychic", ""],
"azelf": [4, "Psychic", ""],
"dialga": [4, "Steel", "Dragon"],
"palkia": [4, "Water", "Dragon"],
"heatran": [4, "Fire", "Steel"],
"regigigas": [4, "Normal", ""],
"giratina": [4, "Ghost", "Dragon"],
"cresselia": [4, "Psychic", ""],
"phione": [4, "Water", ""],
"manaphy": [4, "Water", ""],
"darkrai": [4, "Dark", ""],
"shaymin": [4, "Grass", ""],
"arceus": [4, "Normal", ""],
"victini": [5, "Psychic", "Fire"],
"snivy": [5, "Grass", ""],
"servine": [5, "Grass", ""],
"serperior": [5, "Grass", ""],
"tepig": [5, "Fire", ""],
"pignite": [5, "Fire", "Fighting"],
"emboar": [5, "Fire", "Fighting"],
"oshawott": [5, "Water", ""],
"dewott": [5, "Water", ""],
"samurott": [5, "Water", ""],
"patrat": [5, "Normal", ""],
"watchog": [5, "Normal", ""],
"lillipup": [5, "Normal", ""],
"herdier": [5, "Normal", ""],
"stoutland": [5, "Normal", ""],
"purrloin": [5, "Dark", ""],
"liepard": [5, "Dark", ""],
"pansage": [5, "Grass", ""],
"simisage": [5, "Grass", ""],
"pansear": [5, "Fire", ""],
"simisear": [5, "Fire", ""],
"panpour": [5, "Water", ""],
"simipour": [5, "Water", ""],
"munna": [5, "Psychic", ""],
"musharna": [5, "Psychic", ""],
"pidove": [5, "Normal", "Flying"],
"tranquill": [5, "Normal", "Flying"],
"unfezant": [5, "Normal", "Flying"],
"blitzle": [5, "Electric", ""],
"zebstrika": [5, "Electric", ""],
"roggenrola": [5, "Rock", ""],
"boldore": [5, "Rock", ""],
"gigalith": [5, "Rock", ""],
"woobat": [5, "Psychic", "Flying"],
"swoobat": [5, "Psychic", "Flying"],
"drilbur": [5, "Ground", ""],
"excadrill": [5, "Ground", "Steel"],
"audino": [5, "Normal", ""],
"timburr": [5, "Fighting", ""],
"gurdurr": [5, "Fighting", ""],
"conkeldurr": [5, "Fighting", ""],
"tympole": [5, "Water", ""],
"palpitoad": [5, "Water", "Ground"],
"seismitoad": [5, "Water", "Ground"],
"throh": [5, "Fighting", ""],
"sawk": [5, "Fighting", ""],
"sewaddle": [5, "Bug", "Grass"],
"swadloon": [5, "Bug", "Grass"],
"leavanny": [5, "Bug", "Grass"],
"venipede": [5, "Bug", "Poison"],
"whirlipede": [5, "Bug", "Poison"],
"scolipede": [5, "Bug", "Poison"],
"cottonee": [5, "Grass", "Fairy"],
"whimsicott": [5, "Grass", "Fairy"],
"petilil": [5, "Grass", ""],
"lilligant": [5, "Grass", ""],
"basculin": [5, "Water", ""],
"sandile": [5, "Ground", "Dark"],
"krokorok": [5, "Ground", "Dark"],
"krookodile": [5, "Ground", "Dark"],
"darumaka": [5, "Fire", ""],
"darmanitan": [5, "Fire", ""],
"maractus": [5, "Grass", ""],
"dwebble": [5, "Bug", "Rock"],
"crustle": [5, "Bug", "Rock"],
"scraggy": [5, "Dark", "Fighting"],
"scrafty": [5, "Dark", "Fighting"],
"sigilyph": [5, "Psychic", "Flying"],
"yamask": [5, "Ghost", ""],
"cofagrigus": [5, "Ghost", ""],
"tirtouga": [5, "Water", "Rock"],
"carracosta": [5, "Water", "Rock"],
"archen": [5, "Rock", "Flying"],
"archeops": [5, "Rock", "Flying"],
"trubbish": [5, "Poison", ""],
"garbodor": [5, "Poison", ""],
"zorua": [5, "Dark", ""],
"zoroark": [5, "Dark", ""],
"minccino": [5, "Normal", ""],
"cinccino": [5, "Normal", ""],
"gothita": [5, "Psychic", ""],
"gothorita": [5, "Psychic", ""],
"gothitelle": [5, "Psychic", ""],
"solosis": [5, "Psychic", ""],
"duosion": [5, "Psychic", ""],
"reuniclus": [5, "Psychic", ""],
"ducklett": [5, "Water", "Flying"],
"swanna": [5, "Water", "Flying"],
"vanillite": [5, "Ice", ""],
"vanillish": [5, "Ice", ""],
"vanilluxe": [5, "Ice", ""],
"deerling": [5, "Normal", "Grass"],
"sawsbuck": [5, "Normal", "Grass"],
"emolga": [5, "Electric", "Flying"],
"karrablast": [5, "Bug", ""],
"escavalier": [5, "Bug", "Steel"],
"foongus": [5, "Grass", "Poison"],
"amoonguss": [5, "Grass", "Poison"],
"frillish": [5, "Water", "Ghost"],
"jellicent": [5, "Water", "Ghost"],
"alomomola": [5, "Water", ""],
"joltik": [5, "Bug", "Electric"],
"galvantula": [5, "Bug", "Electric"],
"ferroseed": [5, "Grass", "Steel"],
"ferrothorn": [5, "Grass", "Steel"],
"klink": [5, "Steel", ""],
"klang": [5, "Steel", ""],
"klinklang": [5, "Steel", ""],
"tynamo": [5, "Electric", ""],
"eelektrik": [5, "Electric", ""],
"eelektross": [5, "Electric", ""],
"elgyem": [5, "Psychic", ""],
"beheeyem": [5, "Psychic", ""],
"litwick": [5, "Ghost", "Fire"],
"lampent": [5, "Ghost", "Fire"],
"chandelure": [5, "Ghost", "Fire"],
"axew": [5, "Dragon", ""],
"fraxure": [5, "Dragon", ""],
"haxorus": [5, "Dragon", ""],
"cubchoo": [5, "Ice", ""],
"beartic": [5, "Ice", ""],
"cryogonal": [5, "Ice", ""],
"shelmet": [5, "Bug", ""],
"accelgor": [5, "Bug", ""],
"stunfisk": [5, "Ground", "Electric"],
"mienfoo": [5, "Fighting", ""],
"mienshao": [5, "Fighting", ""],
"druddigon": [5, "Dragon", ""],
"golett": [5, "Ground", "Ghost"],
"golurk": [5, "Ground", "Ghost"],
"pawniard": [5, "Dark", "Steel"],
"bisharp": [5, "Dark", "Steel"],
"bouffalant": [5, "Normal", ""],
"rufflet": [5, "Normal", "Flying"],
"braviary": [5, "Normal", "Flying"],
"vullaby": [5, "Dark", "Flying"],
"mandibuzz": [5, "Dark", "Flying"],
"heatmor": [5, "Fire", ""],
"durant": [5, "Bug", "Steel"],
"deino": [5, "Dark", "Dragon"],
"zweilous": [5, "Dark", "Dragon"],
"hydreigon": [5, "Dark", "Dragon"],
"larvesta": [5, "Bug", "Fire"],
"volcarona": [5, "Bug", "Fire"],
"cobalion": [5, "Steel", "Fighting"],
"terrakion": [5, "Rock", "Fighting"],
"virizion": [5, "Grass", "Fighting"],
"tornadus": [5, "Flying", ""],
"thundurus": [5, "Electric", "Flying"],
"reshiram": [5, "Dragon", "Fire"],
"zekrom": [5, "Dragon", "Electric"],
"landorus": [5, "Ground", "Flying"],
"kyurem": [5, "Dragon", "Ice"],
"keldeo": [5, "Water", "Fighting"],
"meloetta": [5, "Normal", "Psychic"],
"genesect": [5, "Bug", "Steel"],
"chespin": [6, "Grass", ""],
"quilladin": [6, "Grass", ""],
"chesnaught": [6, "Grass", "Fighting"],
"fennekin": [6, "Fire", ""],
"braixen": [6, "Fire", ""],
"delphox": [6, "Fire", "Psychic"],
"froakie": [6, "Water", ""],
"frogadier": [6, "Water", ""],
"greninja": [6, "Water", "Dark"],
"bunnelby": [6, "Normal", ""],
"diggersby": [6, "Normal", "Ground"],
"fletchling": [6, "Normal", "Flying"],
"fletchinder": [6, "Fire", "Flying"],
"talonflame": [6, "Fire", "Flying"],
"scatterbug": [6, "Bug", ""],
"spewpa": [6, "Bug", ""],
"vivillon": [6, "Bug", "Flying"],
"litleo": [6, "Fire", "Normal"],
"pyroar": [6, "Fire", "Normal"],
"flabébé": [6, "Fairy", ""],
"floette": [6, "Fairy", ""],
"florges": [6, "Fairy", ""],
"skiddo": [6, "Grass", ""],
"gogoat": [6, "Grass", ""],
"pancham": [6, "Fighting", ""],
"pangoro": [6, "Fighting", "Dark"],
"furfrou": [6, "Normal", ""],
"espurr": [6, "Psychic", ""],
"meowstic": [6, "Psychic", ""],
"honedge": [6, "Steel", "Ghost"],
"doublade": [6, "Steel", "Ghost"],
"aegislash": [6, "Steel", "Ghost"],
"spritzee": [6, "Fairy", ""],
"aromatisse": [6, "Fairy", ""],
"swirlix": [6, "Fairy", ""],
"slurpuff": [6, "Fairy", ""],
"inkay": [6, "Dark", "Psychic"],
"malamar": [6, "Dark", "Psychic"],
"binacle": [6, "Rock", "Water"],
"barbaracle": [6, "Rock", "Water"],
"skrelp": [6, "Poison", "Water"],
"dragalge": [6, "Poison", "Dragon"],
"clauncher": [6, "Water", ""],
"clawitzer": [6, "Water", ""],
"helioptile": [6, "Electric", "Normal"],
"heliolisk": [6, "Electric", "Normal"],
"tyrunt": [6, "Rock", "Dragon"],
"tyrantrum": [6, "Rock", "Dragon"],
"amaura": [6, "Rock", "Ice"],
"aurorus": [6, "Rock", "Ice"],
"sylveon": [6, "Fairy", ""],
"hawlucha": [6, "Fighting", "Flying"],
"dedenne": [6, "Electric", "Fairy"],
"carbink": [6, "Rock", "Fairy"],
"goomy": [6, "Dragon", ""],
"sliggoo": [6, "Dragon", ""],
"goodra": [6, "Dragon", ""],
"klefki": [6, "Steel", "Fairy"],
"phantump": [6, "Ghost", "Grass"],
"trevenant": [6, "Ghost", "Grass"],
"pumpkaboo": [6, "Ghost", "Grass"],
"gourgeist": [6, "Ghost", "Grass"],
"bergmite": [6, "Ice", ""],
"avalugg": [6, "Ice", ""],
"noibat": [6, "Flying", "Dragon"],
"noivern": [6, "Flying", "Dragon"],
"xerneas": [6, "Fairy", ""],
"yveltal": [6, "Dark", "Flying"],
"zygarde50% forme": [6, "Dragon", "Ground"],
"diancie": [6, "Rock", "Fairy"],
"hoopa": [6, "Psychic", "Ghost"],
"volcanion": [6, "Fire", "Water"],
"rowlet": [7, "Grass", "Flying"],
"dartrix": [7, "Grass", "Flying"],
"decidueye": [7, "Grass", "Ghost"],
"litten": [7, "Fire", ""],
"torracat": [7, "Fire", ""],
"incineroar": [7, "Fire", "Dark"],
"popplio": [7, "Water", ""],
"brionne": [7, "Water", ""],
"primarina": [7, "Water", "Fairy"],
"pikipek": [7, "Normal", "Flying"],
"trumbeak": [7, "Normal", "Flying"],
"toucannon": [7, "Normal", "Flying"],
"yungoos": [7, "Normal", ""],
"gumshoos": [7, "Normal", ""],
"grubbin": [7, "Bug", ""],
"charjabug": [7, "Bug", "Electric"],
"vikavolt": [7, "Bug", "Electric"],
"crabrawler": [7, "Fighting", ""],
"crabominable": [7, "Fighting", "Ice"],
"oricorio": [7, "Fire", "Flying"],
"cutiefly": [7, "Bug", "Fairy"],
"ribombee": [7, "Bug", "Fairy"],
"rockruff": [7, "Rock", ""],
"lycanroc": [7, "Rock", ""],
"wishiwashi": [7, "Water", ""],
"mareanie": [7, "Poison", "Water"],
"toxapex": [7, "Poison", "Water"],
"mudbray": [7, "Ground", ""],
"mudsdale": [7, "Ground", ""],
"dewpider": [7, "Water", "Bug"],
"araquanid": [7, "Water", "Bug"],
"fomantis": [7, "Grass", ""],
"lurantis": [7, "Grass", ""],
"morelull": [7, "Grass", "Fairy"],
"shiinotic": [7, "Grass", "Fairy"],
"salandit": [7, "Poison", "Fire"],
"salazzle": [7, "Poison", "Fire"],
"stufful": [7, "Normal", "Fighting"],
"bewear": [7, "Normal", "Fighting"],
"bounsweet": [7, "Grass", ""],
"steenee": [7, "Grass", ""],
"tsareena": [7, "Grass", ""],
"comfey": [7, "Fairy", ""],
"oranguru": [7, "Normal", "Psychic"],
"passimian": [7, "Fighting", ""],
"wimpod": [7, "Bug", "Water"],
"golisopod": [7, "Bug", "Water"],
"sandygast": [7, "Ghost", "Ground"],
"palossand": [7, "Ghost", "Ground"],
"pyukumuku": [7, "Water", ""],
"type: null": [7, "Normal", ""],
"silvally": [7, "Normal", ""],
"minior": [7, "Rock", "Flying"],
"komala": [7, "Normal", ""],
"turtonator": [7, "Fire", "Dragon"],
"togedemaru": [7, "Electric", "Steel"],
"mimikyu": [7, "Ghost", "Fairy"],
"bruxish": [7, "Water", "Psychic"],
"drampa": [7, "Normal", "Dragon"],
"dhelmise": [7, "Ghost", "Grass"],
"jangmo-o": [7, "Dragon", ""],
"hakamo-o": [7, "Dragon", "Fighting"],
"kommo-o": [7, "Dragon", "Fighting"],
"tapu koko": [7, "Electric", "Fairy"],
"tapu lele": [7, "Psychic", "Fairy"],
"tapu bulu": [7, "Grass", "Fairy"],
"tapu fini": [7, "Water", "Fairy"],
"cosmog": [7, "Psychic", ""],
"cosmoem": [7, "Psychic", ""],
"solgaleo": [7, "Psychic", "Steel"],
"lunala": [7, "Psychic", "Ghost"],
"nihilego": [7, "Rock", "Poison"],
"buzzwole": [7, "Bug", "Fighting"],
"pheromosa": [7, "Bug", "Fighting"],
"xurkitree": [7, "Electric", ""],
"celesteela": [7, "Steel", "Flying"],
"kartana": [7, "Grass", "Steel"],
"guzzlord": [7, "Dark", "Dragon"],
"necrozma": [7, "Psychic", ""],
"magearna": [7, "Steel", "Fairy"],
"marshadow": [7, "Fighting", "Ghost"],
"poipole": [7, "Poison", ""],
"naganadel": [7, "Poison", "Dragon"],
"stakataka": [7, "Rock", "Steel"],
"blacephalon": [7, "Fire", "Ghost"],
"zeraora": [7, "Electric", ""],
"meltan": [7, "Steel", ""],
"melmetal": [7, "Steel", ""],
"grookey": [8, "Grass", ""],
"thwackey": [8, "Grass", ""],
"rillaboom": [8, "Grass", ""],
"scorbunny": [8, "Fire", ""],
"raboot": [8, "Fire", ""],
"cinderace": [8, "Fire", ""],
"sobble": [8, "Water", ""],
"drizzile": [8, "Water", ""],
"inteleon": [8, "Water", ""],
"skwovet": [8, "Normal", ""],
"greedent": [8, "Normal", ""],
"rookidee": [8, "Flying", ""],
"corvisquire": [8, "Flying", ""],
"corviknight": [8, "Flying", "Steel"],
"blipbug": [8, "Bug", ""],
"dottler": [8, "Bug", "Psychic"],
"orbeetle": [8, "Bug", "Psychic"],
"nickit": [8, "Dark", ""],
"thievul": [8, "Dark", ""],
"gossifleur": [8, "Grass", ""],
"eldegoss": [8, "Grass", ""],
"wooloo": [8, "Normal", ""],
"dubwool": [8, "Normal", ""],
"chewtle": [8, "Water", ""],
"drednaw": [8, "Water", "Rock"],
"yamper": [8, "Electric", ""],
"boltund": [8, "Electric", ""],
"rolycoly": [8, "Rock", ""],
"carkol": [8, "Rock", "Fire"],
"coalossal": [8, "Rock", "Fire"],
"applin": [8, "Grass", "Dragon"],
"flapple": [8, "Grass", "Dragon"],
"appletun": [8, "Grass", "Dragon"],
"silicobra": [8, "Ground", ""],
"sandaconda": [8, "Ground", ""],
"cramorant": [8, "Flying", "Water"],
"arrokuda": [8, "Water", ""],
"barraskewda": [8, "Water", ""],
"toxel": [8, "Electric", "Poison"],
"toxtricity": [8, "Electric", "Poison"],
"sizzlipede": [8, "Fire", "Bug"],
"centiskorch": [8, "Fire", "Bug"],
"clobbopus": [8, "Fighting", ""],
"grapploct": [8, "Fighting", ""],
"sinistea": [8, "Ghost", ""],
"polteageist": [8, "Ghost", ""],
"hatenna": [8, "Psychic", ""],
"hattrem": [8, "Psychic", ""],
"hatterene": [8, "Psychic", "Fairy"],
"impidimp": [8, "Dark", "Fairy"],
"morgrem": [8, "Dark", "Fairy"],
"grimmsnarl": [8, "Dark", "Fairy"],
"obstagoon": [8, "Dark", "Normal"],
"perrserker": [8, "Steel", ""],
"cursola": [8, "Ghost", ""],
"sirfetch'd": [8, "Fighting", ""],
"mr. rime": [8, "Ice", "Psychic"],
"runerigus": [8, "Ground", "Ghost"],
"milcery": [8, "Fairy", ""],
"alcremie": [8, "Fairy", ""],
"falinks": [8, "Fighting", ""],
"pincurchin": [8, "Electric", ""],
"snom": [8, "Ice", "Bug"],
"frosmoth": [8, "Ice", "Bug"],
"stonjourner": [8, "Rock", ""],
"eiscue": [8, "Ice", ""],
"indeedee": [8, "Psychic", "Normal"],
"morpeko": [8, "Electric", "Dark"],
"cufant": [8, "Steel", ""],
"copperajah": [8, "Steel", ""],
"dracozolt": [8, "Electric", "Dragon"],
"arctozolt": [8, "Electric", "Ice"],
"dracovish": [8, "Water", "Dragon"],
"arctovish": [8, "Water", "Ice"],
"duraludon": [8, "Steel", "Dragon"],
"dreepy": [8, "Dragon", "Ghost"],
"drakloak": [8, "Dragon", "Ghost"],
"dragapult": [8, "Dragon", "Ghost"],
"zacian": [8, "Fairy", ""],
"zamazenta": [8, "Fighting", ""],
"eternatus": [8, "Poison", "Dragon"],
"kubfu": [8, "Fighting", ""],
"urshifu": [8, "Fighting", "Dark"],
"zarude": [8, "Dark", "Grass"],
"regieleki": [8, "Electric", ""],
"regidrago": [8, "Dragon", ""],
"glastrier": [8, "Ice", ""],
"spectrier": [8, "Ghost", ""],
"calyrex": [8, "Psychic", "Grass"],
"wyrdeer": [8, "Normal", "Psychic"],
"kleavor": [8, "Bug", "Rock"],
"ursaluna": [8, "Ground", "Normal"],
"basculegion": [8, "Water", "Ghost"],
"sneasler": [8, "Fighting", "Poison"],
"overqwil": [8, "Dark", "Poison"],
"enamorus": [8, "Fairy", "Flying"],
"sprigatito": [9, "Grass", ""],
"floragato": [9, "Grass", ""],
"meowscarada": [9, "Grass", "Dark"],
"fuecoco": [9, "Fire", ""],
"crocalor": [9, "Fire", ""],
"skeledirge": [9, "Fire", "Ghost"],
"quaxly": [9, "Water", ""],
"quaxwell": [9, "Water", ""],
"quaquaval": [9, "Water", "Fighting"],
"lechonk": [9, "Normal", ""],
"oinkologne": [9, "Normal", ""],
"tarountula": [9, "Bug", ""],
"spidops": [9, "Bug", ""],
"nymble": [9, "Bug", ""],
"lokix": [9, "Bug", "Dark"],
"pawmi": [9, "Electric", ""],
"pawmo": [9, "Electric", "Fighting"],
"pawmot": [9, "Electric", "Fighting"],
"tandemaus": [9, "Normal", ""],
"maushold": [9, "Normal", ""],
"fidough": [9, "Fairy", ""],
"dachsbun": [9, "Fairy", ""],
"smoliv": [9, "Grass", "Normal"],
"dolliv": [9, "Grass", "Normal"],
"arboliva": [9, "Grass", "Normal"],
"squawkabilly": [9, "Normal", "Flying"],
"nacli": [9, "Rock", ""],
"naclstack": [9, "Rock", ""],
"garganacl": [9, "Rock", ""],
"charcadet": [9, "Fire", ""],
"armarouge": [9, "Fire", "Psychic"],
"ceruledge": [9, "Fire", "Ghost"],
"tadbulb": [9, "Electric", ""],
"bellibolt": [9, "Electric", ""],
"wattrel": [9, "Electric", "Flying"],
"kilowattrel": [9, "Electric", "Flying"],
"maschiff": [9, "Dark", ""],
"mabosstiff": [9, "Dark", ""],
"shroodle": [9, "Poison", "Normal"],
"grafaiai": [9, "Poison", "Normal"],
"bramblin": [9, "Grass", "Ghost"],
"brambleghast": [9, "Grass", "Ghost"],
"toedscool": [9, "Ground", "Grass"],
"toedscruel": [9, "Ground", "Grass"],
"klawf": [9, "Rock", ""],
"capsakid": [9, "Grass", ""],
"scovillain": [9, "Grass", "Fire"],
"rellor": [9, "Bug", ""],
"rabsca": [9, "Bug", "Psychic"],
"flittle": [9, "Psychic", ""],
"espathra": [9, "Psychic", ""],
"tinkatink": [9, "Fairy", "Steel"],
"tinkatuff": [9, "Fairy", "Steel"],
"tinkaton": [9, "Fairy", "Steel"],
"wiglett": [9, "Water", ""],
"wugtrio": [9, "Water", ""],
"bombirdier": [9, "Flying", "Dark"],
"finizen": [9, "Water", ""],
"palafin": [9, "Water", ""],
"varoom": [9, "Steel", "Poison"],
"revavroom": [9, "Steel", "Poison"],
"cyclizar": [9, "Dragon", "Normal"],
"orthworm": [9, "Steel", ""],
"glimmet": [9, "Rock", "Poison"],
"glimmora": [9, "Rock", "Poison"],
"greavard": [9, "Ghost", ""],
"houndstone": [9, "Ghost", ""],
"flamigo": [9, "Flying", "Fighting"],
"cetoddle": [9, "Ice", ""],
"cetitan": [9, "Ice", ""],
"veluza": [9, "Water", "Psychic"],
"dondozo": [9, "Water", ""],
"tatsugiri": [9, "Dragon", "Water"],
"annihilape": [9, "Fighting", "Ghost"],
"clodsire": [9, "Poison", "Ground"],
"farigiraf": [9, "Normal", "Psychic"],
"dudunsparce": [9, "Normal", ""],
"kingambit": [9, "Dark", "Steel"],
"great tusk": [9, "Ground", "Fighting"],
"scream tail": [9, "Fairy", "Psychic"],
"brute bonnet": [9, "Grass", "Dark"],
"flutter mane": [9, "Ghost", "Fairy"],
"slither wing": [9, "Bug", "Fighting"],
"sandy shocks": [9, "Electric", "Ground"],
"iron treads": [9, "Ground", "Steel"],
"iron bundle": [9, "Ice", "Water"],
"iron hands": [9, "Fighting", "Electric"],
"iron jugulis": [9, "Dark", "Flying"],
"iron moth": [9, "Fire", "Poison"],
"iron thorns": [9, "Rock", "Electric"],
"frigibax": [9, "Dragon", "Ice"],
"arctibax": [9, "Dragon", "Ice"],
"baxcalibur": [9, "Dragon", "Ice"],
"gimmighoul": [9, "Ghost", ""],
"gholdengo": [9, "Steel", "Ghost"],
"wo-chien": [9, "Dark", "Grass"],
"chien-pao": [9, "Dark", "Ice"],
"ting-lu": [9, "Dark", "Ground"],
"chi-yu": [9, "Dark", "Fire"],
"roaring moon": [9, "Dragon", "Dark"],
"iron valiant": [9, "Fairy", "Fighting"],
"koraidon": [9, "Fighting", "Dragon"],
"miraidon": [9, "Electric", "Dragon"],
"walking wake": [9, "Water", "Dragon"],
"iron leaves": [9, "Grass", "Psychic"],
"dipplin": [9, "Grass", "Dragon"],
"poltchageist": [9, "Grass", "Ghost"],
"sinistcha": [9, "Grass", "Ghost"],
"okidogi": [9, "Poison", "Fighting"],
"munkidori": [9, "Poison", "Psychic"],
"fezandipiti": [9, "Poison", "Fairy"],
"ogerpon": [9, "Grass", ""],
"archaludon": [9, "Steel", "Dragon"],
"hydrapple": [9, "Grass", "Dragon"],
"gouging fire": [9, "Fire", "Dragon"],
"raging bolt": [9, "Electric", "Dragon"],
"iron boulder": [9, "Rock", "Psychic"],
"iron crown": [9, "Steel", "Psychic"],
"terapagos": [9, "Normal", ""],
"pecharunt": [9, "Poison", "Ghost"],
"rattata (alolan)": [1, "Dark", "Normal"],
"raticate (alolan)": [1, "Dark", "Normal"],
"raichu (alolan)": [1, "Electric", "Psychic"],
"sandshrew (alolan)": [1, "Ice", ""],
"sandslash (alolan)": [1, "Ice", ""],
"vulpix (alolan)": [1, "Ice", ""],
"ninetales (alolan)": [1, "Ice", "Fairy"],
"diglett (alolan)": [1, "Ground", "Steel"],
"dugtrio (alolan)": [1, "Ground", "Steel"],
"meowth (alolan)": [1, "Dark", ""],
"meowth (galarian)": [1, "Steel", ""],
"persian (alolan)": [1, "Dark", ""],
"growlithe (hisuian)": [1, "Fire", "Rock"],
"arcanine (hisuian)": [1, "Fire", "Rock"],
"geodude (alolan)": [1, "Rock", "Electric"],
"graveler (alolan)": [1, "Rock", "Electric"],
"golem (alolan)": [1, "Rock", "Electric"],
"ponyta (galarian)": [1, "Psychic", ""],
"rapidash (galarian)": [1, "Psychic", "Fairy"],
"slowpoke (galarian)": [1, "Psychic", ""],
"slowbro (galarian)": [1, "Poison", "Psychic"],
"farfetch'd (galarian)": [1, "Fighting", ""],
"grimer (alolan)": [1, "Poison", "Dark"],
"muk (alolan)": [1, "Poison", "Dark"],
"voltorb (hisuian)": [1, "Electric", "Grass"],
"electrode (hisuian)": [1, "Electric", "Grass"],
"exeggutor (alolan)": [1, "Grass", "Dragon"],
"marowak (alolan)": [1, "Fire", "Ghost"],
"weezing (galarian)": [1, "Poison", "Fairy"],
"mr. mime (galarian)": [1, "Ice", "Psychic"],
"tauros (paldean)": [1, "Fighting", ""],
"articuno (galarian)": [1, "Psychic", "Flying"],
"zapdos (galarian)": [1, "Fighting", "Flying"],
"moltres (galarian)": [1, "Dark", "Flying"],
"typhlosion (hisuian)": [2, "Fire", "Ghost"],
"wooper (paldean)": [2, "Poison", "Ground"],
"slowking (galarian)": [2, "Poison", "Psychic"],
"qwilfish (hisuian)": [2, "Dark", "Poison"],
"sneasel (hisuian)": [2, "Fighting", "Poison"],
"corsola (galarian)": [2, "Ghost", ""],
"zigzagoon (galarian)": [3, "Dark", "Normal"],
"linoone (galarian)": [3, "Dark", "Normal"],
"samurott (hisuian)": [5, "Water", "Dark"],
"lilligant (hisuian)": [5, "Grass", "Fighting"],
"darumaka (galarian)": [5, "Ice", ""],
"darmanitan (galarian)": [5, "Ice", ""],
"yamask (galarian)": [5, "Ground", "Ghost"],
"zorua (hisuian)": [5, "Normal", "Ghost"],
"zoroark (hisuian)": [5, "Normal", "Ghost"],
"stunfisk (galarian)": [5, "Ground", "Steel"],
"braviary (hisuian)": [5, "Psychic", "Flying"],
"sliggoo (hisuian)": [6, "Steel", "Dragon"],
"goodra (hisuian)": [6, "Steel", "Dragon"],
"avalugg (hisuian)": [6, "Ice", "Rock"],
"decidueye (hisuian)": [7, "Grass", "Fighting"]
};
function uid() {
return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function fmtTime(totalSeconds) {
totalSeconds = Math.max(0, Math.floor(totalSeconds));
var h = Math.floor(totalSeconds / 3600);
var m = Math.floor((totalSeconds % 3600) / 60);
var s = totalSeconds % 60;
if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
return m + 'm ' + String(s).padStart(2, '0') + 's';
}
function elapsedSeconds(hunt) {
var extra = 0;
if (hunt.running && hunt.runStart) {
extra = (Date.now() - hunt.runStart) / 1000;
}
return (hunt.accumulatedSeconds || 0) + extra;
}
function cumulativeProb(n, denom) {
if (!denom || denom <= 0) return 0;
var p = 1 - Math.pow(1 - 1 / denom, n);
return Math.max(0, Math.min(1, p));
}
/* ---------- sprite lookup (pokemondb.net) ---------- */
function pokemonSlug(name) {
return String(name || '')
.trim().toLowerCase()
.replace(/♀/g, '-f')
.replace(/♂/g, '-m')
.replace(/[.']/g, '')
.replace(/[:\s]+/g, '-')
.replace(/[^a-z0-9-]/g, '')
.replace(/-+/g, '-')
.replace(/^-|-$/g, '');
}
function pokemonGenOf(name) {
var info = SPECIES_INFO[normName(name)];
return info ? info[0] : null;
}
// Builds the slug Pokemon Showdown's sprite CDN expects. Unlike
// pokemonSlug() (pokemondb's convention, which keeps hyphens in base
// names like "ho-oh"), Showdown strips ALL punctuation from the base
// species name - "Kommo-o" -> "kommoo", "Farfetch'd" -> "farfetchd" - and
// only re-introduces a hyphen for an actual form suffix, e.g.
// "raichu-alola". Reuses the same (Alolan)/(Galarian)/etc tag parsing and
// suffix map as pokespriteSlug() above, since Showdown uses the same
// suffix words for regional forms.
function showdownSlug(name) {
var m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(String(name || '').trim());
var base = m ? m[1] : name;
var suffix = m ? REGION_TAG_TO_POKESPRITE_SUFFIX[m[2].trim().toLowerCase()] : null;
var slug = String(base || '')
.trim().toLowerCase()
.replace(/♀/g, 'f')
.replace(/♂/g, 'm')
.replace(/[^a-z0-9]/g, '');
if (!slug) return '';
return suffix ? (slug + '-' + suffix) : slug;
}
// Ordered list of sprite URLs to try for a given Pokemon, based on its
// generation. Gen 1-5 -> animated Black & White 2 gif first, then animated
// Black & White gif, then falling back to the static Black & White shiny
// if no animated sprite exists for that Pokemon in either set. Gen 6-8 ->
// Pokemon Showdown's animated sprite CDN first (the same "3D model"
// render-turntable style Project Pokemon's sprite index credits to the
// community/pkparaiso - Showdown hosts an actively-maintained copy of
// this same art at play.pokemonshowdown.com/sprites/ani-shiny/, which is
// far more reliable to hotlink than a small fansite), falling back to the
// static renders this app used before (X/Y for gen 6, Sun/Moon then
// Ultra Sun/Ultra Moon for gen 7, HOME for gen 8) if a specific
// Pokemon/form isn't in Showdown's set. Gen 9 -> Pokemon HOME. All shiny.
function shinySpriteUrls(name) {
var slug = pokemonSlug(name);
if (!slug) return [];
var gen = pokemonGenOf(name);
var base = 'https://img.pokemondb.net/sprites/';
if (gen === 6 || gen === 7 || gen === 8) {
var sdSlug = showdownSlug(name);
var animated = sdSlug ? ['https://play.pokemonshowdown.com/sprites/ani-shiny/' + sdSlug + '.gif'] : [];
var staticFallback =
(gen === 6) ? [base + 'x-y/shiny/' + slug + '.png'] :
(gen === 7) ? [base + 'sun-moon/shiny/' + slug + '.png', base + 'ultra-sun-ultra-moon/shiny/' + slug + '.png'] : [base + 'home/shiny/' + slug + '.png'];
return animated.concat(staticFallback);
}
if (gen === 9) return [base + 'home/shiny/' + slug + '.png'];
// gen 1-5, and unknown/undated Pokemon: try pokemondb's Black/White 2
// animated shiny sprite first (the set requested), then Black/White,
// then the static Black/White shiny. Showdown's "ani-shiny" set (which
// covers the whole dex, not just gen 6-8) is kept as a fallback after
// those - img.pokemondb.net has been known to block hotlinked requests
// (see their /sprites page: "linking directly to our images... uses
// bandwidth and costs us money"), so if the pokemondb URLs 403 in a
// given browser/network, Showdown still fills in rather than falling
// all the way through to the letter placeholder.
var slugForShowdown = showdownSlug(name);
var showdownFallback = slugForShowdown ? ['https://play.pokemonshowdown.com/sprites/ani-shiny/' + slugForShowdown + '.gif'] : [];
return [
base + 'black-white-2/anim/shiny/' + slug + '.gif',
base + 'black-white/anim/shiny/' + slug + '.gif'
].concat(showdownFallback, [
base + 'black-white/shiny/' + slug + '.png'
]);
}
// Maps the "(Alolan)"/"(Galarian)"/"(Hisuian)"/"(Paldean)" tag used in this
// app's display names to the suffix PokeSprite itself uses in its
// filenames (e.g. "raichu-alola.png", not "raichu-alolan.png").
var REGION_TAG_TO_POKESPRITE_SUFFIX = {
'alolan': 'alola',
'galarian': 'galar',
'hisuian': 'hisui',
'paldean': 'paldea'
};
// Builds the PokeSprite pixel-sprite slug for a display name. Unlike
// pokemonSlug() (which targets pokemondb's naming), this maps regional
// variant tags to PokeSprite's own suffixes so the pixel sprite actually
// resolves instead of guaranteed-404ing on every single variant.
function pokespriteSlug(name) {
var m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(String(name || '').trim());
if (m) {
var base = pokemonSlug(m[1]);
var suffix = REGION_TAG_TO_POKESPRITE_SUFFIX[m[2].trim().toLowerCase()];
return suffix ? (base + '-' + suffix) : base;
}
return pokemonSlug(name);
}
// Ordered sprite URLs for the Living Dex species chips: the PokeSprite
// pixel box sprite first (hotlinked from msikma/pokesprite on GitHub via
// the jsdelivr CDN - not stored in this project, just referenced), using
// the "pokemon-gen8" set which covers every base species plus regional
// forms (Alolan/Galarian/Hisuian) through Legends: Arceus. Only Pokemon or
// forms PokeSprite genuinely doesn't have pixel art for (mainly the
// Paldean-exclusive species/forms, which postdate PokeSprite's last sync)
// fall back to HOME's 3D render. Pass shiny=true for the Shiny Living Dex
// tab to use the shiny variant.

function dexEntrySpriteUrls(name, shiny) {
var slug = pokemonSlug(name);
if (!slug) return [];
var pixelSlug = pokespriteSlug(name);
var pixel = 'https://cdn.jsdelivr.net/gh/msikma/pokesprite@master/pokemon-gen8/' + (shiny ? 'shiny' : 'regular') + '/' + pixelSlug + '.png';
var home = 'https://img.pokemondb.net/sprites/home/' + (shiny ? 'shiny' : 'normal') + '/' + slug + '.png';
return [pixel, home];
}
// Live "evolves from" lookup via PokeAPI, used for the catch confirmation
// card. This app doesn't carry a hand-built evolution chain table (that's
// impractical to maintain for 1000+ species by hand), so instead this
// makes a single lightweight request per species to a free, CORS-enabled
// public API and reads evolves_from_species off the response. Regional
// variant tags like "(Alolan)" are stripped since PokeAPI's evolution
// data lives on the base species. Results are cached in-memory so a given
// species is only ever fetched once per session, and any failure (offline,
// unmapped slug, etc.) resolves to null rather than throwing, so callers
// can just hide the line rather than show an error.
var _evolvesFromCache = {};
function fetchEvolvesFrom(name) {
var m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(String(name || '').trim());
var base = m ? m[1] : name;
var slug = pokemonSlug(base);
if (!slug) return Promise.resolve(null);
if (Object.prototype.hasOwnProperty.call(_evolvesFromCache, slug)) {
return Promise.resolve(_evolvesFromCache[slug]);
}
return fetch('https://pokeapi.co/api/v2/pokemon-species/' + slug + '/')
.then(function(res) {
if (!res.ok) throw new Error('pokeapi lookup failed');
return res.json();
})
.then(function(data) {
var from = data && data.evolves_from_species ? data.evolves_from_species.name : null;
var pretty = from ? from.charAt(0).toUpperCase() + from.slice(1).replace(/-/g, ' ') : null;
_evolvesFromCache[slug] = pretty;
return pretty;
})
.catch(function() {
return null;
});
}
// Walks a PokeAPI evolution-chain tree looking for the node whose species
// slug matches targetSlug, returning its depth (0 = the base/basic form,
// 1 = first evolution, 2 = second evolution, etc). Returns null if the
// species isn't found in the chain (shouldn't normally happen).
function findStageInChain(node, targetSlug, depth) {
if (!node) return null;
if (node.species && node.species.name === targetSlug) return depth;
var evolvesTo = node.evolves_to || [];
for (var i = 0; i < evolvesTo.length; i++) {
var found = findStageInChain(evolvesTo[i], targetSlug, depth + 1);
if (found !== null) return found;
}
return null;
}
function stageLabel(stage) {
if (stage === 0) return 'Basic';
if (stage === null || stage === undefined) return null;
return 'Stage ' + stage;
}
// Like fetchEvolvesFrom, but also resolves which stage of its evolution
// line the species is (Basic / Stage 1 / Stage 2...) by fetching the
// evolution chain and walking it. One extra request per species (cached
// alongside the "evolves from" lookup, in-memory, per session), and any
// failure just resolves stage to null so callers can hide the badge.
var _evoStageCache = {};
function fetchEvoStage(name) {
var m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(String(name || '').trim());
var base = m ? m[1] : name;
var slug = pokemonSlug(base);
if (!slug) return Promise.resolve(null);
if (Object.prototype.hasOwnProperty.call(_evoStageCache, slug)) {
return Promise.resolve(_evoStageCache[slug]);
}
return fetch('https://pokeapi.co/api/v2/pokemon-species/' + slug + '/')
.then(function(res) {
if (!res.ok) throw new Error('pokeapi lookup failed');
return res.json();
})
.then(function(data) {
var chainUrl = data && data.evolution_chain ? data.evolution_chain.url : null;
if (!chainUrl) return null;
return fetch(chainUrl)
.then(function(res2) {
if (!res2.ok) throw new Error('evolution chain lookup failed');
return res2.json();
})
.then(function(chainData) {
return findStageInChain(chainData.chain, slug, 0);
});
})
.then(function(stage) {
_evoStageCache[slug] = stage;
return stage;
})
.catch(function() {
return null;
});
}
// Per-generation zoom factor for sprite images. Different sprite sets
// (animated Black & White, Showdown's animated gifs, HOME renders...) have
// very different amounts of built-in transparent padding, so each
// generation can be scaled independently to look consistent in the
// fixed-size avatar boxes. Gen 6-8 were retuned for Showdown's animated
// gifs (tighter, more consistent framing than the old static renders) -
// nudge these if a particular Pokemon still looks off since Showdown's
// own sprite sizing has some inconsistency between older and newer
// additions. Edit any value here to resize just that generation's
// sprites everywhere they appear (hunt cards + Shiny Log). Unlisted/
// unknown generations fall back to DEFAULT_SPRITE_SCALE.
var GEN_SPRITE_SCALE = {
1: 1.15,
2: 1.15,
3: 1.15,
4: 1.15,
5: 1.2,
6: 1.05,
7: 1.05,
8: 1.05,
9: 0.95
};
var DEFAULT_SPRITE_SCALE = 1.45;
// Builds the <img>+fallback-letter markup for a Pokemon's shiny sprite,
// wiring up the ordered URL list above so onerror steps through each
// candidate before finally showing the letter placeholder.
function spriteMarkup(name) {
var urls = shinySpriteUrls(name);
var letter = escapeHtml((name || '?').trim().charAt(0).toUpperCase());
if (!urls.length) {
return '<span class="fallback-letter">' + letter + '</span>';
}
var gen = pokemonGenOf(name);
var scale = GEN_SPRITE_SCALE.hasOwnProperty(gen) ? GEN_SPRITE_SCALE[gen] : DEFAULT_SPRITE_SCALE;
var first = urls[0];
var rest = urls.slice(1);
return '<img src="' + first + '" data-fallbacks="' + escapeHtml(JSON.stringify(rest)) + '" alt="" loading="lazy" style="transform:scale(' + scale + ')" onerror="window.__spriteErr(this)">' +
'<span class="fallback-letter" style="display:none">' + letter + '</span>';
}
// Shared onerror handler: tries the next URL in data-fallbacks, or
// reveals the letter placeholder once the list is exhausted.
window.__spriteErr = function(img) {
var fallbacks = [];
try {
fallbacks = JSON.parse(img.getAttribute('data-fallbacks') || '[]');
} catch (e) {}
if (fallbacks.length) {
var next = fallbacks.shift();
img.setAttribute('data-fallbacks', JSON.stringify(fallbacks));
img.src = next;
} else {
img.style.display = 'none';
var sib = img.nextElementSibling;
if (sib) sib.style.display = 'flex';
}
};
// Builds a small sprite (no scale/zoom) with the same cascading
// fallback behavior, used for the Living Dex species chips.
function smallSpriteMarkup(name, urls) {
var letter = escapeHtml((name || '?').trim().charAt(0).toUpperCase());
if (!urls.length) {
return '<span class="fallback-letter">' + letter + '</span>';
}
var first = urls[0];
var rest = urls.slice(1);
return '<img src="' + first + '" data-fallbacks="' + escapeHtml(JSON.stringify(rest)) + '" alt="" loading="lazy" onerror="window.__spriteErr(this)">' +
'<span class="fallback-letter" style="display:none">' + letter + '</span>';
}
/* ---------- tabs ---------- */
var tabs = document.querySelectorAll('nav.tabs button');
var views = {
hunts: document.getElementById('view-hunts'),
collection: document.getElementById('view-collection'),
livingdex: document.getElementById('view-livingdex')
};
var dexClamshell = document.getElementById('dex-clamshell');
var BG_CLASS = {
hunts: 'bg-hunts',
collection: 'bg-log',
livingdex: 'bg-dex'
};
function setBodyBg(tab) {
document.body.classList.remove('bg-hunts', 'bg-log', 'bg-dex');
document.body.classList.add(BG_CLASS[tab] || 'bg-hunts');
}
// Active Hunts and Shiny Log are the two facing pages of one physical
// clamshell (see .dex-clamshell in style.css) - neither is ever
// display:none. Living Dex sits outside this clamshell entirely now: it's
// only reached via its nav button (see the tabs click handler below), and
// is shown/hidden with a plain display toggle in CSS rather than being a
// third stop on the swipeable track.
//   Active Hunts  --swipe left-->  Shiny Log
//   Shiny Log     --swipe right--> Active Hunts
//   Active Hunts  --swipe right--> (nothing further - first page)
//   Shiny Log     --swipe left-->  (nothing further - last page)
// NEXT_TAB/PREV_TAB only list the directions that actually go somewhere;
// a missing entry means that swipe direction has no destination and just
// springs back (see the RESIST damping in the swipe handler below).
var NEXT_TAB = { hunts: 'collection' };
var PREV_TAB = { collection: 'hunts' };
// Each tab's fixed stop along the track, in page-widths - matches the
// .dex-clamshell[data-active="..."] .dex-track rules in CSS-16. Living
// Dex has no entry here on purpose - it's not on the track, so a swipe
// gesture that starts there (see onStart below) is a no-op rather than
// something that tries to look up a position for it.
var TAB_POSITION = { hunts: 0, collection: 1 };
// Switches the active tab's nav state, data-active, aria-hidden, and
// background - everything that's safe to do immediately, with no
// dependency on later parts of the script. Kept separate from
// applyTabState() below because the very first call happens at init time,
// before things like dexOpenGens (declared further down this file) exist
// yet - calling the render pass that early throws (renderLivingDex reads
// dexOpenGens) and silently aborts the rest of this script, which is why
// swiping and the hunts list could look "gone": nothing after the
// throwing line ever ran, including the swipe handler setup below.
function syncTabChrome(tab) {
tabs.forEach(function(b) {
b.classList.remove('active');
if (b.dataset.tab === tab) b.classList.add('active');
});
dexClamshell.setAttribute('data-active', tab);
views.hunts.setAttribute('aria-hidden', tab === 'hunts' ? 'false' : 'true');
views.collection.setAttribute('aria-hidden', tab === 'collection' ? 'false' : 'true');
views.livingdex.setAttribute('aria-hidden', tab === 'livingdex' ? 'false' : 'true');
setBodyBg(tab);
}
// Switches the active tab: chrome (above) plus a full render. This is the
// entry point for changing tabs once the script has finished loading -
// the swipe handler and nav clicks below both call this.
function applyTabState(tab) {
syncTabChrome(tab);
renderAll();
}
function activateTab(tab) {
applyTabState(tab);
}
syncTabChrome('hunts');
tabs.forEach(function(btn) {
btn.addEventListener('click', function() {
activateTab(btn.dataset.tab);
});
});
// The silver pill on the Shiny Log screen (formerly decorative) jumps
// straight to Living Dex, now that there's no tab bar to reach it from
// directly.
['btn-log-to-livingdex-1'].forEach(function(id) {
var btn = document.getElementById(id);
if (btn) btn.addEventListener('click', function() {
activateTab('livingdex');
});
});
// Living Dex has no tab bar to get back out through either, so it gets
// its own explicit way back to Active Hunts.
var livingDexBackBtn = document.getElementById('btn-livingdex-back');
if (livingDexBackBtn) livingDexBackBtn.addEventListener('click', function() {
activateTab('hunts');
});
// ---------- swipe between Active Hunts <-> Shiny Log <-> Living Dex (mobile) ----------
// The clamshell always shows exactly one of these three "pages" as
// active, and the CSS already gives .dex-track a fixed resting transform
// per tab (see CSS-16 in style.css). Rather than waiting for a finished
// swipe gesture and then firing that transition cold, this drags the
// track's transform 1:1 with the finger (transition disabled mid-drag so
// there's no lag), then on release re-enables the transition and either
// finishes the slide (data-active flips to whichever neighbor was
// revealed) or springs back to where it started - both using the exact
// same transform values the CSS would land on, so there's no jump where
// the drag position and the resting position disagree.
(function setupClamshellSwipe() {
if (!dexClamshell) return;
var track = dexClamshell.querySelector('.dex-track');
if (!track) return;
var frame = dexClamshell.querySelector('.dex-frame');
var TRANSITION = 'transform 0.55s cubic-bezier(0.65, 0, 0.35, 1)';
var RESIST = 0.35; // damping applied when dragging past an edge (nothing to reveal)
var COMMIT_RATIO = 0.28; // fraction of width dragged before the swipe "sticks"
var COMMIT_VELOCITY = 0.5; // px/ms - fast flicks commit even if short
var DIRECTION_THRESHOLD = 8; // px moved before we decide horizontal vs vertical

// Let the browser handle vertical scrolling on its own; we only take
// over once a drag reveals itself as horizontal.
dexClamshell.style.touchAction = 'pan-y';

var startX = 0, startY = 0, startTime = 0;
var decided = false; // have we classified this gesture yet?
var dragging = false; // classified as horizontal, we're driving the transform
var fromTab = 'hunts';
var width = 1; // one page's width in px, measured fresh at drag start
var baseX = 0; // track's resting position (in px) for fromTab - -TAB_POSITION[fromTab] * width

// Only Shiny Log carries a margin-left fold at rest (see CSS-16) - it's
// what makes Active Hunts peek in on its left. Active Hunts sits flush
// (margin-left: 0).
function marginLeftFor(tab) {
return tab === 'collection' ? -24 : 0;
}

function resetDragStyles() {
track.style.transition = '';
track.style.transform = '';
if (frame) {
frame.style.transition = '';
frame.style.marginLeft = '';
}
}

function onStart(e) {
if (e.touches.length !== 1) return;
startX = e.touches[0].clientX;
startY = e.touches[0].clientY;
startTime = Date.now();
decided = false;
dragging = false;
fromTab = dexClamshell.getAttribute('data-active');
if (!(fromTab in TAB_POSITION)) { fromTab = null; return; } // Living Dex - not draggable
width = views[fromTab].offsetWidth || 1;
baseX = -TAB_POSITION[fromTab] * width;
// Shiny Log's resting transform gets a +24px compensation in CSS-16 (see
// style.css) to offset its own .dex-frame margin-left fold - match it
// here so a drag starting from Shiny Log begins from the exact same
// pixel position the page is actually resting at, instead of jumping
// 24px on the first frame.
if (fromTab === 'collection') baseX += 24;
}

function onMove(e) {
if (!fromTab) return; // started on Living Dex - nothing to drag
if (e.touches.length !== 1) return;
var dx = e.touches[0].clientX - startX;
var dy = e.touches[0].clientY - startY;
if (!decided) {
if (Math.abs(dx) < DIRECTION_THRESHOLD && Math.abs(dy) < DIRECTION_THRESHOLD) return;
decided = true;
dragging = Math.abs(dx) > Math.abs(dy);
if (dragging) {
track.style.transition = 'none';
if (frame) frame.style.transition = 'none';
}
}
if (!dragging) return; // vertical gesture - let native scroll handle it
if (e.cancelable) e.preventDefault(); // stop page rubber-banding while we drag
// Active Hunts has no swipe-right destination and Living Dex has no
// swipe-left destination (they're the first/last pages) - drag those
// directions with resistance so they read as "nothing further this way"
// rather than a full 1:1 reveal that never actually commits.
var canAdvance = (dx < 0 && !!NEXT_TAB[fromTab]) || (dx > 0 && !!PREV_TAB[fromTab]);
var effectiveDx = canAdvance ? dx : dx * RESIST;
effectiveDx = Math.max(-width, Math.min(width, effectiveDx));
track.style.transform = 'translateX(' + (baseX + effectiveDx) + 'px)';
// Eases the frame's margin-left fold in step with drag progress instead
// of leaving it pinned at fromTab's resting value for the whole drag, so
// the window's edge and the content sliding under it stay in sync the
// entire way, not just at rest.
if (frame) {
var neighborTab = dx < 0 ? NEXT_TAB[fromTab] : PREV_TAB[fromTab];
var fromMargin = marginLeftFor(fromTab);
var toMargin = neighborTab ? marginLeftFor(neighborTab) : fromMargin;
var progress = width ? Math.min(1, Math.abs(effectiveDx) / width) : 0;
frame.style.marginLeft = (fromMargin + (toMargin - fromMargin) * progress) + 'px';
}
}

function onEnd(e) {
if (!decided || !dragging) { decided = false; dragging = false; return; }
decided = false;
dragging = false;
var touch = e.changedTouches[0];
var dx = touch.clientX - startX;
var dt = Math.max(1, Date.now() - startTime);
var velocity = dx / dt;
var committed = Math.abs(dx) > width * COMMIT_RATIO || Math.abs(velocity) > COMMIT_VELOCITY;
var toTab = fromTab;
if (committed && dx < 0 && NEXT_TAB[fromTab]) {
toTab = NEXT_TAB[fromTab];
} else if (committed && dx > 0 && PREV_TAB[fromTab]) {
toTab = PREV_TAB[fromTab];
}
// Re-enable the transition, force the browser to register it at the
// current drag position, then commit/spring back so it animates from
// exactly where the finger let go rather than snapping first.
track.style.transition = TRANSITION;
if (frame) frame.style.transition = '';
void dexClamshell.offsetHeight; // force reflow so the transition above "takes"
if (toTab !== fromTab) applyTabState(toTab);
track.style.transform = '';
if (frame) frame.style.marginLeft = '';
setTimeout(resetDragStyles, 600);
}

function onCancel() {
decided = false;
dragging = false;
resetDragStyles();
}

dexClamshell.addEventListener('touchstart', onStart, { passive: true });
dexClamshell.addEventListener('touchmove', onMove, { passive: false });
dexClamshell.addEventListener('touchend', onEnd, { passive: true });
dexClamshell.addEventListener('touchcancel', onCancel, { passive: true });
})();
// ---------- tap the peeking sliver to jump straight there ----------
// When a page is only showing as its resting peek (not the active page),
// it's still real DOM in real position - just mostly clipped by
// .dex-frame's overflow:hidden - so the visible sliver is genuinely
// clickable. This makes tapping that sliver jump straight to it instead
// of requiring a full swipe.
(function setupPeekTap() {
if (!dexClamshell) return;
function handlePeekTap(tab) {
return function(e) {
if (dexClamshell.getAttribute('data-active') === tab) return; // already the active page, let it behave normally
e.preventDefault();
e.stopPropagation();
activateTab(tab);
};
}
views.hunts.addEventListener('click', handlePeekTap('hunts'), true);
views.collection.addEventListener('click', handlePeekTap('collection'), true);
})();
/* ---------- rendering: hunts ---------- */
var huntSortMode = 'created';
function sortHuntsForDisplay(list) {
var sorted = list.slice();
if (huntSortMode === 'longest') {
sorted.sort(function(a, b) {
return elapsedSeconds(b) - elapsedSeconds(a);
});
} else if (huntSortMode === 'luck') {
// "Worst luck" = furthest past the statistically expected point
// without having found it yet (every hunt still in this list is,
// by definition, not caught) - i.e. highest cumulative probability
// first.
sorted.sort(function(a, b) {
return cumulativeProb(b.encounters, b.denom) - cumulativeProb(a.encounters, a.denom);
});
} else {
sorted.sort(function(a, b) {
return a.createdAt - b.createdAt;
});
}
return sorted;
}
function renderHunts() {
var wrap = document.getElementById('hunts-list');
wrap.innerHTML = '';
if (state.hunts.length === 0) {
wrap.innerHTML = '<div class="empty"><div class="glyph">✧</div><p class="lead">No hunts in progress.</p><p>Start one to begin logging encounters, odds, and time spent.</p><button type="button" class="primary empty-cta" data-action="new-hunt">Start a Hunt</button></div>';
return;
}
sortHuntsForDisplay(state.hunts).forEach(function(hunt) {
var el = document.createElement('div');
el.className = 'hunt-card';
var prob = cumulativeProb(hunt.encounters, hunt.denom);
var pct = Math.round(prob * 1000) / 10;
var dexNum = dexNumberOf(hunt.pokemon);
var entryLabel = dexNum ? ('No. ' + String(dexNum).padStart(4, '0')) : 'No. ????';
var info = speciesInfo(hunt.pokemon);
var idLine = escapeHtml(hunt.pokemon).toUpperCase() + ' // ' + (info && info.types.length ? info.types.join(' · ').toUpperCase() : 'UNKNOWN TYPE') + (info && info.gen ? ' // GEN ' + info.gen : '');
el.innerHTML =
'<div class="hunt-dex-flap">' +
'<div class="hunt-dex-flap-crease-wrap"><div class="hunt-dex-flap-crease"></div></div>' +
'<div class="hunt-dex-lens-wrap">' +
'<div class="hunt-dex-lens hunt-dex-flap-lens" data-action="new-hunt" role="button" tabindex="0" title="Start a Hunt" aria-label="Start a Hunt"><span class="hunt-dex-flap-lens-inner"></span></div>' +
'<div class="hunt-dex-lights hunt-dex-flap-lights">' +
'<button class="hunt-dex-light r" data-action="delete-hunt" data-id="' + hunt.id + '" title="Abandon hunt" aria-label="Abandon hunt"></button>' +
'<span class="hunt-dex-light y" aria-hidden="true"></span>' +
'<span class="hunt-dex-light g' + (hunt.running ? ' lit' : '') + '" title="' + (hunt.running ? 'Timer running' : 'Timer paused') + '"></span>' +
'</div>' +
'</div>' +
'</div>' +
'<div class="hunt-dex-hinge">' +
'<div class="hunt-dex-hinge-sep top"></div>' +
'<div class="hunt-dex-hinge-sep bottom"></div>' +
'</div>' +
'<div class="hunt-dex-body">' +
'<div class="hunt-dex-bezel">' +
'<div class="hunt-dex-bezel-dots"><span></span><span></span></div>' +
'<div class="hunt-dex-screen">' +
'<div class="hunt-dex-entry-row">' +
'<span>ENTRY ' + entryLabel + '</span>' +
'<span class="hunt-dex-running">' + (hunt.running ? '<span class="hunt-dex-rec-dot"></span> TRACKING' : 'PAUSED') + '</span>' +
'</div>' +
'<div class="hunt-dex-main">' +
'<div class="hunt-dex-portrait">' + spriteMarkup(hunt.pokemon) + '</div>' +
'<div class="hunt-dex-id-block">' +
'<div class="hunt-dex-id">' + idLine + '</div>' +
'<div class="hunt-dex-name">' + escapeHtml(hunt.pokemon) + '</div>' +
'<div class="tag-row">' +
'<span class="tag">' + escapeHtml(hunt.game) + '</span>' +
'<span class="tag">' + escapeHtml(hunt.method) + '</span>' +
'<span class="tag">1 in ' + hunt.denom + '</span>' +
(hunt.shinyCharm ? '<span class="tag">✨ Charm</span>' : '') +
'</div>' +
'</div>' +
'</div>' +
'<div class="hunt-dex-readout">' +
'<div class="cell"><div class="num">' + hunt.encounters + '</div><div class="lbl">Encounters</div></div>' +
'<div class="cell"><div class="num" data-timer-for="' + hunt.id + '">' + fmtTime(elapsedSeconds(hunt)) + '</div><div class="lbl">Time Spent</div></div>' +
'<div class="cell"><div class="num">' + pct + '%</div><div class="lbl">Odds So Far</div></div>' +
'</div>' +
'<div class="hunt-dex-bar-track"><div class="hunt-dex-bar-fill" style="width:' + pct + '%"></div></div>' +
'<div class="hunt-dex-bar-caption"><span>P(shiny) BY NOW</span><span>' + hunt.encounters + ' / ' + hunt.denom + ' AVG</span></div>' +
'<div class="hunt-dex-actions">' +
'<button class="hunt-dex-btn hunt-dex-btn-ghost hunt-dex-btn-step" data-action="remove-encounter" data-id="' + hunt.id + '" title="Remove an encounter">−</button>' +
'<button class="hunt-dex-btn hunt-dex-btn-ghost hunt-dex-btn-step" data-action="add-encounter" data-id="' + hunt.id + '" title="Add an encounter">+</button>' +
'<button class="hunt-dex-btn hunt-dex-btn-ghost hunt-dex-btn-x5" data-action="add-encounter-5" data-id="' + hunt.id + '">+5</button>' +
'<button class="hunt-dex-btn hunt-dex-btn-ghost hunt-dex-btn-timer" data-action="toggle-timer" data-id="' + hunt.id + '" title="' + (hunt.running ? 'Pause timer' : 'Start timer') + '">' + (hunt.running ? '⏸' : '▶') + '</button>' +
'<button class="hunt-dex-btn hunt-dex-btn-found" data-action="mark-found" data-id="' + hunt.id + '">Caught!</button>' +
'</div>' +
'</div>' +
'</div>' +
'<div class="hunt-dex-handheld-controls">' +
'<div class="hunt-dex-joystick-wrap">' +
'<div class="hunt-dex-mic-grille"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>' +
'<div class="hunt-dex-joystick-socket">' +
'<span class="hunt-dex-joystick-plate"></span>' +
'<button class="hunt-dex-round-btn" data-action="toggle-timer" data-id="' + hunt.id + '" title="' + (hunt.running ? 'Pause timer' : 'Start timer') + '">' + (hunt.running ? '⏸' : '▶') + '</button>' +
'</div>' +
'</div>' +
'<div class="hunt-dex-mini-col">' +
'<div class="hunt-dex-count-row">' +
'<button class="hunt-dex-pill minus" data-action="remove-encounter" data-id="' + hunt.id + '" title="Remove an encounter">−1</button>' +
'<button class="hunt-dex-pill plus" data-action="add-encounter" data-id="' + hunt.id + '" title="Add an encounter">+1</button>' +
'</div>' +
'<div class="hunt-dex-mini-screen"><span class="mini-num">' + hunt.encounters + '</span><span class="mini-lbl">ENC · ' + pct + '%</span></div>' +
'</div>' +
'<div class="hunt-dex-dpad">' +
'<span class="dpad-plate"></span>' +
'<button class="hdpad-btn dpad-up" data-action="add-encounter-5" data-id="' + hunt.id + '" title="Add 5 encounters"><span>+5</span></button>' +
'<button class="hdpad-btn dpad-right" data-action="add-encounter" data-id="' + hunt.id + '" title="Add an encounter"><span>+1</span></button>' +
'<span class="hdpad-btn dpad-down" aria-hidden="true"></span>' +
'<button class="hdpad-btn dpad-left" data-action="remove-encounter" data-id="' + hunt.id + '" title="Remove an encounter"><span>−1</span></button>' +
'<span class="dpad-center"></span>' +
'</div>' +
'</div>' +
'<div class="hunt-dex-pokeball-row"><button class="hunt-dex-pokeball-btn" data-action="mark-found" data-id="' + hunt.id + '" title="Mark as caught" aria-label="Mark as caught"></button></div>' +
'<div class="hunt-dex-grille"><span></span><span></span><span></span><span></span><span></span></div>' +
'</div>';
wrap.appendChild(el);
});
syncHuntFrameHeight();
}
// Keeps the mobile hunts scroll frame (and the sliver of the next page
// that peeks in beside it) pinned to the real, rendered height of one
// hunt card - rather than the phone's full viewport height - so the
// peek strip lines up with exactly one Pokedex card instead of running
// taller or shorter than it.
function syncHuntFrameHeight() {
var firstCard = document.querySelector('#hunts-list .hunt-card');
var root = document.documentElement;
if (firstCard && firstCard.offsetHeight) {
root.style.setProperty('--hunt-frame-height', firstCard.offsetHeight + 'px');
} else {
root.style.removeProperty('--hunt-frame-height');
}
}
var huntFrameResizeTimer = null;
window.addEventListener('resize', function() {
clearTimeout(huntFrameResizeTimer);
huntFrameResizeTimer = setTimeout(syncHuntFrameHeight, 150);
});
function escapeHtml(s) {
return String(s).replace(/[&<>"']/g, function(c) {
return {
'&': '&amp;',
'<': '&lt;',
'>': '&gt;',
'"': '&quot;',
"'": '&#39;'
} [c];
});
}
/* ---------- pokemon name autocomplete ---------- */
// Flat, properly-cased list of every species name, built once from GEN_DATA.
var ALL_SPECIES_NAMES = (function() {
var arr = [];
GEN_DATA.forEach(function(g) {
g.species.forEach(function(sp) {
arr.push(sp[1]);
});
});
return arr;
})();
// Species name -> national dex number, built once from GEN_DATA, so hunt
// cards can show a Pokedex-style "Entry No." without re-scanning the
// whole species list on every render.
var SPECIES_DEX_NUM = (function() {
var map = {};
GEN_DATA.forEach(function(g) {
g.species.forEach(function(sp) {
map[normName(sp[1])] = sp[0];
});
});
return map;
})();
function dexNumberOf(name) {
var n = SPECIES_DEX_NUM[normName(name)];
return (n === undefined) ? null : n;
}
// Wires a live-filtering suggestion dropdown onto a text input. Matches
// starting with the typed text are ranked above matches that merely
// contain it. Supports mouse click, arrow-key navigation, and Enter/Escape.
function attachPokemonAutocomplete(input) {
if (!input || input.dataset.autocompleteBound) return;
input.dataset.autocompleteBound = '1';
input.setAttribute('autocomplete', 'off');
var field = input.parentNode;
field.classList.add('field-autocomplete');
var list = document.createElement('div');
list.className = 'autocomplete-list';
field.appendChild(list);
var matches = [];
var activeIndex = -1;
function close() {
list.style.display = 'none';
list.innerHTML = '';
matches = [];
activeIndex = -1;
}
function highlight() {
var items = list.querySelectorAll('.autocomplete-item');
items.forEach(function(it, i) {
it.classList.toggle('active', i === activeIndex);
});
if (activeIndex >= 0 && items[activeIndex]) items[activeIndex].scrollIntoView({
block: 'nearest'
});
}
function selectMatch(name) {
input.value = name;
close();
input.dispatchEvent(new Event('change'));
input.focus();
}
function update() {
var q = input.value.trim().toLowerCase();
if (!q) {
close();
return;
}
var starts = [],
contains = [];
ALL_SPECIES_NAMES.forEach(function(name) {
var ln = name.toLowerCase();
var idx = ln.indexOf(q);
if (idx === 0) starts.push(name);
else if (idx > 0) contains.push(name);
});
matches = starts.concat(contains).slice(0, 8);
activeIndex = -1;
if (!matches.length) {
close();
return;
}
list.innerHTML = matches.map(function(name, i) {
return '<div class="autocomplete-item" data-idx="' + i + '">' + escapeHtml(name) + '</div>';
}).join('');
list.style.display = 'block';
}
input.addEventListener('input', update);
input.addEventListener('focus', update);
input.addEventListener('keydown', function(e) {
if (list.style.display !== 'block') return;
if (e.key === 'ArrowDown') {
e.preventDefault();
activeIndex = Math.min(activeIndex + 1, matches.length - 1);
highlight();
} else if (e.key === 'ArrowUp') {
e.preventDefault();
activeIndex = Math.max(activeIndex - 1, 0);
highlight();
} else if (e.key === 'Enter') {
if (activeIndex >= 0) {
e.preventDefault();
selectMatch(matches[activeIndex]);
}
} else if (e.key === 'Escape') {
close();
}
});
list.addEventListener('mousedown', function(e) {
var item = e.target.closest('.autocomplete-item');
if (!item) return;
e.preventDefault();
selectMatch(matches[parseInt(item.dataset.idx, 10)]);
});
document.addEventListener('click', function(e) {
if (e.target !== input && !list.contains(e.target)) close();
});
}
/* ---------- rendering: collection (catch log) ---------- */
var logEditMode = false;
// Which collection entry (by id, not array index) the screen is
// showing. Tracking the id rather than a raw index means the
// selection survives re-sorting/filtering instead of jumping to
// whatever now happens to sit at the old index.
var logSelectedId = null;
var logViewMode = 'card'; // 'card' | 'grid'
var logShowHoF = false;
var logSearchQuery = '';
var logSortMode = 'newest';
var logFilterGame = '';
var logFilterMethod = '';
var logFilterGen = '';

var LOG_SORT_LABELS = {
newest: 'Newest',
oldest: 'Oldest',
rarest: 'Rarest Odds',
fastest: 'Fastest Catch',
most: 'Most Encounters'
};

// Best-effort odds for an entry: use the odds actually rolled at catch
// time if saved (denom), otherwise recompute the same way a fresh hunt
// would - so manually-added log entries (never went through Active
// Hunts) still sort/rank sensibly against ones that did.
function logEntryDenom(entry) {
if (entry.denom) return entry.denom;
return computeOdds(entry.game, entry.method, !!entry.shinyCharm) || 0;
}
function logEntryDateValue(entry) {
var raw = entry.dateEnded || entry.date || entry.dateBegan || '';
var t = raw ? new Date(raw).getTime() : NaN;
return isNaN(t) ? 0 : t;
}
// Search + filter + sort applied on top of state.collection without
// mutating it. Card mode, Grid mode, and Hall of Fame's "jump to this
// entry" all read from this same list so they always agree.
function filteredLogEntries() {
var q = logSearchQuery.trim().toLowerCase();
var list = state.collection.filter(function(e) {
if (q && e.pokemon.toLowerCase().indexOf(q) === -1) return false;
if (logFilterGame && e.game !== logFilterGame) return false;
if (logFilterMethod && e.method !== logFilterMethod) return false;
if (logFilterGen && String(e.gen || '') !== logFilterGen) return false;
return true;
});
list.sort(function(a, b) {
switch (logSortMode) {
case 'oldest':
return logEntryDateValue(a) - logEntryDateValue(b);
case 'rarest':
return logEntryDenom(b) - logEntryDenom(a);
case 'fastest':
return (a.encounters || 0) - (b.encounters || 0);
case 'most':
return (b.encounters || 0) - (a.encounters || 0);
case 'newest':
default:
return logEntryDateValue(b) - logEntryDateValue(a);
}
});
return list;
}
// Shows/hides the Card screen, Grid screen, and Hall of Fame screen,
// and reflects the current mode on the shell so CSS can hide the nav
// arrows/edit dot (which only make sense in Card mode).
function updateLogModeUI() {
var shell = document.getElementById('log-dex-shell');
var cardScreen = document.getElementById('log-latest-screen');
var gridScreen = document.getElementById('log-grid-screen');
var hofScreen = document.getElementById('log-hof-screen');
if (shell) {
shell.dataset.logMode = logViewMode;
shell.dataset.logHof = logShowHoF ? 'true' : 'false';
}
document.querySelectorAll('#log-mode-toggle button').forEach(function(b) {
b.classList.toggle('active', b.dataset.mode === logViewMode);
});
document.getElementById('btn-log-hof').setAttribute('aria-pressed', logShowHoF ? 'true' : 'false');
var showCard = !logShowHoF && logViewMode === 'card';
var showGrid = !logShowHoF && logViewMode === 'grid';
var showHof = logShowHoF;
cardScreen.classList.toggle('log-screen-hidden', !showCard);
gridScreen.classList.toggle('log-screen-visible', showGrid);
hofScreen.classList.toggle('log-screen-visible', showHof);
}
// Call whenever search/sort/filter changes so the Card screen actually
// jumps to reflect the new results, instead of silently staying on
// whatever entry was already selected (which happens if that entry
// still happens to satisfy the new criteria).
function logCardJumpToTop() {
var list = filteredLogEntries();
logSelectedId = list.length ? list[0].id : null;
}
function renderCollection() {
updateLogModeUI();
renderLogCard();
renderLogGrid();
renderLogHoF();
}
function renderLogCard() {
var screen = document.getElementById('log-latest-screen');
var list = filteredLogEntries();
if (list.length === 0) {
logSelectedId = null;
screen.innerHTML =
'<div class="log-dex-screen-empty">' +
(state.collection.length === 0 ? 'Your first catch will show up here' : 'No catches match your search/filters') +
'</div>';
return;
}
var index = -1;
for (var i = 0; i < list.length; i++) {
if (list[i].id === logSelectedId) { index = i; break; }
}
if (index < 0) {
// No valid selection (first load, or the selected entry just got
// filtered/deleted out) - default to whichever entry is truly the
// most recently caught, regardless of what the current sort puts
// first.
var newestEntry = state.collection[state.collection.length - 1];
if (newestEntry) {
for (var j = 0; j < list.length; j++) {
if (list[j].id === newestEntry.id) { index = j; break; }
}
}
if (index < 0) index = list.length - 1;
logSelectedId = list[index].id;
}
var latest = list[index];
var info = speciesInfo(latest.pokemon);
var gen = latest.gen || (info ? info.gen : null);
var types = latest.types || (info ? info.types : []);
var unit = methodUnit(latest.method);
var began = latest.dateBegan || '';
var ended = latest.dateEnded || latest.date || '';
var dexNum = dexNumberOf(latest.pokemon);
var entryLabel = dexNum ? ('No. ' + String(dexNum).padStart(4, '0')) : 'No. ????';
var trueNewest = state.collection[state.collection.length - 1];
var isLatestEntry = !!trueNewest && latest.id === trueNewest.id;
var screenPosLabel = isLatestEntry ? 'LATEST CATCH' : ('CATCH ' + (index + 1) + ' OF ' + list.length);
var metaBits = [latest.game, latest.method, gen ? ('Gen ' + gen) : null].filter(Boolean);
var meta = escapeHtml(metaBits.join(' · '));
var beganRow = began ? ('<div class="log-dex-screen-meta">Began - ' + escapeHtml(fmtDate(began)) + '</div>') : '';
var endRow = ended ? ('<div class="log-dex-screen-meta">End - ' + escapeHtml(fmtDate(ended)) + '</div>') : '';
var timeRow = latest.timeSpentMinutes ? ('<div class="log-dex-screen-meta">Time Spent - ' + escapeHtml(fmtTime(latest.timeSpentMinutes * 60)) + '</div>') : '';
var dateGroup = (beganRow || endRow || timeRow) ? ('<div class="log-dex-screen-date-group">' + beganRow + endRow + timeRow + '</div>') : '';
// Screen mirrors the log card exactly - same fields, same text - and
// is now the only place the latest catch is shown (no more duplicate
// row below). Edit/delete actions live here too, toggled by the
// "Edit" button same as the old card actions did.
screen.classList.toggle('edit-mode', logEditMode);
screen.innerHTML =
'<div class="log-dex-screen-toprow">' +
'<div class="log-dex-screen-label">' + entryLabel + ' · ' + screenPosLabel + '</div>' +
'<div class="log-dex-screen-count">' + latest.encounters + '<span class="unit">' + escapeHtml(unit) + '</span></div>' +
'</div>' +
'<div class="log-dex-screen-body">' +
'<div class="log-dex-screen-sprite">' + spriteMarkup(latest.pokemon) + '</div>' +
'<div class="log-dex-screen-text">' +
'<div class="log-dex-screen-name">' + escapeHtml(latest.pokemon) + '</div>' +
'<div class="log-dex-screen-types">' + typeBadges(types, 68) + '</div>' +
(meta ? '<div class="log-dex-screen-meta">' + meta + '</div>' : '') +
dateGroup +
(latest.notes ? '<div class="log-dex-screen-notes">' + escapeHtml(latest.notes) + '</div>' : '') +
'</div>' +
'<div class="log-dex-screen-actions">' +
'<button class="icon-btn" data-action="undo-log" data-id="' + latest.id + '" title="Move back to Active Hunts">↩</button>' +
'<button class="icon-btn" data-action="edit-log" data-id="' + latest.id + '" title="Edit entry">✎</button>' +
'<button class="icon-btn" data-action="delete-log" data-id="' + latest.id + '" title="Delete entry">✕</button>' +
'</div>' +
'</div>';
}
// Steps the Card view backward (-1) or forward (+1) through the
// current filtered/sorted list, wrapping at either end.
function logScreenStep(dir) {
var list = filteredLogEntries();
if (list.length === 0) return;
var index = -1;
for (var i = 0; i < list.length; i++) {
if (list[i].id === logSelectedId) { index = i; break; }
}
if (index < 0) index = 0;
index = (index + dir + list.length) % list.length;
logSelectedId = list[index].id;
renderCollection();
}
// Grid mode: a scrollable gallery of small sprite tiles built from the
// same filtered/sorted list as Card mode. Tapping a tile jumps Card
// mode straight to that entry.
function renderLogGrid() {
var screen = document.getElementById('log-grid-screen');
if (!screen.classList.contains('log-screen-visible')) {
// Still rebuild it while hidden so it's ready the moment the person
// switches to Grid, but skip the work entirely if there's nothing
// to look at yet.
if (state.collection.length === 0) return;
}
var list = filteredLogEntries();
if (list.length === 0) {
screen.innerHTML = '<div class="log-grid-empty">' +
(state.collection.length === 0 ? 'Your first catch will show up here' : 'No catches match your search/filters') +
'</div>';
return;
}
var tilesHtml = list.map(function(e) {
var dexNum = dexNumberOf(e.pokemon);
var label = dexNum ? ('No. ' + String(dexNum).padStart(4, '0')) : 'No. ????';
return '<button type="button" class="log-grid-tile" data-id="' + e.id + '" title="' + escapeHtml(e.pokemon) + '">' +
'<span class="log-grid-tile-sprite">' + spriteMarkup(e.pokemon) + '</span>' +
'<span class="log-grid-tile-name">' + escapeHtml(e.pokemon) + '</span>' +
'<span class="log-grid-tile-num">' + label + '</span>' +
'</button>';
}).join('');
screen.innerHTML = '<div class="log-grid-inner">' + tilesHtml + '</div>';
}
document.getElementById('log-grid-screen').addEventListener('click', function(e) {
var tile = e.target.closest('.log-grid-tile');
if (!tile) return;
var entry = state.collection.find(function(c) {
return c.id === tile.dataset.id;
});
if (!entry) return;
openLogEntryCardModal(entry);
});
// Hall of Fame: luckiest catch (fewest encounters relative to the
// odds), longest hunt (most time logged, falling back to encounters
// if nobody has timed anything), and most encounters overall. Always
// computed from the full collection (not the current search/filter),
// since these are meant to be whole-log records.
function computeHallOfFame() {
var list = state.collection;
if (!list.length) return null;
var luckiest = null,
luckiestRatio = Infinity;
var longest = null;
var most = null;
list.forEach(function(e) {
var denom = logEntryDenom(e);
if (denom > 0 && e.encounters > 0) {
var ratio = e.encounters / denom;
if (ratio < luckiestRatio) {
luckiestRatio = ratio;
luckiest = e;
}
}
if (!most || (e.encounters || 0) > (most.encounters || 0)) most = e;
if ((e.timeSpentMinutes || 0) > 0 && (!longest || e.timeSpentMinutes > longest.timeSpentMinutes)) {
longest = e;
}
});
// Nobody logged time spent on anything - fall back to encounters as
// the next best proxy for "longest hunt" so the row isn't just blank.
if (!longest) longest = most;
return { luckiest: luckiest, longest: longest, most: most };
}
function hofRowHtml(label, entry, statText) {
if (!entry) {
return '<div class="log-hof-row" style="cursor:default;"><div class="log-hof-row-text"><div class="log-hof-row-label">' + escapeHtml(label) + '</div><div class="log-hof-row-name">—</div></div></div>';
}
return '<button type="button" class="log-hof-row" data-id="' + entry.id + '">' +
'<span class="log-hof-row-sprite">' + spriteMarkup(entry.pokemon) + '</span>' +
'<span class="log-hof-row-text">' +
'<span class="log-hof-row-label">' + escapeHtml(label) + '</span>' +
'<span class="log-hof-row-name">' + escapeHtml(entry.pokemon) + '</span>' +
'</span>' +
'<span class="log-hof-row-stat">' + escapeHtml(statText) + '</span>' +
'</button>';
}
function renderLogHoF() {
var screen = document.getElementById('log-hof-screen');
var hof = computeHallOfFame();
if (!hof) {
screen.innerHTML = '<div class="log-hof-empty">Catch a shiny to start your Hall of Fame</div>';
return;
}
var luckiestStat = hof.luckiest ?
(hof.luckiest.encounters + ' / ' + logEntryDenom(hof.luckiest) + ' odds') : '';
var longestStat = hof.longest ?
(hof.longest.timeSpentMinutes ? (fmtTime(hof.longest.timeSpentMinutes * 60) + ' spent') : (hof.longest.encounters + ' encounters')) : '';
var mostStat = hof.most ? (hof.most.encounters + ' encounters') : '';
screen.innerHTML =
'<div class="log-hof-title">HALL OF FAME</div>' +
hofRowHtml('Luckiest Catch', hof.luckiest, luckiestStat) +
hofRowHtml('Longest Hunt', hof.longest, longestStat) +
hofRowHtml('Most Encounters', hof.most, mostStat);
}
document.getElementById('log-hof-screen').addEventListener('click', function(e) {
var row = e.target.closest('.log-hof-row[data-id]');
if (!row) return;
logSelectedId = row.dataset.id;
logShowHoF = false;
logViewMode = 'card';
renderCollection();
});
document.getElementById('log-mode-toggle').addEventListener('click', function(e) {
var btn = e.target.closest('button[data-mode]');
if (!btn) return;
logViewMode = btn.dataset.mode;
logShowHoF = false;
renderCollection();
});
document.getElementById('btn-log-hof').addEventListener('click', function() {
logShowHoF = !logShowHoF;
renderCollection();
});
var logSearchInput = document.getElementById('log-search');
logSearchInput.addEventListener('input', function() {
logSearchQuery = this.value;
logCardJumpToTop();
renderCollection();
});
document.getElementById('btn-log-search').addEventListener('click', function(e) {
e.stopPropagation();
closeOtherDexDropdowns('log-search-wrap');
document.getElementById('log-search-wrap').classList.toggle('open');
if (document.getElementById('log-search-wrap').classList.contains('open')) {
logSearchInput.focus();
}
});
document.getElementById('log-search-panel').addEventListener('click', function(e) {
e.stopPropagation();
});
document.getElementById('btn-log-sort').addEventListener('click', function(e) {
e.stopPropagation();
closeOtherDexDropdowns('log-sort-wrap');
document.getElementById('log-sort-wrap').classList.toggle('open');
});
document.getElementById('log-sort-panel').addEventListener('click', function(e) {
e.stopPropagation();
var opt = e.target.closest('.dex-select-option');
if (!opt) return;
logSortMode = opt.dataset.value;
document.querySelectorAll('#log-sort-panel .dex-select-option').forEach(function(o) {
o.classList.toggle('active', o === opt);
});
document.getElementById('btn-log-sort').textContent = LOG_SORT_LABELS[logSortMode] + ' ▾';
document.getElementById('btn-log-sort').classList.toggle('active', logSortMode !== 'newest');
document.getElementById('log-sort-wrap').classList.remove('open');
logCardJumpToTop();
renderCollection();
});
document.getElementById('btn-log-filter').addEventListener('click', function(e) {
e.stopPropagation();
closeOtherDexDropdowns('log-filter-wrap');
document.getElementById('log-filter-wrap').classList.toggle('open');
});
document.getElementById('log-filter-panel').addEventListener('click', function(e) {
e.stopPropagation();
});
(function populateLogFilterOptions() {
var gameSel = document.getElementById('log-filter-game');
GAMES.forEach(function(g) {
var opt = document.createElement('option');
opt.value = g;
opt.textContent = g;
gameSel.appendChild(opt);
});
var methodSel = document.getElementById('log-filter-method');
METHODS.forEach(function(m) {
var opt = document.createElement('option');
opt.value = m;
opt.textContent = m;
methodSel.appendChild(opt);
});
var genSel = document.getElementById('log-filter-gen');
GEN_DATA.forEach(function(g) {
var opt = document.createElement('option');
opt.value = String(g.gen);
opt.textContent = 'Gen ' + g.gen + ' (' + g.region + ')';
genSel.appendChild(opt);
});
})();
function updateLogFilterButtonLabel() {
var activeCount = [logFilterGame, logFilterMethod, logFilterGen].filter(Boolean).length;
var btn = document.getElementById('btn-log-filter');
btn.textContent = (activeCount ? activeCount + ' Filter' + (activeCount > 1 ? 's' : '') : 'All') + ' ▾';
btn.classList.toggle('active', activeCount > 0);
}
document.getElementById('log-filter-game').addEventListener('change', function() {
logFilterGame = this.value;
updateLogFilterButtonLabel();
logCardJumpToTop();
renderCollection();
});
document.getElementById('log-filter-method').addEventListener('change', function() {
logFilterMethod = this.value;
updateLogFilterButtonLabel();
logCardJumpToTop();
renderCollection();
});
document.getElementById('log-filter-gen').addEventListener('change', function() {
logFilterGen = this.value;
updateLogFilterButtonLabel();
logCardJumpToTop();
renderCollection();
});
document.getElementById('btn-log-filter-clear').addEventListener('click', function() {
logFilterGame = '';
logFilterMethod = '';
logFilterGen = '';
document.getElementById('log-filter-game').value = '';
document.getElementById('log-filter-method').value = '';
document.getElementById('log-filter-gen').value = '';
updateLogFilterButtonLabel();
logCardJumpToTop();
renderCollection();
});
document.getElementById('btn-log-reset-filters').addEventListener('click', function() {
logSearchQuery = '';
logSortMode = 'newest';
logFilterGame = '';
logFilterMethod = '';
logFilterGen = '';
logSearchInput.value = '';
document.getElementById('log-filter-game').value = '';
document.getElementById('log-filter-method').value = '';
document.getElementById('log-filter-gen').value = '';
document.querySelectorAll('#log-sort-panel .dex-select-option').forEach(function(o) {
o.classList.toggle('active', o.dataset.value === 'newest');
});
document.getElementById('btn-log-sort').textContent = LOG_SORT_LABELS.newest + ' ▾';
document.getElementById('btn-log-sort').classList.remove('active');
updateLogFilterButtonLabel();
document.getElementById('log-search-wrap').classList.remove('open');
document.getElementById('log-sort-wrap').classList.remove('open');
document.getElementById('log-filter-wrap').classList.remove('open');
logCardJumpToTop();
renderCollection();
});
/* ---------- rendering: living dex ---------- */
var dexOpenGens = {};
var dexMode = 'living';
var dexSortMode = 'dex';
var dexTypeFilter = '';
function normName(s) {
return String(s || '').trim().toLowerCase();
}
// Fixed display order for regional forms sharing a dex number with their
// base species - used by sortDexSpecies (both 'dex' and 'uncaught' modes)
// so e.g. Meowth's forms always read Meowth, Meowth (Alolan), Meowth
// (Galarian), regardless of what order GEN_DATA happens to list them in.
// ('alpha' mode doesn't need this - localeCompare already puts these
// tags in the same order since A < G < H < P.)
var REGION_VARIANT_ORDER = {
'': 0,
'Alolan': 1,
'Galarian': 2,
'Hisuian': 3,
'Paldean': 4
};
function regionVariantWeight(name) {
var tag = parseRegionalVariant(name).tag || '';
return REGION_VARIANT_ORDER.hasOwnProperty(tag) ? REGION_VARIANT_ORDER[tag] : 99;
}
// Returns a re-ordered copy of a generation's species list for display,
// leaving the original GEN_DATA array (and therefore dex-number-based
// counts) untouched.
function sortDexSpecies(speciesList, caughtMap, mode) {
var arr = speciesList.slice();
if (mode === 'alpha') {
arr.sort(function(a, b) {
return a[1].localeCompare(b[1]);
});
} else if (mode === 'uncaught') {
arr.sort(function(a, b) {
var ac = caughtMap[normName(a[1])] ? 1 : 0;
var bc = caughtMap[normName(b[1])] ? 1 : 0;
if (ac !== bc) return ac - bc;
if (a[0] !== b[0]) return a[0] - b[0];
return regionVariantWeight(a[1]) - regionVariantWeight(b[1]);
});
} else {
// 'dex': species arrive in dex-number order already, but same-number
// regional forms still need the fixed Alolan/Galarian/Hisuian/Paldean
// ordering applied on top.
arr.sort(function(a, b) {
if (a[0] !== b[0]) return a[0] - b[0];
return regionVariantWeight(a[1]) - regionVariantWeight(b[1]);
});
}
return arr;
}
// Dims every species chip in the grid whose types don't include the
// currently-selected filter type, leaving matching chips fully opaque.
// Doesn't touch the caught state, sort order, or rebuild any sprite
// <img> - it only toggles a class, so it's safe to call after any
// render/re-sort without disturbing sprites or scroll position.
function applyDexTypeFilter() {
var grid = document.getElementById('dex-grid');
if (!grid) return;
var active = !!dexTypeFilter;
grid.querySelectorAll('.dex-chip').forEach(function(chip) {
if (!active) {
chip.classList.remove('type-dimmed');
return;
}
var info = speciesInfo(chip.dataset.name);
var matches = !!(info && info.types.indexOf(dexTypeFilter) !== -1);
chip.classList.toggle('type-dimmed', !matches);
});
}
document.getElementById('btn-dex-type-filter').addEventListener('click', function(e) {
e.stopPropagation();
closeOtherDexDropdowns('dex-type-wrap');
document.getElementById('dex-type-wrap').classList.toggle('open');
});
document.getElementById('dex-type-panel').addEventListener('click', function(e) {
e.stopPropagation();
var opt = e.target.closest('.dex-select-option');
if (!opt) return;
dexTypeFilter = opt.dataset.value;
document.querySelectorAll('#dex-type-panel .dex-select-option').forEach(function(o) {
o.classList.toggle('active', o === opt);
});
document.getElementById('btn-dex-type-filter').textContent = 'Filter: ' + (dexTypeFilter || 'All Types') + ' ▾';
document.getElementById('btn-dex-type-filter').classList.toggle('active', !!dexTypeFilter);
document.getElementById('dex-type-wrap').classList.remove('open');
applyDexTypeFilter();
});
/* ---------- variant filter (Original / Alolan / Galarian / Hisuian / Paldean) ---------- */
// Which variant categories are currently visible. All true by default so
// the dex looks unfiltered until the user opens the panel and unchecks some.
var dexVariantFilter = {
Original: true,
Alolan: true,
Galarian: true,
Hisuian: true,
Paldean: true
};
var VARIANT_FILTER_KEYS = ['Original', 'Alolan', 'Galarian', 'Hisuian', 'Paldean'];
var VARIANT_CHECKBOX_IDS = {
Original: 'vf-original',
Alolan: 'vf-alolan',
Galarian: 'vf-galarian',
Hisuian: 'vf-hisuian',
Paldean: 'vf-paldean'
};
// Hides (rather than dims) chips whose variant category is unchecked, since
// this is a true filter of which forms the person wants to see, not a soft
// highlight like the type filter. Doesn't touch caught state, sort order,
// or sprite <img> nodes, so it's safe to call after any render/re-sort.
function applyDexVariantFilter() {
var grid = document.getElementById('dex-grid');
if (!grid) return;
grid.querySelectorAll('.dex-chip').forEach(function(chip) {
var cat = chip.dataset.variant || 'Original';
var visible = dexVariantFilter[cat] !== false;
chip.classList.toggle('variant-hidden', !visible);
});
updateVariantFilterButtonState();
}
// Reflects whether any category is turned off onto the filter button itself
// (a highlighted border) so it's obvious at a glance that a filter is active.
function updateVariantFilterButtonState() {
var btn = document.getElementById('btn-variant-filter');
if (!btn) return;
var allOn = VARIANT_FILTER_KEYS.every(function(k) {
return dexVariantFilter[k] !== false;
});
btn.classList.toggle('active', !allOn);
}
VARIANT_FILTER_KEYS.forEach(function(key) {
var cb = document.getElementById(VARIANT_CHECKBOX_IDS[key]);
if (!cb) return;
cb.addEventListener('change', function() {
dexVariantFilter[key] = cb.checked;
applyDexVariantFilter();
});
});
document.getElementById('vf-select-all').addEventListener('click', function() {
VARIANT_FILTER_KEYS.forEach(function(key) {
dexVariantFilter[key] = true;
var cb = document.getElementById(VARIANT_CHECKBOX_IDS[key]);
if (cb) cb.checked = true;
});
applyDexVariantFilter();
});
document.getElementById('vf-select-none').addEventListener('click', function() {
VARIANT_FILTER_KEYS.forEach(function(key) {
dexVariantFilter[key] = false;
var cb = document.getElementById(VARIANT_CHECKBOX_IDS[key]);
if (cb) cb.checked = false;
});
applyDexVariantFilter();
});
// Shared across all three Living Dex toolbar dropdowns (variant filter,
// sort, type filter) so opening one always closes the others - each
// button's own click handler stops propagation (so it can toggle itself
// without the document-level listener immediately closing it again),
// which means the document listener never gets a chance to close a
// *different* dropdown that was already open. This runs that same
// "close everything" sweep manually, minus whichever wrap is about to
// be opened.
function closeOtherDexDropdowns(exceptId) {
['variant-filter-wrap', 'dex-sort-wrap', 'dex-type-wrap', 'log-search-wrap', 'log-sort-wrap', 'log-filter-wrap'].forEach(function(id) {
if (id === exceptId) return;
var wrap = document.getElementById(id);
if (wrap) wrap.classList.remove('open');
});
}
document.getElementById('btn-variant-filter').addEventListener('click', function(e) {
e.stopPropagation();
closeOtherDexDropdowns('variant-filter-wrap');
document.getElementById('variant-filter-wrap').classList.toggle('open');
});
document.getElementById('variant-filter-panel').addEventListener('click', function(e) {
e.stopPropagation();
});
document.addEventListener('click', function() {
closeOtherDexDropdowns(null);
});
// Re-orders the chips already sitting in the DOM to match dexSortMode,
// by moving the existing chip elements (appendChild on an element
// already in the document just relocates it) instead of rebuilding the
// grid. Rebuilding would hand every sprite a brand-new <img loading="lazy">
// node, and a fresh lazy image only starts fetching once it's near the
// viewport - so a full rebuild left everything below the fold blank
// until scrolled to. Moving the existing nodes keeps their already-
// loaded (or already-fetching) image intact, so re-sorting never blanks
// out the list.
function resortDexGrid() {
var caught = (dexMode === 'shiny') ?
Object.assign({}, shinyCaughtSet(), state.livingDexShiny) :
state.livingDex;
document.querySelectorAll('#dex-grid .dex-card').forEach(function(card) {
var gen = GEN_DATA.filter(function(g) {
return String(g.gen) === card.dataset.gen;
})[0];
if (!gen) return;
var panel = card.querySelector('.dex-species-grid');
if (!panel) return;
var chipByName = {};
panel.querySelectorAll('.dex-chip').forEach(function(chip) {
chipByName[chip.dataset.name] = chip;
});
sortDexSpecies(gen.species, caught, dexSortMode).forEach(function(sp) {
var chip = chipByName[normName(sp[1])];
if (chip) panel.appendChild(chip);
});
});
}
// Finds which generation a species belongs to, for the search-jump box.
function findDexLocation(name) {
var norm = normName(name);
for (var i = 0; i < GEN_DATA.length; i++) {
var g = GEN_DATA[i];
for (var j = 0; j < g.species.length; j++) {
if (normName(g.species[j][1]) === norm) return {
gen: g.gen
};
}
}
return null;
}
// Like findDexLocation, but also returns the species' 1-indexed position
// within its own generation's species list and that generation's total
// count - i.e. a TCG-style "set number" (Charmander -> 4/151 in Kanto)
// rather than the national dex number used elsewhere on the card.
function genSetInfoFor(name) {
var norm = normName(name);
for (var i = 0; i < GEN_DATA.length; i++) {
var g = GEN_DATA[i];
for (var j = 0; j < g.species.length; j++) {
if (normName(g.species[j][1]) === norm) {
return {
gen: g.gen,
region: g.region,
relNum: j + 1,
genTotal: g.species.length
};
}
}
}
return null;
}
// Opens the right generation card, scrolls it into view, and highlights
// the matching chip so a search-box selection is easy to spot. The
// card and its chips already exist in the DOM from the initial render -
// expanding is just a CSS class flip, so this never touches (or
// reloads) any sprite <img>. The highlight persists until the region
// card is collapsed (see the toggle-dex click handler above).
function jumpToDexSpecies(name) {
var loc = findDexLocation(name);
if (!loc) return;
var card = document.querySelector('#dex-grid .dex-card[data-gen="' + loc.gen + '"]');
if (!card) return;
// Only one search highlight is shown at a time, so clear any leftover
// highlight from a previous jump before applying the new one.
document.querySelectorAll('.dex-chip-highlighted').forEach(function(chip) {
chip.classList.remove('dex-chip-highlighted');
});
dexOpenGens[loc.gen] = true;
card.classList.add('expanded');
updateDexExpandAllLabel();
if (typeof card.scrollIntoView === 'function') card.scrollIntoView({
behavior: 'smooth',
block: 'start'
});
var target = null;
var norm = normName(name);
card.querySelectorAll('.dex-chip').forEach(function(chip) {
if (chip.dataset.name === norm) target = chip;
});
if (target) {
target.classList.remove('dex-chip-highlighted');
// force reflow so re-triggering the flash animation on the same
// chip works even if it was already highlighted
void target.offsetWidth;
target.classList.add('dex-chip-highlighted');
}
}
// Keeps the Expand All / Collapse All button label in sync with
// whether every generation card is currently open.
function updateDexExpandAllLabel() {
var btn = document.getElementById('btn-dex-expand-all');
if (!btn) return;
var allOpen = GEN_DATA.length > 0 && GEN_DATA.every(function(g) {
return !!dexOpenGens[g.gen];
});
btn.textContent = allOpen ? 'Collapse All' : 'Expand All';
}
function shinyCaughtSet() {
var set = {};
state.collection.forEach(function(c) {
set[normName(c.pokemon)] = true;
});
return set;
}
// Splits a display name like "Rattata (Alolan)" into { base: "Rattata",
// tag: "Alolan" } for known regional-variant suffixes, so the chip can
// show the base species name plus a small separate tag instead of the
// whole parenthetical sitting inline in the name.
var KNOWN_REGION_TAGS = ['Alolan', 'Galarian', 'Hisuian', 'Paldean'];
function parseRegionalVariant(name) {
var m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(String(name || '').trim());
if (m && KNOWN_REGION_TAGS.indexOf(m[2].trim()) !== -1) {
return {
base: m[1],
tag: m[2].trim()
};
}
return {
base: name,
tag: null
};
}
document.getElementById('dex-mode-toggle').addEventListener('click', function(e) {
var btn = e.target.closest('button[data-mode]');
if (!btn) return;
dexMode = btn.dataset.mode;
document.querySelectorAll('#dex-mode-toggle button').forEach(function(b) {
b.classList.toggle('active', b.dataset.mode === dexMode);
});
renderLivingDex();
});
var DEX_SORT_LABELS = {
dex: 'Dex Number',
alpha: 'A–Z',
uncaught: 'Uncaught First'
};
document.getElementById('btn-dex-sort').addEventListener('click', function(e) {
e.stopPropagation();
closeOtherDexDropdowns('dex-sort-wrap');
document.getElementById('dex-sort-wrap').classList.toggle('open');
});
document.getElementById('dex-sort-panel').addEventListener('click', function(e) {
e.stopPropagation();
var opt = e.target.closest('.dex-select-option');
if (!opt) return;
dexSortMode = opt.dataset.value;
document.querySelectorAll('#dex-sort-panel .dex-select-option').forEach(function(o) {
o.classList.toggle('active', o === opt);
});
document.getElementById('btn-dex-sort').textContent = 'Sort: ' + DEX_SORT_LABELS[dexSortMode] + ' ▾';
document.getElementById('btn-dex-sort').classList.toggle('active', dexSortMode !== 'dex');
document.getElementById('dex-sort-wrap').classList.remove('open');
resortDexGrid();
});
var btnDexExpandAll = document.getElementById('btn-dex-expand-all');
if (btnDexExpandAll) {
btnDexExpandAll.addEventListener('click', function() {
var allOpen = GEN_DATA.length > 0 && GEN_DATA.every(function(g) {
return !!dexOpenGens[g.gen];
});
GEN_DATA.forEach(function(g) {
dexOpenGens[g.gen] = !allOpen;
});
document.querySelectorAll('#dex-grid .dex-card').forEach(function(card) {
card.classList.toggle('expanded', !allOpen);
});
updateDexExpandAllLabel();
});
}
var dexSearchInput = document.getElementById('dex-search');
attachPokemonAutocomplete(dexSearchInput);
dexSearchInput.addEventListener('change', function() {
var val = this.value.trim();
if (!val) return;
jumpToDexSpecies(val);
this.value = '';
});
function renderLivingDex() {
var caught = (dexMode === 'shiny') ?
Object.assign({}, shinyCaughtSet(), state.livingDexShiny) :
state.livingDex;
var totalSpecies = 0,
totalCaught = 0;
GEN_DATA.forEach(function(g) {
totalSpecies += g.species.length;
});
var grid = document.getElementById('dex-grid');
grid.innerHTML = '';
// Flags the grid so the CSS can give caught chips a sparkle/rainbow
// ring while browsing the Shiny Living Dex, instead of the plain
// green "caught" look used in normal Living Dex mode.
grid.classList.toggle('shiny-mode', dexMode === 'shiny');
GEN_DATA.forEach(function(g) {
var genCaught = 0;
g.species.forEach(function(sp) {
if (caught[normName(sp[1])]) genCaught++;
});
totalCaught += genCaught;
var pct = Math.round((genCaught / g.species.length) * 100);
var isOpen = !!dexOpenGens[g.gen];
var card = document.createElement('div');
card.className = 'dex-card' + (isOpen ? ' expanded' : '');
card.dataset.gen = g.gen;
var displaySpecies = sortDexSpecies(g.species, caught, dexSortMode);
var chipsHtml = displaySpecies.map(function(sp) {
var has = !!caught[normName(sp[1])];
var variant = parseRegionalVariant(sp[1]);
var nameHtml = '<span class="dex-chip-name-text">' + escapeHtml(variant.base) + '</span>' + (variant.tag ? ' <span class="dex-chip-tag dex-chip-tag-' + variant.tag.toLowerCase() + '">' + variant.tag.toUpperCase() + '</span>' : '');
var interactive = ' data-action="toggle-species" data-name="' + escapeHtml(normName(sp[1])) + '"';
// data-variant tags each chip with its regional-variant category (or
// "Original" for base-form species) so applyDexVariantFilter() can
// show/hide chips by category without re-parsing the display name.
var variantAttr = ' data-variant="' + escapeHtml(variant.tag || 'Original') + '"';
var spriteImg = '<span class="dex-chip-sprite">' + smallSpriteMarkup(sp[1], dexEntrySpriteUrls(sp[1], dexMode === 'shiny')) + '</span>';
return '<div class="dex-chip' + (has ? ' caught' : '') + ' interactive"' + interactive + variantAttr + '>' + spriteImg + '<span class="n">#' + sp[0] + '</span><span class="dex-chip-name">' + nameHtml + '</span></div>';
}).join('');
var badgeCompleteClass = (pct === 100) ? ' complete' : '';
card.innerHTML =
'<div class="dex-card-banner">' +
'<div class="dex-card-head" data-action="toggle-dex" data-gen="' + g.gen + '">' +
// REGION BALL CONTAINER: round "pokeball" badge for each region,
// using REGION_BALLS (defined near GEN_DATA above) for the image,
// with the plain gen-number badge as a fallback if it's missing/fails to load.
// Gets a small green checkmark corner badge (see .dex-gen-badge.complete
// in style.css) once every species in this generation is caught.
(function() {
var ballFile = REGION_BALLS[g.region];
if (ballFile) {
return '<div class="dex-gen-badge' + badgeCompleteClass + '">' +
'<img src="images/region-balls/' + ballFile + '" alt="' + escapeHtml(g.region) + ' ball" onerror="this.style.display=\'none\'; this.nextElementSibling.style.display=\'flex\';">' +
'<span class="dex-gen-badge-fallback">' + g.gen + '</span>' +
'</div>';
}
return '<div class="dex-gen-badge' + badgeCompleteClass + '"><span class="dex-gen-badge-fallback" style="display:flex;">' + g.gen + '</span></div>';
})() +
'<div class="dex-card-title">' +
'<div class="region">' + escapeHtml(g.region) + '</div>' +
'<div class="gen-label">Generation ' + g.gen + '</div>' +
'</div>' +
'<div class="dex-card-count">' + genCaught + ' / ' + g.species.length + '</div>' +
'<div class="dex-chevron">▾</div>' +
'</div>' +
'<div class="dex-card-progress"><div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div></div>' +
'</div>' +
'<div class="dex-species-panel"><div class="dex-species-grid">' + chipsHtml + '</div></div>';
grid.appendChild(card);
});
var summary = document.getElementById('dex-summary');
var overallPct = totalSpecies > 0 ? Math.round((totalCaught / totalSpecies) * 100) : 0;
var label = dexMode === 'shiny' ? 'Shiny Species Caught' : 'Species Caught';
summary.innerHTML =
'<div><div class="num">' + totalCaught + ' / ' + totalSpecies + '</div><div class="lbl">' + label + '</div></div>' +
'<div class="bar-track"><div class="bar-fill" style="width:' + overallPct + '%"></div></div>' +
'<div style="font-weight:800; font-family:var(--hud); color:var(--red);">' + overallPct + '%</div>';
updateDexExpandAllLabel();
applyDexTypeFilter();
applyDexVariantFilter();
}
document.getElementById('dex-grid').addEventListener('click', function(e) {
var chip = e.target.closest('[data-action="toggle-species"]');
if (chip) {
var name = chip.dataset.name;
var store = (dexMode === 'shiny') ? state.livingDexShiny : state.livingDex;
var nowCaught;
if (store[name]) {
delete store[name];
nowCaught = false;
} else {
store[name] = true;
nowCaught = true;
}
save();
// Update just this chip + the counters in place, instead of calling
// renderLivingDex() and rebuilding the whole grid. A full rebuild
// recreates every sprite <img> in the Dex (every generation, not
// just the one clicked). Since sprites load with loading="lazy",
// brand-new <img> nodes only fetch once they're near the viewport -
// so a full rebuild also left most of the list blank until scrolled
// to, on top of restarting every onerror fallback chain from the top.
chip.classList.toggle('caught', nowCaught);
updateDexCounters();
// "Uncaught first" reorders chips by caught status, so a toggle
// still needs to move this chip - resortDexGrid() does that by
// relocating the existing chip nodes (no new <img> elements), so
// it doesn't trigger the blank-until-scrolled issue above either.
if (dexSortMode === 'uncaught') resortDexGrid();
return;
}
var head = e.target.closest('[data-action="toggle-dex"]');
if (!head) return;
var gen = head.dataset.gen;
dexOpenGens[gen] = !dexOpenGens[gen];
// Expanding/collapsing a card is pure CSS (the .expanded class toggles
// a display rule) so just flip the class - no need to rebuild the grid
// (and every sprite in it) just to open one card.
var genCard = head.closest('.dex-card');
genCard.classList.toggle('expanded', !!dexOpenGens[gen]);
// A search-jump highlight is meant to last only as long as its region
// stays open - once the person collapses the card, clear any
// highlighted chip inside it so it doesn't stay lit the next time
// the card is reopened.
if (!dexOpenGens[gen]) {
genCard.querySelectorAll('.dex-chip-highlighted').forEach(function(chip) {
chip.classList.remove('dex-chip-highlighted');
});
}
updateDexExpandAllLabel();
});
// Recomputes and updates the per-card and overall Living Dex counters
// (caught/total counts, progress bars, percentages) without touching any
// sprite <img> elements, so sprites never reload/re-flash from a counter
// update alone.
function updateDexCounters() {
var caught = (dexMode === 'shiny') ?
Object.assign({}, shinyCaughtSet(), state.livingDexShiny) :
state.livingDex;
var totalSpecies = 0,
totalCaught = 0;
document.querySelectorAll('#dex-grid .dex-card').forEach(function(card) {
var gen = GEN_DATA.filter(function(g) {
return String(g.gen) === card.dataset.gen;
})[0];
if (!gen) return;
var genCaught = 0;
gen.species.forEach(function(sp) {
if (caught[normName(sp[1])]) genCaught++;
});
totalCaught += genCaught;
totalSpecies += gen.species.length;
var pct = Math.round((genCaught / gen.species.length) * 100);
var countEl = card.querySelector('.dex-card-count');
if (countEl) countEl.textContent = genCaught + ' / ' + gen.species.length;
var barEl = card.querySelector('.dex-card-progress .bar-fill');
if (barEl) barEl.style.width = pct + '%';
var badgeEl = card.querySelector('.dex-gen-badge');
if (badgeEl) badgeEl.classList.toggle('complete', pct === 100);
});
var summary = document.getElementById('dex-summary');
var overallPct = totalSpecies > 0 ? Math.round((totalCaught / totalSpecies) * 100) : 0;
var label = dexMode === 'shiny' ? 'Shiny Species Caught' : 'Species Caught';
summary.innerHTML =
'<div><div class="num">' + totalCaught + ' / ' + totalSpecies + '</div><div class="lbl">' + label + '</div></div>' +
'<div class="bar-track"><div class="bar-fill" style="width:' + overallPct + '%"></div></div>' +
'<div style="font-weight:800; font-family:var(--hud); color:var(--red);">' + overallPct + '%</div>';
}
function renderAll() {
renderHunts();
renderCollection();
renderLivingDex();
}
/* ---------- live timer tick ---------- */
setInterval(function() {
if (views.hunts.style.display === 'none') return;
state.hunts.forEach(function(hunt) {
if (hunt.running) {
var elNum = document.querySelector('[data-timer-for="' + hunt.id + '"]');
if (elNum) elNum.textContent = fmtTime(elapsedSeconds(hunt));
}
});
}, 1000);
/* ---------- event delegation for hunt actions ---------- */
document.getElementById('hunts-list').addEventListener('click', function(e) {
var btn = e.target.closest('[data-action]');
if (!btn) return;
if (btn.dataset.action === 'new-hunt') {
openNewHuntModal();
return;
}
var id = btn.dataset.id;
var hunt = state.hunts.find(function(h) {
return h.id === id;
});
if (!hunt) return;
var action = btn.dataset.action;
var isHandheldBtn = btn.classList.contains('hunt-dex-round-btn') || btn.classList.contains('hdpad-btn') || btn.classList.contains('hunt-dex-pokeball-btn');
if (isHandheldBtn) {
// Play the push-down-then-pop animation on the real button first.
// The re-render below replaces this button with a fresh one, so
// without this delay the animation would never get a chance to play.
btn.classList.add('is-pressing');
setTimeout(function() {
runHuntAction(action, hunt, id, btn);
}, 180);
return;
}
runHuntAction(action, hunt, id, btn);
});
document.getElementById('hunts-list').addEventListener('keydown', function(e) {
if (e.key !== 'Enter' && e.key !== ' ') return;
var lens = e.target.closest('[data-action="new-hunt"]');
if (!lens) return;
e.preventDefault();
openNewHuntModal();
});
function runHuntAction(action, hunt, id, btn) {
if (action === 'add-encounter' || action === 'add-encounter-5') {
hunt.encounters += (action === 'add-encounter-5' ? 5 : 1);
if (!hunt.running) {
hunt.running = true;
hunt.runStart = Date.now();
}
spawnSparkle(btn);
save();
renderHunts();
} else if (action === 'remove-encounter') {
// Corrects a misclick rather than logging a real encounter, so unlike
// +1/+5 it doesn't spawn a sparkle or auto-start the timer - and it
// never drops the count below zero.
hunt.encounters = Math.max(0, hunt.encounters - 1);
save();
renderHunts();
} else if (action === 'toggle-timer') {
if (hunt.running) {
hunt.accumulatedSeconds = elapsedSeconds(hunt);
hunt.running = false;
hunt.runStart = null;
} else {
hunt.running = true;
hunt.runStart = Date.now();
}
spawnSparkle(btn);
save();
renderHunts();
} else if (action === 'mark-found') {
spawnSparkle(btn);
openFoundModal(hunt);
} else if (action === 'delete-hunt') {
if (confirm('Abandon this hunt? This can\'t be undone.')) {
state.hunts = state.hunts.filter(function(h) {
return h.id !== id;
});
save();
renderHunts();
}
}
}
function spawnSparkle(btn) {
var s = document.createElement('span');
s.className = 'sparkle';
s.textContent = '✦';
var rect = btn.getBoundingClientRect();
s.style.left = (rect.left + rect.width / 2 - 6) + 'px';
s.style.top = (rect.top - 4) + 'px';
s.style.position = 'fixed';
document.body.appendChild(s);
setTimeout(function() {
s.remove();
}, 800);
}
/* ---------- modals ---------- */
function openModal(html, extraClass) {
var overlay = document.createElement('div');
overlay.className = 'overlay';
overlay.innerHTML = '<div class="modal' + (extraClass ? ' ' + extraClass : '') + '">' + html + '</div>';
overlay.addEventListener('click', function(e) {
if (e.target === overlay) overlay.remove();
});
document.body.appendChild(overlay);
// Lock the page behind the overlay from scrolling while it's open.
// Overlays get closed from several different places (cancel, save,
// backdrop click, delete, etc.) rather than one central function, so
// instead of touching every one of those call sites, just watch for
// this overlay leaving the DOM and unlock automatically - and only
// once no other overlay is still open, in case one is ever stacked
// on top of another.
document.documentElement.classList.add('modal-open');
var scrollLockObserver = new MutationObserver(function() {
if (!document.body.contains(overlay)) {
scrollLockObserver.disconnect();
if (!document.querySelector('.overlay')) {
document.documentElement.classList.remove('modal-open');
}
}
});
scrollLockObserver.observe(document.body, { childList: true });
return overlay;
}
function gameOptions(sel) {
return GAMES.map(function(g) {
return '<option ' + (g === sel ? 'selected' : '') + '>' + g + '</option>';
}).join('');
}
function methodOptions(sel) {
return METHODS.map(function(m) {
return '<option ' + (m === sel ? 'selected' : '') + '>' + m + '</option>';
}).join('');
}
function openNewHuntModal() {
// Remember the Game/Method picked last time, so repeat hunts don't
// require reselecting them every time - only the Pokémon name resets.
var prefs = state.lastHuntPrefs || {};
var overlay = openModal(
'<div class="hunt-dexnav-hinge" aria-hidden="true"><span></span><span></span></div>' +
'<div class="hunt-dexnav-screws" aria-hidden="true"><span></span><span></span><span></span><span></span></div>' +
'<div class="hunt-dexnav-screen">' +
'<div class="modal-dex-head">' +
'<div class="modal-dex-head-title"><span class="modal-dex-dot"></span><h3>Start a Hunt</h3></div>' +
'<div class="modal-dex-lights" aria-hidden="true"><span class="modal-dex-light g lit"></span><span class="modal-dex-light y"></span></div>' +
'</div>' +
'<div class="hunt-radar">' +
'<div class="hunt-radar-ring" aria-hidden="true"></div>' +
'<div class="hunt-radar-sweep" aria-hidden="true"></div>' +
'<div class="hunt-radar-crosshair" aria-hidden="true"></div>' +
'<svg class="hunt-radar-lines" aria-hidden="true"></svg>' +
'<div class="hunt-radar-select-field node-game">' +
'<span class="hunt-radar-node-label">Game</span>' +
'<div class="hunt-radar-select-value" id="f-game-visual"></div>' +
'<select id="f-game" class="hunt-radar-select-native">' + gameOptions(prefs.game) + '</select>' +
'</div>' +
'<div class="hunt-radar-select-field node-method">' +
'<span class="hunt-radar-node-label">Method</span>' +
'<div class="hunt-radar-select-value" id="f-method-visual"></div>' +
'<select id="f-method" class="hunt-radar-select-native">' + methodOptions(prefs.method) + '</select>' +
'</div>' +
'<div class="hunt-radar-orb-wrap">' +
'<div class="hunt-radar-orb" id="f-portrait"><span class="fallback-letter">?</span></div>' +
'<div class="hunt-radar-id">' +
'<span class="modal-dex-num" id="f-dexnum"></span>' +
'<span class="modal-dex-types" id="f-types"></span>' +
'</div>' +
'</div>' +
'<div class="hunt-radar-node node-odds">' +
'<span class="hunt-radar-node-label">Odds</span>' +
'<div class="odds-display" id="f-odds-display"></div>' +
'</div>' +
'<div class="hunt-radar-node node-charm" id="f-charm-field">' +
'<div class="checkbox-field"><input type="checkbox" id="f-charm"><label for="f-charm">Shiny Charm</label></div>' +
'<div class="field-hint" id="f-charm-hint"></div>' +
'</div>' +
'</div>' +
'</div>' +
'<div class="field hunt-radar-name-field"><label>Target Pokémon</label><input type="text" id="f-pokemon" placeholder="e.g. Gible" autofocus></div>' +
'<div class="modal-actions hunt-dexnav-keys">' +
'<div class="hunt-dexnav-key-group">' +
'<button class="ghost hunt-dexnav-key" id="cancel" aria-label="Cancel">Cancel</button>' +
'<span class="hunt-dexnav-key-label">Cancel</span>' +
'</div>' +
'<div class="hunt-dexnav-key-group">' +
'<button class="primary hunt-dexnav-key" id="save" aria-label="Start Hunt">Start Hunt</button>' +
'<span class="hunt-dexnav-key-label">Start</span>' +
'</div>' +
'</div>' +
'<div class="hunt-dexnav-vents" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>' +
'<span class="hunt-dexnav-brand" aria-hidden="true">DEXNAV</span>',
'modal-new-hunt'
);
var oddsDisplay = overlay.querySelector('#f-odds-display');
var gameSel = overlay.querySelector('#f-game');
var methodSel = overlay.querySelector('#f-method');
var gameVisual = overlay.querySelector('#f-game-visual');
var methodVisual = overlay.querySelector('#f-method-visual');
var charmChk = overlay.querySelector('#f-charm');
var charmHint = overlay.querySelector('#f-charm-hint');
var pokemonInput = overlay.querySelector('#f-pokemon');
var portrait = overlay.querySelector('#f-portrait');
var dexNumEl = overlay.querySelector('#f-dexnum');
var typesEl = overlay.querySelector('#f-types');
charmChk.checked = !!prefs.shinyCharm;
// Game/Method are real <select> elements (so the native picker, keyboard
// nav, and mobile scroll-wheel all still work) laid transparently over
// a plain text div that shows the current value - that div is free to
// wrap onto a second line, so long entries like "Omega Ruby/Alpha
// Sapphire" are never clipped the way a native select's own closed-state
// text would be.
function syncSelectVisual(select, visual) {
visual.textContent = select.value;
}
syncSelectVisual(gameSel, gameVisual);
syncSelectVisual(methodSel, methodVisual);
attachPokemonAutocomplete(pokemonInput);
// Live shiny-sprite + dex-number + type-badge preview: fills in as soon
// as the typed name resolves to a known species, and resets to the "?"
// placeholder state the rest of the time (empty field, mid-typing, or
// an unrecognized name), so it's a quick "did I type that right?" check
// before committing to the hunt.
function refreshPortrait() {
var name = pokemonInput.value.trim();
var info = name ? speciesInfo(name) : null;
if (info) {
portrait.innerHTML = spriteMarkup(name);
var dexNum = dexNumberOf(name);
dexNumEl.textContent = dexNum ? ('No. ' + String(dexNum).padStart(4, '0')) : '';
typesEl.innerHTML = info.types.map(function(t) {
var color = TYPE_COLORS[t] || 'var(--ink-dim)';
return '<span class="tag tag-type" style="--type-color:' + color + '">' + escapeHtml(t) + '</span>';
}).join('');
} else {
portrait.innerHTML = '<span class="fallback-letter">?</span>';
dexNumEl.textContent = '';
typesEl.innerHTML = '';
}
}
pokemonInput.addEventListener('input', refreshPortrait);
pokemonInput.addEventListener('change', refreshPortrait);
// Draws the green "radar" leader lines connecting the sprite orb to each
// of the four info nodes (Game/Method/Odds/Charm), replacing what used
// to be four separate boxed fields. Measures actual rendered positions
// (via getBoundingClientRect) rather than hardcoding coordinates, so it
// stays correct across text wrapping, font loading, and window resizes.
function layoutHuntRadarLines() {
var radar = overlay.querySelector('.hunt-radar');
var svg = overlay.querySelector('.hunt-radar-lines');
var orb = overlay.querySelector('.hunt-radar-orb');
if (!radar || !svg || !orb) return;
var radarRect = radar.getBoundingClientRect();
if (!radarRect.width || !radarRect.height) return;
svg.setAttribute('viewBox', '0 0 ' + radarRect.width + ' ' + radarRect.height);
var orbRect = orb.getBoundingClientRect();
var cx = orbRect.left + orbRect.width / 2 - radarRect.left;
var cy = orbRect.top + orbRect.height / 2 - radarRect.top;
var r = orbRect.width / 2;
function edgePoint(dx, dy) {
var len = Math.sqrt(dx * dx + dy * dy) || 1;
return { x: cx + (dx / len) * r, y: cy + (dy / len) * r };
}
// Traces an elbowed line (diagonal, then straight) from the given
// corner of a node's bounding box out to a point on the orb's edge in
// the direction (dx, dy). cornerX/cornerY pick which corner of the
// node to start from, so the line leaves from whichever side of the
// text actually faces the orb.
function tracePath(selector, dx, dy, cornerX, cornerY) {
var node = overlay.querySelector(selector);
if (!node) return null;
var nRect = node.getBoundingClientRect();
if (!nRect.width || !nRect.height) return null;
var anchor = {
x: (cornerX === 'right' ? nRect.right : nRect.left) - radarRect.left,
y: (cornerY === 'bottom' ? nRect.bottom : nRect.top) - radarRect.top
};
var edge = edgePoint(dx, dy);
var ddx = edge.x - anchor.x;
var ddy = edge.y - anchor.y;
// Scale the curve's "bend" proportionally to the line's own length (instead
// of a fixed 16px), so long lines (Odds/Charm, far from the orb) curve just
// as visibly as short ones (Game/Method, close to the orb). Capped at 40px
// so very long lines don't over-curve.
var dist = Math.sqrt(ddx * ddx + ddy * ddy);
var L = Math.min(dist * 0.35, 40);
var elbow = {
x: anchor.x + (ddx < 0 ? -L : L),
y: anchor.y + (ddy < 0 ? -L : L)
};
return { anchor: anchor, elbow: elbow, edge: edge };
}
// Reflects every point in a trace across the orb's horizontal center (cx),
// so the mirrored side is a true reflection instead of being independently
// computed from its own (differently sized/positioned) node.
function mirrorPoints(t) {
if (!t) return null;
function flip(p) { return { x: 2 * cx - p.x, y: p.y }; }
return { anchor: flip(t.anchor), elbow: flip(t.elbow), edge: flip(t.edge) };
}
function pathString(t) {
return 'M ' + t.anchor.x.toFixed(1) + ' ' + t.anchor.y.toFixed(1) +
' Q ' + t.elbow.x.toFixed(1) + ' ' + t.elbow.y.toFixed(1) +
' ' + t.edge.x.toFixed(1) + ' ' + t.edge.y.toFixed(1);
}
var gameTrace = tracePath('.node-game .hunt-radar-select-value', -0.75, -0.75, 'right', 'bottom');
var methodTrace = mirrorPoints(gameTrace) || tracePath('.node-method .hunt-radar-select-value', 0.75, -0.75, 'left', 'bottom');
var oddsTrace = tracePath('.node-odds .odds-display', -0.75, 0.75, 'right', 'top');
var charmTrace = mirrorPoints(oddsTrace) || tracePath('.node-charm .checkbox-field', 0.75, 0.75, 'left', 'top');
var traces = [gameTrace, methodTrace, oddsTrace, charmTrace];
var markup = '';
traces.forEach(function(t) {
if (!t) return;
markup += '<path class="hunt-radar-line-path" d="' + pathString(t) + '"/>' +
'<circle class="hunt-radar-line-dot" cx="' + t.edge.x.toFixed(1) + '" cy="' + t.edge.y.toFixed(1) + '" r="2.5"/>';
});
svg.innerHTML = markup;
}
requestAnimationFrame(layoutHuntRadarLines);
var huntRadarResizeHandler = function() {
if (!document.body.contains(overlay)) {
window.removeEventListener('resize', huntRadarResizeHandler);
return;
}
layoutHuntRadarLines();
};
window.addEventListener('resize', huntRadarResizeHandler);
// Shiny Charm didn't exist before Gen 6 (and isn't a thing in GO), so
// the checkbox disables itself - and unchecks - for games where it
// couldn't actually be equipped, instead of silently no-op'ing the
// odds boost for an invalid game/charm combination.
function refreshCharmAvailability() {
var available = SHINY_CHARM_GAMES.indexOf(gameSel.value) !== -1;
charmChk.disabled = !available;
if (!available) {
charmChk.checked = false;
}
charmHint.textContent = available ? '' : 'Not available in ' + gameSel.value + '.';
}
function refreshOdds() {
refreshCharmAvailability();
var denom = computeOdds(gameSel.value, methodSel.value, charmChk.checked);
oddsDisplay.textContent = '1 in ' + denom.toLocaleString();
requestAnimationFrame(layoutHuntRadarLines);
}
refreshOdds();
gameSel.addEventListener('change', function() {
syncSelectVisual(gameSel, gameVisual);
refreshOdds();
});
methodSel.addEventListener('change', function() {
syncSelectVisual(methodSel, methodVisual);
refreshOdds();
});
charmChk.addEventListener('change', refreshOdds);
overlay.querySelector('#cancel').addEventListener('click', function() {
var btn = this;
btn.classList.add('is-pressing');
setTimeout(function() {
overlay.remove();
}, 180);
});
overlay.querySelector('#save').addEventListener('click', function() {
var name = overlay.querySelector('#f-pokemon').value.trim();
if (!name) {
overlay.querySelector('#f-pokemon').focus();
return;
}
var btn = this;
btn.classList.add('is-pressing');
setTimeout(function() {
var denom = computeOdds(gameSel.value, methodSel.value, charmChk.checked);
state.lastHuntPrefs = {
game: gameSel.value,
method: methodSel.value,
shinyCharm: charmChk.checked
};
state.hunts.push({
id: uid(),
pokemon: name,
game: gameSel.value,
method: methodSel.value,
shinyCharm: charmChk.checked,
denom: denom,
encounters: 0,
accumulatedSeconds: 0,
running: false,
runStart: null,
createdAt: Date.now()
});
save();
renderHunts();
overlay.remove();
}, 180);
});
}
var btnNewHunt = document.getElementById('btn-new-hunt');
if (btnNewHunt) btnNewHunt.addEventListener('click', openNewHuntModal);
var btnLogCatch = document.getElementById('btn-log-catch');
if (btnLogCatch) btnLogCatch.addEventListener('click', function() {
openCatchModal(null);
});
document.getElementById('btn-toggle-log-edit').addEventListener('click', function() {
logEditMode = !logEditMode;
this.classList.toggle('active', logEditMode);
this.setAttribute('aria-pressed', logEditMode ? 'true' : 'false');
renderCollection();
});
function openFoundModal(hunt) {

  var info = speciesInfo(hunt.pokemon);
  var types = info ? info.types : [];
  var typeColor = TYPE_COLORS[types[0]] || 'var(--yellow)';
  var dexNum = dexNumberOf(hunt.pokemon);
  var dexNumStr = dexNum ? ('NO. ' + String(dexNum).padStart(3, '0')) : 'NO. ???';
  var timeHunted = fmtTime(elapsedSeconds(hunt));
  var oddsStr = hunt.denom ? ('1/' + hunt.denom) : '—';
  var hpUnitLabel = methodUnit(hunt.method).toUpperCase();
  var dateEndedStr = fmtDate(new Date());
  var genLabel = info && info.gen ? ('Generation ' + info.gen) : '';

  var genSetInfo = genSetInfoFor(hunt.pokemon);
  var cardNumStr = genSetInfo ?
    (String(genSetInfo.relNum).padStart(3, '0') + '/' + genSetInfo.genTotal) :
    (dexNum ? String(dexNum).padStart(3, '0') : '???') + '/' + totalSpeciesCount();
  var setBallFile = genSetInfo ? REGION_BALLS[genSetInfo.region] : null;
  var setBallMarkup = setBallFile ?
    '<img class="tcg-credit-seticon" src="images/region-balls/' + setBallFile + '" alt="' + escapeHtml(genSetInfo.region) + ' ball" onerror="this.style.display=\'none\'">' : '';

  var overlay = openModal(
    '<div class="tcg-card" style="--type-color:' + typeColor + '">' +
      '<div class="tcg-inner">' +

        '<div class="tcg-header">' +
          '<div class="tcg-header-left">' +
            '<h3 class="tcg-name">' + escapeHtml(hunt.pokemon) + '</h3>' +
            '<div class="tcg-evo-stage" id="tcg-evo-stage" style="display:none;"></div>' +
            '<div class="tcg-evo-line" id="tcg-evo-line" style="display:none;"></div>' +
          '</div>' +
          '<div class="tcg-hp">' +
            '<div>' +
              '<div class="tcg-hp-label">' + hpUnitLabel + '</div>' +
              '<div class="tcg-hp-value">' + (hunt.encounters || 0) + '</div>' +
            '</div>' +
            hpTypeIcon(types, typeColor) +
          '</div>' +
        '</div>' +

        '<div class="tcg-art">' +
          '<div class="tcg-art-rays"></div>' +
          '<div class="tcg-art-glow"></div>' +
          '<span class="tcg-spark s1">✦</span>' +
          '<span class="tcg-spark s2">✧</span>' +
          '<span class="tcg-spark s3">✦</span>' +
          '<div class="tcg-preevo" id="tcg-preevo" style="display:none;"></div>' +
          '<div class="tcg-sprite-wrap" id="tcg-confirm-sprite" title="Click to add to your collection" role="button" tabindex="0" aria-label="Confirm and add to collection">' +
            spriteMarkup(hunt.pokemon) +
          '</div>' +
        '</div>' +

        '<div class="tcg-dexline">' + dexNumStr + '&nbsp;•&nbsp;' + typeBadges(types) + '</div>' +
        '<div class="tcg-dates">Began ' + fmtDate(hunt.createdAt) + '&nbsp;•&nbsp;Caught ' + dateEndedStr + '</div>' +

        '<div class="tcg-attack">' +
          '<div class="tcg-attack-cost">' + energyIcon(null, types[0]) + '</div>' +
          '<div class="tcg-attack-name">Time Hunted</div>' +
          '<div class="tcg-attack-dmg">' + timeHunted + '</div>' +
        '</div>' +
        '<div class="tcg-attack">' +
          '<div class="tcg-attack-cost">' + energyIcon(null, types[1] || types[0]) + '</div>' +
          '<div class="tcg-attack-name">Odds of Encounter</div>' +
          '<div class="tcg-attack-dmg">' + oddsStr + '</div>' +
        '</div>' +

        weaknessResistanceBar(types) +

        '<table class="tcg-stats-table">' +
          '<tr>' +
            '<td class="tcg-stats-icon">' + gameIconMarkup(hunt.game) + '</td>' +
            '<td class="tcg-stats-label">Game</td>' +
            '<td class="tcg-stats-value">' + escapeHtml(hunt.game) + '</td>' +
          '</tr>' +
          '<tr>' +
            '<td class="tcg-stats-icon">' + methodIconMarkup() + '</td>' +
            '<td class="tcg-stats-label">Method</td>' +
            '<td class="tcg-stats-value">' + escapeHtml(hunt.method) + '</td>' +
          '</tr>' +
          '<tr' + (hunt.shinyCharm ? ' class="tcg-stats-row-active"' : '') + '>' +
            '<td class="tcg-stats-icon">' + charmIconMarkup() + '</td>' +
            '<td class="tcg-stats-label">Charm</td>' +
            '<td class="tcg-stats-value">' + (hunt.shinyCharm ? 'Yes' : 'No') + '</td>' +
          '</tr>' +
        '</table>' +

        '<div class="tcg-credit">' +
          '<div class="tcg-credit-row">' +
            '<span class="tcg-credit-illus">Illus. Shiny Tracker</span>' +
            (genLabel ? ('<span class="tcg-credit-sep">•</span><span class="tcg-credit-gen">' + escapeHtml(genLabel) + '</span>') : '') +
          '</div>' +
          '<div class="tcg-credit-row tcg-credit-num">' +
            setBallMarkup +
            '<span>' + cardNumStr + '</span>' +
            rarityGlyphMarkup(hunt.denom) +
          '</div>' +
        '</div>' +

      '</div>' +
    '</div>',

    'modal-found'
  );

  hydrateTypeCircleIcons(overlay);

  function confirmFound() {

    var timeSpentMinutes = Math.round(elapsedSeconds(hunt) / 60);
    var pokemonName = hunt.pokemon;
    var savedInfo = speciesInfo(pokemonName);

    state.collection.push({
      id: uid(),
      pokemon: pokemonName,
      gen: savedInfo ? savedInfo.gen : null,
      types: savedInfo ? savedInfo.types : [],
      game: hunt.game,
      method: hunt.method,
      shinyCharm: hunt.shinyCharm,
      denom: hunt.denom,
      encounters: hunt.encounters || 0,
      dateBegan: fmtDate(hunt.createdAt),
      dateEnded: new Date().toISOString().slice(0, 10),
      timeSpentMinutes: timeSpentMinutes,
      notes: ''
    });

    logSelectedId = state.collection[state.collection.length - 1].id;
    state.hunts = state.hunts.filter(function(h) {
      return h.id !== hunt.id;
    });

    save();
    renderAll();
    overlay.remove();

    var tabBtn = document.querySelector('nav.tabs button[data-tab="collection"]');
    if (tabBtn) { tabBtn.click(); } else { activateTab('collection'); }
  }

  fetchEvolvesFrom(hunt.pokemon).then(function(fromName) {
    var evoEl = overlay.querySelector('#tcg-evo-line');
    var preEvoEl = overlay.querySelector('#tcg-preevo');
    var cardEl = overlay.querySelector('.tcg-card');
    if (fromName) {
      if (cardEl) cardEl.classList.add('has-evo');
      if (evoEl) {
        evoEl.textContent = 'Evolves from ' + fromName;
        evoEl.style.display = '';
      }
      if (preEvoEl) {
        preEvoEl.innerHTML = spriteMarkup(fromName);
        preEvoEl.style.display = 'flex';
      }
    }
  });

  fetchEvoStage(hunt.pokemon).then(function(stage) {
    var label = stageLabel(stage);
    if (!label) return;
    var stageEl = overlay.querySelector('#tcg-evo-stage');
    var cardEl = overlay.querySelector('.tcg-card');
    if (cardEl) cardEl.classList.add('has-stage');
    if (stageEl) {
      stageEl.textContent = label;
      stageEl.style.display = '';
    }
  });

  function showCatchConfirmPopover() {
    if (overlay.querySelector('.catch-confirm-popover-backdrop')) return;

    var backdrop = document.createElement('div');
    backdrop.className = 'catch-confirm-popover-backdrop';
    backdrop.innerHTML =
      '<div class="catch-confirm-popover">' +
        '<div class="catch-confirm-popover-title">Log this catch?</div>' +
        '<div class="catch-confirm-popover-sub">' + escapeHtml(hunt.pokemon) + ' will be added to your Shiny Log.</div>' +
        '<div class="catch-confirm-popover-actions">' +
          '<button type="button" class="ghost" data-popover-action="cancel">Cancel</button>' +
          '<button type="button" class="primary" data-popover-action="confirm">Yes, caught it!</button>' +
        '</div>' +
      '</div>';

    backdrop.addEventListener('click', function(e) {
      if (e.target === backdrop) backdrop.remove();
    });
    backdrop.querySelector('[data-popover-action="cancel"]').addEventListener('click', function() {
      backdrop.remove();
    });
    backdrop.querySelector('[data-popover-action="confirm"]').addEventListener('click', function() {
      backdrop.remove();
      confirmFound();
    });

    overlay.appendChild(backdrop);
    backdrop.querySelector('[data-popover-action="confirm"]').focus();
  }

  var confirmSprite = overlay.querySelector('#tcg-confirm-sprite');
  confirmSprite.addEventListener('click', showCatchConfirmPopover);
  confirmSprite.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      showCatchConfirmPopover();
    }
  });
}
function openLogEntryCardModal(entry) {

  var info = speciesInfo(entry.pokemon);
  var types = (entry.types && entry.types.length) ? entry.types : (info ? info.types : []);
  var typeColor = TYPE_COLORS[types[0]] || 'var(--yellow)';
  var dexNum = dexNumberOf(entry.pokemon);
  var dexNumStr = dexNum ? ('NO. ' + String(dexNum).padStart(3, '0')) : 'NO. ???';
  var timeSpentStr = entry.timeSpentMinutes ? fmtTime(entry.timeSpentMinutes * 60) : '—';
  var denom = logEntryDenom(entry);
  var oddsStr = denom ? ('1/' + denom) : '—';
  var hpUnitLabel = methodUnit(entry.method).toUpperCase();
  var began = entry.dateBegan || entry.dateEnded || entry.date || '';
  var ended = entry.dateEnded || entry.date || entry.dateBegan || '';
  var genLabel = (entry.gen || (info ? info.gen : null)) ? ('Generation ' + (entry.gen || info.gen)) : '';

  var genSetInfo = genSetInfoFor(entry.pokemon);
  var cardNumStr = genSetInfo ?
    (String(genSetInfo.relNum).padStart(3, '0') + '/' + genSetInfo.genTotal) :
    (dexNum ? String(dexNum).padStart(3, '0') : '???') + '/' + totalSpeciesCount();
  var setBallFile = genSetInfo ? REGION_BALLS[genSetInfo.region] : null;
  var setBallMarkup = setBallFile ?
    '<img class="tcg-credit-seticon" src="images/region-balls/' + setBallFile + '" alt="' + escapeHtml(genSetInfo.region) + ' ball" onerror="this.style.display=\'none\'">' : '';

  var overlay = openModal(
    '<div class="tcg-card" style="--type-color:' + typeColor + '">' +
      '<div class="tcg-inner">' +

        '<div class="tcg-header">' +
          '<div class="tcg-header-left">' +
            '<h3 class="tcg-name">' + escapeHtml(entry.pokemon) + '</h3>' +
            '<div class="tcg-evo-stage" id="tcg-evo-stage" style="display:none;"></div>' +
            '<div class="tcg-evo-line" id="tcg-evo-line" style="display:none;"></div>' +
          '</div>' +
          '<div class="tcg-hp">' +
            '<div>' +
              '<div class="tcg-hp-label">' + hpUnitLabel + '</div>' +
              '<div class="tcg-hp-value">' + (entry.encounters || 0) + '</div>' +
            '</div>' +
            hpTypeIcon(types, typeColor) +
          '</div>' +
        '</div>' +

        '<div class="tcg-art">' +
          '<div class="tcg-art-rays"></div>' +
          '<div class="tcg-art-glow"></div>' +
          '<span class="tcg-spark s1">✦</span>' +
          '<span class="tcg-spark s2">✧</span>' +
          '<span class="tcg-spark s3">✦</span>' +
          '<div class="tcg-preevo" id="tcg-preevo" style="display:none;"></div>' +
          '<div class="tcg-sprite-wrap">' +
            spriteMarkup(entry.pokemon) +
          '</div>' +
        '</div>' +

        '<div class="tcg-dexline">' + dexNumStr + '&nbsp;•&nbsp;' + typeBadges(types) + '</div>' +
        '<div class="tcg-dates">Began ' + fmtDate(began) + '&nbsp;•&nbsp;Caught ' + fmtDate(ended) + '</div>' +

        '<div class="tcg-attack">' +
          '<div class="tcg-attack-cost">' + energyIcon(null, types[0]) + '</div>' +
          '<div class="tcg-attack-name">Time Hunted</div>' +
          '<div class="tcg-attack-dmg">' + timeSpentStr + '</div>' +
        '</div>' +
        '<div class="tcg-attack">' +
          '<div class="tcg-attack-cost">' + energyIcon(null, types[1] || types[0]) + '</div>' +
          '<div class="tcg-attack-name">Odds of Encounter</div>' +
          '<div class="tcg-attack-dmg">' + oddsStr + '</div>' +
        '</div>' +

        weaknessResistanceBar(types) +

        '<table class="tcg-stats-table">' +
          '<tr>' +
            '<td class="tcg-stats-icon">' + gameIconMarkup(entry.game) + '</td>' +
            '<td class="tcg-stats-label">Game</td>' +
            '<td class="tcg-stats-value">' + escapeHtml(entry.game) + '</td>' +
          '</tr>' +
          '<tr>' +
            '<td class="tcg-stats-icon">' + methodIconMarkup() + '</td>' +
            '<td class="tcg-stats-label">Method</td>' +
            '<td class="tcg-stats-value">' + escapeHtml(entry.method) + '</td>' +
          '</tr>' +
          '<tr' + (entry.shinyCharm ? ' class="tcg-stats-row-active"' : '') + '>' +
            '<td class="tcg-stats-icon">' + charmIconMarkup() + '</td>' +
            '<td class="tcg-stats-label">Charm</td>' +
            '<td class="tcg-stats-value">' + (entry.shinyCharm ? 'Yes' : 'No') + '</td>' +
          '</tr>' +
        '</table>' +

        '<div class="tcg-credit">' +
          '<div class="tcg-credit-row">' +
            '<span class="tcg-credit-illus">Illus. Shiny Tracker</span>' +
            (genLabel ? ('<span class="tcg-credit-sep">•</span><span class="tcg-credit-gen">' + escapeHtml(genLabel) + '</span>') : '') +
          '</div>' +
          '<div class="tcg-credit-row tcg-credit-num">' +
            setBallMarkup +
            '<span>' + cardNumStr + '</span>' +
            rarityGlyphMarkup(denom) +
          '</div>' +
        '</div>' +

      '</div>' +
    '</div>',

    'modal-found'
  );

  hydrateTypeCircleIcons(overlay);

  fetchEvolvesFrom(entry.pokemon).then(function(fromName) {
    var evoEl = overlay.querySelector('#tcg-evo-line');
    var preEvoEl = overlay.querySelector('#tcg-preevo');
    var cardEl = overlay.querySelector('.tcg-card');
    if (fromName) {
      if (cardEl) cardEl.classList.add('has-evo');
      if (evoEl) {
        evoEl.textContent = 'Evolves from ' + fromName;
        evoEl.style.display = '';
      }
      if (preEvoEl) {
        preEvoEl.innerHTML = spriteMarkup(fromName);
        preEvoEl.style.display = 'flex';
      }
    }
  });

  fetchEvoStage(entry.pokemon).then(function(stage) {
    var label = stageLabel(stage);
    if (!label) return;
    var stageEl = overlay.querySelector('#tcg-evo-stage');
    var cardEl = overlay.querySelector('.tcg-card');
    if (cardEl) cardEl.classList.add('has-stage');
    if (stageEl) {
      stageEl.textContent = label;
      stageEl.style.display = '';
    }
  });
}
function openCatchModal() {
var overlay = openModal(
'<h3>Log a Shiny</h3>' +
'<div class="field"><label>Pokémon</label><input type="text" id="f-pokemon" placeholder="e.g. Gible" autofocus></div>' +
'<div class="field-row">' +
'<div class="field"><label>Game</label><select id="f-game">' + gameOptions() + '</select></div>' +
'<div class="field"><label>Method</label><select id="f-method">' + methodOptions() + '</select></div>' +
'</div>' +
'<div class="field-row">' +
'<div class="field"><label>Encounters / Eggs / Resets</label><input type="number" id="f-enc" min="0" value="0"></div>' +
'<div class="field"><label>Time spent (minutes, optional)</label><input type="number" id="f-mins" min="0" placeholder="e.g. 90"></div>' +
'</div>' +
'<div class="field-row">' +
'<div class="field"><label>Date began</label><input type="date" id="f-date-began" value="' + new Date().toISOString().slice(0, 10) + '"></div>' +
'<div class="field"><label>Date ended</label><input type="date" id="f-date" value="' + new Date().toISOString().slice(0, 10) + '"></div>' +
'</div>' +
'<div class="field"><label>Notes (optional)</label><textarea id="f-notes" rows="2"></textarea></div>' +
'<div class="modal-actions"><button class="ghost" id="cancel">Cancel</button><button class="primary" id="save">Add to Collection</button></div>'
);
attachPokemonAutocomplete(overlay.querySelector('#f-pokemon'));
overlay.querySelector('#cancel').addEventListener('click', function() {
overlay.remove();
});
overlay.querySelector('#save').addEventListener('click', function() {
var name = overlay.querySelector('#f-pokemon').value.trim();
if (!name) {
overlay.querySelector('#f-pokemon').focus();
return;
}
var info = speciesInfo(name);
state.collection.push({
id: uid(),
pokemon: name,
gen: info ? info.gen : null,
types: info ? info.types : [],
game: overlay.querySelector('#f-game').value,
method: overlay.querySelector('#f-method').value,
encounters: parseInt(overlay.querySelector('#f-enc').value || '0', 10) || 0,
dateBegan: overlay.querySelector('#f-date-began').value,
dateEnded: overlay.querySelector('#f-date').value,
timeSpentMinutes: parseInt(overlay.querySelector('#f-mins').value || '0', 10) || 0,
notes: overlay.querySelector('#f-notes').value.trim()
});
logSelectedId = state.collection[state.collection.length - 1].id;
save();
renderCollection();
renderLivingDex();
overlay.remove();
});
}
function openEditLogModal(entry) {
var overlay = openModal(
'<h3>Edit Log Entry</h3>' +
'<div class="field"><label>Pokémon</label><input type="text" id="f-pokemon" value="' + escapeHtml(entry.pokemon) + '" autofocus></div>' +
'<div class="field-row">' +
'<div class="field"><label>Game</label><select id="f-game">' + gameOptions(entry.game) + '</select></div>' +
'<div class="field"><label>Method</label><select id="f-method">' + methodOptions(entry.method) + '</select></div>' +
'</div>' +
'<div class="field-row">' +
'<div class="field"><label>Encounters / Eggs / Resets</label><input type="number" id="f-enc" min="0" value="' + entry.encounters + '"></div>' +
'<div class="field"><label>Time spent (minutes, optional)</label><input type="number" id="f-mins" min="0" value="' + (entry.timeSpentMinutes || 0) + '"></div>' +
'</div>' +
'<div class="field-row">' +
'<div class="field"><label>Date began</label><input type="date" id="f-date-began" value="' + fmtDate(entry.dateBegan || entry.dateEnded || entry.date) + '"></div>' +
'<div class="field"><label>Date ended</label><input type="date" id="f-date" value="' + fmtDate(entry.dateEnded || entry.date) + '"></div>' +
'</div>' +
'<div class="field"><label>Notes (optional)</label><textarea id="f-notes" rows="2">' + escapeHtml(entry.notes || '') + '</textarea></div>' +
'<div class="modal-actions"><button class="ghost danger" id="delete">Delete Entry</button><button class="ghost" id="cancel">Cancel</button><button class="primary" id="save">Save Changes</button></div>'
);
attachPokemonAutocomplete(overlay.querySelector('#f-pokemon'));
overlay.querySelector('#cancel').addEventListener('click', function() {
overlay.remove();
});
overlay.querySelector('#delete').addEventListener('click', function() {
if (confirm('Delete this log entry? This can\'t be undone.')) {
state.collection = state.collection.filter(function(c) {
return c.id !== entry.id;
});
save();
renderCollection();
renderLivingDex();
overlay.remove();
}
});
overlay.querySelector('#save').addEventListener('click', function() {
var name = overlay.querySelector('#f-pokemon').value.trim();
if (!name) {
overlay.querySelector('#f-pokemon').focus();
return;
}
var info = speciesInfo(name);
entry.pokemon = name;
entry.gen = info ? info.gen : null;
entry.types = info ? info.types : [];
entry.game = overlay.querySelector('#f-game').value;
entry.method = overlay.querySelector('#f-method').value;
entry.encounters = parseInt(overlay.querySelector('#f-enc').value || '0', 10) || 0;
entry.dateBegan = overlay.querySelector('#f-date-began').value;
entry.dateEnded = overlay.querySelector('#f-date').value;
delete entry.date;
entry.timeSpentMinutes = parseInt(overlay.querySelector('#f-mins').value || '0', 10) || 0;
entry.notes = overlay.querySelector('#f-notes').value.trim();
save();
renderCollection();
renderLivingDex();
overlay.remove();
});
}
document.getElementById('log-latest-screen').addEventListener('click', function(e) {
var btn = e.target.closest('[data-action]');
if (!btn) return;
var id = btn.dataset.id;
var entry = state.collection.find(function(c) {
return c.id === id;
});
if (!entry) return;
if (btn.dataset.action === 'edit-log') {
openEditLogModal(entry);
} else if (btn.dataset.action === 'delete-log') {
if (confirm('Delete this log entry? This can\'t be undone.')) {
state.collection = state.collection.filter(function(c) {
return c.id !== id;
});
save();
renderCollection();
renderLivingDex();
}
} else if (btn.dataset.action === 'undo-log') {
if (confirm('Move "' + entry.pokemon + '" back to Active Hunts? It will be removed from your Shiny Log.')) {
undoLogEntry(entry);
}
}
});
// Reverses a catch: pulls a Shiny Log entry back out and rebuilds an
// Active Hunts entry from whatever info it saved (game, method, encounter
// count, time spent, shiny charm/odds if present), for the "I accidentally
// logged that before actually catching it" case. Placed at the very front
// of state.hunts, and its createdAt is nudged earlier than every other
// active hunt if needed, so it's guaranteed to land at the top of the
// default (oldest-first) Active Hunts sort regardless of when it actually
// began.
function undoLogEntry(entry) {
var guessedCreatedAt = entry.dateBegan ? new Date(entry.dateBegan).getTime() : NaN;
if (isNaN(guessedCreatedAt)) guessedCreatedAt = Date.now();
var minExistingCreatedAt = state.hunts.reduce(function(min, h) {
return Math.min(min, h.createdAt);
}, guessedCreatedAt);
var createdAt = Math.min(guessedCreatedAt, minExistingCreatedAt - 1);
var shinyCharm = !!entry.shinyCharm;
var denom = entry.denom || computeOdds(entry.game, entry.method, shinyCharm);

state.hunts.unshift({
id: uid(),
pokemon: entry.pokemon,
game: entry.game,
method: entry.method,
shinyCharm: shinyCharm,
denom: denom,
encounters: entry.encounters || 0,
accumulatedSeconds: (entry.timeSpentMinutes || 0) * 60,
running: false,
runStart: null,
createdAt: createdAt
});

state.collection = state.collection.filter(function(c) {
return c.id !== entry.id;
});

logSelectedId = state.collection.length ? state.collection[state.collection.length - 1].id : null;
save();
renderAll();

var tabBtn = document.querySelector('nav.tabs button[data-tab="hunts"]');
if (tabBtn) { tabBtn.click(); } else { activateTab('hunts'); }
}
document.getElementById('log-screen-prev').addEventListener('click', function() {
logScreenStep(-1);
});
document.getElementById('log-screen-next').addEventListener('click', function() {
logScreenStep(1);
});
(function initStars() {
var container = document.getElementById('stars');
for (var i = 0; i < 60; i++) {
var s = document.createElement('div');
s.className = 'star';
s.style.left = (Math.random() * 100) + '%';
s.style.top = (Math.random() * 100) + '%';
s.style.animationDelay = (Math.random() * 4) + 's';
container.appendChild(s);
}
})();
renderAll();
syncFromCloud();
})();
