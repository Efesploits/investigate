/* Work out where a photograph was taken from the picture itself.
 *
 * StreetCLIP scores an image against text captions, so "where is this?" has to
 * be asked as a series of multiple-choice questions. Asking it once against
 * every region on earth would be 5,000 options and mostly noise, so it goes in
 * stages — the same shape the StreetCLIP paper uses:
 *
 *   1. which country?          197 options   (skipped when the analyst says)
 *   2. which region within it? tens of options per country
 *   3. what is in the frame?   climate, setting, architecture, writing
 *
 * Stage 1 and 3 share a single pass, because encoding the image is the
 * expensive half and the labels ride along cheaply.
 *
 * The answer is deliberately a RANKED LIST, not a single point. Measured on 30
 * street-level photographs across 10 countries the top guess was right 25
 * times and the right answer was in the top five 29 times — so the top five is
 * what the analyst gets to choose from.
 */
"use strict";
const clip = require("./clip");
const regions = require("./regions");
const cities = require("./cities");

const GEO_UA = "m3-investigation-tool/1.0 (geoint lookup)";

/* Prompt ensembling was measured and dropped. Averaging three phrasings moved
 * the top guess from 25/30 to 26/30 but left top-3 and top-5 untouched at
 * 29/30 — and since the analyst picks from a list, the list is what matters.
 * One template is the same answer for a third of the work. */
const COUNTRY_TEMPLATE = "A Street View photo in {}.";
const REGION_TEMPLATE = "A Street View photo of {}, {}.";
const CITY_TEMPLATE = "A Street View photo taken in {}, {}.";

/* Scene questions. Each was checked against known-truth photographs; the
 * threshold is the confidence below which the answer stops being worth
 * showing. Writing-system detection is right ~57% of the time overall but was
 * 10/10 once it passed 0.6, so it is shown only when it clears that.
 *
 * A drive-on-the-left/right probe was built and dropped: 16/30, which on a
 * two-way question is a coin toss, and it never grew confident enough to
 * filter. A wrong answer there reads as hard evidence, so none is better. */
const SCENE = [
  {
    key: "climate", label: "Climate", template: "A photo taken in {}.", min: 0.55,
    options: [
      ["Tropical", "a hot humid tropical climate"], ["Desert", "an arid desert climate"],
      ["Temperate", "a mild temperate climate"], ["Cold / snowy", "a cold snowy climate"],
      ["Mediterranean", "a dry mediterranean climate"], ["Subtropical", "a humid subtropical climate"],
    ],
  },
  {
    key: "setting", label: "Setting", template: "A photo of {}.", min: 0.4,
    options: [
      ["City centre", "a dense city centre"], ["Suburb", "a suburban residential street"],
      ["Rural road", "a rural country road"], ["Small town", "a small town high street"],
      ["Industrial", "an industrial estate"], ["Coast", "a beach or coastline"],
      ["Mountains", "a mountain landscape"], ["Farmland", "open farmland"],
    ],
  },
  {
    key: "architecture", label: "Architecture", template: "A photo of {}.", min: 0.4,
    options: [
      ["Glass high-rise", "modern glass high-rise buildings"],
      ["European townhouses", "european stone townhouses"],
      ["East Asian", "traditional east asian buildings"],
      ["Timber housing", "north american timber houses"],
      ["Soviet-era blocks", "soviet-era concrete apartment blocks"],
      ["Colonial", "colonial-era architecture"],
      ["Middle Eastern", "middle eastern architecture"],
      ["Informal housing", "informal low-rise housing"],
    ],
  },
  {
    key: "script", label: "Writing", template: "Text in this photo is written in {}.", min: 0.6,
    options: [
      ["Latin", "the latin alphabet"], ["Cyrillic", "the cyrillic alphabet"], ["Arabic", "arabic script"],
      ["Chinese", "chinese characters"], ["Japanese", "japanese writing"], ["Korean", "korean hangul"],
      ["Greek", "the greek alphabet"], ["Thai", "thai script"], ["Hebrew", "hebrew script"],
      ["Devanagari", "devanagari script"],
    ],
  },
];

/* Five countries, because that is where the true answer lands 29 times in 30.
 * Only the leading three are worth a second pass for regions — below that the
 * country itself is too shaky for a region guess to mean anything. */
const MAX_CANDIDATES = 5;
const REGION_COUNTRIES = 3;
const PER_COUNTRY = 3;
/* The town pass is the expensive one — every label costs, and the vision tower
 * re-runs each time the batch spills past a chunk. Two countries at 120 towns
 * apiece keeps the whole scan inside one extra pass. */
