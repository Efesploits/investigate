/* Countries and their subdivisions, loaded once from the generated
 * regions.json. Two consumers with different needs:
 *
 *   the picker  wants every entry, including the dependencies and islands, so
 *               an analyst can narrow to somewhere obscure by hand.
 *   the model   wants only places a street photograph could plausibly come
 *               from — leaving Antarctica and a dozen uninhabited rocks in the
 *               country softmax only bleeds probability off the real answer.
 */
"use strict";
const data = require("./regions.json");

const byCode = new Map(data.countries.map((c) => [c.c, c]));
const subMaps = new Map();   // country code -> Map(sub code -> sub)

const country = (code) => byCode.get(String(code || "").toUpperCase()) || null;

function subdivisions(code) {
  const c = country(code);
  return c ? c.subs : [];
}

/* Codes are stored the way ISO writes them ("NL-UT"), but a caller that
 * already knows the country reasonably passes just "UT" — accept either. */
function subdivision(countryCode, subCode) {
  const c = country(countryCode);
  if (!c) return null;
  if (!subMaps.has(c.c)) subMaps.set(c.c, new Map(c.subs.map((s) => [s.c, s])));
  const map = subMaps.get(c.c);
  const raw = String(subCode || "").trim();
  if (!raw) return null;
  return map.get(raw) || map.get(c.c + "-" + raw.toUpperCase()) || null;
}

/** Countries worth putting in front of the model. */
const scorable = () => data.countries.filter((c) => !c.x);

/* A country's ISO list often mixes admin levels, and the odd ones out are
 * frequently nowhere near the mainland: the Netherlands carries Aruba and Sint
 * Eustatius alongside its twelve provinces, and a photograph of an Amsterdam
 * canal was landing on a Caribbean island because the rarer name scored higher.
 * Offering the model only the country's primary level — the type it has most
 * of — keeps the guess on the right land mass. The picker still lists
 * everything, because an analyst may well mean Aruba. */
const modalCache = new Map();
function scorableSubdivisions(code) {
  const c = country(code);
  if (!c) return [];
  if (modalCache.has(c.c)) return modalCache.get(c.c);
  const counts = new Map();
  c.subs.forEach((s) => counts.set(s.t, (counts.get(s.t) || 0) + 1));
  let modal = null, best = 0;
  counts.forEach((n, t) => { if (n > best) { best = n; modal = t; } });
  const picked = best >= 2 ? c.subs.filter((s) => s.t === modal) : c.subs;
  modalCache.set(c.c, picked);
  return picked;
}

/** What to write in a caption — "South Korea", not "Korea, Republic of".
 *  The same rewrite is what a person wants to read, so it doubles as the
 *  display name; the raw ISO spelling never reaches a screen. */
const promptName = (c) => (c && (c.p || c.n)) || "";
const displayName = promptName;

const typeName = (i) => data.types[i] || "Region";

/** Shape the picker wants: subdivisions already grouped under their type so a
 *  country with 131 entries still reads as 22 regions plus 96 departments. */
function pickerList() {
  return data.countries.slice().sort((a, b) => displayName(a).localeCompare(displayName(b))).map((c) => {
    const groups = [];
    let current = null;
    for (const s of c.subs) {
      if (!current || current.t !== s.t) {
        current = { t: s.t, type: typeName(s.t), items: [] };
        groups.push(current);
      }
      current.items.push({ c: s.c, n: s.n });
    }
    return { code: c.c, name: displayName(c), groups: groups.map((g) => ({ type: g.type, items: g.items })) };
  });
}

module.exports = {
  country, subdivision, subdivisions, scorable, scorableSubdivisions, promptName, displayName, typeName, pickerList,
  count: data.countries.length,
};
