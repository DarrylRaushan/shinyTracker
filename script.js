// of the screen instead of failing silently. Several past bugs in this file
// (see comments near syncTabChrome and connectToCloud) were invisible on
// mobile precisely because nothing surfaced the thrown error - this makes
// the next one visible without needing a computer/dev tools. Safe to remove
// once things are stable again.
(function() {
var shown = 0;
window.addEventListener('error', function(e) {
if (shown >= 3) return;
shown++;
var banner = document.createElement('div');
banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#c0392b;color:#fff;font:11px/1.4 monospace;padding:10px 12px;white-space:pre-wrap;max-height:40vh;overflow:auto;box-shadow:0 2px 8px rgba(0,0,0,.4);';
banner.textContent = 'JS Error: ' + e.message + '\n' + (e.filename ? e.filename.split('/').pop() : '') + ':' + e.lineno + ':' + e.colno;
document.body.appendChild(banner);
});
})();
// alone). The Firestore listener's own use of it wasn't wrapped in a
// try/catch though, so it threw on every snapshot and stopped the sync
// from ever applying - which is what broke "Firestore loading info"
// entirely.
var STORE_KEY = 'shinyTrackerState';
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
// The populated document in this Firebase project stores tracker fields directly
// at shinyTracker/state. Earlier revisions mistakenly listened to mydata.payload,
// which is a separate, empty legacy document and therefore made the app appear to
// stop loading saved data.
var CLOUD_DOC = null;
var LEGACY_CLOUD_DOC = null;
// Rolling snapshot history: a copy of state is written here every time
// pushToCloud() successfully saves, so a bad overwrite (this bug, a future
// bug, a fat-finger) can be undone from inside the app without touching the
// Firebase console. Only the most recent HISTORY_LIMIT snapshots are kept -
// see pruneHistory(). This is a recent-changes safety net, not a substitute
// for Firestore's own daily backups/PITR, which cover longer time spans.
var HISTORY_COLLECTION = null;
var HISTORY_LIMIT = 30;
var _cloudSaveTimer = null;
var _cloudRetryTimer = null;
var _cloudSyncStarted = false;
var _cloudMigrationAttempted = false;
// Guards against a stale local copy (e.g. a device/PWA install that hasn't
// been opened in a while, sitting on old localStorage) pushing its old data
// over a newer cloud document before it's had a chance to pull the current
// state down first. Until the first real pull-down completes, pushes are
// queued instead of sent, so we never win a race against our own stale cache.
var _cloudInitialPullDone = false;
var _pushPendingAfterPull = false;
function connectToCloud() {
if (CLOUD_DOC) return true;
try {
if (!window.firebase || !firebase.apps || !firebase.apps.length || !firebase.firestore) return false;
db = firebase.firestore();
CLOUD_DOC = db.collection('shinyTracker').doc('state');
LEGACY_CLOUD_DOC = db.collection('shinyTracker').doc('mydata');
HISTORY_COLLECTION = db.collection('shinyTrackerHistory');
return true;
} catch (e) {
console.error('Firestore unavailable', e);
return false;
}
}
function retryCloudConnection() {
if (_cloudRetryTimer) return;
_cloudRetryTimer = setTimeout(function() {
_cloudRetryTimer = null;
syncFromCloud();
}, 1000);
}
function normaliseCloudState(source) {
source = source && typeof source === 'object' ? source : {};
return {
hunts: Array.isArray(source.hunts) ? source.hunts : [],
collection: Array.isArray(source.collection) ? source.collection : [],
livingDex: source.livingDex && typeof source.livingDex === 'object' ? source.livingDex : {},
livingDexShiny: source.livingDexShiny && typeof source.livingDexShiny === 'object' ? source.livingDexShiny : {},
lastHuntPrefs: Object.prototype.hasOwnProperty.call(source, 'lastHuntPrefs') ? source.lastHuntPrefs : null
};
}
function cloudStateSignature(source) {
return JSON.stringify(normaliseCloudState(source));
}
function cloudFieldsFromState(source) {
var clean = normaliseCloudState(source);
clean.updatedAt = Date.now();
return clean;
}
function applyCloudState(remote) {
var clean = normaliseCloudState(remote);
if (cloudStateSignature(clean) === cloudStateSignature(state)) {
markInitialPullDone();
return;
}
state = clean;
try {
localStorage.setItem(STORE_KEY, JSON.stringify(state));
} catch (e) {}
renderAll();
markInitialPullDone();
}
function markInitialPullDone() {
if (_cloudInitialPullDone) return;
_cloudInitialPullDone = true;
if (_pushPendingAfterPull) {
_pushPendingAfterPull = false;
pushToCloud();
}
}
function pushToCloud() {
if (!connectToCloud()) {
retryCloudConnection();
return;
}
if (!_cloudInitialPullDone) {
// Don't write yet - we don't know if our local copy is stale. Remember
// that a push is owed and send it as soon as the first pull lands.
_pushPendingAfterPull = true;
return;
}
clearTimeout(_cloudSaveTimer);
_cloudSaveTimer = setTimeout(function() {
CLOUD_DOC.set(cloudFieldsFromState(state)).then(function() {
recordHistorySnapshot();
}).catch(function(e) {
console.error('Firestore save failed', e);
});
}, 600);
}
function recordHistorySnapshot() {
if (!HISTORY_COLLECTION) return;
var snapshot = cloudFieldsFromState(state);
snapshot.savedAt = Date.now();
HISTORY_COLLECTION.add(snapshot).then(pruneHistory).catch(function(e) {
console.error('Firestore history save failed', e);
});
}
function pruneHistory() {
if (!HISTORY_COLLECTION) return;
HISTORY_COLLECTION.orderBy('savedAt', 'desc').get().then(function(snap) {
if (snap.size <= HISTORY_LIMIT) return;
var batch = db.batch();
snap.docs.slice(HISTORY_LIMIT).forEach(function(doc) {
batch.delete(doc.ref);
});
batch.commit().catch(function(e) {
console.error('Firestore history prune failed', e);
});
}).catch(function(e) {
console.error('Firestore history prune query failed', e);
});
}
function migrateLegacyCloudIfNeeded() {
if (_cloudMigrationAttempted || !LEGACY_CLOUD_DOC) {
pushToCloud();
return;
}
_cloudMigrationAttempted = true;
LEGACY_CLOUD_DOC.get().then(function(legacyDoc) {
var legacy = legacyDoc.exists ? legacyDoc.data() : null;
if (legacy && typeof legacy.payload === 'string') {
try {
applyCloudState(JSON.parse(legacy.payload));
} catch (e) {
console.error('Failed to parse legacy Firestore data', e);
}
}
pushToCloud();
}).catch(function(e) {
console.error('Firestore legacy migration failed', e);
pushToCloud();
});
}
function syncFromCloud() {
if (!connectToCloud()) {
retryCloudConnection();
return;
}
if (_cloudSyncStarted) return;
_cloudSyncStarted = true;
CLOUD_DOC.onSnapshot(function(doc) {
if (!doc.exists) {
// First use of the current direct-field document: safely import an older
// payload document when present, otherwise seed it from local state.
// Nothing exists yet in the cloud, so there's no newer data we could
// clobber - safe to let a push through immediately.
_cloudInitialPullDone = true;
migrateLegacyCloudIfNeeded();
return;
}
if (doc.metadata.hasPendingWrites) return;
applyCloudState(doc.data());
}, function(e) {
console.error('Firestore sync error', e);
});
}
// This was defined but never called - invisible in regular Safari since
// localStorage persists across visits there, but fatal for the iOS
// "Add to Home Screen" app, which gets its own empty storage silo
// completely separate from Safari's on first launch. Without this call,
// that fresh empty local state had nothing to fall back on.
syncFromCloud();
var GAMES = ["Scarlet/Violet", "Legends Arceus", "Sword/Shield", "Let's Go Pikachu/Eevee",
"Ultra Sun/Ultra Moon", "Sun/Moon", "Omega Ruby/Alpha Sapphire", "X/Y",
"Black 2/White 2", "Black/White", "HeartGold/SoulSilver", "Platinum",
"Diamond/Pearl", "FireRed/LeafGreen", "Ruby/Sapphire/Emerald", "Pokémon GO", "Other"
];
// Custom per-game icon images for the catch-confirmation card (tcg-stats
// table "Game" row). Each entry lists the version(s) bundled into that
// game option as a full filename (with extension) living in
// images/game-symbols/ - gameIconMarkup() below renders one icon per
// name side by side. Extensions don't have to match each other (mix
// .png/.jpg/.webp freely) since the filename here is used exactly as
// written. If a file is missing, its own onerror just hides that icon
// (the other version's icon still shows); if a game has no mapping at
// all it falls back to the generic cartridge glyph (ICON_GAME).
// NOTE: rename these to match whatever you actually saved the images as
// (including the correct extension - a mismatched extension is the most
// common reason an icon silently fails to show).
var GAME_ICONS = {
"Scarlet/Violet": ["scarlet.jpg", "violet.jpg"],
"Legends Arceus": ["arceus.jpg"],
"Sword/Shield": ["sword.jpg", "shield.jpg"],
"Let's Go Pikachu/Eevee": ["letsgopikachu.jpg", "letsgoeevee.jpg"],
"Ultra Sun/Ultra Moon": ["ultrasun.jpg", "ultramoon.jpg"],
"Sun/Moon": ["sun.jpg", "moon.jpg"],
"Omega Ruby/Alpha Sapphire": ["omegaruby.jpg", "alphasapphire.jpg"],
"X/Y": ["pokemonx.jpg", "pokemony.jpg"],
"Black 2/White 2": ["black2.jpg", "white2.jpg"],
"Black/White": ["black.jpg", "white.jpg"],
"HeartGold/SoulSilver": ["heartgold.jpg", "soulsilver.jpg"],
"Platinum": ["platinum.png"],
"Diamond/Pearl": ["diamond.png", "pearl.png"],
"FireRed/LeafGreen": ["firered.png", "leafgreen.png"],
"Ruby/Sapphire/Emerald": ["ruby.png", "sapphire.png", "emerald.png"],
"Pokémon GO": ["pokemongo.png"],
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
// "R,G,B" string for a TYPE_COLORS hex value, so CSS can build rgba()
// tints/borders/glows at whatever alpha it needs from one source of
// truth instead of a separate hardcoded color per use (see the species
// chip's --type-rgb custom property below).
var TYPE_RGB_CACHE = {};
function typeRgbTriple(type) {
if (TYPE_RGB_CACHE[type]) return TYPE_RGB_CACHE[type];
var hex = TYPE_COLORS[type] || '#A8A8A8';
var r = parseInt(hex.slice(1, 3), 16);
var g = parseInt(hex.slice(3, 5), 16);
var b = parseInt(hex.slice(5, 7), 16);
var triple = r + ',' + g + ',' + b;
TYPE_RGB_CACHE[type] = triple;
return triple;
}
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
// GAME_ICONS, images/game-symbols/<name>.png), side by side. Falls back
// to the generic cartridge glyph if the game has no mapping at all.
function gameIconMarkup(game) {
var files = GAME_ICONS[game];
if (!files || !files.length) return ICON_GAME;
var imgs = files.map(function(filename) {
return '<img class="tcg-stats-icon-img tcg-icon-game" src="images/game-symbols/' + filename + '" alt="' + escapeHtml(game) + '" onerror="handleGameIconError(this)">';
}).join('');
return '<span class="tcg-stats-icon-group">' + imgs + '</span>';
}
// Box-art style thumbnails for the Game field on the Start Hunt modal
// (see syncGameSelectVisual() below). Reuses the same GAME_ICONS
// mapping and images/game-symbols/ files as gameIconMarkup() above, just
// rendered bigger (.hunt-radar-game-icon-img in style.css) since this
// box has more room than the small table row icon. Falls back to the
// generic cartridge glyph if the game has no mapping, and a broken
// image just hides itself via handleGameIconError().
function gameBoxArtMarkup(game) {
var files = GAME_ICONS[game];
if (!files || !files.length) return ICON_GAME;
return files.map(function(filename) {
return '<img class="hunt-radar-game-icon-img" src="images/game-symbols/' + filename + '" alt="' + escapeHtml(game) + '" onerror="handleGameIconError(this)">';
}).join('');
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
// Regular (non-shiny) Living Dex progress, used to badge the "Living Dex"
// pill on the Shiny Log page so it doubles as a live progress teaser
// instead of a plain nav link. Deliberately always the non-shiny count
// (regardless of whatever dexMode the Living Dex page itself is currently
// showing) since that's the number people generally think of as "my dex".
function livingDexProgress() {
var caughtTotal = 0;
GEN_DATA.forEach(function(g) {
g.species.forEach(function(sp) {
if (state.livingDex[normName(sp[1])]) caughtTotal++;
});
});
return { caught: caughtTotal, total: totalSpeciesCount() };
}
// Shiny counterpart of livingDexProgress() - used by the split Living/Shiny
// toggle so both percentages can be shown at once regardless of which one
// is currently active.
function shinyDexProgress() {
var caught = Object.assign({}, shinyCaughtSet(), state.livingDexShiny);
var caughtTotal = 0;
GEN_DATA.forEach(function(g) {
g.species.forEach(function(sp) {
if (caught[normName(sp[1])]) caughtTotal++;
});
});
return { caught: caughtTotal, total: totalSpeciesCount() };
}
function updateLivingDexPillBadge() {
var el = document.getElementById('log-dex-pill-count');
if (!el) return;
var p = livingDexProgress();
el.textContent = p.caught + ' / ' + p.total;
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
// Live Pokédex-entry lookup via PokeAPI, used by the 3D model viewer to
// show genus/height/weight/flavor text like an actual dex entry rather
// than a bare model window. Two endpoints are combined - species (genus +
// flavor text) and the base pokemon resource (height/weight, which live
// separately) - and merged into one small object. Cached per slug like
// fetchEvolvesFrom above, and any failure resolves to null so the caller
// can just leave the entry panel blank instead of erroring.
var _dexEntryCache = {};
function fetchDexEntryData(name) {
var slug = pokemonSlug(name);
if (!slug) return Promise.resolve(null);
if (Object.prototype.hasOwnProperty.call(_dexEntryCache, slug)) {
return Promise.resolve(_dexEntryCache[slug]);
}
var speciesPromise = fetch('https://pokeapi.co/api/v2/pokemon-species/' + slug + '/')
.then(function(res) {
if (!res.ok) throw new Error('pokeapi species lookup failed');
return res.json();
});
var pokemonPromise = fetch('https://pokeapi.co/api/v2/pokemon/' + slug + '/')
.then(function(res) {
if (!res.ok) throw new Error('pokeapi pokemon lookup failed');
return res.json();
});
return Promise.all([speciesPromise, pokemonPromise])
.then(function(results) {
var species = results[0], mon = results[1];
var genusEntry = (species.genera || []).filter(function(g) { return g.language && g.language.name === 'en'; })[0];
var flavorEntry = (species.flavor_text_entries || []).filter(function(f) { return f.language && f.language.name === 'en'; }).pop();
var entry = {
genus: genusEntry ? genusEntry.genus : null,
// PokeAPI flavor text keeps the original games' line-break/form-feed
// characters baked in, which read as garbage whitespace outside a
// fixed-width in-game textbox - collapse them to normal spaces here.
flavorText: flavorEntry ? flavorEntry.flavor_text.replace(/[\n\f\r]+/g, ' ') : null,
// height is decimetres, weight is hectograms - convert to metres/kg.
heightM: typeof mon.height === 'number' ? (mon.height / 10) : null,
weightKg: typeof mon.weight === 'number' ? (mon.weight / 10) : null
};
_dexEntryCache[slug] = entry;
return entry;
})
.catch(function() {
_dexEntryCache[slug] = null;
return null;
});
}
// Walks a PokeAPI evolution-chain tree looking for the node whose species
// slug matches targetSlug, returning { stage, isFinal } (stage: 0 = the
// base/basic form, 1 = first evolution, 2 = second evolution, etc;
// isFinal: true if that node has no further evolutions). Returns null if
// the species isn't found in the chain (shouldn't normally happen).
function findChainInfo(node, targetSlug, depth) {
if (!node) return null;
if (node.species && node.species.name === targetSlug) {
var evolvesTo = node.evolves_to || [];
return { stage: depth, isFinal: !evolvesTo.length };
}
var kids = node.evolves_to || [];
for (var i = 0; i < kids.length; i++) {
var found = findChainInfo(kids[i], targetSlug, depth + 1);
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
// line the species is (Basic / Stage 1 / Stage 2...), and whether that
// stage is the final one in the chain, by fetching the evolution chain
// and walking it. One extra request per species, cached by slug - and,
// on a successful resolve, persisted to localStorage (EVO_CACHE_STORE_KEY
// below) rather than just kept in memory, since this same cache now also
// backs the mobile Living Dex's evo-stage filter (applyDexEvoStageFilter),
// which wants the data to stay put across page loads instead of re-fetching
// every species again each visit. Any failure just resolves to null (and
// isn't persisted, so a transient network hiccup doesn't permanently block
// a species) so callers can hide the badge / skip the boost / leave the
// filter's "checking" state until a retry succeeds.
var EVO_CACHE_STORE_KEY = 'shinyTrackerEvoChainCache';
var _evoChainInfoCache = (function() {
try {
var raw = localStorage.getItem(EVO_CACHE_STORE_KEY);
return raw ? JSON.parse(raw) : {};
} catch (e) {
return {};
}
})();
function persistEvoChainCache() {
try {
localStorage.setItem(EVO_CACHE_STORE_KEY, JSON.stringify(_evoChainInfoCache));
} catch (e) {}
}
// Tracks lookups currently in flight, keyed by slug. applyDexEvoStageFilter
// re-scans every chip on the page each time any single lookup resolves, so
// without this, every chip that was still uncached at that moment would
// fire its own brand-new network request on every one of those re-scans -
// each of those, once it *also* resolved, triggering yet another full
// re-scan that fired a fresh round of duplicates for whatever was still
// pending. That compounding (not any one request on its own) is what was
// piling up hundreds of overlapping fetches and promise chains in memory
// and crashing the tab with "Out of Memory" - reusing the same in-flight
// promise for a slug that's already being looked up turns that into one
// real network request per species, no matter how many chips ask for it
// while it's pending.
var _evoChainInFlight = {};
function fetchEvoChainInfo(name) {
var m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(String(name || '').trim());
var base = m ? m[1] : name;
var slug = pokemonSlug(base);
if (!slug) return Promise.resolve(null);
if (Object.prototype.hasOwnProperty.call(_evoChainInfoCache, slug)) {
return Promise.resolve(_evoChainInfoCache[slug]);
}
if (Object.prototype.hasOwnProperty.call(_evoChainInFlight, slug)) {
return _evoChainInFlight[slug];
}
var promise = fetch('https://pokeapi.co/api/v2/pokemon-species/' + slug + '/')
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
return findChainInfo(chainData.chain, slug, 0);
});
})
.then(function(info) {
_evoChainInfoCache[slug] = info;
if (info) persistEvoChainCache();
return info;
})
.catch(function() {
return null;
})
.then(function(info) {
delete _evoChainInFlight[slug];
return info;
});
_evoChainInFlight[slug] = promise;
return promise;
}
/* ---------- evo-stage filter (mobile Living Dex toolbar) ----------
   Buckets a fetchEvoChainInfo() result into one of four mutually-exclusive
   groups for the Base/Middle/Final/Single-stage filter chips:
   - single: no family at all (stage 0, and also the final node - Ditto,
     legendaries, etc.) - kept separate from "final" since conceptually
     these aren't the final evolution *of* anything.
   - base:   stage 0 with more evolutions ahead.
   - final:  the last node of a multi-stage chain (stage > 0, isFinal).
   - middle: everything else (stage > 0, not final). */
function evoStageBucket(info) {
if (!info) return null;
if (info.stage === 0) return info.isFinal ? 'single' : 'base';
return info.isFinal ? 'final' : 'middle';
}
// All true by default (unfiltered), same convention as dexVariantFilter.
var dexEvoStageFilter = {
base: true,
middle: true,
final: true,
single: true
};
// Hides chips whose evo-stage bucket isn't currently selected. Species
// whose bucket isn't cached yet get a transient "checking" look (see
// .evo-stage-checking in style.css) while fetchEvoChainInfo resolves, then
// this re-runs for just that lookup rather than re-scanning everything.
// Scans every .dex-chip in the document (desktop #dex-grid and whichever
// mobile #kalos-gen-grid tile is currently expanded both use this markup),
// same as applyDexTypeFilter/applyDexVariantFilter below.
// _evoChainRerenderQueued tracks which slugs already have a "call me again
// once this resolves" callback registered - every chip on the page can
// reach this same else-branch for the same still-pending slug on every
// rescan (e.g. every other species' lookup completing triggers one), and
// without this guard each of those would stack another
// .then(applyDexEvoStageFilter) onto the same in-flight promise, so one
// resolved fetch fired a full extra rescan for every chip that had ever
// asked - compounding badly across a page of hundreds of chips.
var _evoChainRerenderQueued = {};
function applyDexEvoStageFilter() {
var allOn = Object.keys(dexEvoStageFilter).every(function(k) {
return dexEvoStageFilter[k];
});
document.querySelectorAll('.dex-chip[data-name]').forEach(function(chip) {
if (allOn) {
chip.classList.remove('evo-stage-hidden', 'evo-stage-checking');
return;
}
var m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(chip.dataset.name || '');
var slug = pokemonSlug(m ? m[1] : chip.dataset.name);
if (slug && Object.prototype.hasOwnProperty.call(_evoChainInfoCache, slug)) {
var bucket = evoStageBucket(_evoChainInfoCache[slug]);
chip.classList.remove('evo-stage-checking');
chip.classList.toggle('evo-stage-hidden', !(bucket && dexEvoStageFilter[bucket]));
} else {
chip.classList.add('evo-stage-checking');
chip.classList.remove('evo-stage-hidden');
if (slug && _evoChainRerenderQueued[slug]) return;
if (slug) _evoChainRerenderQueued[slug] = true;
fetchEvoChainInfo(chip.dataset.name).then(function(info) {
if (slug) delete _evoChainRerenderQueued[slug];
applyDexEvoStageFilter();
return info;
});
}
});
}
// Thin wrapper kept for existing callers (TCG catch-card evo-stage badge)
// that only care about the numeric stage, not final-evo status.
function fetchEvoStage(name) {
return fetchEvoChainInfo(name).then(function(info) {
return info ? info.stage : null;
});
}
// Living Dex sprite boost: Basic and Stage-1 (non-final) species tend to
// be drawn much smaller within their fixed-size sprite canvas than fully-
// evolved forms (a Caterpie sprite has way more transparent padding
// around it than a Butterfree one), so the single flat zoom every chip
// gets (.dex-chip-sprite img, see style.css) leaves early-evolution chips
// looking tiny next to their evolved neighbors. The same is true in
// reverse for the final stage of a *3-stage* line (e.g. Charizard) versus
// the final stage of a 2-stage line (e.g. Raichu) - the 3-stage final
// still reads small next to a boosted Charmeleon/Ivysaur, so it gets
// boosted too. Only a 2-stage line's final evo (stage 1 and isFinal, e.g.
// Raichu) is left at the normal scale - it's already the odd one out with
// less padding baked into its sprite than a mid-chain stage-1 form.
//
// Three tiers, not two: basic (stage 0) and 3+-stage finals both land on
// the shared .dex-chip-stage-boost scale (their sprites' own baked-in
// padding difference is enough to make a final naturally read bigger than
// a basic at that same scale, so they don't need separate numbers) - but
// a middle evo (stage >= 1, not final, e.g. Charmeleon/Ivysaur) needs a
// class of its own, .dex-chip-stage-boost-mid, sized a step above the
// shared boost so it doesn't blend into the basics next to it.
//
// This walks the chips in a given gen container, looks up each species'
// chain info via fetchEvoChainInfo (PokeAPI, cached per slug - see
// above), and applies the right tier class. Only called on a gen actually
// being opened/expanded (not on every render) since the whole grid holds
// 1000+ species and most of it stays collapsed/off-screen - see call
// sites in expandDexCard, expandKalosTile, and
// renderKalosMobileDex/renderLivingDex for the already-open case. Chips
// are marked with a dataset flag once checked so re-expanding a gen (or a
// data-only re-render of an already-open one) never re-issues the same
// lookup.
function applyEvoStageBoosts(genContainer) {
if (!genContainer) return;
var chips = genContainer.querySelectorAll('.dex-chip[data-name]');
Array.prototype.forEach.call(chips, function(chip) {
if (chip.dataset.evoBoostChecked) return;
chip.dataset.evoBoostChecked = '1';
fetchEvoChainInfo(chip.dataset.name).then(function(info) {
if (!info) return;
if (info.isFinal && info.stage === 1) return; // 2-stage final (Raichu) - untouched
if (info.stage >= 1 && !info.isFinal) {
chip.classList.add('dex-chip-stage-boost-mid'); // middle evo
} else {
chip.classList.add('dex-chip-stage-boost'); // basic, or 3+-stage final
}
});
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
// before things like dexOpenGen (declared further down this file) exists
// yet - calling the render pass that early throws (renderLivingDex reads
// dexOpenGen) and silently aborts the rest of this script, which is why
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
// Switches the active tab's visible chrome only. A page swipe is navigation,
// not a data update, so it must not rebuild #kalos-gen-grid: rebuilding the
// carousel mid-transition briefly exposed its older generic tile layer before
// the current cartridge treatment restabilised. Data mutations continue to
// call renderAll() directly at their own call sites.
function applyTabState(tab) {
syncTabChrome(tab);
if (tab === 'livingdex') lockKalosToggleFilterCardHeight();
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
// Retrigger the click-bounce animation even on rapid repeat clicks
// (removing the class first forces a reflow so the animation restarts).
btn.classList.remove('log-dex-pill-clicked');
void btn.offsetWidth;
btn.classList.add('log-dex-pill-clicked');
activateTab('livingdex');
});
btn.addEventListener('animationend', function(e) {
if (e.animationName === 'log-dex-pill-click') btn.classList.remove('log-dex-pill-clicked');
});
});
// Living Dex has no tab bar to get back out through either, so it gets
// its own explicit way back to Active Hunts - now a small button next to
// each mode toggle (desktop .dex-mode-toggle and mobile .kalos-mode-toggle)
// instead of the old shared page-header bar.
document.querySelectorAll('.dex-toggle-back-btn').forEach(function(btn) {
btn.addEventListener('click', function(e) {
// Needed now that the mobile copy of this button lives inside .kalos-top
// (see index.html), which has its own click handler that opens/closes
// the shell - without this the tap would both navigate back AND toggle
// the shell shut. No-op on the desktop copy, which isn't nested in a
// clickable ancestor.
e.stopPropagation();
activateTab('hunts');
});
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
var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
var velocity = dx / dt; // px/ms, signed with drag direction
var committed = Math.abs(dx) > width * COMMIT_RATIO || Math.abs(velocity) > COMMIT_VELOCITY;
var toTab = fromTab;
if (committed && dx < 0 && NEXT_TAB[fromTab]) {
toTab = NEXT_TAB[fromTab];
} else if (committed && dx > 0 && PREV_TAB[fromTab]) {
toTab = PREV_TAB[fromTab];
}
// Snapshot exactly where the finger left the track/frame before
// applyTabState() below flips data-active (and with it, the CSS resting
// transform this element would otherwise snap straight to).
var canAdvance = (dx < 0 && !!NEXT_TAB[fromTab]) || (dx > 0 && !!PREV_TAB[fromTab]);
var effectiveDx = canAdvance ? dx : dx * RESIST;
effectiveDx = Math.max(-width, Math.min(width, effectiveDx));
var currentX = baseX + effectiveDx;
var currentMargin = frame ? (parseFloat(frame.style.marginLeft) || marginLeftFor(fromTab)) : 0;
var targetX = -TAB_POSITION[toTab] * width + (toTab === 'collection' ? 24 : 0);
var targetMargin = marginLeftFor(toTab);

if (toTab !== fromTab) applyTabState(toTab);

if (window.Motion && window.Motion.animate && !reduceMotion) {
// A physical spring (fed the release velocity) instead of the old fixed
// cubic-bezier transition - flicks carry their momentum into the
// animation instead of every swipe easing in at the same fixed rate
// regardless of how fast the finger was moving.
track.style.transition = 'none';
if (frame) frame.style.transition = 'none';
var SPRING = { type: 'spring', bounce: 0, duration: 0.5 };
var trackSpring = Object.assign({ velocity: velocity * 1000 }, SPRING);
window.Motion.animate(track, { x: [currentX, targetX] }, trackSpring).finished.then(function() {
track.style.transition = '';
track.style.transform = '';
});
if (frame) {
window.Motion.animate(frame, { marginLeft: [currentMargin, targetMargin] }, SPRING).finished.then(function() {
frame.style.transition = '';
frame.style.marginLeft = '';
});
}
} else {
// Re-enable the CSS transition, force the browser to register it at the
// current drag position, then commit/spring back so it animates from
// exactly where the finger let go rather than snapping first.
track.style.transition = TRANSITION;
if (frame) frame.style.transition = '';
void dexClamshell.offsetHeight; // force reflow so the transition above "takes"
track.style.transform = '';
if (frame) frame.style.marginLeft = '';
setTimeout(resetDragStyles, 600);
}
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
'<button class="hunt-dex-light y" data-action="dev-tools" data-id="' + hunt.id + '" title="Add to Log" aria-label="Add to Log"></button>' +
'<button class="hunt-dex-light g' + (hunt.running ? ' lit' : '') + '" data-action="edit-hunt" data-id="' + hunt.id + '" title="Edit Hunt" aria-label="Edit Hunt"></button>' +
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
'<button class="hunt-dex-btn hunt-dex-btn-ghost hunt-dex-btn-timer" data-action="toggle-timer" data-id="' + hunt.id + '" title="' + (hunt.running ? 'Pause timer' : 'Start timer') + '">' + (hunt.running ? '⏸\uFE0E' : '▶\uFE0E') + '</button>' +
'<button class="hunt-dex-btn hunt-dex-btn-found" data-action="mark-found" data-id="' + hunt.id + '">Caught!</button>' +
'</div>' +
'</div>' +
'</div>' +
'<div class="hunt-dex-handheld-controls">' +
'<div class="hunt-dex-joystick-wrap">' +
'<div class="hunt-dex-mic-grille"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>' +
'<div class="hunt-dex-joystick-socket">' +
'<span class="hunt-dex-joystick-plate"></span>' +
'<button class="hunt-dex-round-btn" data-action="toggle-timer" data-id="' + hunt.id + '" title="' + (hunt.running ? 'Pause timer' : 'Start timer') + '">' + (hunt.running ? '⏸\uFE0E' : '▶\uFE0E') + '</button>' +
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
'<div class="dpad-rock">' +
'<span class="dpad-bar-v"></span>' +
'<span class="dpad-bar-h"></span>' +
'<button class="hdpad-btn dpad-up" data-action="add-encounter-5" data-id="' + hunt.id + '" title="Add 5 encounters"><span>+5</span></button>' +
'<button class="hdpad-btn dpad-right" data-action="add-encounter" data-id="' + hunt.id + '" title="Add an encounter"><span>+1</span></button>' +
'<span class="hdpad-btn dpad-down" aria-hidden="true"></span>' +
'<button class="hdpad-btn dpad-left" data-action="remove-encounter" data-id="' + hunt.id + '" title="Remove an encounter"><span>−1</span></button>' +
'</div>' +
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
updateLivingDexPillBadge();
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
// Keeps at most one of the six log toolbar keys (Search, Sort, Filter,
// Reset, HoF, Edit) "lit" at a time, EXCEPT Search/Sort/Filter, which
// are allowed to stay active together - so opening/toggling any key
// clears the others unless they're named in `keep`. Only touches state
// that's actually set (so it doesn't force needless re-renders), and
// returns whether anything actually changed.
function resetLogKeysExcept(keep) {
keep = keep || [];
var changed = false;
if (keep.indexOf('search') === -1) {
if (logSearchQuery) {
logSearchQuery = '';
logSearchInput.value = '';
changed = true;
}
document.getElementById('log-search-wrap').classList.remove('open');
}
if (keep.indexOf('sort') === -1) {
if (logSortMode !== 'newest') {
logSortMode = 'newest';
document.querySelectorAll('#log-sort-panel .dex-select-option').forEach(function(o) {
o.classList.toggle('active', o.dataset.value === 'newest');
});
document.getElementById('btn-log-sort').textContent = LOG_SORT_LABELS.newest + ' ▾';
document.getElementById('btn-log-sort').classList.remove('active');
changed = true;
}
document.getElementById('log-sort-wrap').classList.remove('open');
}
if (keep.indexOf('filter') === -1) {
if (logFilterGame || logFilterMethod || logFilterGen) {
logFilterGame = '';
logFilterMethod = '';
logFilterGen = '';
document.getElementById('log-filter-game').value = '';
document.getElementById('log-filter-method').value = '';
document.getElementById('log-filter-gen').value = '';
updateLogFilterButtonLabel();
changed = true;
}
document.getElementById('log-filter-wrap').classList.remove('open');
}
if (keep.indexOf('hof') === -1 && logShowHoF) {
logShowHoF = false;
changed = true;
}
if (keep.indexOf('edit') === -1 && logEditMode) {
logEditMode = false;
var editBtn = document.getElementById('btn-toggle-log-edit');
editBtn.classList.remove('active');
editBtn.setAttribute('aria-pressed', 'false');
changed = true;
}
if (changed) logCardJumpToTop();
return changed;
}
document.getElementById('btn-log-hof').addEventListener('click', function() {
resetLogKeysExcept(['hof']);
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
var changed = resetLogKeysExcept(['search', 'sort', 'filter']);
closeOtherDexDropdowns('log-search-wrap');
document.getElementById('log-search-wrap').classList.toggle('open');
if (document.getElementById('log-search-wrap').classList.contains('open')) {
logSearchInput.focus();
}
if (changed) renderCollection();
});
document.getElementById('log-search-panel').addEventListener('click', function(e) {
e.stopPropagation();
});
document.getElementById('btn-log-sort').addEventListener('click', function(e) {
e.stopPropagation();
var changed = resetLogKeysExcept(['search', 'sort', 'filter']);
closeOtherDexDropdowns('log-sort-wrap');
document.getElementById('log-sort-wrap').classList.toggle('open');
if (changed) renderCollection();
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
var changed = resetLogKeysExcept(['search', 'sort', 'filter']);
closeOtherDexDropdowns('log-filter-wrap');
document.getElementById('log-filter-wrap').classList.toggle('open');
if (changed) renderCollection();
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
resetLogKeysExcept([]);
renderCollection();
});
/* ---------- rendering: living dex ---------- */
// Which generation (if any) is currently expanded into its full banner on
// the desktop Living Dex grid. Only one gen can be open at a time - opening
// a new one hides every other gen square, mirroring the mobile Kalos
// single-open drill-down (kalosOpenGen) instead of the old multi-open
// accordion this used to be.
var dexOpenGen = null;
var dexMode = 'living';
var dexSortMode = 'dex';
// When on, tapping a species sprite in an opened gen box opens its 3D
// model (see open3DModelModal) instead of toggling it caught. Flipped by
// #btn-dex-3d-toggle/#btn-k-3d-toggle - see wiring near those ids below.
var dex3DMode = false;
var dexTypeFilter = '';
// Which generation (if any) is currently drilled into on the mobile Kalos
// dex's gen-detail screen (null = showing the 3-per-row gen tile grid).
var kalosOpenGen = null;
// Index (into GEN_DATA order) of whichever tile is currently centered in
// the peek carousel. Kept up to date by syncKalosCarousel() as the person
// drags, used to know which tile a tap should expand vs. bring to center,
// and to restore scroll position after renderKalosMobileDex() rebuilds
// the tiles (innerHTML = '' resets scrollLeft to 0 otherwise).
var kalosCarouselIndex = 0;
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
// Fully hides every species chip in the grid whose types don't include the
// currently-selected filter type, leaving only matching chips in view.
// Doesn't touch the caught state, sort order, or rebuild any sprite
// <img> - it only toggles a class, so it's safe to call after any
// render/re-sort without disturbing sprites or scroll position.
// Scans every .dex-chip in the document, not just #dex-grid, so this one
// function drives both the desktop grid and whichever mobile
// #kalos-gen-grid tile is currently expanded (both use identical chip
// markup - see buildDexChipsHtml) without duplicating the filter logic
// for the mobile toolbar. Desktop's chips all exist in the DOM up front
// (collapsed gens are just CSS-hidden, not removed), so this covered the
// whole dex before; mobile only ever has the open tile's chips in the DOM
// at a time, so this naturally scopes itself to whatever's visible there.
function applyDexTypeFilter() {
var active = !!dexTypeFilter;
document.querySelectorAll('.dex-chip').forEach(function(chip) {
if (!active) {
chip.classList.remove('type-hidden');
return;
}
var info = speciesInfo(chip.dataset.name);
var matches = !!(info && info.types.indexOf(dexTypeFilter) !== -1);
chip.classList.toggle('type-hidden', !matches);
});
}
// Keeps the type-filter button label/active-state and the currently-
// selected option in sync across both the desktop (#btn-dex-type-filter)
// and mobile (#btn-k-type) toolbars, whichever one triggered the change.
function syncDexTypeUI() {
var label = 'Filter: ' + (dexTypeFilter || 'All Types') + ' ▾';
var shortLabel = (dexTypeFilter || 'Type') + ' ▾';
[
{ btn: 'btn-dex-type-filter', panel: 'dex-type-panel', label: label },
{ btn: 'btn-k-type', panel: 'k-type-panel', label: shortLabel }
].forEach(function(ui) {
var btn = document.getElementById(ui.btn);
var panel = document.getElementById(ui.panel);
if (btn) {
btn.textContent = ui.label;
btn.classList.toggle('active', !!dexTypeFilter);
}
if (panel) {
panel.querySelectorAll('.dex-select-option').forEach(function(o) {
o.classList.toggle('active', o.dataset.value === dexTypeFilter);
});
}
});
}
function setDexTypeFilter(value) {
dexTypeFilter = value;
syncDexTypeUI();
applyDexTypeFilter();
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
setDexTypeFilter(opt.dataset.value);
document.getElementById('dex-type-wrap').classList.remove('open');
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
// Scans the whole document (see applyDexTypeFilter above for why).
function applyDexVariantFilter() {
document.querySelectorAll('.dex-chip').forEach(function(chip) {
var cat = chip.dataset.variant || 'Original';
var visible = dexVariantFilter[cat] !== false;
chip.classList.toggle('variant-hidden', !visible);
});
syncVariantCheckboxes();
}
// Reflects the current dexVariantFilter state onto the desktop checkboxes
// (still genuinely multi-select there), the mobile toolbar's Form pills
// (#k-variant-panel .dex-select-option - single-select there, so a pill
// only lights up when it's the *one* category currently on, not just
// whenever it happens to be included), and both filter buttons' active
// state, so whichever panel the person didn't just use still shows the
// truth.
function syncVariantCheckboxes() {
var onKeys = VARIANT_FILTER_KEYS.filter(function(k) {
return dexVariantFilter[k] !== false;
});
var allOn = onKeys.length === VARIANT_FILTER_KEYS.length;
var soleActiveKey = onKeys.length === 1 ? onKeys[0] : null;
VARIANT_FILTER_KEYS.forEach(function(key) {
var cb = document.getElementById(VARIANT_CHECKBOX_IDS[key]);
if (cb) cb.checked = dexVariantFilter[key] !== false;
var opt = document.querySelector('#k-variant-panel .dex-select-option[data-value="' + key + '"]');
if (opt) opt.classList.toggle('active', key === soleActiveKey);
});
['btn-variant-filter', 'btn-k-variant'].forEach(function(id) {
var btn = document.getElementById(id);
if (btn) btn.classList.toggle('active', !allOn);
});
}
function wireVariantCheckboxes(idMap) {
VARIANT_FILTER_KEYS.forEach(function(key) {
var cb = document.getElementById(idMap[key]);
if (!cb) return;
cb.addEventListener('change', function() {
dexVariantFilter[key] = cb.checked;
applyDexVariantFilter();
});
});
}
function wireVariantSelectAll(btnId, value) {
var btn = document.getElementById(btnId);
if (!btn) return;
btn.addEventListener('click', function() {
VARIANT_FILTER_KEYS.forEach(function(key) {
dexVariantFilter[key] = value;
});
applyDexVariantFilter();
});
}
wireVariantCheckboxes(VARIANT_CHECKBOX_IDS);
wireVariantSelectAll('vf-select-all', true);
wireVariantSelectAll('vf-select-none', false);
// Shared across every Living Dex toolbar dropdown - desktop's (variant
// filter, sort, type filter), the Shiny Log's (search/sort/filter), and
// the new mobile Living Dex toolbar's (search/sort/type/form/stage) - so
// opening one always closes the others. Each button's own click handler
// stops propagation (so it can toggle itself without the document-level
// listener immediately closing it again), which means the document
// listener never gets a chance to close a *different* dropdown that was
// already open. This runs that same "close everything" sweep manually,
// minus whichever wrap is about to be opened.
function closeOtherDexDropdowns(exceptId) {
[
'variant-filter-wrap', 'dex-sort-wrap', 'dex-type-wrap',
'log-search-wrap', 'log-sort-wrap', 'log-filter-wrap',
'k-search-wrap', 'k-sort-wrap', 'k-type-wrap', 'k-variant-wrap', 'k-evo-wrap'
].forEach(function(id) {
if (id === exceptId) return;
var wrap = document.getElementById(id);
if (wrap) wrap.classList.remove('open');
});
if (!exceptId || exceptId.indexOf('k-') !== 0) collapseKalosToolbar();
}
// Freezes #kalos-toggle-filter-card at its natural rendered height the
// first time Living Dex is actually visible (it's display:none behind the
// Hunts/Shiny Log tabs until then, so measuring any earlier would just
// read 0). From then on the card can never grow or shrink - not while a
// filter dropdown is reskinned open, not if the percentage/fraction text
// changes - because every state already lays out to the same height, this
// just pins that height explicitly and clips anything that would ever
// disagree with it, rather than trusting that to stay true.
var _kalosToggleFilterCardLocked = false;
function lockKalosToggleFilterCardHeight() {
if (_kalosToggleFilterCardLocked) return;
var card = document.getElementById('kalos-toggle-filter-card');
if (!card) return;
requestAnimationFrame(function() {
var h = card.getBoundingClientRect().height;
if (!h) return; // not actually laid out yet - next tab switch will retry
card.style.height = h + 'px';
card.style.overflow = 'hidden';
_kalosToggleFilterCardLocked = true;
});
}
// Puts the mobile Living Dex toolbar (#kalos-filter-toolbar) into
// "reskin-in-place" mode for the given wrap: every other pill slot is
// hidden and the given wrap's own panel takes over the freed-up space
// (see the CSS-KALOS-MOBILE reskin rules in style.css). Search gets its
// own reskin-search class rather than reusing reskin-full only because its
// panel is a single <input>, not a .dex-select-option grid - the CSS still
// takes over the whole toolbar (both rows) the same way.
function expandKalosToolbar(wrapId) {
var toolbar = document.getElementById('kalos-filter-toolbar');
if (!toolbar) return;
toolbar.classList.remove('reskin-full', 'reskin-search');
toolbar.classList.add(wrapId === 'k-search-wrap' ? 'reskin-search' : 'reskin-full');
toolbar.querySelectorAll('.dex-select-wrap.expanded').forEach(function(w) {
w.classList.remove('expanded');
});
var wrap = document.getElementById(wrapId);
if (wrap) wrap.classList.add('expanded');
}
// Reverts #kalos-filter-toolbar back to its normal 6-button layout.
function collapseKalosToolbar() {
var toolbar = document.getElementById('kalos-filter-toolbar');
if (!toolbar) return;
toolbar.classList.remove('reskin-full', 'reskin-search');
toolbar.querySelectorAll('.dex-select-wrap.expanded').forEach(function(w) {
w.classList.remove('expanded');
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
/* ---------- mobile Living Dex filter toolbar ----------
   Compact icon-button strip under the Living/Shiny toggle (see
   #kalos-filter-toolbar in index.html), reusing the exact
   .log-dex-grid-btn/.dex-select-wrap/.dex-select-panel pattern already
   built for the Shiny Log toolbar. Search/Sort/Type/Form all drive the
   same dexSearchQuery-equivalent/dexSortMode/dexTypeFilter/dexVariantFilter
   state as the desktop toolbar above (via the shared apply/sync functions),
   so the two toolbars can never drift out of sync with each other. Stage
   is new (see applyDexEvoStageFilter, defined near fetchEvoChainInfo). */
// Opens a k-* dropdown: toggles its own .open, then hands the toolbar
// over to expandKalosToolbar/collapseKalosToolbar to do the visual
// reskin-in-place morph (see the CSS-KALOS-MOBILE reskin rules).
function toggleKalosDropdown(wrapId) {
closeOtherDexDropdowns(wrapId);
var wrap = document.getElementById(wrapId);
var willOpen = !wrap.classList.contains('open');
wrap.classList.toggle('open', willOpen);
if (willOpen) {
expandKalosToolbar(wrapId);
} else {
collapseKalosToolbar();
}
return willOpen;
}
document.getElementById('btn-k-search').addEventListener('click', function(e) {
e.stopPropagation();
var opened = toggleKalosDropdown('k-search-wrap');
var input = document.getElementById('k-dex-search');
if (input && opened) {
setTimeout(function() { input.focus(); }, 0);
}
});
document.getElementById('k-search-panel').addEventListener('click', function(e) {
e.stopPropagation();
});
var kDexSearchInput = document.getElementById('k-dex-search');
attachPokemonAutocomplete(kDexSearchInput);
kDexSearchInput.addEventListener('change', function() {
var val = this.value.trim();
if (!val) return;
jumpToDexSpeciesMobile(val);
this.value = '';
document.getElementById('k-search-wrap').classList.remove('open');
collapseKalosToolbar();
});
document.getElementById('btn-k-sort').addEventListener('click', function(e) {
e.stopPropagation();
toggleKalosDropdown('k-sort-wrap');
});
document.getElementById('k-sort-panel').addEventListener('click', function(e) {
e.stopPropagation();
var opt = e.target.closest('.dex-select-option');
if (!opt) return;
setDexSortMode(opt.dataset.value);
document.getElementById('k-sort-wrap').classList.remove('open');
collapseKalosToolbar();
});
document.getElementById('btn-k-type').addEventListener('click', function(e) {
e.stopPropagation();
toggleKalosDropdown('k-type-wrap');
});
document.getElementById('k-type-panel').addEventListener('click', function(e) {
e.stopPropagation();
var opt = e.target.closest('.dex-select-option');
if (!opt) return;
setDexTypeFilter(opt.dataset.value);
document.getElementById('k-type-wrap').classList.remove('open');
collapseKalosToolbar();
});
document.getElementById('btn-k-variant').addEventListener('click', function(e) {
e.stopPropagation();
toggleKalosDropdown('k-variant-wrap');
});
// Form is single-select now, same pattern as Sort/Type: a tap sets that
// one variant category as the sole active filter (everything else turns
// off) and the panel closes immediately - no Done pill needed any more.
// Still driven through the same dexVariantFilter object the desktop
// checkboxes use (see applyDexVariantFilter/syncVariantCheckboxes above),
// just always leaving exactly one key true from this panel's own taps.
document.getElementById('k-variant-panel').addEventListener('click', function(e) {
e.stopPropagation();
var opt = e.target.closest('.dex-select-option');
if (!opt) return;
var key = opt.dataset.value;
VARIANT_FILTER_KEYS.forEach(function(k) {
dexVariantFilter[k] = (k === key);
});
applyDexVariantFilter();
document.getElementById('k-variant-wrap').classList.remove('open');
collapseKalosToolbar();
});
document.getElementById('btn-k-evo').addEventListener('click', function(e) {
e.stopPropagation();
toggleKalosDropdown('k-evo-wrap');
});
// Stage is single-select now too: a tap sets that one bucket as the sole
// active filter and closes the panel, same as Sort/Type/Form - no Done
// pill, and no "keep at least one on" guard needed since there's always
// exactly one (or, before any tap, none - meaning unfiltered).
document.getElementById('k-evo-panel').addEventListener('click', function(e) {
e.stopPropagation();
var opt = e.target.closest('.dex-select-option');
if (!opt) return;
var key = opt.dataset.value;
Object.keys(dexEvoStageFilter).forEach(function(k) {
dexEvoStageFilter[k] = (k === key);
});
document.querySelectorAll('#k-evo-panel .dex-select-option').forEach(function(o) {
o.classList.toggle('active', o.dataset.value === key);
});
syncDexEvoStageButtonState();
applyDexEvoStageFilter();
document.getElementById('k-evo-wrap').classList.remove('open');
collapseKalosToolbar();
});
function syncDexEvoStageButtonState() {
var btn = document.getElementById('btn-k-evo');
if (!btn) return;
var allOn = Object.keys(dexEvoStageFilter).every(function(k) {
return dexEvoStageFilter[k];
});
btn.classList.toggle('active', !allOn);
}
// Sliding highlight pill (#kalos-toolbar-highlight, see index.html) that
// glides under whichever toolbar button currently has its dropdown open,
// iOS-segmented-control style. Only one of Search/Sort/Type/Form/Stage is
// ever open at a time (closeOtherDexDropdowns enforces that), so "the
// open one" is a well-defined single target to slide to - driven off a
// MutationObserver on the toolbar's own open/closed classes rather than
// threading an extra call through every button handler, so it can never
// drift out of sync with whichever code path happened to toggle a wrap.
(function initKalosToolbarHighlight() {
var toolbar = document.getElementById('kalos-filter-toolbar');
var highlight = document.getElementById('kalos-toolbar-highlight');
if (!toolbar || !highlight) return;
var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function update() {
// While the toolbar is reskinned in place (see expandKalosToolbar), the
// open button is hidden (or, for Search, not the thing being pointed at
// any more) - the sliding highlight has nothing meaningful to sit under,
// so it just stays hidden until the toolbar is back to its normal shape.
if (toolbar.classList.contains('reskin-full') || toolbar.classList.contains('reskin-search')) {
highlight.style.opacity = '0';
return;
}
var openBtn = toolbar.querySelector('.dex-select-wrap.open > .log-dex-grid-btn');
if (!openBtn) {
highlight.style.opacity = '0';
return;
}
var toolbarRect = toolbar.getBoundingClientRect();
var btnRect = openBtn.getBoundingClientRect();
var target = {
left: (btnRect.left - toolbarRect.left) + 'px',
top: (btnRect.top - toolbarRect.top) + 'px',
width: btnRect.width + 'px',
height: btnRect.height + 'px'
};
highlight.style.opacity = '1';
if (window.Motion && window.Motion.animate && !reduceMotion) {
window.Motion.animate(highlight, target, { duration: 0.25, easing: [0.34, 1.56, 0.64, 1] });
} else {
Object.assign(highlight.style, target);
}
}
new MutationObserver(update).observe(toolbar, { attributes: true, attributeFilter: ['class'], subtree: true });
window.addEventListener('resize', function() {
if (toolbar.querySelector('.dex-select-wrap.open')) update();
});
})();
// Resets every Living Dex filter (search highlight aside - that clears
// itself the next time a gen is opened/collapsed) back to its default,
// same pattern as the Shiny Log's #btn-log-reset-filters.
document.getElementById('btn-k-reset-filters').addEventListener('click', function(e) {
e.stopPropagation();
setDexSortMode('dex');
setDexTypeFilter('');
VARIANT_FILTER_KEYS.forEach(function(key) {
dexVariantFilter[key] = true;
});
applyDexVariantFilter();
Object.keys(dexEvoStageFilter).forEach(function(key) {
dexEvoStageFilter[key] = true;
});
document.querySelectorAll('#k-evo-panel .dex-select-option').forEach(function(o) {
o.classList.remove('active');
});
syncDexEvoStageButtonState();
applyDexEvoStageFilter();
setDexAnimatedOnlyFilter(false);
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
if (dexOpenGen !== String(loc.gen)) {
if (dexOpenGen) {
var prevCard = document.querySelector('#dex-grid .dex-card[data-gen="' + dexOpenGen + '"]');
if (prevCard) prevCard.classList.remove('expanded');
}
expandDexCard(card);
}
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
// Mobile counterpart of jumpToDexSpecies: switches the Kalos carousel to
// whichever gen the species belongs to (same state change as swiping
// there - see finalizeKalosGenSwitch) and highlights the matching chip.
// renderKalosMobileDex already centers the newly-open gen's pane
// (tileGrid.scrollLeft = openTile.offsetLeft) as part of its normal
// kalosOpenGen branch, so no extra carousel-scroll call is needed here -
// just re-running the render with kalosOpenGen set to the target gen.
function jumpToDexSpeciesMobile(name) {
var loc = findDexLocation(name);
if (!loc) return;
document.querySelectorAll('.dex-chip-highlighted').forEach(function(chip) {
chip.classList.remove('dex-chip-highlighted');
});
kalosOpenGen = String(loc.gen);
kalosCarouselIndex = kalosGenIndexOf(kalosOpenGen);
renderKalosMobileDex(kalosCurrentCaughtMap());
var grid = document.getElementById('kalos-gen-grid');
var target = null;
var norm = normName(name);
if (grid) {
grid.querySelectorAll('.dex-chip').forEach(function(chip) {
if (chip.dataset.name === norm) target = chip;
});
}
if (target) {
target.classList.remove('dex-chip-highlighted');
void target.offsetWidth;
target.classList.add('dex-chip-highlighted');
if (typeof target.scrollIntoView === 'function') {
target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
}
}
// Expands one gen square into its full banner right where it's sitting in
// the grid, and hides every other square - the desktop counterpart of
// expandKalosTile(), reusing the same flipAnimate() grow so it visibly
// swells into place instead of just popping open.
function expandDexCard(card) {
var grid = card.parentNode;
if (!grid) return;
var first = card.getBoundingClientRect();
Array.prototype.forEach.call(grid.children, function(c) {
if (c !== card) c.hidden = true;
});
dexOpenGen = card.dataset.gen;
card.classList.add('expanded');
hideChipsForStagger(card);
applyEvoStageBoosts(card);
flipAnimate(card, first, function() { staggerChipsIn(card); });
}
// Collapses the expanded gen card back into its square and brings the
// other squares back - the desktop counterpart of collapseKalosTile().
function collapseDexCard(card) {
var grid = card.parentNode;
if (!grid) return;
var first = card.getBoundingClientRect();
dexOpenGen = null;
card.classList.remove('expanded');
// A search-jump highlight is meant to last only as long as its region
// stays open - once the person collapses the card, clear any
// highlighted chip inside it so it doesn't stay lit the next time
// the card is reopened.
card.querySelectorAll('.dex-chip-highlighted').forEach(function(chip) {
chip.classList.remove('dex-chip-highlighted');
});
Array.prototype.forEach.call(grid.children, function(c) {
c.hidden = false;
});
flipAnimate(card, first);
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
// Both halves of the Living/Shiny split toggle are always rendered with
// their own live percentage (see buildDexSplitToggleHtml, called from
// renderLivingDex), so switching modes never has to reveal a hidden
// number - it just re-renders with the new side marked active. A short
// spring "pop" on the newly-active percentage (popDexSplitActive, below)
// gives the switch some tactile feedback on top of that re-render.
document.querySelectorAll('.dex-split-toggle').forEach(function(toggle) {
toggle.addEventListener('click', function(e) {
var btn = e.target.closest('.dex-split-half[data-mode]');
if (!btn || btn.dataset.mode === dexMode) return;
// Grab the outgoing active half's on-screen position before the
// re-render wipes it out, so the trail (below) has a real start point
// to fly from instead of just materializing on the target.
var prevActive = toggle.querySelector('.dex-split-half.active');
var fromRect = prevActive ? prevActive.getBoundingClientRect() : null;
var toggleRect = toggle.getBoundingClientRect();
var targetMode = btn.dataset.mode;
dexMode = targetMode;
renderLivingDex();
popDexSplitActive();
slideDexSplitTrail(toggle, fromRect, toggleRect, toggle.querySelector('.dex-split-half.active'), targetMode);
});
});
// Springs the just-activated side's percentage up from slightly-shrunk to
// slightly-overshot to rest, via Motion - purely decorative feedback for
// a user-driven mode switch, skipped entirely if Motion isn't loaded or
// the person prefers reduced motion (the static bigger-when-active size
// from .dex-split-half.active .dex-split-pct in style.css still applies
// either way, so the "this one's active" cue never depends on the pop).
function popDexSplitActive() {
if (!(window.Motion && window.Motion.animate)) return;
if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
document.querySelectorAll('.dex-split-half.active .dex-split-pct').forEach(function(el) {
window.Motion.animate(el, { scale: [0.78, 1.16, 1] }, { duration: 0.4, ease: [0.34, 1.56, 0.64, 1] });
});
}
// Flies a short-lived glowing "trail" (via Motion) from the half that was
// just active to the one that was just tapped, using a plain FLIP: the
// trail is a throwaway absolutely-positioned element sized/positioned to
// match the outgoing half's real rect, then animated (left/top/width/
// height/opacity) to the incoming half's rect and removed once it lands.
// Purely decorative on top of the instant CSS active-state swap, so a
// missing rect, missing Motion, or reduced-motion preference all just
// skip it rather than block the (already-completed) mode switch.
function slideDexSplitTrail(toggle, fromRect, toggleRect, toEl, mode) {
if (!fromRect || !toEl) return;
if (!(window.Motion && window.Motion.animate)) return;
if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
var toRect = toEl.getBoundingClientRect();
var startLeft = fromRect.left - toggleRect.left;
var startTop = fromRect.top - toggleRect.top;
var endLeft = toRect.left - toggleRect.left;
var endTop = toRect.top - toggleRect.top;
var trail = document.createElement('span');
trail.className = 'dex-split-trail dex-split-trail-' + mode;
trail.style.left = startLeft + 'px';
trail.style.top = startTop + 'px';
trail.style.width = fromRect.width + 'px';
trail.style.height = fromRect.height + 'px';
toggle.appendChild(trail);
var controls = window.Motion.animate(trail, {
left: [startLeft + 'px', endLeft + 'px'],
top: [startTop + 'px', endTop + 'px'],
width: [fromRect.width + 'px', toRect.width + 'px'],
height: [fromRect.height + 'px', toRect.height + 'px'],
opacity: [0.85, 0]
}, { duration: 0.42, ease: [0.22, 1, 0.36, 1] });
if (controls && controls.finished && controls.finished.then) {
controls.finished.then(function() { trail.remove(); }).catch(function() { trail.remove(); });
} else {
setTimeout(function() { trail.remove(); }, 450);
}
}
var DEX_SORT_LABELS = {
dex: 'Dex Number',
alpha: 'A–Z',
uncaught: 'Uncaught First'
};
var DEX_SORT_SHORT_LABELS = {
dex: 'Dex #',
alpha: 'A–Z',
uncaught: 'Uncaught'
};
// Re-orders chips already in the DOM to match dexSortMode, for whichever
// generation(s) are currently expanded in the mobile Kalos carousel (the
// open tile plus its swipe-neighbor panes, if any) - same in-place-move
// technique as resortDexGrid (below), so any already-loading sprite <img>
// nodes are relocated rather than rebuilt/re-fetched.
function resortKalosGrid() {
var caught = kalosCurrentCaughtMap();
document.querySelectorAll('#kalos-gen-grid .kalos-gen-tile-expanded').forEach(function(tile) {
var gen = GEN_DATA.filter(function(g) {
return String(g.gen) === tile.dataset.gen;
})[0];
if (!gen) return;
var panel = tile.querySelector('.dex-species-grid');
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
// Keeps the sort button label/active-state and selected option in sync
// across both the desktop (#btn-dex-sort) and mobile (#btn-k-sort)
// toolbars, whichever one triggered the change.
function syncDexSortUI() {
[
{ btn: 'btn-dex-sort', panel: 'dex-sort-panel', label: 'Sort: ' + DEX_SORT_LABELS[dexSortMode] + ' ▾' },
{ btn: 'btn-k-sort', panel: 'k-sort-panel', label: DEX_SORT_SHORT_LABELS[dexSortMode] + ' ▾' }
].forEach(function(ui) {
var btn = document.getElementById(ui.btn);
var panel = document.getElementById(ui.panel);
if (btn) {
btn.textContent = ui.label;
btn.classList.toggle('active', dexSortMode !== 'dex');
}
if (panel) {
panel.querySelectorAll('.dex-select-option').forEach(function(o) {
o.classList.toggle('active', o.dataset.value === dexSortMode);
});
}
});
}
function setDexSortMode(mode) {
dexSortMode = mode;
syncDexSortUI();
resortDexGrid();
resortKalosGrid();
}
document.getElementById('btn-dex-sort').addEventListener('click', function(e) {
e.stopPropagation();
closeOtherDexDropdowns('dex-sort-wrap');
document.getElementById('dex-sort-wrap').classList.toggle('open');
});
document.getElementById('dex-sort-panel').addEventListener('click', function(e) {
e.stopPropagation();
var opt = e.target.closest('.dex-select-option');
if (!opt) return;
setDexSortMode(opt.dataset.value);
document.getElementById('dex-sort-wrap').classList.remove('open');
});
var dexSearchInput = document.getElementById('dex-search');
attachPokemonAutocomplete(dexSearchInput);
dexSearchInput.addEventListener('change', function() {
var val = this.value.trim();
if (!val) return;
jumpToDexSpecies(val);
this.value = '';
});
// Builds the species-chip grid markup for one generation - shared by the
// desktop dex-grid cards and the mobile Kalos dex's gen-detail screen so
// both stay in sync without duplicating the chip-building logic.
function buildDexChipsHtml(g, caught) {
var displaySpecies = sortDexSpecies(g.species, caught, dexSortMode);
return displaySpecies.map(function(sp) {
var has = !!caught[normName(sp[1])];
var variant = parseRegionalVariant(sp[1]);
// Regional variants no longer get a separate name-row tag pill - the cell
// background motif (see .dex-chip[data-variant="..."]::before in
// style.css) now carries that signal instead, so the sprite can stay
// full-size instead of being squeezed to make room for the pill.
var nameHtml = '<span class="dex-chip-name-text">' + escapeHtml(variant.base) + '</span>';
// role/tabindex/aria-pressed/aria-label make each chip a real toggle
// button for screen readers and keyboard users - previously these were
// bare clickable <div>s with no accessible name at all, which matters
// more now that the chip leads with a sprite/silhouette and the name
// text itself is secondary and easy for a screen reader to miss.
var chipLabel = variant.base + (variant.tag ? ' (' + variant.tag + ')' : '') + (has ? ', caught' : ', not caught');
// data-dexnum/data-display back the 3D View toggle (open3DModelModal) -
// sp[0] is the National Dex number shared by every regional form of a
// species, which is also how the Pokemon-3D-api model repo keys its
// files (see pokemon3DModelUrls below).
var interactive = ' data-action="toggle-species" data-name="' + escapeHtml(normName(sp[1])) + '" data-dexnum="' + sp[0] + '" data-display="' + escapeHtml(variant.base + (variant.tag ? ' (' + variant.tag + ')' : '')) + '" role="button" tabindex="0" aria-pressed="' + (has ? 'true' : 'false') + '" aria-label="' + escapeHtml(chipLabel) + '"';
// data-variant tags each chip with its regional-variant category (or
// "Original" for base-form species) so applyDexVariantFilter() can
// show/hide chips by category without re-parsing the display name.
var variantAttr = ' data-variant="' + escapeHtml(variant.tag || 'Original') + '"';
// Tints the cell (background/border/caught-glow, all via CSS rgba())
// by the species' primary type, so scanning a gen for "what fire types
// are left" is a color-glance instead of a name-by-name read.
var info = speciesInfo(sp[1]);
var typeRgb = typeRgbTriple(info && info.types.length ? info.types[0] : null);
var spriteImg = '<span class="dex-chip-sprite">' + smallSpriteMarkup(sp[1], dexEntrySpriteUrls(sp[1], dexMode === 'shiny')) + '</span>';
return '<div class="dex-chip' + (has ? ' caught' : '') + ' interactive"' + interactive + variantAttr + ' style="--type-rgb:' + typeRgb + '">' + spriteImg + '<span class="n">#' + sp[0] + '</span><span class="dex-chip-name">' + nameHtml + '</span></div>';
}).join('');
}
// Springs the sprite wrapper up from slightly-shrunk to slightly-overshot
// to rest the instant a chip is marked caught, so the silhouette-to-color
// reveal (already an eased CSS filter transition on .dex-chip.caught img,
// see style.css) reads as a small "catch" moment instead of an instant
// class swap. Animates the .dex-chip-sprite wrapper rather than the img
// itself, since the img already carries a fixed base transform:scale(...)
// for its per-gen sprite sizing that a Motion-driven inline transform
// would otherwise clobber. No-op without Motion or with reduced motion
// preferred; un-catching a chip never calls this.
function animateCatchReveal(chip) {
if (!(window.Motion && window.Motion.animate)) return;
if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
var wrap = chip.querySelector('.dex-chip-sprite');
if (!wrap) return;
window.Motion.animate(wrap, { scale: [0.7, 1.18, 1] }, { duration: 0.45, ease: [0.34, 1.56, 0.64, 1] });
}
// Keeps a chip's aria-pressed/aria-label in sync with its caught state
// after an in-place toggle (the fast path used by both grid click
// handlers below, which mutate the existing chip node instead of calling
// buildDexChipsHtml again).
function updateChipA11y(chip, nowCaught) {
chip.setAttribute('aria-pressed', nowCaught ? 'true' : 'false');
var label = chip.getAttribute('aria-label') || '';
label = label.replace(/, (caught|not caught)$/, '');
chip.setAttribute('aria-label', label + (nowCaught ? ', caught' : ', not caught'));
}
// Geometry for the circular "dex complete" ring wrapped around each
// region-ball badge (see buildDexGenBadgeHtml below). Drawn on a 0-100
// viewBox so the same stroke-dasharray/offset numbers work regardless of
// the badge's actual pixel size (56px desktop, 40px mobile Kalos tile).
var GEN_BADGE_RING_R = 46;
var GEN_BADGE_RING_CIRC = 2 * Math.PI * GEN_BADGE_RING_R;
// Bumped for every ring built so each gets its own unique gradient id -
// #dex-grid and #kalos-gen-grid can both be in the DOM at once, so two
// badges for the same gen (desktop + mobile) must never share one id.
var dexGenBadgeRingId = 0;
function genBadgeRingOffset(pct) {
return (GEN_BADGE_RING_CIRC * (1 - Math.max(0, Math.min(100, pct || 0)) / 100)).toFixed(1);
}
// Builds the round region-ball badge (with gen-number fallback) for one
// generation, wrapped in a circular progress ring that fills clockwise as
// more of that generation's dex gets caught - shared by the desktop
// dex-grid cards and the mobile Kalos dex's gen tiles. While browsing the
// Shiny Living Dex (dexMode === 'shiny') the ring fill is a rainbow
// gradient instead of the plain green/gold, matching the sparkle treatment
// already used on caught chips in that mode.
function buildDexGenBadgeHtml(g, pct) {
var ballFile = REGION_BALLS[g.region];
var badgeInner = ballFile ?
('<img src="images/region-balls/' + ballFile + '" alt="' + escapeHtml(g.region) + ' ball" onerror="this.style.display=\'none\'; this.nextElementSibling.style.display=\'flex\';">' +
'<span class="dex-gen-badge-fallback">' + g.gen + '</span>') :
('<span class="dex-gen-badge-fallback" style="display:flex;">' + g.gen + '</span>');
var isShiny = dexMode === 'shiny';
var gradId = 'dex-ring-rainbow-' + (dexGenBadgeRingId++);
var defsHtml = isShiny ?
('<defs><linearGradient id="' + gradId + '" x1="0%" y1="0%" x2="100%" y2="0%">' +
'<stop offset="0%" stop-color="#ff6ec7"></stop>' +
'<stop offset="25%" stop-color="#ffd166"></stop>' +
'<stop offset="50%" stop-color="#6ee7b7"></stop>' +
'<stop offset="75%" stop-color="#60a5fa"></stop>' +
'<stop offset="100%" stop-color="#c084fc"></stop>' +
'</linearGradient></defs>') : '';
var fillStyle = 'stroke-dashoffset:' + genBadgeRingOffset(pct) + (isShiny ? ';stroke:url(#' + gradId + ')' : '');
return (
'<div class="dex-gen-badge-ring' + (pct >= 100 ? ' is-complete' : '') + '">' +
'<svg class="dex-gen-badge-ring-svg" viewBox="0 0 100 100" aria-hidden="true">' +
defsHtml +
'<circle class="ring-track" cx="50" cy="50" r="' + GEN_BADGE_RING_R + '"></circle>' +
'<circle class="ring-fill" cx="50" cy="50" r="' + GEN_BADGE_RING_R + '" stroke-dasharray="' + GEN_BADGE_RING_CIRC.toFixed(1) + '" style="' + fillStyle + '"></circle>' +
'</svg>' +
'<div class="dex-gen-badge">' + badgeInner + '</div>' +
'</div>'
);
}
// Builds both halves of the Living/Shiny split toggle at once - Living%
// on the left, Shiny% on the right - so neither percentage is ever hidden
// behind the other; the active mode is picked out via .active (bigger,
// bolder, tinted - see style.css) while both stay fully visible. Icons
// (pokéball / sparkle) stand in for text labels so the switch reads at a
// glance without relying on color alone. Tapping a half switches dexMode
// (see the .dex-split-toggle click handler above).
var DEX_SPLIT_ICONS = {
living: '<svg viewBox="0 0 24 24" width="17" height="17" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.15"/><path d="M3 12a9 9 0 0 1 18 0" fill="currentColor" opacity="0.5"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M3 12H9M15 12H21" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
shiny: '<svg viewBox="0 0 24 24" width="17" height="17" xmlns="http://www.w3.org/2000/svg"><path d="M12 2 L14.3 9.7 L22 12 L14.3 14.3 L12 22 L9.7 14.3 L2 12 L9.7 9.7 Z" fill="currentColor"/></svg>'
};
function buildDexSplitToggleHtml(livingProgress, shinyProgress, activeMode) {
return (
buildDexSplitHalfHtml('living', 'Living', livingProgress, activeMode === 'living') +
'<span class="dex-split-divider" aria-hidden="true"></span>' +
buildDexSplitHalfHtml('shiny', 'Shiny', shinyProgress, activeMode === 'shiny')
);
}
function buildDexSplitHalfHtml(mode, label, progress, isActive) {
var pct = progress.total > 0 ? Math.round((progress.caught / progress.total) * 100) : 0;
return (
'<button type="button" class="dex-split-half dex-split-' + mode + (isActive ? ' active' : '') + '" data-mode="' + mode + '" aria-pressed="' + (isActive ? 'true' : 'false') + '" aria-label="' + label + ' Dex: ' + pct + '% caught, ' + progress.caught + ' of ' + progress.total + '">' +
'<span class="dex-split-icon-wrap" aria-hidden="true" style="--pct:' + pct + '"><span class="dex-split-ring"></span><span class="dex-split-icon">' + DEX_SPLIT_ICONS[mode] + '</span></span>' +
'<span class="dex-split-pct"><span class="dex-split-pct-num">' + pct + '</span>%</span>' +
'<span class="dex-split-frac">' + progress.caught + ' / ' + progress.total + '</span>' +
'<span class="dex-split-bar" aria-hidden="true"><span class="dex-split-bar-fill" style="width:' + pct + '%"></span></span>' +
'</button>'
);
}
// Remembers the last percentage drawn for each half (shared by the desktop
// #dex-mode-toggle and mobile #kalos-mode-toggle, since both always mirror
// the same totals) so the two percentage numbers - and their mini progress
// bars - can count/slide from old -> new via Motion instead of just
// popping to the new value on every re-render. Skips animating on the
// very first render and falls back to an instant jump if Motion isn't
// available or the person prefers reduced motion.
var dexSplitAnimState = { living: null, shiny: null };
function animateDexSplitToggleTo(livingProgress, shinyProgress) {
var prev = dexSplitAnimState;
var livingPct = livingProgress.total > 0 ? Math.round((livingProgress.caught / livingProgress.total) * 100) : 0;
var shinyPct = shinyProgress.total > 0 ? Math.round((shinyProgress.caught / shinyProgress.total) * 100) : 0;
var isFirstRender = prev.living === null;
dexSplitAnimState = { living: livingPct, shiny: shinyPct };
if (isFirstRender || (prev.living === livingPct && prev.shiny === shinyPct)) return;
var noMotion = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
!(window.Motion && window.Motion.animate);
if (noMotion) return;
var animate = window.Motion.animate;
['dex-mode-toggle', 'kalos-mode-toggle'].forEach(function(id) {
var el = document.getElementById(id);
if (!el) return;
var livingNum = el.querySelector('.dex-split-living .dex-split-pct-num');
var shinyNum = el.querySelector('.dex-split-shiny .dex-split-pct-num');
var livingBar = el.querySelector('.dex-split-living .dex-split-bar-fill');
var shinyBar = el.querySelector('.dex-split-shiny .dex-split-bar-fill');
if (livingNum) {
animate(prev.living, livingPct, { duration: 0.45, ease: [0.22, 1, 0.36, 1], onUpdate: function(v) { livingNum.textContent = Math.round(v); } });
}
if (shinyNum) {
animate(prev.shiny, shinyPct, { duration: 0.45, ease: [0.22, 1, 0.36, 1], onUpdate: function(v) { shinyNum.textContent = Math.round(v); } });
}
if (livingBar) {
animate(prev.living, livingPct, { duration: 0.45, ease: [0.22, 1, 0.36, 1], onUpdate: function(v) { livingBar.style.width = v + '%'; } });
if (prev.living !== livingPct) {
animate(livingBar, { filter: ['brightness(1)', 'brightness(1.9)', 'brightness(1)'] }, { duration: 0.6, delay: 0.25, ease: 'easeOut' });
}
}
if (shinyBar) {
animate(prev.shiny, shinyPct, { duration: 0.45, ease: [0.22, 1, 0.36, 1], onUpdate: function(v) { shinyBar.style.width = v + '%'; } });
if (prev.shiny !== shinyPct) {
animate(shinyBar, { filter: ['brightness(1)', 'brightness(1.9)', 'brightness(1)'] }, { duration: 0.6, delay: 0.25, ease: 'easeOut' });
}
}
});
}
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
var isOpen = dexOpenGen !== null && String(dexOpenGen) === String(g.gen);
var card = document.createElement('div');
card.className = 'dex-card' + (isOpen ? ' expanded' : '');
card.dataset.gen = g.gen;
if (dexOpenGen !== null && !isOpen) card.hidden = true;
var chipsHtml = buildDexChipsHtml(g, caught);
card.innerHTML =
'<div class="dex-card-banner">' +
'<div class="dex-card-head" data-action="toggle-dex" data-gen="' + g.gen + '">' +
// REGION BALL CONTAINER: round "pokeball" badge for each region,
// using REGION_BALLS (defined near GEN_DATA above) for the image,
// with the plain gen-number badge as a fallback if it's missing/fails to load.
buildDexGenBadgeHtml(g, pct) +
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
if (isOpen) applyEvoStageBoosts(card);
});
var livingProgress = (dexMode === 'living') ? { caught: totalCaught, total: totalSpecies } : livingDexProgress();
var shinyProgress = (dexMode === 'shiny') ? { caught: totalCaught, total: totalSpecies } : shinyDexProgress();
var toggle = document.getElementById('dex-mode-toggle');
toggle.innerHTML = buildDexSplitToggleHtml(livingProgress, shinyProgress, dexMode);
var kalosToggle = document.getElementById('kalos-mode-toggle');
if (kalosToggle) kalosToggle.innerHTML = toggle.innerHTML;
animateDexSplitToggleTo(livingProgress, shinyProgress);
renderKalosMobileDex(caught);
applyDexTypeFilter();
applyDexVariantFilter();
applyDexAnimatedFilter();
updateLivingDexPillBadge();
}
// ---------- mobile Kalos dex: gen-tile grid + gen-detail drill-down ----------
// Renders the 3-per-row gen tile grid inside the mobile Kalos dex's screen,
// and (if a gen is currently drilled into) refreshes that gen's detail
// panel too, so both stay accurate after every caught-toggle or mode
// switch without needing their own separate render pass to stay in sync.
// Lightweight counter-only refresh for the mobile Kalos dex, used after a
// single chip toggle (see updateDexCounters below) instead of a full
// renderKalosMobileDex() rebuild. Updates each tile's caught count,
// progress ring, and (for the currently-open tile) its header count, all
// via direct DOM writes - it never touches a sprite <img>, a chip, or
// any other element besides these count/ring nodes. Rebuilding the whole
// tile grid on every tap was recreating every sprite image in the open
// panel, which is what made the whole grid visibly flicker each time a
// single species was caught.
function updateKalosDexCounts(caught) {
var tileGrid = document.getElementById('kalos-gen-grid');
if (!tileGrid) return;
tileGrid.querySelectorAll('.kalos-gen-tile').forEach(function(tile) {
var gen = GEN_DATA.filter(function(g) {
return String(g.gen) === tile.dataset.gen;
})[0];
if (!gen) return;
var genCaught = kalosGenCaughtCount(gen, caught);
var pct = Math.round((genCaught / gen.species.length) * 100);
if (tile.classList.contains('kalos-gen-tile-expanded')) {
var countEl = tile.querySelector('.kalos-gen-detail-title .dex-card-count');
if (countEl) countEl.textContent = genCaught + ' / ' + gen.species.length;
} else {
var tileCountEl = tile.querySelector('.kalos-gen-tile-count');
if (tileCountEl) tileCountEl.textContent = genCaught + ' / ' + gen.species.length;
var ringFillEl = tile.querySelector('.dex-gen-badge-ring .ring-fill');
if (ringFillEl) ringFillEl.style.strokeDashoffset = genBadgeRingOffset(pct);
var ringEl = tile.querySelector('.dex-gen-badge-ring');
if (ringEl) ringEl.classList.toggle('is-complete', pct === 100);
}
});
}
function kalosGenCaughtCount(g, caught) {
var n = 0;
g.species.forEach(function(sp) {
if (caught[normName(sp[1])]) n++;
});
return n;
}
// Index of a gen (by number) within GEN_DATA's fixed 1-9 order - used to
// find which tiles flank the open one (renderKalosMobileDex) and to keep
// kalosCarouselIndex in sync with whichever gen is currently open.
function kalosGenIndexOf(genNum) {
for (var i = 0; i < GEN_DATA.length; i++) {
if (String(GEN_DATA[i].gen) === String(genNum)) return i;
}
return -1;
}
// Maps a generation number to a cartridge shell style for the mobile
// Living Dex carousel tiles: gens 1-3 (GBA), 4-5 (DS), 6-7 (3DS), 8-9
// (Switch).
function kalosCartStyleForGen(genNum) {
var n = Number(genNum);
if (n >= 1 && n <= 3) return 'gba';
if (n >= 4 && n <= 5) return 'ds';
if (n >= 6 && n <= 7) return '3ds';
if (n >= 8 && n <= 9) return 'switch';
return '';
}
// Optional real box-art photo for a generation's cartridge-shell Living
// Dex tile (gens 1-7 - GBA/DS/3DS styles, see kalosCartStyleForGen
// above; gens 8-9 use the Switch-shell layout instead and aren't
// covered by this), layered behind the badge/label instead of the
// plain gold/sunburst swirl sticker. Filenames are looked up as-is
// under images/game-symbols/ (include the extension, any image type
// works). Placeholder filenames below are guesses - rename each to
// match whatever you actually saved, or set an entry to null/remove
// it to fall back to the plain swirl sticker for that gen.
var GEN_BOX_ART = {
1: "firegreen.jpg", // Kanto
2: "heartgold.jpg",  // Johto
3: "emerald.jpg",    // Hoenn
4: "platinum.jpg",              // Sinnoh — Pokémon Platinum cover artwork
5: "black.jpg",                 // Unova — Pokémon Black cover artwork
6: "x.jpg",   // Kalos
7: "usum.png"         // Alola
};
function buildKalosTileCollapsedHtml(g, genCaught) {
var pct = Math.round((genCaught / g.species.length) * 100);
if (kalosCartStyleForGen(g.gen) === 'switch') {
// Same floating completion-bar hierarchy used above the GBA/DS/3DS
// cartridges, reused here so the Switch cards get a matching bar on top.
var switchHudBallFile = REGION_BALLS[g.region];
var switchHudBallFallbacks = {
"ball_kanto_pokeball.png": "poke-ball",
"ball_johto_greatball.png": "great-ball",
"ball_hoenn_ultraball.png": "ultra-ball",
"ball_sinnoh_masterball.png": "master-ball",
"ball_unova_quickball.png": "quick-ball",
"ball_kalos_timerball.png": "timer-ball",
"ball_alola_beastball.png": "beast-ball",
"ball_galar_dynamaxball.png": "poke-ball",
"ball_paldea_premierball.png": "premier-ball"
};
var switchHudBallSlug = switchHudBallFallbacks[switchHudBallFile] || "poke-ball";
var switchHudBallRemote = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/" + switchHudBallSlug + ".png";
var switchHudBall = switchHudBallFile ?
('<span class="kalos-gba-ball"><img src="' + switchHudBallRemote + '" data-local-src="images/region-balls/' + switchHudBallFile + '" alt="" onerror="this.style.display=\'none\';this.parentElement.classList.add(\'is-fallback\');"></span>') :
'<span class="kalos-gba-ball is-fallback"></span>';
var switchCompletion =
'<div class="kalos-ds-completion" aria-label="' + escapeHtml(g.region) + ' completion ' + pct + ' percent">' +
switchHudBall +
'<span class="kalos-ds-region">' + escapeHtml(g.region) + '</span>' +
'<span class="kalos-ds-progress"><strong>' + pct + '%</strong><small>' + genCaught + ' / ' + g.species.length + '</small></span>' +
'</div>';
return (
'<div class="kalos-gen-tile-sticker">' +
'<div class="kalos-switch-header">' +
'<svg class="kalos-switch-header-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
'<rect x="2" y="3" width="7" height="18" rx="3.5" fill="#fff"/>' +
'<circle cx="5.5" cy="7.2" r="1" fill="#E60012"/>' +
'<rect x="15" y="3" width="7" height="18" rx="3.5" fill="#fff"/>' +
'<circle cx="18.5" cy="8" r="1.3" fill="#E60012"/>' +
'</svg>' +
'<span class="kalos-switch-header-text">Nintendo Switch</span>' +
'</div>' +
'<div class="kalos-switch-art">' +
buildDexGenBadgeHtml(g, pct) +
'<div class="kalos-switch-region">' + escapeHtml(g.region) + '</div>' +
'<div class="kalos-switch-publisher">Shiny Tracker</div>' +
'<div class="kalos-switch-rating">' +
'<span class="kalos-switch-rating-letter">E</span>' +
'<span class="kalos-switch-rating-sub">Everyone</span>' +
'</div>' +
'</div>' +
'<div class="kalos-switch-footer">LA-H-TRK-0' + g.gen + '-USA</div>' +
'</div>' +
switchCompletion
);
}
var cartStyleForBoxArt = kalosCartStyleForGen(g.gen);
var boxArt = (cartStyleForBoxArt === 'gba' || cartStyleForBoxArt === 'ds' || cartStyleForBoxArt === '3ds') ? GEN_BOX_ART[g.gen] : null;
var usesDsReferencePhoto = cartStyleForBoxArt === 'ds' && Boolean(boxArt);
var cartPrefix = cartStyleForBoxArt === 'gba' ? 'AGB' : (cartStyleForBoxArt === 'ds' ? 'NTR' : 'LNA-CTR');
var cartCode = cartPrefix + '-TRK-' + String(g.gen).padStart(2, '0') + '-USA';
var hudBallFile = REGION_BALLS[g.region];
var hudBallFallbacks = {
"ball_kanto_pokeball.png": "poke-ball",
"ball_johto_greatball.png": "great-ball",
"ball_hoenn_ultraball.png": "ultra-ball",
"ball_sinnoh_masterball.png": "master-ball",
"ball_unova_quickball.png": "quick-ball",
"ball_kalos_timerball.png": "timer-ball",
"ball_alola_beastball.png": "beast-ball",
"ball_galar_dynamaxball.png": "poke-ball",
"ball_paldea_premierball.png": "premier-ball"
};
var hudBallSlug = hudBallFallbacks[hudBallFile] || "poke-ball";
var hudBallRemote = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/" + hudBallSlug + ".png";
var gbaHudBall = hudBallFile ?
('<span class="kalos-gba-ball"><img src="' + hudBallRemote + '" data-local-src="images/region-balls/' + hudBallFile + '" alt="" onerror="this.style.display=\'none\';this.parentElement.classList.add(\'is-fallback\');"></span>') :
'<span class="kalos-gba-ball is-fallback"></span>';
var gbaCompletion = cartStyleForBoxArt === 'gba' ? (
'<div class="kalos-gba-completion" style="--complete:' + pct + '%;--complete-rail:calc(' + pct + '% - 11px)" aria-label="' + escapeHtml(g.region) + ' completion ' + pct + ' percent">' +
gbaHudBall +
'<span class="kalos-gba-region">' + escapeHtml(g.region) + '</span>' +
'<span class="kalos-gba-progress"><strong>' + pct + '%</strong><small>' + genCaught + ' / ' + g.species.length + '</small></span>' +
'</div>'
) : '';
var dsCompletion = (cartStyleForBoxArt === 'ds' || cartStyleForBoxArt === '3ds') ? (
'<div class="kalos-ds-completion" aria-label="' + escapeHtml(g.region) + ' completion ' + pct + ' percent">' +
gbaHudBall +
'<span class="kalos-ds-region">' + escapeHtml(g.region) + '</span>' +
'<span class="kalos-ds-progress"><strong>' + pct + '%</strong><small>' + genCaught + ' / ' + g.species.length + '</small></span>' +
'</div>'
) : '';
// An explicit element is used for the small lower DS retention triangle. It
// keeps the detail above the shell artwork and avoids pseudo-element layering
// being suppressed by the carousel’s depth/overflow treatment.
var dsBottomTriangle = cartStyleForBoxArt === 'ds' ?
'<span class="kalos-ds-bottom-triangle" aria-hidden="true"></span>' : '';
var threeDsLabel = cartStyleForBoxArt === '3ds' ? (
'<div class="kalos-3ds-label">' +
'<div class="kalos-3ds-brand">NINTENDO <span class="kalos-3ds-mark"><i></i><i></i>3DS</span><sup>™</sup></div>' +
'<div class="kalos-3ds-inset-art">' +
(boxArt ? '<img class="kalos-3ds-boxart" src="images/game-symbols/' + boxArt + '" alt="" onerror="this.remove()">' : '') +
'</div>' +
'<div class="kalos-3ds-info-bar">' +
'<span class="kalos-3ds-nintendo"><span class="kalos-3ds-nintendo-word">Nintendo</span><span class="kalos-3ds-nintendo-sub">The Pokémon Company</span></span>' +
'<span class="kalos-3ds-ce" aria-hidden="true">CE</span>' +
'</div>' +
'<div class="kalos-3ds-product-code">LNA-CTR-TRK-0' + g.gen + '-USA</div>' +
'</div>'
) : '';
// GBA and DS cards are now physical cartridges with their own dedicated
// completion HUD above the shell. Do not keep the retired generic card
// badge/label/code inside those faces: during a swipe that old markup was
// still present in the DOM and could be exposed by the older shared styles.
var usesPhysicalCartridgeChrome = cartStyleForBoxArt === 'gba' || cartStyleForBoxArt === 'ds' || cartStyleForBoxArt === '3ds';
var legacyTileDetails = usesPhysicalCartridgeChrome ? '' : (
buildDexGenBadgeHtml(g, pct) +
'<div class="kalos-gen-tile-label">' +
'<div class="kalos-gen-tile-region">' + escapeHtml(g.region) + '</div>' +
'<div class="kalos-gen-tile-count">' + genCaught + ' / ' + g.species.length + '</div>' +
'</div>' +
'<div class="kalos-cart-product-code">' + cartCode + '</div>'
);
return (
'<div class="kalos-gen-tile-sticker' + (boxArt ? ' has-boxart' : '') + (usesDsReferencePhoto ? ' has-ds-reference-photo' : '') + '">' +
(threeDsLabel || ((boxArt ? '<img class="kalos-gen-tile-boxart" src="images/game-symbols/' + boxArt + '" alt="" onerror="this.remove()">' : '') + legacyTileDetails)) +
'</div>' +
dsBottomTriangle +
gbaCompletion +
dsCompletion
);
}
function buildKalosTileExpandedHtml(g, caught, genCaught) {
return (
'<div class="dex-card-banner kalos-gen-detail-banner">' +
'<div class="kalos-gen-detail-head">' +
'<button type="button" class="kalos-gen-back" aria-label="Back to generations">◀&#xFE0E; Back</button>' +
'<div class="kalos-gen-detail-title">' +
'<div class="region">' + escapeHtml(g.region) + '</div>' +
'<div class="gen-label">Generation ' + g.gen + '</div>' +
'<div class="dex-card-count">' + genCaught + ' / ' + g.species.length + '</div>' +
'</div>' +
'</div>' +
'</div>' +
'<div class="dex-species-panel">' +
'<div class="dex-species-grid">' + buildDexChipsHtml(g, caught) + '</div>' +
'</div>'
);
}
// Filtering (Type/Form/Stage) only hides individual chips inside the
// species grid - it should never shrink the panel wrapped around them.
// Without this, hiding most of a gen's chips let this panel's own height
// (it's also the element the per-gen map background is painted on)
// collapse down to whatever content was left, cutting the artwork off
// partway instead of it always running the panel's full, unfiltered
// length. Must be called once per fresh (still fully unfiltered) render,
// right before the Type/Form/Stage filters get (re)applied to that same
// markup - it captures the true full height at that moment and floors
// the panel there, so the filters afterward only ever hide chips.
function pinKalosSpeciesPanelHeights(root) {
(root || document).querySelectorAll('.kalos-gen-tile-expanded .dex-species-panel').forEach(function(panel) {
// offsetHeight, not getBoundingClientRect() - the tile this panel lives
// in is mid-FLIP-grow at this point (see flipAnimate above), sitting
// under a CSS transform that getBoundingClientRect() would report as
// part of its size. offsetHeight reads the real layout box and ignores
// transforms entirely, so it's unaffected by whatever the grow
// animation is doing visually at the moment this runs.
panel.style.minHeight = '';
panel.style.minHeight = panel.offsetHeight + 'px';
});
}
// Rebuilds the gen tile grid. If a gen is currently expanded
// (kalosOpenGen), that one tile is (re)built in its expanded/banner form
// in its own slot and every other tile stays hidden, instead of a
// separate detail panel living elsewhere - so counts/chips stay accurate
// after every caught-toggle without disturbing which square is open.
function renderKalosMobileDex(caught) {
var tileGrid = document.getElementById('kalos-gen-grid');
if (!tileGrid) return;
// The open tile's species list (.dex-species-panel) scrolls internally,
// separately from the page. Rebuilding below (tileGrid.innerHTML = '')
// throws that panel away and creates a brand new one for the same gen,
// which resets its scrollTop to 0 - that's what was yanking the open
// panel back to its top every time a chip tap re-rendered through here
// (e.g. catching a species). Save the scroll position before the wipe
// and restore it on the freshly-built panel below.
var openPanelBefore = tileGrid.querySelector('.kalos-gen-tile-expanded[data-gen="' + kalosOpenGen + '"] .dex-species-panel');
var savedPanelScrollTop = openPanelBefore ? openPanelBefore.scrollTop : null;
// Marks every rebuilt tile rail as the current cartridge renderer. The
// stylesheet uses this state to keep the retired generic-card treatment out
// of the modern mobile carousel.
tileGrid.dataset.carouselDesign = 'cartridge-v2';
// Open generations deliberately use the original map-and-species-panel view;
// only the collapsed rail uses the newer physical cartridge presentation.
tileGrid.dataset.openPresentation = kalosOpenGen ? 'region-map' : 'cartridge';
tileGrid.innerHTML = '';
// Mirrors the .shiny-mode class the desktop #dex-grid gets (see
// renderLivingDex) so the same rainbow "caught" styling that grid uses
// also applies to species chips inside an expanded gen tile here.
tileGrid.classList.toggle('shiny-mode', dexMode === 'shiny');
// While a gen is open, its immediate prev/next neighbors (by GEN_DATA
// order) are built as expanded panes too, not just collapsed+hidden -
// together with the open gen they form the 3-pane scroll-snap carousel
// swiped between in initKalosGenSwipe(). Every other tile stays a small
// hidden square, same as before.
var openIdx = kalosOpenGen ? kalosGenIndexOf(kalosOpenGen) : -1;
GEN_DATA.forEach(function(g, i) {
var genCaught = kalosGenCaughtCount(g, caught);
// An opened generation is a fixed detail view. Neighbour generations remain
// hidden until this panel is closed, so horizontal swiping cannot switch the
// person away from the map they deliberately opened.
var isPane = openIdx !== -1 && i === openIdx;
var tile = document.createElement('div');
tile.dataset.gen = g.gen;
if (isPane) {
tile.className = 'kalos-gen-tile kalos-gen-tile-expanded dex-card';
tile.innerHTML = buildKalosTileExpandedHtml(g, caught, genCaught);
applyEvoStageBoosts(tile);
} else {
tile.className = 'kalos-gen-tile';
var cartStyle = kalosCartStyleForGen(g.gen);
if (cartStyle) tile.dataset.cart = cartStyle;
tile.setAttribute('role', 'button');
tile.setAttribute('tabindex', '0');
tile.innerHTML = buildKalosTileCollapsedHtml(g, genCaught);
if (openIdx !== -1) tile.hidden = true;
}
tileGrid.appendChild(tile);
});
if (savedPanelScrollTop !== null) {
var openPanelAfter = tileGrid.querySelector('.kalos-gen-tile-expanded[data-gen="' + kalosOpenGen + '"] .dex-species-panel');
if (openPanelAfter) openPanelAfter.scrollTop = savedPanelScrollTop;
}
tileGrid.classList.toggle('kalos-gen-grid-open', !!kalosOpenGen);
buildKalosDots();
if (kalosOpenGen) {
var dots = document.getElementById('kalos-gen-dots');
if (dots) dots.hidden = true;
// innerHTML = '' above reset scrollLeft to 0 - line the open pane
// straight back up with the grid's left edge (full-bleed panes, so
// this is all it takes to center it with its neighbors just out of
// frame) with no animation, since this is a data refresh, not a
// navigation.
var openTile = tileGrid.querySelector('.kalos-gen-tile-expanded[data-gen="' + kalosOpenGen + '"]');
if (openTile) tileGrid.scrollLeft = openTile.offsetLeft;
} else {
// innerHTML = '' above just reset scrollLeft to 0 - snap the rebuilt
// track back to whichever tile was centered before this render (no
// animation, this is a data refresh, not a navigation) and refresh
// the scale/opacity of every tile from that position.
scrollKalosCarouselToIndex(kalosCarouselIndex, false);
syncKalosCarousel();
var dots2 = document.getElementById('kalos-gen-dots');
if (dots2) dots2.hidden = false;
}
// Freshly-built chips above start unfiltered - re-apply whichever of the
// mobile toolbar's Type/Form/Stage filters are currently active so a
// filter set before a catch, a gen swipe, or a jump-to-species doesn't
// get silently dropped by this rebuild.
pinKalosSpeciesPanelHeights(tileGrid);
applyDexTypeFilter();
applyDexVariantFilter();
applyDexEvoStageFilter();
applyDexAnimatedFilter();
}
// ---------- mobile Kalos dex: depth carousel ----------
// The earlier implementation relied on the browser to snap a horizontal track
// into place and then re-measured the cards. This controller adopts the supplied
// DepthCarousel model in plain JavaScript: a continuous position drives the
// depth, tilt, tint and scale of every card; GSAP eases the same position to its
// resting generation after a drag, wheel move, dot tap or adjacent-card tap.
var kalosCarouselSyncQueued = false;
var kalosDepthTween = null;
var kalosDepthDrag = null;
var kalosDepthWheelTimer = null;
var kalosDepthIgnoreClickUntil = 0;
var kalosPendingScrollLeft = null;
var kalosPointerMoveQueued = false;
// Applies the most recent drag-computed scrollLeft (see the pointermove
// handler in initKalosCarousel) and the depth layout together in one rAF
// tick, however many pointermove samples arrived since the last frame.
function applyKalosPendingScroll() {
kalosPointerMoveQueued = false;
if (kalosPendingScrollLeft === null) return;
var grid = document.getElementById('kalos-gen-grid');
if (grid) grid.scrollLeft = kalosPendingScrollLeft;
kalosPendingScrollLeft = null;
syncKalosCarousel();
}
var KALOS_DEPTH_CONFIG = {
  depth: 118,
  spread: 32,
  tilt: 10,
  visibleCards: 3,
  falloff: 0.17,
  duration: 0.62
};

// Builds the dot row underneath the carousel, one dot per generation.
function buildKalosDots() {
var dotsWrap = document.getElementById('kalos-gen-dots');
if (!dotsWrap) return;
dotsWrap.innerHTML = GEN_DATA.map(function(g, i) {
return '<button type="button" class="kalos-gen-dot' + (i === kalosCarouselIndex ? ' active' : '') +
'" data-index="' + i + '" aria-label="Go to Generation ' + g.gen + '"></button>';
}).join('');
}
function updateKalosDots(index) {
var dotsWrap = document.getElementById('kalos-gen-dots');
if (!dotsWrap) return;
Array.prototype.forEach.call(dotsWrap.querySelectorAll('.kalos-gen-dot'), function(dot, i) {
dot.classList.toggle('active', i === index);
});
}
// Hand-rolled requestAnimationFrame tween, used as a fallback for scrollLeft/
// scrollTop sliding animations whenever an animation library is unavailable.
function rafTweenValue(from, to, durationSec, onUpdate, onDone) {
var start = null;
function easeInOutCubic(t) {
return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function step(ts) {
if (start === null) start = ts;
var t = Math.min(1, (ts - start) / (durationSec * 1000));
onUpdate(from + (to - from) * easeInOutCubic(t));
if (t < 1) {
requestAnimationFrame(step);
} else if (onDone) {
onDone();
}
}
requestAnimationFrame(step);
}
function kalosReducedMotion() {
return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function stopKalosDepthMotion() {
// Motion playback controls use stop(); the previous GSAP controller used
// kill(). Support both so an interrupted swipe always starts from the exact
// scroll position currently visible on screen.
if (kalosDepthTween) {
if (kalosDepthTween.stop) kalosDepthTween.stop();
else if (kalosDepthTween.kill) kalosDepthTween.kill();
}
kalosDepthTween = null;
if (kalosDepthWheelTimer) clearTimeout(kalosDepthWheelTimer);
kalosDepthWheelTimer = null;
// Drop any drag-sample scrollLeft still waiting for its rAF tick, so a stray
// pre-release touch sample can't overwrite the position a tween/jump is
// about to set.
kalosPendingScrollLeft = null;
}
function kalosCarouselTargetForIndex(index) {
var grid = document.getElementById('kalos-gen-grid');
if (!grid) return null;
var tile = grid.children[index];
if (!tile) return null;
var maxScroll = Math.max(0, grid.scrollWidth - grid.clientWidth);
var target = tile.offsetLeft - (grid.clientWidth - tile.clientWidth) / 2;
return Math.max(0, Math.min(maxScroll, target));
}
// Converts the physical scroll position into the carousel's continuous logical
// position. It uses real per-card targets rather than a fixed card width, which
// keeps the motion smooth even though the cartridge silhouettes vary in width.
function kalosCarouselPositionFromScroll(grid, scrollLeft) {
var count = grid.children.length;
if (!count) return 0;
var first = kalosCarouselTargetForIndex(0);
if (first === null || scrollLeft <= first) return 0;
var last = kalosCarouselTargetForIndex(count - 1);
if (last === null || scrollLeft >= last) return count - 1;
for (var i = 0; i < count - 1; i++) {
var a = kalosCarouselTargetForIndex(i);
var b = kalosCarouselTargetForIndex(i + 1);
if (a === null || b === null) continue;
if (scrollLeft >= a && scrollLeft <= b) {
var span = Math.max(1, b - a);
return i + (scrollLeft - a) / span;
}
}
return Math.max(0, Math.min(count - 1, Math.round(scrollLeft / Math.max(1, grid.clientWidth * 0.7))));
}
function kalosCarouselIndexForScroll(grid, scrollLeft) {
return Math.max(0, Math.min(grid.children.length - 1, Math.round(kalosCarouselPositionFromScroll(grid, scrollLeft))));
}
// Applies the supplied DepthCarousel's perspective treatment to the existing
// cartridge tiles. The central card stays crisp and frontmost; neighbours step
// backward in Z-space, fan outward and darken as they recede.
//
// iOS Safari note: this used to also grow a `blur()` filter on receding
// tiles. WebKit renders `filter` on elements sitting inside a
// `transform-style: preserve-3d` / `perspective` context (which this rail
// needs for the fan-out) off the compositor, so every one of those blurred
// tiles was being *repainted on the CPU* on every single rAF tick of a drag -
// the actual source of the stutter on iPhone. Depth is still communicated by
// scale + darkening + opacity alone (all fully compositor-driven), and tiles
// far enough away to be functionally invisible now skip style writes and
// pointer-event checks entirely instead of still being pushed through the
// transform/opacity/z-index pipeline every frame.
function layoutKalosDepthCarousel(position) {
var grid = document.getElementById('kalos-gen-grid');
if (!grid || kalosOpenGen) return;
var tiles = grid.children;
if (!tiles.length) return;
var cfg = KALOS_DEPTH_CONFIG;
for (var i = 0; i < tiles.length; i++) {
var tile = tiles[i];
// This matches the supplied DepthCarousel rail: the selected generation
// sits at the front, while later generations fan out to the right and
// recede into the screen. A previous generation can briefly ghost in while
// the position is fractional, then fades rather than competing with the
// forward stack.
var d = i - position;
var back = Math.max(0, d);
var distance = Math.abs(d);
var shown = distance <= cfg.visibleCards + 0.55;
if (!shown) {
// Already fully faded out and off to the side - cheapest possible state,
// and skipping the writes below means far-off tiles cost nothing per frame.
if (tile.dataset.kalosShown === '0') continue;
tile.dataset.kalosShown = '0';
tile.style.opacity = '0';
tile.style.pointerEvents = 'none';
continue;
}
tile.dataset.kalosShown = '1';
var side = d * cfg.spread;
var z = -cfg.depth * d;
var rotate = cfg.tilt * Math.max(0, Math.min(d, 1));
var scale = Math.max(0.82, 1 - back * 0.045);
var opacity = d < 0 ? Math.max(0, 1 + d) : 1;
var brightness = Math.max(0.42, 1 - back * cfg.falloff);
tile.style.transform = 'translate3d(' + side.toFixed(2) + 'px, 0, ' + z.toFixed(2) + 'px) rotateY(' + rotate.toFixed(2) + 'deg) scale(' + scale.toFixed(3) + ')';
tile.style.opacity = opacity.toFixed(3);
tile.style.filter = 'brightness(' + brightness.toFixed(3) + ')';
tile.style.zIndex = String(2000 - Math.round(d * 20));
tile.style.pointerEvents = opacity > 0.05 ? 'auto' : 'none';
}
var nearest = Math.max(0, Math.min(tiles.length - 1, Math.round(position)));
if (nearest !== kalosCarouselIndex) {
kalosCarouselIndex = nearest;
updateKalosDots(nearest);
}
}
function syncKalosCarousel() {
kalosCarouselSyncQueued = false;
var grid = document.getElementById('kalos-gen-grid');
if (!grid || kalosOpenGen) return;
layoutKalosDepthCarousel(kalosCarouselPositionFromScroll(grid, grid.scrollLeft));
}
function queueKalosCarouselSync() {
if (kalosCarouselSyncQueued) return;
kalosCarouselSyncQueued = true;
requestAnimationFrame(syncKalosCarousel);
}
function tweenKalosCarouselTo(target, animate) {
var grid = document.getElementById('kalos-gen-grid');
if (!grid) return;
stopKalosDepthMotion();
if (!animate || kalosReducedMotion()) {
grid.scrollLeft = target;
syncKalosCarousel();
return;
}
if (window.Motion && window.Motion.animate) {
// Motion animates the numeric scroll value while the grid itself remains the
// source of truth for native touch dragging and scroll measurements. A short,
// no-bounce spring preserves momentum without the elastic overshoot that can
// make the depth cards momentarily stack over one another.
var motionControl = window.Motion.animate(grid.scrollLeft, target, {
type: 'spring',
visualDuration: 0.42,
bounce: 0,
onUpdate: function(value) {
grid.scrollLeft = value;
queueKalosCarouselSync();
}
});
kalosDepthTween = motionControl;
motionControl.then(function() {
if (kalosDepthTween !== motionControl) return;
kalosDepthTween = null;
syncKalosCarousel();
});
} else {
rafTweenValue(grid.scrollLeft, target, KALOS_DEPTH_CONFIG.duration, function(value) {
grid.scrollLeft = value;
queueKalosCarouselSync();
}, function() {
syncKalosCarousel();
});
}
}
// Public helper used by dots, keyboard activation and a tap on a peeking card.
function scrollKalosCarouselToIndex(index, smooth) {
var grid = document.getElementById('kalos-gen-grid');
if (!grid) return;
var safeIndex = Math.max(0, Math.min(grid.children.length - 1, index));
var target = kalosCarouselTargetForIndex(safeIndex);
if (target === null) return;
tweenKalosCarouselTo(target, smooth);
}
function nearestKalosCarouselIndex(grid, velocityX) {
var projected = grid.scrollLeft - velocityX * 220;
var maxScroll = Math.max(0, grid.scrollWidth - grid.clientWidth);
projected = Math.max(0, Math.min(maxScroll, projected));
return kalosCarouselIndexForScroll(grid, projected);
}
function consumeKalosDepthDragClick() {
if (Date.now() < kalosDepthIgnoreClickUntil) {
kalosDepthIgnoreClickUntil = 0;
return true;
}
return false;
}
function initKalosCarousel() {
var grid = document.getElementById('kalos-gen-grid');
var dotsWrap = document.getElementById('kalos-gen-dots');
if (!grid) return;
grid.classList.add('kalos-depth-ready');
grid.addEventListener('scroll', queueKalosCarouselSync, { passive: true });
window.addEventListener('resize', queueKalosCarouselSync);
if (dotsWrap) {
dotsWrap.addEventListener('click', function(e) {
var dot = e.target.closest('.kalos-gen-dot');
if (!dot) return;
scrollKalosCarouselToIndex(parseInt(dot.dataset.index, 10), true);
});
}
grid.addEventListener('wheel', function(e) {
if (kalosOpenGen || grid.children.length < 2) return;
var raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
if (!raw) return;
e.preventDefault();
stopKalosDepthMotion();
var delta = e.deltaMode === 1 ? raw * 24 : raw;
var maxScroll = Math.max(0, grid.scrollWidth - grid.clientWidth);
grid.scrollLeft = Math.max(0, Math.min(maxScroll, grid.scrollLeft + delta));
queueKalosCarouselSync();
kalosDepthWheelTimer = setTimeout(function() {
scrollKalosCarouselToIndex(nearestKalosCarouselIndex(grid, 0), true);
}, 120);
}, { passive: false });
// Mobile gesture policy: do not assume that a touch beginning on a card
// belongs to the carousel. The first few pixels choose an axis; a vertical
// gesture is handed straight back to the page, while a horizontal gesture is
// captured and drives the continuous depth layout below.
var KALOS_SWIPE_AXIS_THRESHOLD = 6;
grid.addEventListener('pointerdown', function(e) {
if (kalosOpenGen || grid.children.length < 2 || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
stopKalosDepthMotion();
kalosDepthDrag = {
id: e.pointerId,
startX: e.clientX,
startY: e.clientY,
startScroll: grid.scrollLeft,
startIndex: kalosCarouselIndexForScroll(grid, grid.scrollLeft),
lastX: e.clientX,
lastTime: performance.now(),
velocityX: 0,
axis: null,
moved: false
};
});
grid.addEventListener('pointermove', function(e) {
var drag = kalosDepthDrag;
if (!drag || drag.id !== e.pointerId || kalosOpenGen) return;
var dx = e.clientX - drag.startX;
var dy = e.clientY - drag.startY;
if (!drag.axis) {
if (Math.abs(dx) < KALOS_SWIPE_AXIS_THRESHOLD && Math.abs(dy) < KALOS_SWIPE_AXIS_THRESHOLD) return;
drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
if (drag.axis === 'y') return;
drag.moved = true;
grid.classList.add('is-dragging');
grid.setPointerCapture(e.pointerId);
}
if (drag.axis !== 'x') return;
// touch-action: pan-y lets the browser keep vertical page scrolling, while
// this cancellation keeps a horizontal swipe entirely under carousel control.
e.preventDefault();
var now = performance.now();
var dt = Math.max(now - drag.lastTime, 1);
// A single pointermove sample's instantaneous speed can spike wildly on
// iPhone (very small dt between samples turns even a few px of jitter
// into a huge px/ms figure), which - fed into nearestKalosCarouselIndex's
// velocity projection - was flinging the carousel several cards past
// where a normal one-card swipe should land. Smoothing it into a running
// average instead of using the raw last-sample value keeps the release
// velocity representative of the whole gesture, not just its final tick.
var instantVelocityX = (e.clientX - drag.lastX) / dt;
drag.velocityX = drag.velocityX * 0.7 + instantVelocityX * 0.3;
drag.lastX = e.clientX;
drag.lastTime = now;
var maxScroll = Math.max(0, grid.scrollWidth - grid.clientWidth);
// iOS delivers pointermove samples faster than the display can paint (often
// well above 60/sec), so writing `scrollLeft` straight from every sample -
// each write immediately followed by the depth layout's own layout reads -
// was forcing far more synchronous layout work per second than the screen
// could ever show. Only the arithmetic runs here now; the actual scrollLeft
// write plus the depth-layout pass are coalesced onto a single rAF tick
// below, one per real frame no matter how many touch samples land inside it.
kalosPendingScrollLeft = Math.max(0, Math.min(maxScroll, drag.startScroll - dx));
if (!kalosPointerMoveQueued) {
kalosPointerMoveQueued = true;
requestAnimationFrame(applyKalosPendingScroll);
}
}, { passive: false });
function finishDepthDrag(e) {
var drag = kalosDepthDrag;
if (!drag || (e && drag.id !== e.pointerId)) return;
// Make sure grid.scrollLeft reflects the very last drag sample (it may not
// have hit its rAF tick yet) before reading it below to decide the release
// target - otherwise a fast release right after a pointermove could compute
// the flung index off a one-frame-stale position.
if (kalosPendingScrollLeft !== null) {
grid.scrollLeft = kalosPendingScrollLeft;
kalosPendingScrollLeft = null;
}
kalosDepthDrag = null;
grid.classList.remove('is-dragging');
if (!drag.moved || drag.axis !== 'x' || kalosOpenGen) return;
kalosDepthIgnoreClickUntil = Date.now() + 360;
// However fast the flick, a single swipe should only ever advance one
// card - it's a row of gen boxes to page through deliberately, not a
// long inertial scroller. nearestKalosCarouselIndex's velocity-projected
// landing spot is still used to decide *which* neighbor (or whether to
// snap back to the start card), just clamped to a one-card step.
var flungIndex = nearestKalosCarouselIndex(grid, drag.velocityX);
var target = Math.max(drag.startIndex - 1, Math.min(drag.startIndex + 1, flungIndex));
scrollKalosCarouselToIndex(target, true);
}
grid.addEventListener('pointerup', finishDepthDrag, { passive: true });
grid.addEventListener('pointercancel', finishDepthDrag, { passive: true });
grid.addEventListener('lostpointercapture', finishDepthDrag, { passive: true });
syncKalosCarousel();
}
function kalosCurrentCaughtMap() {
return (dexMode === 'shiny') ?
Object.assign({}, shinyCaughtSet(), state.livingDexShiny) :
state.livingDex;
}
// Animates an element's own transition from looking like `first` (its
// pre-change box) to its actual current box, via a transform FLIP: since
// the element has already been changed to its final DOM state (grid-column,
// content, etc.) by the time this runs, `last` is measured live, and we
// fake the "still small/still big" starting look with translate+scale,
// then release it to transform:none - so the element visibly grows or
// shrinks exactly where it already, correctly, sits in the grid, instead
// of flying to some other fixed position.
// `onDone`, if given, fires once the grow/shrink has visibly settled -
// used to chain the species-chip stagger (see staggerChipsIn below) so
// chips don't start revealing until the box itself has actually arrived.
function flipAnimate(el, first, onDone) {
var last = el.getBoundingClientRect();
var dx = first.left - last.left;
var dy = first.top - last.top;
var sx = first.width / last.width;
var sy = first.height / last.height;
function cleanup() {
el.style.transformOrigin = '';
el.style.transform = '';
if (onDone) onDone();
}
el.style.transformOrigin = 'top left';
if (window.Motion && window.Motion.animate) {
// A bounce:0 spring instead of the earlier stiffness/damping pairing:
// that combo (300/26) was underdamped, so x/y/scaleX/scaleY - four
// separate spring sims - each overshot and settled at very slightly
// different moments, reading as a wobble/skew rather than a clean
// grow. bounce:0 keeps the natural spring deceleration (still softer
// than a cubic-bezier cutoff) but removes the overshoot entirely, so
// all four channels arrive together and the box just eases into place.
window.Motion.animate(el, {
x: [dx, 0],
y: [dy, 0],
scaleX: [sx, 1],
scaleY: [sy, 1]
}, {
type: 'spring',
bounce: 0,
duration: 0.45
}).finished.then(cleanup);
} else {
el.style.transition = 'none';
el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')';
el.getBoundingClientRect(); // force reflow so the starting transform is committed
requestAnimationFrame(function() {
el.style.transition = 'transform 0.4s cubic-bezier(.65,0,.35,1)';
el.style.transform = 'none';
});
el.addEventListener('transitionend', function onEnd(e) {
if (e && e.target !== el) return;
el.removeEventListener('transitionend', onEnd);
el.style.transition = '';
cleanup();
});
}
}
// Immediately zeroes out every species chip inside `container` (no
// motion yet) right as a gen box starts opening, so staggerChipsIn()
// below has something to reveal from instead of the chips just already
// being visible the moment the box/panel finishes opening around them.
// No-op without Motion - chips stay visible as before.
function hideChipsForStagger(container) {
if (!window.Motion || !window.Motion.animate || !container) return;
var chips = container.querySelectorAll('.dex-chip');
Array.prototype.forEach.call(chips, function(chip) {
chip.style.opacity = '0';
});
}
// Fades + nudges each species chip up into place with a small stagger
// between them, once the box around them has finished growing - turns
// the chip grid from "all chips pop in on the same frame" into a short
// cascade. Pairs with hideChipsForStagger() above; no-op without Motion.
function staggerChipsIn(container) {
if (!window.Motion || !window.Motion.animate || !container) return;
var chips = container.querySelectorAll('.dex-chip');
if (!chips.length) return;
window.Motion.animate(
chips,
{ opacity: [0, 1], y: [6, 0] },
{ duration: 0.22, ease: 'easeOut', delay: window.Motion.stagger(0.02, { startDelay: 0.05 }) }
).finished.then(function() {
Array.prototype.forEach.call(chips, function(chip) {
chip.style.opacity = '';
chip.style.transform = '';
});
});
}
// Expands the tiles immediately before/after `tile` (already adjacent in
// GEN_DATA order, so they're already the right neighbors) into their own
// full detail panes flanking it, and hides every other tile - turning the
// grid into the 3-pane scroll-snap window that initKalosGenSwipe() below
// scrolls between. A gen with nothing on one side (Kanto has no gen
// before it, Gen 9 none after) just doesn't get a pane there, so
// scrolling that direction has nowhere to go.
function buildKalosNeighborPanes(tile, grid, caught) {
var prev = tile.previousElementSibling, next = tile.nextElementSibling;
Array.prototype.forEach.call(grid.children, function(t) {
t.hidden = (t !== tile && t !== prev && t !== next);
});
[prev, next].forEach(function(sib) {
if (!sib || sib.hidden) return;
var g = GEN_DATA.filter(function(x) {
return String(x.gen) === sib.dataset.gen;
})[0];
if (!g) return;
sib.className = 'kalos-gen-tile kalos-gen-tile-expanded dex-card';
sib.removeAttribute('role');
sib.removeAttribute('tabindex');
sib.style.transform = '';
sib.style.opacity = '';
sib.innerHTML = buildKalosTileExpandedHtml(g, caught, kalosGenCaughtCount(g, caught));
applyEvoStageBoosts(sib);
});
// Full-bleed panes (flex: 0 0 100%) sit end-to-end, so lining the open
// gen's left edge up with the grid's is all it takes to center it with
// its neighbors just out of frame - no animation, this is state setup.
grid.scrollLeft = tile.offsetLeft;
}
// All the other squares disappear the instant one is tapped, and that
// tile grows into the banner right where it was sitting in the grid.
function expandKalosTile(tile) {
var gen = tile.dataset.gen;
var g = GEN_DATA.filter(function(x) {
return String(x.gen) === String(gen);
})[0];
if (!g) return;
stopKalosDepthMotion();
var first = tile.getBoundingClientRect();
var grid = tile.parentNode;
kalosCarouselIndex = Array.prototype.indexOf.call(grid.children, tile);
kalosOpenGen = gen;
grid.classList.add('kalos-gen-grid-open');
// Expansion changes from a console cartridge into the shared region-map frame.
// Set this state immediately; waiting for a later render left the first open
// frame constrained by the closed DS/GBA/3DS/Switch dimensions.
grid.dataset.openPresentation = 'region-map';
var dots = document.getElementById('kalos-gen-dots');
if (dots) dots.hidden = true;
var caught = kalosCurrentCaughtMap();
tile.className = 'kalos-gen-tile kalos-gen-tile-expanded dex-card';
tile.removeAttribute('data-cart');
tile.removeAttribute('role');
tile.removeAttribute('tabindex');
// Clear whatever scale/opacity syncKalosCarousel() left inline on this
// tile from its carousel life - flipAnimate() below sets its own
// transform to drive the grow animation, so a leftover scale here would
// make it grow from the wrong size.
tile.style.transform = '';
tile.style.opacity = '';
tile.innerHTML = buildKalosTileExpandedHtml(g, caught, kalosGenCaughtCount(g, caught));
// Opened panels no longer swipe between generations. Keep only the selected
// full-width map panel in the rail so it owns every available pixel.
Array.prototype.forEach.call(grid.children, function(sibling) {
	sibling.hidden = sibling !== tile;
});
grid.scrollLeft = tile.offsetLeft;
hideChipsForStagger(tile);
applyEvoStageBoosts(tile);
flipAnimate(tile, first, function() { staggerChipsIn(tile); });
// Same reason as the end of renderKalosMobileDex: this path builds fresh
// chips directly (tile + its neighbor panes) without going through that
// function, so any active Type/Form/Stage filter needs re-applying here
// too or it'd silently drop the moment someone taps a tile open.
pinKalosSpeciesPanelHeights(grid);
applyDexTypeFilter();
applyDexVariantFilter();
applyDexEvoStageFilter();
applyDexAnimatedFilter();
}
// Collapses the currently-expanded tile back down into its own square and
// brings the other squares back.
function collapseKalosTile() {
var grid = document.getElementById('kalos-gen-grid');
if (!grid) {
kalosOpenGen = null;
return;
}
var tile = grid.querySelector('.kalos-gen-tile-expanded[data-gen="' + kalosOpenGen + '"]');
if (!tile) {
kalosOpenGen = null;
return;
}
var g = GEN_DATA.filter(function(x) {
return String(x.gen) === String(kalosOpenGen);
})[0];
var first = tile.getBoundingClientRect();
var caught = kalosCurrentCaughtMap();
kalosOpenGen = null;
grid.dataset.openPresentation = 'cartridge';
// Revert the flanking prev/next panes (see buildKalosNeighborPanes)
// back to their small collapsed squares too - they were only ever
// borrowed from the grid for the swipe, not actually "open".
Array.prototype.forEach.call(grid.querySelectorAll('.kalos-gen-tile-expanded'), function(t) {
if (t === tile) return;
var gg = GEN_DATA.filter(function(x) {
return String(x.gen) === t.dataset.gen;
})[0];
if (!gg) return;
t.className = 'kalos-gen-tile';
t.setAttribute('role', 'button');
t.setAttribute('tabindex', '0');
t.innerHTML = buildKalosTileCollapsedHtml(gg, kalosGenCaughtCount(gg, caught));
});
if (g) {
var genCaught = kalosGenCaughtCount(g, caught);
tile.className = 'kalos-gen-tile';
tile.setAttribute('role', 'button');
tile.setAttribute('tabindex', '0');
tile.innerHTML = buildKalosTileCollapsedHtml(g, genCaught);
var cartStyle = kalosCartStyleForGen(g.gen);
if (cartStyle) tile.dataset.cart = cartStyle;
}
Array.prototype.forEach.call(grid.children, function(t) {
t.hidden = false;
});
grid.classList.remove('kalos-gen-grid-open');
// The tile that was expanded is still the one that should be centered -
// snap the track back to it (no animation; this is a state restore, not
// a navigation) before re-measuring everyone's scale/opacity.
scrollKalosCarouselToIndex(kalosCarouselIndex, false);
syncKalosCarousel();
var dots = document.getElementById('kalos-gen-dots');
if (dots) dots.hidden = false;
flipAnimate(tile, first);
}
// Commits a swipe between open gen panes: switches kalosOpenGen to
// whichever gen the person scrolled onto and does a normal re-render,
// which rebuilds the 3-pane window centered on the new gen (see
// renderKalosMobileDex/buildKalosNeighborPanes). Called only once a
// scroll has actually settled on a neighbor pane, so this just hands off
// from that pane's brief life as a swiped-to neighbor to the grid's
// normal managed state.
function finalizeKalosGenSwitch(genNum) {
kalosOpenGen = String(genNum);
kalosCarouselIndex = kalosGenIndexOf(kalosOpenGen);
renderKalosMobileDex(kalosCurrentCaughtMap());
}
// ---------- swipe between open gen tiles ----------
// While a gen tile is expanded, the grid holds it plus its immediate
// prev/next neighbors (buildKalosNeighborPanes) as full-bleed scroll-snap
// panes. Touches on the banner/header above the species panel are left
// completely alone - plain native horizontal scrolling, same mechanism
// as the collapsed peek carousel (initKalosCarousel), works fine there
// since nothing else in that area wants the touch.
//
// The species panel itself is different: it's a genuinely two-axis area
// now (vertical to scroll the chip list, horizontal to swipe gens), and
// two earlier attempts at this both broke because *something native* was
// still allowed to move its scroll position at the same time our own
// code was also trying to: first the panel's own vertical auto-scroll
// competing with our horizontal drag, then (once we locked the panel to
// pan-y) the banner's native scroll racing our hand-driven scrollLeft
// whenever a gesture crossed from one into the other.
//
// So the panel's touch-action is now `none` (see style.css) - the
// browser does nothing on its own for touches starting there, full stop.
// initKalosGenSwipe() below is the only thing moving anything for those
// touches: it reads the first bit of movement to decide horizontal vs.
// vertical, then drives either grid.scrollLeft (gen swipe) or the
// panel's own scrollTop (chip list) by hand for the rest of that
// gesture, with a little momentum on release for the vertical case since
// touch-action: none also switches off the panel's native scroll
// momentum/inertia.
var kalosGenScrollSettleTimer = null;
var kalosGenVelocityX = 0; // px/ms left behind by a manual horizontal drag's last move, consumed once by the very next settle
function scheduleKalosGenScrollSettle() {
if (!kalosOpenGen) return;
if (kalosGenScrollSettleTimer) clearTimeout(kalosGenScrollSettleTimer);
kalosGenScrollSettleTimer = setTimeout(settleKalosGenScroll, 90);
}
// Once the person stops scrolling, finds whichever open-gen pane should
// end up centered and animates the rest of the way there with Motion,
// then commits the gen switch (if any) once that slide has visibly
// landed. Always plays the slide - even a release that's already very
// close to its resting spot gets a quick eased finish - rather than
// only stepping in on a "missed" snap, which is what made fast swipes
// look like they just clipped straight to the next gen instead of
// sliding into it.
function settleKalosGenScroll() {
var grid = document.getElementById('kalos-gen-grid');
if (!grid || !kalosOpenGen) return;
var panes = Array.prototype.filter.call(grid.children, function(t) {
return !t.hidden;
});
if (panes.length < 2) return;
var closest = null;
// A fast flick commits to the neighbor in that direction even if the
// finger only travelled a short distance - same "short flick still
// counts" idea as the Active Hunts/Shiny Log tab swipe (COMMIT_VELOCITY
// there). Without this, a quick flick that didn't get far would just
// fall back to "nearest by position" below and slide backward to where
// it started, which reads as ignoring the flick entirely.
var COMMIT_VELOCITY = 0.5; // px/ms
if (Math.abs(kalosGenVelocityX) > COMMIT_VELOCITY) {
var openIdx = -1;
panes.forEach(function(t, i) { if (t.dataset.gen === String(kalosOpenGen)) openIdx = i; });
// Negative velocityX = finger moving left = scrollLeft increasing =
// advancing to the neighbor further along in DOM order (next gen).
if (kalosGenVelocityX < 0) closest = panes[openIdx + 1] || null;
else closest = panes[openIdx - 1] || null;
}
kalosGenVelocityX = 0; // consumed - don't let it leak into an unrelated later settle
if (!closest) {
// No strong flick (or nothing that way to flick to) - fall back to
// whichever pane is nearest the grid's center right now.
var gridRect = grid.getBoundingClientRect();
var center = gridRect.left + gridRect.width / 2;
var closestDist = Infinity;
panes.forEach(function(t) {
var r = t.getBoundingClientRect();
var dist = Math.abs((r.left + r.width / 2) - center);
if (dist < closestDist) { closestDist = dist; closest = t; }
});
}
if (!closest) return;
var target = closest.offsetLeft - (grid.clientWidth - closest.clientWidth) / 2;
var landedOnNeighbor = closest.dataset.gen !== String(kalosOpenGen);
function commit() {
if (landedOnNeighbor) finalizeKalosGenSwitch(closest.dataset.gen);
}
if (Math.abs(grid.scrollLeft - target) <= 1) {
grid.scrollLeft = target;
commit();
} else if (window.Motion && window.Motion.animate) {
window.Motion.animate(grid.scrollLeft, target, {
duration: 0.32,
ease: [0.65, 0, 0.35, 1],
onUpdate: function(v) { grid.scrollLeft = v; }
}).finished.then(commit);
} else {
rafTweenValue(grid.scrollLeft, target, 0.32, function(v) { grid.scrollLeft = v; }, commit);
}
}
function initKalosGenSwipe() {
var grid = document.getElementById('kalos-gen-grid');
if (!grid) return;
// Expanded generations are fixed map panels, not a second carousel. Closed
// generations still use initKalosCarousel() and retain their normal swipe.
return;
grid.addEventListener('scroll', scheduleKalosGenScrollSettle, { passive: true });

var DIRECTION_THRESHOLD = 8; // px moved before we decide horizontal vs vertical
var MOMENTUM_MULTIPLIER = 120; // projects release velocity (px/ms) into a fling distance
var startX = 0, startY = 0, lastX = 0, lastY = 0, lastT = 0;
var velocityX = 0, velocityY = 0; // px/ms, smoothed over the last couple of samples
var startScrollLeft = 0, startScrollTop = 0;
var panel = null; // the .dex-species-panel this gesture started on, if any
var decided = false; // have we classified this gesture yet?
var axis = null; // 'x' (gen swipe) or 'y' (chip list scroll) once decided

function onStart(e) {
if (!kalosOpenGen) return;
if (e.touches.length !== 1) return;
panel = e.target.closest('.dex-species-panel');
if (!panel) return; // touch started on the banner/header - leave it to native scrolling
var t = e.touches[0];
startX = lastX = t.clientX;
startY = lastY = t.clientY;
lastT = e.timeStamp;
velocityX = 0;
velocityY = 0;
startScrollLeft = grid.scrollLeft;
startScrollTop = panel.scrollTop;
decided = false;
axis = null;
}

function onMove(e) {
if (!panel) return;
if (e.touches.length !== 1) return;
var t = e.touches[0];
var dx = t.clientX - startX;
var dy = t.clientY - startY;
if (!decided) {
if (Math.abs(dx) < DIRECTION_THRESHOLD && Math.abs(dy) < DIRECTION_THRESHOLD) return;
decided = true;
axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}
e.preventDefault(); // touch-action: none on the panel means nothing native to fight here
var dt = e.timeStamp - lastT;
if (axis === 'x') {
grid.scrollLeft = startScrollLeft - dx;
if (dt > 0) velocityX = (t.clientX - lastX) / dt;
} else {
var maxScrollTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
panel.scrollTop = Math.max(0, Math.min(maxScrollTop, startScrollTop - dy));
if (dt > 0) velocityY = (t.clientY - lastY) / dt;
}
lastX = t.clientX;
lastY = t.clientY;
lastT = e.timeStamp;
}

// Simple deceleration for the chip list's vertical fling, since
// touch-action: none also switched off the panel's native scroll
// momentum - without this, releasing mid-flick would just stop dead
// instead of coasting the way native scrolling (and every other
// scrollable area in the app) does.
function flingPanel(p, velocity) {
var maxScrollTop = Math.max(0, p.scrollHeight - p.clientHeight);
var target = p.scrollTop - velocity * MOMENTUM_MULTIPLIER;
target = Math.max(0, Math.min(maxScrollTop, target));
if (Math.abs(target - p.scrollTop) < 4) return;
if (window.Motion && window.Motion.animate) {
window.Motion.animate(p.scrollTop, target, {
duration: 0.5,
ease: 'easeOut',
onUpdate: function(v) { p.scrollTop = v; }
});
} else {
rafTweenValue(p.scrollTop, target, 0.5, function(v) { p.scrollTop = v; });
}
}

function onEnd() {
if (decided && axis === 'x') {
kalosGenVelocityX = velocityX;
if (kalosGenScrollSettleTimer) clearTimeout(kalosGenScrollSettleTimer);
settleKalosGenScroll();
} else if (decided && axis === 'y' && panel) {
flingPanel(panel, velocityY);
}
panel = null;
decided = false;
axis = null;
}

grid.addEventListener('touchstart', onStart, { passive: true });
grid.addEventListener('touchmove', onMove, { passive: false });
grid.addEventListener('touchend', onEnd, { passive: true });
grid.addEventListener('touchcancel', onEnd, { passive: true });
}
// Shared by both the desktop #dex-grid and mobile #kalos-gen-grid click
// handlers below: flips one species chip's caught state, saves, and
// updates just that chip + the counters in place.
function toggleDexChip(chip, allowResort) {
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
chip.classList.toggle('caught', nowCaught);
updateChipA11y(chip, nowCaught);
if (nowCaught) animateCatchReveal(chip);
updateDexCounters();
if (allowResort && dexSortMode === 'uncaught') resortDexGrid();
}
// Cause-agnostic fix for "tapping a sprite yanks the whole page back to
// the top" on iOS Safari, in two layers:
//
// 1) Species chips are role="button" tabindex="0" divs (see
// buildDexChipsHtml) so they're natively focusable, and tapping one
// focuses it. iOS Safari's auto-scroll-into-view for a newly focused
// element is what's yanking the page - so the most direct fix is to
// immediately blur the chip the instant it's focused, before that
// scroll has a chance to actually happen. focusin (unlike focus)
// bubbles, so this is delegated from the grid rather than attached to
// every chip.
//
// 2) As a safety net in case the blur doesn't win the race (or iOS
// still applies its own scroll animation over several frames rather
// than instantly), restoreScrollAfter below also records the scroll
// position and keeps forcing it back for half a second after the tap,
// rather than checking just once or twice.
function restoreScrollAfter(fn) {
var y = window.scrollY;
fn();
var deadline = Date.now() + 500;
function correct() {
if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y);
if (Date.now() < deadline) requestAnimationFrame(correct);
}
requestAnimationFrame(correct);
}
function preventChipFocusScroll(grid) {
grid.addEventListener('focusin', function(e) {
// Only blur focus that came from a tap/click, not from Tab-ing in
// with a keyboard - otherwise keyboard users could never keep focus
// on a chip long enough to hit Enter/Space and toggle it.
if (dexUsingKeyboard) return;
var chip = e.target.closest('[data-action="toggle-species"]');
if (chip) chip.blur();
});
}
// Heuristic for the keyboard-vs-pointer check above: any Tab press means
// the person is navigating by keyboard right now; any touch/mouse down
// means they're back to pointing/tapping.
var dexUsingKeyboard = false;
document.addEventListener('keydown', function(e) {
if (e.key === 'Tab') dexUsingKeyboard = true;
}, true);
document.addEventListener('mousedown', function() {
dexUsingKeyboard = false;
}, true);
document.addEventListener('touchstart', function() {
dexUsingKeyboard = false;
}, true);
(function() {
var kalosGrid = document.getElementById('kalos-gen-grid');
if (kalosGrid) {
preventChipFocusScroll(kalosGrid);
kalosGrid.addEventListener('click', function(e) {
if (consumeKalosDepthDragClick()) {
e.preventDefault();
e.stopPropagation();
return;
}
var chip = e.target.closest('[data-action="toggle-species"]');
if (chip) {
if (dex3DMode) {
open3DModelModal(chip.dataset.display, chip.dataset.dexnum, dexMode === 'shiny', chip.dataset.variant);
return;
}
restoreScrollAfter(function() {
toggleDexChip(chip, false);
});
return;
}
// Tapping the banner (the photo/header area of the opened gen, not
// the species chips) collapses it back into its square - the back
// button lives inside that same banner, so its clicks bubble up here
// too and don't need their own separate handler.
var banner = e.target.closest('.kalos-gen-detail-banner');
if (banner) {
collapseKalosTile();
return;
}
var tile = e.target.closest('.kalos-gen-tile');
if (tile && !tile.classList.contains('kalos-gen-tile-expanded')) {
var idx = Array.prototype.indexOf.call(kalosGrid.children, tile);
if (idx === kalosCarouselIndex) {
expandKalosTile(tile);
} else {
scrollKalosCarouselToIndex(idx, true);
}
}
});
kalosGrid.addEventListener('keydown', function(e) {
if (e.key !== 'Enter' && e.key !== ' ') return;
// Species chips are now real role="button" tabindex="0" elements (see
// buildDexChipsHtml) - Enter/Space needs to trigger the same toggle the
// click handler above does, since a native click event never fires from
// the keyboard on a <div>.
var chip = e.target.closest('[data-action="toggle-species"]');
if (chip) {
e.preventDefault();
chip.click();
return;
}
var tile = e.target.closest('.kalos-gen-tile');
if (tile && !tile.classList.contains('kalos-gen-tile-expanded')) {
e.preventDefault();
var idx = Array.prototype.indexOf.call(kalosGrid.children, tile);
if (idx === kalosCarouselIndex) {
expandKalosTile(tile);
} else {
scrollKalosCarouselToIndex(idx, true);
}
}
});
initKalosCarousel();
initKalosGenSwipe();
}
// The two shell halves (plus the corner lens button) all toggle the same
// open/closed state - tapping any of them opens the closed shell, and
// tapping again closes it back up. No shell-swing/height-grow choreography
// any more: opening just flips data-open and lets the plain CSS transition
// on .kalos-screen-wrap's max-height (see CSS-KALOS-MOBILE in style.css)
// and .kalos-screen-content's own opacity transition handle the reveal,
// while .kalos-lens-corner-beam-fx fades in alongside it (CSS-KALOS-LENS-BEAM
// in style.css) so the screen reads as being projected from the corner lens
// rather than the case physically opening.
var kalosDex = document.getElementById('kalos-dex');
var kalosTop = document.getElementById('kalos-top');
var kalosBottom = document.getElementById('kalos-bottom');
var kalosLensCorner = document.getElementById('kalos-lens-corner');
var kalosScreenWrap = document.getElementById('kalos-screen-wrap');

if (kalosDex && kalosTop && kalosBottom && kalosScreenWrap) {
var kalosScreenContent = kalosScreenWrap.querySelector('.kalos-screen-content');
// The shell "opening" is really just .kalos-screen-wrap growing from 0
// height to its content's natural height, which pushes .kalos-bottom
// down as it grows (see the CSS-KALOS-MOBILE comment in style.css) -
// but that growth used to happen in a single instant frame (no
// transition on max-height any more, see that same comment), which is
// what read as a sudden pop open/shut. This animates the actual height
// with Motion instead, measuring the wrap's natural open height first
// since data-open flips every dependent CSS rule (aspect-ratio, the
// shell-half sizing, the max-height cap) straight to its resting value
// the instant it's set - so for closing in particular, that flip is
// held off until the collapse animation has actually finished, or the
// shell would snap back into its compact closed shape while the screen
// was still visibly open above it.
// Kept as live handles (rather than fire-and-forget) so a rapid re-tap
// mid-animation stops whatever's still running first - otherwise two
// competing height tweens would fight over the same inline style and
// the shell would visibly stutter instead of just smoothly reversing
// direction.
var kalosHeightAnim = null;
var kalosContentAnim = null;
var stopKalosAnims = function() {
if (kalosHeightAnim) { try { kalosHeightAnim.stop(); } catch (e) {} kalosHeightAnim = null; }
if (kalosContentAnim) { try { kalosContentAnim.stop(); } catch (e) {} kalosContentAnim = null; }
};
var setKalosOpen = function(open) {
kalosTop.setAttribute('aria-expanded', open ? 'true' : 'false');
kalosBottom.setAttribute('aria-expanded', open ? 'true' : 'false');
if (kalosLensCorner) kalosLensCorner.setAttribute('aria-expanded', open ? 'true' : 'false');

var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!window.Motion || !window.Motion.animate || reduceMotion) {
kalosDex.dataset.open = open ? 'true' : 'false';
return;
}

stopKalosAnims();

// Asymmetric easing reads more polished than one curve run both ways:
// opening eases out (quick off the mark, settles gently at full height,
// like the screen catching up to the tap) and closing eases in (starts
// unhurried, gathers speed into the close) rather than mirroring the
// same shape in reverse.
var OPEN_EASE = [0.16, 1, 0.3, 1];
var CLOSE_EASE = [0.7, 0, 0.84, 0];

if (open) {
kalosDex.dataset.open = 'true';
var targetHeight = kalosScreenWrap.scrollHeight;
kalosScreenWrap.style.maxHeight = 'none';
kalosScreenWrap.style.height = '0px';
if (kalosScreenContent) {
kalosScreenContent.style.opacity = '0';
kalosScreenContent.style.transform = 'translateY(6px)';
}
void kalosScreenWrap.offsetHeight; // force layout so the 0px start registers before animating
kalosHeightAnim = window.Motion.animate(
kalosScreenWrap,
{ height: ['0px', targetHeight + 'px'] },
{ duration: 0.48, easing: OPEN_EASE }
);
kalosHeightAnim.finished.then(function() {
kalosScreenWrap.style.height = '';
kalosScreenWrap.style.maxHeight = '';
kalosHeightAnim = null;
}).catch(function() {});
if (kalosScreenContent) {
kalosContentAnim = window.Motion.animate(
kalosScreenContent,
{ opacity: [0, 1], transform: ['translateY(6px)', 'translateY(0px)'] },
{ duration: 0.32, delay: 0.14, easing: 'ease-out' }
);
kalosContentAnim.finished.then(function() {
kalosScreenContent.style.opacity = '';
kalosScreenContent.style.transform = '';
kalosContentAnim = null;
}).catch(function() {});
}
} else {
var startHeight = kalosScreenWrap.scrollHeight;
kalosScreenWrap.style.maxHeight = 'none';
kalosScreenWrap.style.height = startHeight + 'px';
void kalosScreenWrap.offsetHeight;
if (kalosScreenContent) {
kalosContentAnim = window.Motion.animate(
kalosScreenContent,
{ opacity: [1, 0], transform: ['translateY(0px)', 'translateY(6px)'] },
{ duration: 0.18, easing: 'ease-in' }
);
kalosContentAnim.finished.then(function() { kalosContentAnim = null; }).catch(function() {});
}
var finishClose = function() {
kalosDex.dataset.open = 'false';
kalosScreenWrap.style.height = '';
kalosScreenWrap.style.maxHeight = '';
if (kalosScreenContent) {
kalosScreenContent.style.opacity = '';
kalosScreenContent.style.transform = '';
}
kalosHeightAnim = null;
};
kalosHeightAnim = window.Motion.animate(
kalosScreenWrap,
{ height: [startHeight + 'px', '0px'] },
{ duration: 0.34, easing: CLOSE_EASE }
);
kalosHeightAnim.finished.then(finishClose).catch(finishClose);
}
};

var toggleKalosOpen = function() {
setKalosOpen(kalosDex.dataset.open !== 'true');
};
[kalosTop, kalosBottom, kalosLensCorner].forEach(function(half) {
if (!half) return;
half.addEventListener('click', function(e) {
// The lens is its own <button> nested alongside kalosTop/kalosBottom,
// not inside either - stopPropagation isn't needed here, but guard
// against double-firing if it's ever nested in future edits.
toggleKalosOpen();
});
half.addEventListener('keydown', function(e) {
if (e.key === 'Enter' || e.key === ' ') {
e.preventDefault();
toggleKalosOpen();
}
});
});
}
})();
// Same iOS "tap on a chip scrolls the whole page back to top" fix as the
// mobile Kalos grid above - #dex-grid also lives inside a
// transform-translated ancestor (.dex-track, used to slide between the
// Hunts/Log/Living Dex tabs), so its role="button" tabindex="0" species
// chips are just as vulnerable to it. See preventChipFocusScroll/
// restoreScrollAfter above.
preventChipFocusScroll(document.getElementById('dex-grid'));
document.getElementById('dex-grid').addEventListener('click', function(e) {
var chip = e.target.closest('[data-action="toggle-species"]');
if (chip) {
if (dex3DMode) {
open3DModelModal(chip.dataset.display, chip.dataset.dexnum, dexMode === 'shiny', chip.dataset.variant);
return;
}
restoreScrollAfter(function() {
toggleDexChip(chip, true);
});
return;
}
var head = e.target.closest('[data-action="toggle-dex"]');
if (!head) return;
var genCard = head.closest('.dex-card');
if (!genCard) return;
var gen = head.dataset.gen;
if (dexOpenGen === gen) {
collapseDexCard(genCard);
} else {
expandDexCard(genCard);
}
});
// Species chips are role="button" tabindex="0" (see buildDexChipsHtml),
// so Enter/Space needs to fire the same toggle the click handler above
// does - a <div>, unlike a real <button>, never dispatches a click from
// a keyboard activation on its own.
document.getElementById('dex-grid').addEventListener('keydown', function(e) {
if (e.key !== 'Enter' && e.key !== ' ') return;
var chip = e.target.closest('[data-action="toggle-species"]');
if (!chip) return;
e.preventDefault();
chip.click();
});
// 3D View toggle: desktop (#btn-dex-3d-toggle) and mobile
// (#btn-k-3d-toggle) both flip the same dex3DMode flag and stay in sync
// with each other, the same way the desktop/mobile Sort/Type toolbars
// mirror dexSortMode/dexTypeFilter elsewhere in this file. Only a class
// toggle on the two grids (for the cursor/badge affordance in style.css) -
// no re-render needed, since the click handlers above read dex3DMode live.
(function() {
var desktopBtn = document.getElementById('btn-dex-3d-toggle');
var mobileBtn = document.getElementById('btn-k-3d-toggle');
var desktopGrid = document.getElementById('dex-grid');
var mobileGrid = document.getElementById('kalos-gen-grid');
function toggleDex3DMode() {
dex3DMode = !dex3DMode;
if (desktopBtn) desktopBtn.setAttribute('aria-pressed', dex3DMode ? 'true' : 'false');
if (mobileBtn) mobileBtn.setAttribute('aria-pressed', dex3DMode ? 'true' : 'false');
if (desktopGrid) desktopGrid.classList.toggle('mode-3d', dex3DMode);
if (mobileGrid) mobileGrid.classList.toggle('mode-3d', dex3DMode);
}
if (desktopBtn) desktopBtn.addEventListener('click', toggleDex3DMode);
if (mobileBtn) mobileBtn.addEventListener('click', toggleDex3DMode);
})();
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
var ringFillEl = card.querySelector('.dex-gen-badge-ring .ring-fill');
if (ringFillEl) ringFillEl.style.strokeDashoffset = genBadgeRingOffset(pct);
var ringEl = card.querySelector('.dex-gen-badge-ring');
if (ringEl) ringEl.classList.toggle('is-complete', pct === 100);
});
var livingProgress = (dexMode === 'living') ? { caught: totalCaught, total: totalSpecies } : livingDexProgress();
var shinyProgress = (dexMode === 'shiny') ? { caught: totalCaught, total: totalSpecies } : shinyDexProgress();
var toggle = document.getElementById('dex-mode-toggle');
toggle.innerHTML = buildDexSplitToggleHtml(livingProgress, shinyProgress, dexMode);
var kalosToggle = document.getElementById('kalos-mode-toggle');
if (kalosToggle) kalosToggle.innerHTML = toggle.innerHTML;
animateDexSplitToggleTo(livingProgress, shinyProgress);
updateKalosDexCounts(caught);
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
// If this is one of the dpad's directional arms, rock the whole
// connected plate (pressed side dips, opposite side lifts) rather
// than animating the button in isolation.
var dpadWrap = btn.closest('.hunt-dex-dpad');
if (dpadWrap) {
var dir = btn.classList.contains('dpad-up') ? 'up' :
btn.classList.contains('dpad-down') ? 'down' :
btn.classList.contains('dpad-left') ? 'left' :
btn.classList.contains('dpad-right') ? 'right' : null;
if (dir) dpadWrap.classList.add('press-' + dir);
}
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
} else if (action === 'dev-tools') {
openDevToolsModal(hunt);
} else if (action === 'edit-hunt') {
openEditHuntModal(hunt);
} else if (action === 'delete-hunt') {
openAbandonHuntModal(hunt);
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
// ---------- Living Dex: animated-only filter ----------
// Which National Dex numbers currently have a *rigged and animated* .glb in
// the Pokemon-3D-api repo, split by regular/shiny the same way the repo's
// own folders are. There's no metadata endpoint for this - the repo's own
// README tells contributors to check per-model with a VS Code extension -
// so this list was generated by range-fetching just the GLB header + JSON
// chunk of every regular/shiny model (national dex 1-1028) and checking for
// a non-empty "animations" array, without downloading the full mesh/texture
// data. It's a snapshot, not a live check: models the repo adds or replaces
// after this list was built won't be reflected until it's regenerated the
// same way. Regional-variant folders (alolan/galar/hisuian) aren't covered
// yet - see pokemon3DModelUrls below for where those are looked up.
var ANIMATED_REGULAR_IDS = new Set([
1, 6, 15, 25, 40, 41, 81, 88, 89, 93, 95, 132, 133, 134, 135, 136, 146, 149, 150, 160,
168, 183, 196, 197, 200, 210, 212, 249, 253, 271, 302, 330, 341, 348, 353, 386, 392, 404, 429, 452,
470, 471, 472, 494, 529, 570, 591, 604, 610, 644, 645, 658, 718, 726, 747, 752, 778, 789, 790, 796,
798, 802, 805, 810, 811, 814, 839, 844, 845, 846, 847, 848, 849, 862, 867, 875, 880, 881, 884, 886,
887, 890, 892, 893, 896, 897, 899, 900, 901, 902, 903, 904, 905, 909, 910, 911, 920, 921, 922, 923,
932, 933, 934, 941, 946, 947, 962, 967, 979, 981, 983, 984, 987, 994, 995, 996, 997, 998, 999, 1000,
1001, 1002, 1003, 1004, 1007, 1008, 1014, 1015, 1016, 1018, 1020, 1023
]);
var ANIMATED_SHINY_IDS = new Set([
6, 15, 25, 81, 132, 149, 150, 160, 249, 330, 341, 376, 386, 645, 658, 718, 726, 747, 752, 790,
802, 811, 814, 839, 844, 846, 848, 875, 886, 904, 909, 910, 932, 933, 934, 946, 947, 967, 979, 981,
983, 984, 999, 1000, 1001, 1002, 1003, 1004, 1007, 1008
]);
function hasAnimatedModel(dexNum, shiny) {
var n = parseInt(dexNum, 10);
if (!n) return false;
return (shiny ? ANIMATED_SHINY_IDS : ANIMATED_REGULAR_IDS).has(n);
}
// All true by default (unfiltered), same convention as dexEvoStageFilter.
var dexAnimatedOnlyFilter = false;
// Hides chips whose species has no animated model for the currently active
// Living/Shiny mode. Re-checks dexMode itself rather than taking shiny as a
// param, so this can be called from the same generic "re-apply every active
// filter" spots as applyDexTypeFilter/applyDexVariantFilter/
// applyDexEvoStageFilter without every call site needing to know it depends
// on dexMode too. Scans the whole document, same as those (see
// applyDexTypeFilter above for why).
function applyDexAnimatedFilter() {
var shiny = dexMode === 'shiny';
document.querySelectorAll('.dex-chip[data-dexnum]').forEach(function(chip) {
if (!dexAnimatedOnlyFilter) {
chip.classList.remove('anim-hidden');
return;
}
chip.classList.toggle('anim-hidden', !hasAnimatedModel(chip.dataset.dexnum, shiny));
});
}
function syncDexAnimatedFilterUI() {
['btn-dex-anim-filter', 'btn-k-anim-filter'].forEach(function(id) {
var btn = document.getElementById(id);
if (!btn) return;
btn.classList.toggle('active', dexAnimatedOnlyFilter);
btn.setAttribute('aria-pressed', dexAnimatedOnlyFilter ? 'true' : 'false');
});
}
function setDexAnimatedOnlyFilter(value) {
dexAnimatedOnlyFilter = value;
syncDexAnimatedFilterUI();
applyDexAnimatedFilter();
}
['btn-dex-anim-filter', 'btn-k-anim-filter'].forEach(function(id) {
var btn = document.getElementById(id);
if (!btn) return;
btn.addEventListener('click', function(e) {
e.stopPropagation();
setDexAnimatedOnlyFilter(!dexAnimatedOnlyFilter);
});
});
// ---------- Living Dex: 3D model viewer ----------
// Model source: Pokemon-3D-api's community-maintained, web-optimized (Draco
// + WebP) .glb repo, keyed by National Dex number the same way this app's
// own sprite lookups (dexEntrySpriteUrls, shinySpriteUrls above) are keyed
// by name/slug. Regional/alt forms don't have their own distinct entry in
// that repo yet, so every variant of a species (e.g. every Rattata form)
// currently falls back to the same base-species model - an approximation,
// not a bug, until the source repo grows form-specific files.
// Maps this app's dex-chip data-variant tag (see buildDexChipsHtml) to the
// Pokemon-3D-api asset repo's folder name for that regional form. Paldean
// is deliberately omitted - the repo only has it under a shared "multiform"
// bucket (aqua/blaze/combat breeds all point at the same .glb), which isn't
// a meaningful visual upgrade over the base species model, so it's left
// out rather than adding a candidate that never differs from the fallback.
var POKEMON_3D_VARIANT_FOLDERS = {
Alolan: 'alolan',
Galarian: 'galar',
Hisuian: 'hisuian'
};
function pokemon3DModelUrls(dexNum, shiny, variant) {
var n = parseInt(dexNum, 10);
if (!n || n < 1) return [];
var base = 'https://raw.githubusercontent.com/Pokemon-3D-api/assets/main/models/opt/';
var variantFolder = POKEMON_3D_VARIANT_FOLDERS[variant];
var candidates = [];
// Regional variants don't have their own shiny recolors in the repo yet
// (see README's "Shiny Alolan Forms: 0/16"), so even in shiny mode the
// variant-specific regular model is a closer visual match than jumping
// straight to the base species - try it first.
if (variantFolder) candidates.push(base + variantFolder + '/' + n + '.glb');
if (shiny) candidates.push(base + 'shiny/' + n + '.glb');
// Base regular model is the last-resort fallback for everything - see the
// <model-viewer> "error" listener in open3DModelModal, which is what
// actually steps through this list.
candidates.push(base + 'regular/' + n + '.glb');
// De-dupe while preserving order (e.g. a non-shiny, non-variant chip would
// otherwise just be the same regular URL once - dedupe keeps that safe
// even if the mappings above ever overlap).
return candidates.filter(function(url, i) { return candidates.indexOf(url) === i; });
}
// Opens a species' 3D model in the shared modal chrome (openModal above).
// displayName is what's shown in the header; dexNum/shiny pick which .glb
// gets loaded. Swaps <model-viewer>'s src to the next candidate URL on
// load failure instead of just erroring out, the same "ordered candidate
// list" pattern smallSpriteMarkup/window.__spriteErr already use for
// sprites.
function open3DModelModal(displayName, dexNum, shiny, variant) {
var urls = pokemon3DModelUrls(dexNum, shiny, variant);
if (!urls.length) return;
var name = displayName || 'Pokémon';
// HUD id readout in the header - same "NO. 0006" padding convention used
// by the rest of the app's dex-number displays (see dexNumberOf callers).
var dexNumStr = dexNum ? ('NO. ' + String(dexNum).padStart(4, '0')) : 'NO. ????';
// Type badges are local data (no fetch needed) - same speciesInfo/
// typeBadges helpers the rest of the app already uses, so they render
// immediately rather than waiting on the async dex-entry fill below.
var localInfo = speciesInfo(name);
var typesMarkup = localInfo && localInfo.types.length ? typeBadges(localInfo.types, 70) : '';
var overlay = openModal(
// Corner brackets on the popup itself (not just the inner stage below)
// so the whole window reads as a projected viewport, same "scanner
// lock-on" framing language as .model3d-corner already uses inside.
'<span class="model3d-outer-corner tl" aria-hidden="true"></span>' +
'<span class="model3d-outer-corner tr" aria-hidden="true"></span>' +
'<span class="model3d-outer-corner bl" aria-hidden="true"></span>' +
'<span class="model3d-outer-corner br" aria-hidden="true"></span>' +
'<div class="model3d-head"><h3>' + escapeHtml(name) + (shiny ? ' <span class="model3d-shiny-tag">✦ Shiny</span>' : '') + '</h3>' +
'<span class="model3d-hud-id" aria-hidden="true">' + dexNumStr + '</span></div>' +
'<div class="model3d-stage" id="model3d-stage">' +
// Beam/ring/scanlines/corners are purely decorative (aria-hidden) - the
// "beamed up from the Pokédex" framing. The stage starts with all of
// this invisible; adding 'model3d-active' below (right after insertion)
// is what triggers the CSS reveal. Nested in
// .model3d-beam-fx (rather than each having its own opacity transition)
// because .model3d-beam/-beam-ring each already run their own infinite
// CSS *animation* for the idle pulse, and an element can't also smoothly
// *transition* a property that a running animation is driving - the
// animation would just win outright. Fading the wrapper in/out instead
// leaves the pulse animation alone and still gets a smooth reveal.
'<div class="model3d-beam-fx" aria-hidden="true"><div class="model3d-beam"></div><div class="model3d-beam-ring"></div></div>' +
// autoplay is what actually gets a rigged model out of its bind pose -
// without it, model-viewer just renders the skeleton's default rest
// position, which for most Pokemon rigs *is* a T-pose, even though an
// Idle/Walk/Attack clip is baked right into the .glb. animation-name is
// deliberately left unset so model-viewer picks the model's first clip
// itself; we only step in (below) to prefer "Idle" when one exists.
'<model-viewer id="model3d-viewer" src="' + urls[0] + '" alt="3D model of ' + escapeHtml(name) + '" camera-controls auto-rotate autoplay rotation-per-second="18deg" shadow-intensity="0.9" exposure="0.95" interaction-prompt="none" loading="eager"></model-viewer>' +
'<div class="model3d-scanlines" aria-hidden="true"></div>' +
// Vertical tick rulers down each side of the stage, like a scanner's
// depth gauge - purely decorative, layered under the corner brackets.
'<div class="model3d-hud-ticks left" aria-hidden="true"></div>' +
'<div class="model3d-hud-ticks right" aria-hidden="true"></div>' +
// Small live-readout tags in two corners of the stage, echoing the
// beam/rotation stats the model-viewer is actually running with rather
// than inventing unrelated numbers.
'<div class="model3d-hud-readout tl" aria-hidden="true">ROT 18°/S</div>' +
'<div class="model3d-hud-readout br" aria-hidden="true">LINK STABLE</div>' +
'<span class="model3d-corner tl" aria-hidden="true"></span>' +
'<span class="model3d-corner tr" aria-hidden="true"></span>' +
'<span class="model3d-corner bl" aria-hidden="true"></span>' +
'<span class="model3d-corner br" aria-hidden="true"></span>' +
'<div class="model3d-loading" id="model3d-loading">Loading model…</div>' +
'</div>' +
// Dex-entry readout below the stage, styled like an in-universe Pokédex
// page: genus + height/weight stats, type badges, an "evolves from" line
// when one applies, then the flavor text description. Starts in a
// loading state and fills in once fetchDexEntryData/fetchEvolvesFrom
// resolve below, same async-fill pattern as the loading-el swap above.
// Type badges are the one part that's local data, so they render
// immediately rather than waiting.
'<div class="model3d-entry" id="model3d-entry">' +
'<div class="model3d-entry-top">' +
'<span class="model3d-entry-genus" id="model3d-entry-genus">Accessing entry…</span>' +
'<span class="model3d-entry-stats" id="model3d-entry-stats"></span>' +
'</div>' +
(typesMarkup ? '<div class="model3d-entry-types">' + typesMarkup + '</div>' : '') +
'<p class="model3d-entry-evofrom" id="model3d-entry-evofrom" hidden></p>' +
'<p class="model3d-entry-text" id="model3d-entry-text"></p>' +
'</div>',
'modal-3d-viewer'
);
var viewer = overlay.querySelector('#model3d-viewer');
var loadingEl = overlay.querySelector('#model3d-loading');
var stageEl = overlay.querySelector('#model3d-stage');
var entryGenusEl = overlay.querySelector('#model3d-entry-genus');
var entryStatsEl = overlay.querySelector('#model3d-entry-stats');
var entryEvoFromEl = overlay.querySelector('#model3d-entry-evofrom');
var entryTextEl = overlay.querySelector('#model3d-entry-text');
// Fills in the dex-entry panel once PokeAPI resolves (or falls back to a
// short "no data" line if the species can't be found there - some
// regional-variant slugs the app tracks don't exist as their own PokeAPI
// entry). Guarded on overlay still being in the DOM since this can
// resolve after the player's already closed the modal. Evolves-from is
// fetched alongside via the existing fetchEvolvesFrom helper (already
// used by the catch confirmation card) rather than duplicated here.
Promise.all([fetchDexEntryData(name), fetchEvolvesFrom(name)]).then(function(results) {
if (!document.body.contains(overlay)) return;
var entry = results[0], evolvesFrom = results[1];
if (evolvesFrom && entryEvoFromEl) {
entryEvoFromEl.textContent = 'Evolves from ' + evolvesFrom;
entryEvoFromEl.hidden = false;
}
if (!entry || (!entry.genus && !entry.flavorText)) {
if (entryGenusEl) entryGenusEl.textContent = 'No entry data available.';
if (updateLensLines) updateLensLines();
return;
}
if (entryGenusEl) entryGenusEl.textContent = entry.genus || '';
if (entryStatsEl) {
var stats = '';
if (entry.heightM != null) stats += '<span class="model3d-entry-stat"><span class="model3d-entry-stat-label">HT</span>' + entry.heightM.toFixed(1) + ' m</span>';
if (entry.weightKg != null) stats += '<span class="model3d-entry-stat"><span class="model3d-entry-stat-label">WT</span>' + entry.weightKg.toFixed(1) + ' kg</span>';
entryStatsEl.innerHTML = stats;
}
if (entryTextEl) entryTextEl.textContent = entry.flavorText || '';
// The entry panel just changed the modal's height (growing it downward
// only - see the top-pin above), which moves the bottom two corners the
// hologram lens lines are aimed at. Redraw them against the new layout;
// harmless no-op if this modal never had lens lines (desktop/no lens).
if (updateLensLines) updateLensLines();
});
// The whole popup - not just the inner 3D stage - is "the window" the
// lens is projecting: header text and the footer hint sit outside
// .model3d-stage but are still part of that same window, so the
// hologram lines below target/clip against this outer element rather
// than the narrower stage box.
var modalEl = overlay.querySelector('.modal');
// The dex-entry panel below fills in asynchronously once PokeAPI responds
// (see fetchDexEntryData above), and can grow the modal taller than its
// initial loading-state height. The shared .overlay centers modals
// vertically via flex, so left as-is that growth would re-centre the
// whole window - visibly pushing the top edge (and the hologram lens
// lines aimed at its corners, below) upward instead of only growing
// downward. Snapshot the modal's centered top offset right after
// insertion and switch this overlay to flex-start + an equivalent
// margin-top instead, so later height changes only extend the bottom.
var initialModalTop = modalEl.getBoundingClientRect().top;
var overlayPaddingTop = parseFloat(getComputedStyle(overlay).paddingTop) || 0;
overlay.style.alignItems = 'flex-start';
modalEl.style.marginTop = Math.max(0, initialModalTop - overlayPaddingTop) + 'px';
// The mobile Kalos shell's corner lens (see .kalos-lens-corner-beam-fx in
// style.css) used to light up any time the shell was simply open, which
// read as "always on" rather than tied to anything actually happening on
// screen. It's meant to read as "the lens is projecting this", so it
// should only be lit while a 3D model is genuinely being viewed here -
// flip a data attribute on #kalos-dex for exactly that, and clear it
// again whenever this modal leaves the DOM (backdrop click, the close
// button, or anything else that removes it), the same "watch for the
// overlay to disappear" pattern openModal already uses for its own
// scroll-lock above.
var kalosDexEl = document.getElementById('kalos-dex');
// Real hologram lines: rather than drawing a decorative copy of a lens
// inside the modal itself, this traces actual glowing lines from the
// genuine corner lens on the shell (#kalos-lens-corner - only present/
// visible at the mobile Kalos breakpoint) to this modal's own four
// corners, so the projection visibly comes from that physical lens
// rather than a redundant one. Built as its own <svg> appended straight
// to <body> (not inside .model3d-stage) because the lens sits outside
// the modal entirely - the line needs real getBoundingClientRect()
// coordinates for both endpoints, recomputed on resize since the modal
// is centered by flexbox and the lens's position depends on the shell
// layout underneath it.
var kalosLensCorner = document.getElementById('kalos-lens-corner');
var lensLinesSvg = null;
var lensLineEls = null;
var lensConeFill = null;
var updateLensLines = null;
if (kalosLensCorner && kalosLensCorner.getBoundingClientRect().width > 0) {
lensLinesSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
lensLinesSvg.setAttribute('class', 'model3d-lens-lines-fixed');
lensLinesSvg.setAttribute('aria-hidden', 'true');
lensLineEls = [0, 1, 2, 3].map(function() {
var lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
lineEl.setAttribute('class', 'model3d-lens-line-fixed');
lensLinesSvg.appendChild(lineEl);
return lineEl;
});
// Solid holographic fill for the wedge between the lines themselves,
// so the projection reads as one cone of light rather than a few bare
// strokes with empty space between them. Inserted before the lines'
// <svg> so the crisp glowing strokes still paint on top of it.
lensConeFill = document.createElement('div');
lensConeFill.className = 'model3d-lens-cone-fill';
lensConeFill.setAttribute('aria-hidden', 'true');
document.body.appendChild(lensConeFill);
document.body.appendChild(lensLinesSvg);
// Finds where a segment first crosses INTO an axis-aligned rect (Liang-
// Barsky entry parameter). Used below so a line heading to a far corner
// - e.g. the two bottom corners, reached only by cutting across the
// popup's face - simply never gets drawn past that entry point, rather
// than being drawn in full and hidden with clip-path (which doesn't
// reliably clip elements that also carry a CSS filter, like the glow
// on these lines). Returns null if the segment never enters the rect
// before reaching its own endpoint.
function segmentRectEntry(x0, y0, x1, y1, left, top, right, bottom) {
var dx = x1 - x0, dy = y1 - y0;
var p = [-dx, dx, -dy, dy];
var q = [x0 - left, right - x0, y0 - top, bottom - y0];
var t0 = 0, t1 = 1;
for (var i = 0; i < 4; i++) {
if (p[i] === 0) {
if (q[i] < 0) return null;
} else {
var r = q[i] / p[i];
if (p[i] < 0) {
if (r > t1) return null;
if (r > t0) t0 = r;
} else {
if (r < t0) return null;
if (r < t1) t1 = r;
}
}
}
if (t0 <= 0 || t0 >= 1) return null;
return { x: x0 + dx * t0, y: y0 + dy * t0 };
}
updateLensLines = function() {
if (!document.body.contains(overlay) || !document.body.contains(kalosLensCorner) || !modalEl) return;
var lensRect = kalosLensCorner.getBoundingClientRect();
var modalRect = modalEl.getBoundingClientRect();
// getBoundingClientRect() always reports coordinates in the LAYOUT
// viewport (the fixed, address-bar-collapsed size implied by 100vh/
// 100vw). But .model3d-lens-lines-fixed/.model3d-lens-cone-fill are
// position:fixed, and on iOS Safari position:fixed elements are
// painted relative to the VISUAL viewport instead - which shifts
// vertically (and can shift horizontally too, e.g. pinch-zoom)
// whenever Safari's chrome (address/tab bar) is partially shown. That
// mismatch is exactly why the lines used to miss both the lens and the
// modal corners: every coordinate needs to be re-expressed in visual-
// viewport space before it's handed to the fixed SVG. window.
// visualViewport isn't available in every engine, so this is a no-op
// (offsets of 0) anywhere it's missing rather than a hard dependency.
var vv = window.visualViewport;
var vvOffsetX = vv ? vv.offsetLeft : 0;
var vvOffsetY = vv ? vv.offsetTop : 0;
var lx = lensRect.left + lensRect.width / 2 - vvOffsetX;
var ly = lensRect.top + lensRect.height / 2 - vvOffsetY;
var modalLeft = modalRect.left - vvOffsetX;
var modalTop = modalRect.top - vvOffsetY;
var modalRight = modalRect.right - vvOffsetX;
var modalBottom = modalRect.bottom - vvOffsetY;
// .modal has a 24px border-radius, so the true bounding-box corner
// sits past the visible curve - a line aimed straight at it overshoots
// the border instead of landing on it. Pulling each corner in along
// both axes by r*(1-cos45deg) puts the endpoint exactly on the rounded
// corner's outermost point instead, so the beam appears to actually
// meet the border rather than floating past/short of it.
var modalRadius = 24;
var cornerInset = modalRadius * (1 - Math.SQRT1_2);
var corners = [
[modalLeft + cornerInset, modalTop + cornerInset],
[modalRight - cornerInset, modalTop + cornerInset],
[modalLeft + cornerInset, modalBottom - cornerInset],
[modalRight - cornerInset, modalBottom - cornerInset]
];
lensLineEls.forEach(function(lineEl, i) {
var cx = corners[i][0], cy = corners[i][1];
// If this line would have to cross the popup's face to reach its
// corner (true for the two bottom corners here), stop it at the
// point it first meets the popup's edge instead - the popup then
// visually overtakes the rest of the beam, rather than the beam
// drawing over the popup.
var entry = segmentRectEntry(lx, ly, cx, cy, modalLeft, modalTop, modalRight, modalBottom);
lineEl.setAttribute('x1', lx);
lineEl.setAttribute('y1', ly);
lineEl.setAttribute('x2', entry ? entry.x : cx);
lineEl.setAttribute('y2', entry ? entry.y : cy);
});
if (lensConeFill) {
// Same endpoints the lines just used (apex + wherever each of the 4
// lines actually ends now), sorted by angle around the apex so
// connecting them in order traces a clean, non-self-intersecting fan
// rather than a tangled shape.
var endpoints = lensLineEls.map(function(lineEl) {
return [parseFloat(lineEl.getAttribute('x2')), parseFloat(lineEl.getAttribute('y2'))];
});
endpoints.sort(function(a, b) {
return Math.atan2(a[1] - ly, a[0] - lx) - Math.atan2(b[1] - ly, b[0] - lx);
});
var polygonPoints = [[lx, ly]].concat(endpoints);
lensConeFill.style.clipPath = 'polygon(' + polygonPoints.map(function(pt) {
return pt[0] + 'px ' + pt[1] + 'px';
}).join(', ') + ')';
}
};
updateLensLines();
window.addEventListener('resize', updateLensLines);
// A plain 'resize' on window doesn't reliably fire when iOS Safari's
// address/tab bar collapses or expands on scroll - that only moves the
// visual viewport, not the layout viewport window.addEventListener('resize')
// is tied to. Without this, the lens/corner offset correction above
// would use a stale vv.offsetTop/offsetLeft until something else (e.g.
// a real rotation) happened to trigger a resize.
if (window.visualViewport) {
window.visualViewport.addEventListener('resize', updateLensLines);
window.visualViewport.addEventListener('scroll', updateLensLines);
}
}
if (kalosDexEl) {
kalosDexEl.setAttribute('data-model-active', 'true');
var kalosLensObserver = new MutationObserver(function() {
if (!document.body.contains(overlay)) {
kalosLensObserver.disconnect();
kalosDexEl.removeAttribute('data-model-active');
// Tear down the lens-line overlay alongside the modal itself,
// rather than leaving a stray fixed <svg> + resize/visualViewport
// listener behind.
if (lensLinesSvg) {
window.removeEventListener('resize', updateLensLines);
if (window.visualViewport) {
window.visualViewport.removeEventListener('resize', updateLensLines);
window.visualViewport.removeEventListener('scroll', updateLensLines);
}
lensLinesSvg.remove();
lensLinesSvg = null;
}
if (lensConeFill) {
lensConeFill.remove();
lensConeFill = null;
}
}
});
kalosLensObserver.observe(document.body, { childList: true });
}
// Adds 'model3d-active' on the very next frame (rather than
// synchronously) so the browser paints the initial (inactive) state
// first - otherwise it can coalesce that with 'model3d-active' into a
// single paint and skip the modal's own beam/model fade-in transition
// entirely.
var activateTimer = requestAnimationFrame(function() {
requestAnimationFrame(function() {
if (stageEl) stageEl.classList.add('model3d-active');
if (lensLinesSvg) {
if (updateLensLines) updateLensLines();
lensLinesSvg.classList.add('model3d-lens-lines-active');
if (lensConeFill) lensConeFill.classList.add('model3d-lens-lines-active');
}
});
});
var fallbacks = urls.slice(1);
viewer.addEventListener('load', function() {
if (loadingEl) loadingEl.style.display = 'none';
// This repo's models are crowd-sourced from Sketchfab per-Pokemon, so
// not every one has an animation clip baked in - the README even tells
// contributors to check for that before adding an entry. When one's
// present, prefer an "Idle" clip by name if the model has several
// (Idle/Walk/Attack etc.); otherwise autoplay above already started
// whichever clip is first. When there's truly none, flag it rather
// than silently leaving the model looking "stuck" in a T-pose.
var anims = viewer.availableAnimations || [];
if (anims.length) {
var idleMatch = anims.filter(function(a) { return /idle/i.test(a); })[0];
if (idleMatch && idleMatch !== viewer.animationName) {
viewer.animationName = idleMatch;
viewer.play();
}
// model-viewer auto-frames the camera to the model's REST/bind pose at
// load time - but an Idle/Walk/Attack clip can swing wings, tails, or
// limbs well beyond that pose once it's actually playing, which is
// exactly why some Pokemon load in with a wingtip or antenna cropped
// off at the stage edge (see Beedrill). Static models are already
// framed correctly since nothing moves after load, so this margin is
// only added for models that animate - pulling the camera back ~35%
// gives the motion room without shrinking everything unnecessarily.
if (typeof viewer.getCameraOrbit === 'function') {
var orbit = viewer.getCameraOrbit();
viewer.cameraOrbit = orbit.theta + 'rad ' + orbit.phi + 'rad ' + (orbit.radius * 1.35) + 'm';
}
}
});
viewer.addEventListener('error', function() {
if (fallbacks.length) {
viewer.setAttribute('src', fallbacks.shift());
} else if (loadingEl) {
loadingEl.textContent = 'No 3D model available yet for ' + name + '.';
}
});
// No dedicated close button on this modal (closes via backdrop click,
// same as openModal's own default) - watch for the overlay leaving the
// DOM however that happens, so the pending activation frame still gets
// cancelled instead of only being cleaned up from a click handler on a
// button that no longer exists.
var closeCleanupObserver = new MutationObserver(function() {
if (!document.body.contains(overlay)) {
closeCleanupObserver.disconnect();
cancelAnimationFrame(activateTimer);
}
});
closeCleanupObserver.observe(document.body, { childList: true });
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
// Game field gets its own sync: box-art thumbnail(s) from
// gameBoxArtMarkup() alongside the text, instead of plain text.
function syncGameSelectVisual(select, visual) {
visual.innerHTML =
'<span class="hunt-radar-game-visual-icons">' + gameBoxArtMarkup(select.value) + '</span>' +
'<span class="hunt-radar-game-visual-text">' + escapeHtml(select.value) + '</span>';
}
syncGameSelectVisual(gameSel, gameVisual);
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
syncGameSelectVisual(gameSel, gameVisual);
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
resetLogKeysExcept(['edit']);
logEditMode = !logEditMode;
this.classList.toggle('active', logEditMode);
this.setAttribute('aria-pressed', logEditMode ? 'true' : 'false');
renderCollection();
});
// Lets you directly edit an active hunt's saved data (Pokemon, game,
// method, shiny charm, encounters, and time spent) rather than only
// bumping the encounter counter or timer - useful for re-entering a
// hunt's progress after it was lost, or correcting a mistake, without
// having to abandon and restart the hunt from zero. Opened from the
// green light on the hunt card.
// Shared header markup for the hunt-card popup menus (Abandon Hunt, Add
// to Log, Edit Hunt) so all three read as the same "device menu" instead
// of each modal inventing its own header treatment - a dot + title on
// the left, two small decorative status lights on the right, matching
// the look already established by the Dev Tools / Start a Hunt modals.
function huntMenuHeadHtml(title) {
return '<div class="modal-dex-head">' +
'<div class="modal-dex-head-title"><span class="modal-dex-dot"></span><h3>' + escapeHtml(title) + '</h3></div>' +
'<div class="modal-dex-lights" aria-hidden="true"><span class="modal-dex-light g lit"></span><span class="modal-dex-light y"></span></div>' +
'</div>';
}
// Confirmation step for abandoning a hunt, in the same unified-menu style
// as Add to Log and Edit Hunt rather than a native confirm() popup. The
// primary button itself carries the second confirmation: the first click
// swaps it into an armed "Tap again to confirm" state, and only a second
// click on that same button actually deletes the hunt - so a stray tap
// can't silently abandon it, and Cancel (or the backdrop) always backs
// out safely.
function openAbandonHuntModal(hunt) {
var overlay = openModal(
huntMenuHeadHtml('Abandon Hunt') +
'<p class="field-hint">Abandoning <strong>' + escapeHtml(hunt.pokemon) + '</strong> permanently deletes its encounter count, timer, and hunt settings. This can\'t be undone.</p>' +
'<div class="modal-actions"><button class="ghost" id="ab-cancel">Cancel</button><button class="ghost danger" id="ab-confirm">Abandon Hunt</button></div>',
'modal-abandon-hunt'
);
var confirmBtn = overlay.querySelector('#ab-confirm');
var armed = false;
overlay.querySelector('#ab-cancel').addEventListener('click', function() {
overlay.remove();
});
confirmBtn.addEventListener('click', function() {
if (!armed) {
armed = true;
confirmBtn.textContent = 'Tap again to confirm';
confirmBtn.classList.add('is-confirming');
return;
}
state.hunts = state.hunts.filter(function(h) {
return h.id !== hunt.id;
});
save();
renderHunts();
overlay.remove();
});
}
function openEditHuntModal(hunt) {
var totalSeconds = elapsedSeconds(hunt);
var hrs = Math.floor(totalSeconds / 3600);
var mins = Math.floor((totalSeconds % 3600) / 60);
var overlay = openModal(
huntMenuHeadHtml('Edit Hunt') +
'<div class="field"><label>Pok\u00e9mon</label><input type="text" id="eh-pokemon" value="' + escapeHtml(hunt.pokemon) + '" autofocus></div>' +
'<div class="field-row">' +
'<div class="field"><label>Game</label><select id="eh-game">' + gameOptions(hunt.game) + '</select></div>' +
'<div class="field"><label>Method</label><select id="eh-method">' + methodOptions(hunt.method) + '</select></div>' +
'</div>' +
'<div class="field-row">' +
'<div class="field"><label>Odds (1 in ___)</label><input type="number" id="eh-denom" min="1" value="' + hunt.denom + '"></div>' +
'<div class="field"><label>Encounters</label><input type="number" id="eh-encounters" min="0" value="' + hunt.encounters + '"></div>' +
'</div>' +
'<div class="field-row">' +
'<div class="field"><label>Time spent</label><div class="field-row dt-time-row"><input type="number" id="eh-hours" min="0" placeholder="Hrs" value="' + hrs + '"><input type="number" id="eh-minutes" min="0" max="59" placeholder="Min" value="' + mins + '"></div></div>' +
'<div class="checkbox-field" style="align-self:flex-end;margin-bottom:10px;"><input type="checkbox" id="eh-charm"' + (hunt.shinyCharm ? ' checked' : '') + '><label for="eh-charm">Shiny Charm</label></div>' +
'</div>' +
'<p class="field-hint">Odds recalculate automatically when you change Game/Method/Shiny Charm, unless you edit the Odds field yourself afterward.</p>' +
'<div class="modal-actions"><button class="ghost" id="eh-cancel">Cancel</button><button class="primary" id="eh-save">Save Changes</button></div>'
);
attachPokemonAutocomplete(overlay.querySelector('#eh-pokemon'));
var gameSel = overlay.querySelector('#eh-game');
var methodSel = overlay.querySelector('#eh-method');
var charmChk = overlay.querySelector('#eh-charm');
var denomInput = overlay.querySelector('#eh-denom');
var denomTouched = false;
denomInput.addEventListener('input', function() { denomTouched = true; });
function refreshDenom() {
if (denomTouched) return;
denomInput.value = computeOdds(gameSel.value, methodSel.value, charmChk.checked);
}
gameSel.addEventListener('change', refreshDenom);
methodSel.addEventListener('change', refreshDenom);
charmChk.addEventListener('change', refreshDenom);
overlay.querySelector('#eh-cancel').addEventListener('click', function() {
overlay.remove();
});
overlay.querySelector('#eh-save').addEventListener('click', function() {
var name = overlay.querySelector('#eh-pokemon').value.trim();
if (!name) {
overlay.querySelector('#eh-pokemon').focus();
return;
}
hunt.pokemon = name;
hunt.game = gameSel.value;
hunt.method = methodSel.value;
hunt.shinyCharm = charmChk.checked;
hunt.denom = parseInt(denomInput.value, 10) || 1;
hunt.encounters = parseInt(overlay.querySelector('#eh-encounters').value || '0', 10) || 0;
var newHours = parseInt(overlay.querySelector('#eh-hours').value || '0', 10) || 0;
var newMinutes = parseInt(overlay.querySelector('#eh-minutes').value || '0', 10) || 0;
hunt.accumulatedSeconds = (newHours * 3600) + (newMinutes * 60);
// If the timer's currently running, restart its running reference point
// now so the freshly-entered total isn't immediately padded by however
// long has elapsed since the hunt originally started running.
if (hunt.running) {
hunt.runStart = Date.now();
}
save();
renderHunts();
overlay.remove();
});
}
function openDevToolsModal(hunt) {
var overlay = openModal(
huntMenuHeadHtml('Dev Tools') +
'<div class="dev-tools-tabs" id="dt-tabs">' +
'<button type="button" class="dev-tools-tab active" data-tab="add">Add Entry</button>' +
'<button type="button" class="dev-tools-tab" data-tab="history">Version History</button>' +
'</div>' +
'<div class="dev-tools-panel" id="dt-panel-add">' +
'<p class="field-hint">Manually log a catch - use this to re-enter records that were lost, or to log something you caught outside a tracked hunt.</p>' +
'<div class="field"><label>Pokémon</label><input type="text" id="dt-pokemon" placeholder="e.g. Gible" value="' + escapeHtml(hunt ? hunt.pokemon : '') + '"></div>' +
'<div class="field-row">' +
'<div class="field"><label>Game</label><select id="dt-game">' + gameOptions(hunt ? hunt.game : null) + '</select></div>' +
'<div class="field"><label>Method</label><select id="dt-method">' + methodOptions(hunt ? hunt.method : null) + '</select></div>' +
'</div>' +
'<div class="field-row">' +
'<div class="field"><label>Odds (1 in ___)</label><input type="number" id="dt-denom" min="1" value="' + (hunt ? hunt.denom : 4096) + '"></div>' +
'<div class="field"><label>Encounters</label><input type="number" id="dt-encounters" min="0" value="' + (hunt ? hunt.encounters : 0) + '"></div>' +
'</div>' +
'<div class="field-row">' +
'<div class="field"><label>Date Began</label><input type="date" id="dt-date-began"></div>' +
'<div class="field"><label>Date Ended</label><input type="date" id="dt-date-ended" value="' + fmtDate(new Date()) + '"></div>' +
'</div>' +
'<div class="field-row">' +
'<div class="field"><label>Time Spent</label><div class="field-row dt-time-row"><input type="number" id="dt-hours" min="0" placeholder="Hrs" value="0"><input type="number" id="dt-minutes" min="0" max="59" placeholder="Min" value="0"></div></div>' +
'<div class="checkbox-field" style="align-self:flex-end;margin-bottom:10px;"><input type="checkbox" id="dt-charm"' + (hunt && hunt.shinyCharm ? ' checked' : '') + '><label for="dt-charm">Shiny Charm</label></div>' +
'</div>' +
'<div class="field"><label>Notes</label><textarea id="dt-notes" rows="2"></textarea></div>' +
'<div class="modal-actions"><button class="ghost" id="dt-cancel">Cancel</button><button class="primary" id="dt-save">Add to Log</button></div>' +
'</div>' +
'<div class="dev-tools-panel" id="dt-panel-history" style="display:none;">' +
'<p class="field-hint">Recent saved snapshots of your data. Restoring replaces your current hunts/collection with that snapshot\'s contents.</p>' +
'<div class="dev-history-list" id="dt-history-list"><div class="dev-history-empty">Loading…</div></div>' +
'</div>',
'modal-dev-tools'
);
attachPokemonAutocomplete(overlay.querySelector('#dt-pokemon'));
overlay.querySelector('#dt-cancel').addEventListener('click', function() { overlay.remove(); });
var tabs = overlay.querySelector('#dt-tabs');
var panelAdd = overlay.querySelector('#dt-panel-add');
var panelHistory = overlay.querySelector('#dt-panel-history');
var historyLoaded = false;
tabs.addEventListener('click', function(e) {
var btn = e.target.closest('[data-tab]');
if (!btn) return;
tabs.querySelectorAll('.dev-tools-tab').forEach(function(b) { b.classList.remove('active'); });
btn.classList.add('active');
var isHistory = btn.dataset.tab === 'history';
panelAdd.style.display = isHistory ? 'none' : '';
panelHistory.style.display = isHistory ? '' : 'none';
if (isHistory && !historyLoaded) {
historyLoaded = true;
loadHistoryList(overlay);
}
});
overlay.querySelector('#dt-save').addEventListener('click', function() {
var pokemon = overlay.querySelector('#dt-pokemon').value.trim();
if (!pokemon) {
overlay.querySelector('#dt-pokemon').focus();
return;
}
var info = speciesInfo(pokemon);
var dateBeganVal = overlay.querySelector('#dt-date-began').value;
var dateEndedVal = overlay.querySelector('#dt-date-ended').value;
state.collection.push({
id: uid(),
pokemon: pokemon,
gen: info ? info.gen : null,
types: info ? info.types : [],
game: overlay.querySelector('#dt-game').value,
method: overlay.querySelector('#dt-method').value,
shinyCharm: overlay.querySelector('#dt-charm').checked,
denom: parseInt(overlay.querySelector('#dt-denom').value, 10) || 0,
encounters: parseInt(overlay.querySelector('#dt-encounters').value, 10) || 0,
dateBegan: dateBeganVal || dateEndedVal || fmtDate(new Date()),
dateEnded: dateEndedVal || fmtDate(new Date()),
timeSpentMinutes: (parseInt(overlay.querySelector('#dt-hours').value, 10) || 0) * 60 + (parseInt(overlay.querySelector('#dt-minutes').value, 10) || 0),
notes: overlay.querySelector('#dt-notes').value.trim()
});
logSelectedId = state.collection[state.collection.length - 1].id;
save();
renderAll();
overlay.remove();
var tabBtn = document.querySelector('nav.tabs button[data-tab="collection"]');
if (tabBtn) { tabBtn.click(); } else { activateTab('collection'); }
});
}
function loadHistoryList(overlay) {
var list = overlay.querySelector('#dt-history-list');
if (!connectToCloud() || !HISTORY_COLLECTION) {
list.innerHTML = '<div class="dev-history-empty">Cloud sync isn\'t connected right now.</div>';
return;
}
HISTORY_COLLECTION.orderBy('savedAt', 'desc').limit(HISTORY_LIMIT).get().then(function(snap) {
if (!overlay.isConnected) return;
if (snap.empty) {
list.innerHTML = '<div class="dev-history-empty">No saved snapshots yet - they start building up as you use the tracker.</div>';
return;
}
list.innerHTML = snap.docs.map(function(doc) {
var d = doc.data();
var when = new Date(d.savedAt);
var whenStr = isNaN(when.getTime()) ? 'Unknown time' : (fmtDate(when) + ' ' + when.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
var huntsCount = Array.isArray(d.hunts) ? d.hunts.length : 0;
var collCount = Array.isArray(d.collection) ? d.collection.length : 0;
return '<div class="dev-history-row">' +
'<div class="dev-history-meta"><div class="dev-history-when">' + escapeHtml(whenStr) + '</div>' +
'<div class="dev-history-counts">' + huntsCount + ' active hunt' + (huntsCount === 1 ? '' : 's') + ' · ' + collCount + ' logged catch' + (collCount === 1 ? '' : 'es') + '</div></div>' +
'<button type="button" class="ghost dev-history-restore-btn" data-doc-id="' + doc.id + '">Restore</button>' +
'</div>';
}).join('');
list.querySelectorAll('.dev-history-restore-btn').forEach(function(btn) {
btn.addEventListener('click', function() {
restoreHistorySnapshot(btn.dataset.docId, overlay);
});
});
}).catch(function(e) {
console.error('Failed to load history', e);
list.innerHTML = '<div class="dev-history-empty">Couldn\'t load snapshot history.</div>';
});
}
function restoreHistorySnapshot(docId, overlay) {
if (!confirm('Restore this snapshot? Your current hunts and collection will be replaced with what was saved at that point.')) return;
HISTORY_COLLECTION.doc(docId).get().then(function(doc) {
if (!doc.exists) {
alert('That snapshot is no longer available.');
return;
}
var clean = normaliseCloudState(doc.data());
state = clean;
try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
renderAll();
save();
overlay.remove();
}).catch(function(e) {
console.error('Restore failed', e);
alert('Restore failed - check your connection and try again.');
});
}
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
// Stars are placed at fully random positions across the whole viewport,
// which occasionally drops one right at the very top edge - directly
// behind the Living Dex shell's rounded top corners, where it reads as
// a stray blue blip sitting on the corner-groove artwork. Keeping a
// clear band at the top (and a smaller one at the bottom, for symmetry)
// avoids that coincidental overlap without changing how the starfield
// looks anywhere else on the page.
var TOP_CLEAR_PERCENT = 8;
var BOTTOM_CLEAR_PERCENT = 4;
var usableRange = 100 - TOP_CLEAR_PERCENT - BOTTOM_CLEAR_PERCENT;
for (var i = 0; i < 60; i++) {
var s = document.createElement('div');
s.className = 'star';
s.style.left = (Math.random() * 100) + '%';
s.style.top = (TOP_CLEAR_PERCENT + Math.random() * usableRange) + '%';
s.style.animationDelay = (Math.random() * 4) + 's';
container.appendChild(s);
}})


// Populate the interface from local state immediately. Cloud sync can return
// an identical payload and intentionally skip its later render pass, so this
// initial render is required for a valid saved tracker to appear on first load.
