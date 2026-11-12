// Deterministic, local-only helpers. Nothing in this file talks to a network.
// The model decides WHAT looks private; these rules do the counting, swapping and checking.

const RULES = [
  { kind: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'URL', re: /\bhttps?:\/\/[^\s)]+/g },
  { kind: 'CARD', re: /\b(?:\d[ -]?){13,19}\b/g },
  { kind: 'PHONE', re: /(?:\+?\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]?\d{3,4}[ .-]?\d{3,4}\b/g },
  { kind: 'ID', re: /\b(?:SSN|ID|Account|Acct|Policy|Case|Ref|Member)\s*(?:No\.?|Number|#)?\s*[:#]?\s*[A-Z0-9-]{5,}\b/gi },
  { kind: 'ADDRESS', re: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b\.?(?:,?\s*(?:Apt|Unit|Suite|#)\s*[A-Za-z0-9-]+)?/g },
  { kind: 'MONEY', re: /[$\u20ac\u00a3]\s?\d[\d,]*(?:\.\d{1,2})?/g },
  { kind: 'ORG', re: /\b(?:[A-Z][a-z']+\s){1,3}(?:Clinic|Hospital|Medical Center|Bank|School|University|Insurance|Office|Agency|Inc|LLC|Ltd|Living|Properties|Pharmacy)\b\.?/g },
  { kind: 'PERSON', re: /\b(?:Dr|Mr|Mrs|Ms|Mx)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g },
  { kind: 'PERSON', re: /\b(?:son|daughter|wife|husband|partner|mother|father|manager|landlord|doctor|nurse|boss|name is|named|I am|I'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g, group: 1 },
  { kind: 'PERSON', re: /\b[A-Z][a-z]+\s+[A-Z][a-z]{2,}\b/g, skipCommon: true },
  { kind: 'HEALTH', re: /\b(?:asthma|diabetes|cancer|depression|anxiety|ADHD|autism|epilepsy|HIV|pregnan(?:t|cy)|miscarriage|chemotherapy|dialysis|PTSD|bipolar|schizophrenia|dementia|insulin|inhaler|antidepressants?)\b/gi },
  { kind: 'DATE_OF_BIRTH', re: /\b(?:DOB|born on|date of birth)[:\s]+[A-Za-z0-9 ,/.-]{6,20}/gi },
];

const COMMON = new Set(['Hi','Hello','Dear','Please','Thanks','Thank','The','This','That','Since','My','Our','Your','I','He','She','They','We','It','But','And','So','If','When','Last','Next','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday','January','February','March','April','May','June','July','August','September','October','November','December','Jan','Feb','Mar','Apr','Jun','Jul','Aug','Sep','Sept','Oct','Nov','Dec','Avenue','Street','Road','Unit','Apt','Clinic','Hospital','Office','Children','City','Living']);

export const KIND_LABEL = {
  PERSON: 'Person', ORG: 'Organization', PLACE: 'Place', ADDRESS: 'Address', EMAIL: 'Email',
  PHONE: 'Phone', CARD: 'Card number', ID: 'ID number', URL: 'Link', HEALTH: 'Health detail',
  MONEY: 'Money amount', DATE_OF_BIRTH: 'Birth date', OTHER: 'Private detail',
};

export function ruleScan(text) {
  const found = [];
  for (const r of RULES) {
    for (const m of text.matchAll(r.re)) {
      const v = (r.group ? m[r.group] : m[0]).trim().replace(/[.,;:]+$/, '');
      if (r.skipCommon && v.split(/\s+/).some(w => COMMON.has(w))) continue;
      if (v.length >= 3) found.push({ value: v, kind: r.kind, by: 'rule' });
    }
  }
  return found;
}

// Merge model and rule findings, keep only values that really appear in the text,
// drop duplicates and values that sit inside a longer value.
export function mergeFindings(text, lists) {
  const all = lists.flat().filter(f => f && typeof f.value === 'string');
  const seen = new Map();
  for (const f of all) {
    const v = f.value.trim();
    if (v.length < 2 || !text.includes(v)) continue;
    const key = v.toLowerCase();
    if (!seen.has(key)) seen.set(key, { value: v, kind: (KIND_LABEL[f.kind] ? f.kind : 'OTHER'), by: f.by, on: true });
  }
  const items = [...seen.values()];
  // drop a value only if it never appears outside a longer found value
  return items.filter(a => !items.some(b => b !== a && b.value.length > a.value.length && b.value.includes(a.value) && !text.split(b.value).join('').includes(a.value)));
}

// Build stand-in tokens such as [PERSON_1]. Same value always gets the same token.
export function buildMap(items) {
  const counters = {};
  const map = [];
  for (const it of items.filter(i => i.on)) {
    counters[it.kind] = (counters[it.kind] || 0) + 1;
    map.push({ token: `[${it.kind}_${counters[it.kind]}]`, value: it.value, kind: it.kind });
  }
  return map;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function maskText(text, map) {
  let out = text;
  // longest first so "Dana Whitfield" is swapped before "Dana"
  for (const m of [...map].sort((a, b) => b.value.length - a.value.length)) {
    out = out.replace(new RegExp(escapeRe(m.value), 'g'), m.token);
  }
  return out;
}

// The leak check that runs right before anything leaves the device.
export function leakCheck(outbound, map) {
  const lower = outbound.toLowerCase();
  return map.filter(m => lower.includes(m.value.toLowerCase())).map(m => m.value);
}

export function restoreText(text, map) {
  let out = text;
  const used = [];
  for (const m of map) {
    if (out.includes(m.token)) { used.push(m.token); out = out.split(m.token).join(m.value); }
  }
  const missing = map.filter(m => !used.includes(m.token)).map(m => m.token);
  const unknown = [...new Set((out.match(/\[[A-Z_]+_\d+\]/g) || []))];
  return { text: out, used, missing, unknown };
}