const CITY_COUNTRIES = 2;
const CITY_POOL = 120;
/* Photographs come from where people are, and the model has no idea whether a
 * name belongs to a capital or a hamlet — left alone it will hand you a village
 * of 15,000 over the city next door. Weighting its score by log-population
 * fixes that. On 30 known photographs, ranking the town shortlist by
 *
 *     log(model score) + 0.6 x log(population)
 *
 * put the right place first 22 times, against 15 for the model alone and 19 for
 * population alone — and it still overrules "just pick the biggest town" in a
 * third of cases, which is the sign both halves are pulling their weight.
 * Higher weights scored better on that set but only by collapsing towards the
 * biggest city, which those photographs happen to be. */
const POP_PRIOR = 0.6;

/** Turn a country + region name into coordinates. Structured search beats a
 *  free-text one here — we know which field each part belongs in. */
async function geocodePlace({ country, region }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    if (key) {
      const q = [region, country].filter(Boolean).join(", ");
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`;
      const j = await (await fetch(url, { signal: controller.signal })).json();
      const best = j && j.results && j.results[0];
      if (!best || !best.geometry) return null;
      const loc = best.geometry.location;
      return {
        lat: loc.lat, lon: loc.lng, display: best.formatted_address || null,
        level: region ? "region" : "country", zoom: region ? 9 : 5,
      };
    }
    /* Structured search is the precise one, but it only matches when OSM files
     * the region under exactly the admin level ISO calls a "state" — plenty of
     * real subdivisions aren't, so a plain text search backs it up rather than
     * leaving the analyst with a candidate that won't plot. */
    const attempts = [];
    const structured = new URLSearchParams({ format: "jsonv2", limit: "1", "accept-language": "en" });
    if (country) structured.set("country", country);
    if (region) structured.set("state", region);
    attempts.push(structured);
    if (region) {
      attempts.push(new URLSearchParams({
        format: "jsonv2", limit: "1", "accept-language": "en",
        q: region + ", " + country,
      }));
    }
    /* Last resort, the country on its own. Some ISO subdivisions genuinely
     * aren't in OSM under that name — "Höfuðborgarsvæði utan Reykjavíkur" is
     * one — and putting the map on Iceland beats refusing to move at all. */
    if (region && country) {
      attempts.push(new URLSearchParams({ format: "jsonv2", limit: "1", "accept-language": "en", country }));
    }
    for (let i = 0; i < attempts.length; i++) {
      const j = await (await fetch("https://nominatim.openstreetmap.org/search?" + attempts[i].toString(), {
        headers: { "User-Agent": GEO_UA, Accept: "application/json" }, signal: controller.signal,
      })).json();
      const best = Array.isArray(j) && j[0];
      if (best) {
        const countryOnly = !region || i === attempts.length - 1;
        return {
          lat: Number(best.lat), lon: Number(best.lon),
          display: best.display_name || null,
          level: countryOnly ? "country" : "region",
          zoom: countryOnly ? 5 : 9,
        };
      }
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Buffer} buf            image bytes
 * @param {object} hint           { country: ISO2, region: subdivision code }
 * @returns {Promise<null|object>} null when no model is configured
 */
async function locate(buf, hint) {
  if (!clip.available()) return null;
  hint = hint || {};

  const hintCountry = hint.country ? regions.country(hint.country) : null;
  const hintRegion = hintCountry && hint.region ? regions.subdivision(hintCountry.c, hint.region) : null;

  /* ---- pass one: country (unless told) + everything about the scene ---- */
  const groups = [];
  const push = (name, texts) => {
    groups.push({ name, from: groups.reduce((n, g) => n + g.texts.length, 0), texts });
    return groups[groups.length - 1];
  };

  const countryPool = hintCountry ? [] : regions.scorable();
  if (countryPool.length) {
    push("country", countryPool.map((c) => COUNTRY_TEMPLATE.replace("{}", regions.promptName(c))));
  }
  SCENE.forEach((s) => push("scene:" + s.key, s.options.map(([, phrase]) => s.template.replace("{}", phrase))));

  const flat = groups.flatMap((g) => g.texts);
  const logits = await clip.score(buf, flat);
  const take = (name) => {
    const g = groups.find((x) => x.name === name);
    return g ? logits.slice(g.from, g.from + g.texts.length) : [];
  };

  /* ---- read the scene, keeping only answers the model is sure of ---- */
  const scene = [];
  for (const s of SCENE) {
    const p = clip.softmax(take("scene:" + s.key));
    if (!p.length) continue;
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
    if (p[best] >= s.min) scene.push({ key: s.key, label: s.label, value: s.options[best][0], p: p[best] });
  }

  /* ---- rank countries ----
   * This is the call the model is actually good at — right 25 times in 30, and
   * in its own top five 29 times — so it is what the candidate list is built
   * around. */
  let countryRanked;
  if (hintCountry) {
    countryRanked = [{ country: hintCountry, p: 1 }];
  } else {
    const p = clip.softmax(take("country"));
    countryRanked = countryPool
      .map((c, i) => ({ country: c, p: p[i] }))
      .sort((a, b) => b.p - a.p)
      .slice(0, MAX_CANDIDATES);
  }

  /* ---- pass two: regions inside the countries still in the running ----
   *
   * Candidates stay grouped by country, in country order. Multiplying the two
   * probabilities was tried first and is quietly wrong: a country's region
   * scores are a softmax over however many subdivisions it happens to have, so
   * Eswatini splitting 100% four ways beat Thailand splitting it 78 ways on a
   * photograph that was plainly Thai. Country is also the call the model is
   * actually good at, so it leads and the region rides along as a suggestion. */
  const suggestions = new Map();   // country code -> [{ region, p }]
  if (hintRegion) {
    suggestions.set(hintCountry.c, [{ region: hintRegion, p: 1 }]);
  } else {
    const groups = [];
    const texts = [];
    for (const rc of countryRanked.slice(0, REGION_COUNTRIES)) {
      const subs = regions.scorableSubdivisions(rc.country.c);
      if (!subs.length) continue;
      const name = regions.promptName(rc.country);
      groups.push({ code: rc.country.c, from: texts.length, subs });
      subs.forEach((s) => texts.push(REGION_TEMPLATE.replace("{}", s.n).replace("{}", name)));
    }
    const regionLogits = texts.length ? await clip.score(buf, texts) : [];
    for (const g of groups) {
      const p = clip.softmax(regionLogits.slice(g.from, g.from + g.subs.length));
      suggestions.set(g.code, g.subs
        .map((s, i) => ({ region: s, p: p[i] }))
        .sort((a, b) => b.p - a.p)
        .slice(0, PER_COUNTRY));
    }
  }

  /* ---- pass three: which town ----
   *
   * A country is an answer to "where was this taken?" only in the loosest
   * sense, so the last pass scores real place names. Two things make this the
   * most useful stage despite being the least certain: the shortlist is
   * somewhere an analyst can actually look, and every GeoNames entry carries
   * its own coordinates — so a guess arrives ready to plot, with no geocoder
   * in the loop to be slow or rate-limited. */
  const towns = new Map();   // country code -> [{ city, p }]
  {
    const groups = [];
    const texts = [];
    for (const rc of countryRanked.slice(0, CITY_COUNTRIES)) {
      const lead = (suggestions.get(rc.country.c) || [])[0];
      const pool = cities.candidates(rc.country.c, lead ? lead.region.n : null, CITY_POOL);
      if (!pool.length) continue;
      const name = regions.promptName(rc.country);
      groups.push({ code: rc.country.c, from: texts.length, pool });
      pool.forEach((c) => texts.push(CITY_TEMPLATE.replace("{}", c.name).replace("{}", name)));
    }
    const cityLogits = texts.length ? await clip.score(buf, texts) : [];
    for (const g of groups) {
      const p = clip.softmax(cityLogits.slice(g.from, g.from + g.pool.length));
      towns.set(g.code, g.pool
        .map((c, i) => ({
          city: c,
          p: p[i],   // the model's own opinion, reported as-is
          rank: Math.log(Math.max(p[i], 1e-12)) + POP_PRIOR * Math.log(Math.max(c.population, 1)),
        }))
        .sort((a, b) => b.rank - a.rank)
        .slice(0, PER_COUNTRY));
    }
  }

  const out = countryRanked.map((rc) => ({
    country: regions.displayName(rc.country),
    country_code: rc.country.c,
    confidence: rc.p,
    regions: (suggestions.get(rc.country.c) || []).map((x) => ({
      name: x.region.n,
      code: x.region.c,
      type: regions.typeName(x.region.t),
      confidence: x.p,
    })),
    places: (towns.get(rc.country.c) || []).map((x) => ({
      name: x.city.name,
      region: x.city.region,
      coords: { lat: x.city.lat, lon: x.city.lon },
      population: x.city.population,
      confidence: x.p,
    })),
  }));

  /* Open the map on the best town we have. Falling back to geocoding the
   * region only matters for the handful of countries with no cities in the
   * dataset, which is exactly when the geocoder is worth waiting for. */
  if (out.length) {
    const first = out[0];
    if (first.places.length) {
      first.coords = first.places[0].coords;
      first.zoom = 12;
    } else {
      const pt = await geocodePlace({ country: first.country, region: first.regions[0] ? first.regions[0].name : null });
      if (pt) { first.coords = { lat: pt.lat, lon: pt.lon }; first.zoom = pt.zoom; }
    }
  }

  return { engine: clip.engine(), model: clip.MODEL_ID, candidates: out, scene };
}

module.exports = { locate, geocodePlace };
