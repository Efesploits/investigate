/* One-off generator for regions.json — run it, don't ship it.
 *
 *   npm i --no-save iso-3166-2 && node geoint/build-regions.js
 *
 * The output is checked in, so the server has no runtime dependency on the
 * package and no network call to fill the country/region pickers.
 *
 * Two things the raw ISO data can't give us and we add here:
 *   - prompt labels. StreetCLIP was trained on natural English captions, so
 *     "South Korea" scores far better than the registry's "Korea, Republic of".
 *   - a scoring flag. Uninhabited rocks and dependencies with one ISO entry
 *     (Bouvet Island, Heard & McDonald, Antarctica…) never win honestly but do
 *     soak up probability mass in the country softmax, so they're excluded from
 *     the model's label set while staying selectable in the picker.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const iso = require("iso-3166-2");

/* Registry spelling -> what a person would actually write in a caption.
 * Only the names that are genuinely unnatural are rewritten. Adding a definite
 * article ("the Netherlands", "the United States") was tried and measured
 * slightly WORSE on the benchmark, so the bare ISO name stays everywhere it
 * already reads like English. */
const PROMPT_LABEL = {
  "Korea, Republic of": "South Korea",
  "Korea, Democratic People's Republic Of": "North Korea",
  "Congo, The Democratic Republic Of The": "Democratic Republic of the Congo",
  "Macedonia, the Former Yugoslav Republic Of": "North Macedonia",
  "Micronesia, Federated States Of": "Micronesia",
  "Viet Nam": "Vietnam",
  "Côte D'Ivoire": "Ivory Coast",
  "Swaziland": "Eswatini",
  "Czech Republic": "Czechia",
  "Brunei Darussalam": "Brunei",
  "Saint Helena, Ascension and Tristan Da Cunha": "Saint Helena",
  "Cocos  Islands": "Cocos Islands",
  "Bonaire, Sint Eustatius and Saba": "Bonaire",
  "Saint Kitts And Nevis": "Saint Kitts and Nevis",
  "Saint Vincent And The Grenadines": "Saint Vincent and the Grenadines",
  "Holy See (Vatican City State)": "Vatican City",
};

// Excluded from the model's country label set only (still pickable by hand).
const NO_SCORE = new Set([
  "AQ", "BV", "HM", "GS", "TF", "UM", "IO", "CC", "CX", "NF", "PN", "TK", "SJ",
  "AX", "NU", "WF", "MS", "SH", "FK", "BQ", "BL", "MF", "SX", "AI", "TC", "VG",
  "KY", "PM", "GG", "JE", "IM", "YT", "RE", "GP", "MQ", "GF", "AS", "CK", "NR",
  "TV", "PW", "MH", "KI", "FM", "ST", "VA", "SM", "AD", "LI", "MC", "EH", "TL",
]);

/* ISO mixes admin levels inside one country — France carries both its 22
 * regions and its 96 departments. Ranking the types coarsest-first puts the
 * level people actually think in at the top of the picker, and the rest below
 * it under their own heading. Anything unlisted lands in the middle. */
const RANK = {};
const rank = (n, list) => list.forEach((t) => { RANK[t] = n; });
rank(10, ["Country", "Nation", "State", "Region", "Administrative region", "Metropolitan region",
  "Länder", "Federal länder", "Autonomous community", "Autonomous region", "Geographical region",
  "Development region", "Division", "Zone", "Emirate", "Republic", "Oblast", "Entity", "Territory",
  "Union territory", "Federal territory", "Capital territory", "Federal district", "Federal District",
  "Special administrative region", "Autonomous republic", "Geographical unit", "Group of islands",
  "Islands, groups of islands", "Arctic region", "Chain", "Special region", "Geographical entity"]);
rank(20, ["Province", "Governorate", "Prefecture", "County", "Department", "Canton",
  "Metropolitan department", "Autonomous province", "Metropolitan city", "Economic prefecture",
  "Special self-governing province", "Popularate", "Administrative atoll", "Regional council",
  "Island council", "Overseas department", "Overseas territorial collectivity", "Indigenous region"]);
rank(30, ["District", "Rayon", "Two-tier county", "Metropolitan district", "District council area",
  "Council area", "Unitary authority", "Autonomous district", "Administrative territory",
  "District with special status", "Special district", "Territorial unit", "Autonomous territorial unit"]);
rank(40, ["Municipality", "Commune", "Parish", "City", "Town", "Local council", "London borough",
  "District municipality", "City municipality", "Quarter", "Capital city", "Capital", "Special city",
  "Special municipality", "Republican city", "City of county right", "Special administrative city",
  "Special self-governing city", "Town council", "Urban community", "Island", "Area", "Autonomous city",
  "Autonomous municipality", "Autonomous sector", "City corporation", "Capital district",
  "Autonomous city in north africa", "Special island authority", "Special zone", "Outlying area",
  "Administration", "Dependency", "Federal dependency", "Federal capital territory",
  "Pakistan administered area", "Metropolitan administration"]);
const rankOf = (t) => (RANK[t] != null ? RANK[t] : 25);

const types = [];
const typeIndex = (t) => {
  const s = String(t || "Region");
  let i = types.indexOf(s);
  if (i < 0) { i = types.length; types.push(s); }
  return i;
};

const countries = Object.keys(iso.data)
  .map((code) => {
    const c = iso.data[code];
    const subs = Object.keys(c.sub || {})
      .map((sc) => ({ c: sc, n: c.sub[sc].name, t: typeIndex(c.sub[sc].type), _r: rankOf(c.sub[sc].type) }))
      // one subdivision that just restates the country is noise in a picker
      .filter((s) => s.n && s.n.toLowerCase() !== c.name.toLowerCase())
      .sort((a, b) => a._r - b._r || types[a.t].localeCompare(types[b.t]) || a.n.localeCompare(b.n))
      .map((s) => ({ c: s.c, n: s.n, t: s.t }));
    const out = { c: code, n: c.name, subs };
    const label = PROMPT_LABEL[c.name];
    if (label && label !== c.name) out.p = label;
    if (NO_SCORE.has(code)) out.x = 1;   // excluded from model scoring
    return out;
  })
  .sort((a, b) => a.n.localeCompare(b.n));

const out = {
  note: "Generated by geoint/build-regions.js from ISO 3166-1/-2. Do not edit by hand.",
  types,
  countries,
};
const file = path.join(__dirname, "regions.json");
fs.writeFileSync(file, JSON.stringify(out));

const subs = countries.reduce((n, c) => n + c.subs.length, 0);
console.log(
  `regions.json: ${countries.length} countries (${countries.filter((c) => !c.x).length} scored), ` +
  `${subs} subdivisions, ${types.length} types, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`
);
