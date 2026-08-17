/** Collapses "Computer   Science" / " computer science " into a single
 *  consistent "Computer Science" shape — free-text department/programme
 *  fields otherwise fragment the admin department filter and the student
 *  "All departments" dropdown into near-duplicate entries that differ only
 *  by casing or stray whitespace. Doesn't rewrite existing rows (that's a
 *  separate, deliberate decision an admin should make) — only applied when
 *  a value is written (registration, profile edit), so it stops new ones
 *  from adding to the mess without silently rewriting anyone's existing
 *  data. */
function normalizeLabel(str) {
  if (!str) return str;
  return String(str)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

module.exports = { normalizeLabel };
