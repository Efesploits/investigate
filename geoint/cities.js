/* Candidate towns to put in front of the model, with coordinates attached.
 *
 * The point of this stage is precision: the country call is reliable but
 * "somewhere in Brazil" isn't a location. Scoring real place names narrows it
 * to a town, and because GeoNames ships coordinates with each one, the answer
 * arrives ready to plot — no geocoder in the loop.
 *
 * Loaded lazily: it's 1.4MB of JSON, and a server with no model configured
 * should never pay for it.
 */
"use strict";

let data = null;
function load() {
  if (!data) data = require("./cities.json");
  return data;
}

/** Accent- and punctuation-insensitive, because GeoNames and ISO disagree on
 *  how to spell the same region far more often than on which region it is. */
function norm(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const shape = (d, row) => ({
  name: row[0],
  region: row[1] >= 0 ? d.regions[row[1]] : null,
  lat: row[2],
  lon: row[3],
  population: row[4],
});

/**
 * Towns worth asking about for one country.
 *
 * @param {string} cc          ISO country code
 * @param {string|null} region region the model leaned towards, if any
 * @param {number} limit       how many labels this stage can afford
 *
 * Cities in the guessed region come first — that's the whole reason the region
 * stage runs — but the list is always topped up with the country's largest
 * places, because the region guess is the shakiest link in the chain and
 * shouldn't be able to hide the right answer completely.
 */
function candidates(cc, region, limit) {
  const d = load();
  const rows = d.byCountry[String(cc || "").toUpperCase()];
  if (!rows || !rows.length) return [];
  const cap = Math.max(1, limit || 120);

  if (!region) return rows.slice(0, cap).map((r) => shape(d, r));

  const want = norm(region);
  const inRegion = [], rest = [];
  for (const r of rows) {
    const rn = r[1] >= 0 ? d.regions[r[1]] : null;
    (rn && norm(rn) === want ? inRegion : rest).push(r);
  }
  // keep at least a third of the slots for the rest of the country
  const keep = Math.min(inRegion.length, Math.ceil(cap * 0.66));
  return inRegion.slice(0, keep).concat(rest.slice(0, cap - keep)).map((r) => shape(d, r));
}

/** Is there anything to offer for this country at all? */
function has(cc) {
  const rows = load().byCountry[String(cc || "").toUpperCase()];
  return !!(rows && rows.length);
}

const attribution = () => load().attribution;

module.exports = { candidates, has, attribution, norm };
