const HAN_MAP = new Map(Object.entries({
  '銀': '银', '翼': '翼', '殺': '杀', '將': '将', '軍': '军', '術': '术', '師': '师', '疊': '叠', '畫': '画', '動': '动', '劇': '剧', '與': '与', '後': '后', '來': '来', '貓': '猫', '龍': '龙', '記': '记', '憶': '忆', '開': '开', '關': '关', '見': '见', '兩': '两', '個': '个', '時': '时', '國': '国', '間': '间', '異': '异', '萬': '万'
}));

const SEASON_MONTH = { 冬: 0, 春: 3, 夏: 6, 秋: 9 };
function premiereStamp(item) {
  const exact = Date.parse(item?.airedAt || '');
  if (Number.isFinite(exact)) return exact;
  if (Number.isInteger(item?.year)) return Date.UTC(item.year, SEASON_MONTH[item.season] ?? 0, 1);
  return 0;
}

export function normalizeText(input = '') {
  return String(input)
    .normalize('NFKD')
    .toLowerCase()
    .split('')
    .map((char) => HAN_MAP.get(char) || char)
    .join('')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function grams(value) {
  const chars = [...value];
  if (chars.length <= 2) return new Set(chars);
  const result = new Set();
  for (let index = 0; index <= chars.length - 2; index += 1) result.add(chars.slice(index, index + 2).join(''));
  return result;
}

function dice(a, b) {
  const left = grams(a);
  const right = grams(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  left.forEach((item) => { if (right.has(item)) overlap += 1; });
  return (2 * overlap) / (left.size + right.size);
}

export function damerauLevenshtein(a, b, cap = 160) {
  const left = [...a].slice(0, cap);
  const right = [...b].slice(0, cap);
  const rows = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) rows[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + cost);
      }
    }
  }
  return rows[left.length][right.length];
}

export function scoreEntry(entry, rawQuery) {
  const query = normalizeText(rawQuery);
  if (!query) return 1;
  const primary = normalizeText(entry.title);
  const fields = [entry.title, entry.originalTitle, ...(entry.aliases || []), ...(entry.tags || []), ...(entry.genres || []), entry.year, entry.type, entry.format]
    .filter(Boolean)
    .map(normalizeText);

  let best = 0;
  for (const field of fields) {
    if (!field) continue;
    if (field === query) best = Math.max(best, field === primary ? 1 : .96);
    else if (field.startsWith(query)) best = Math.max(best, field === primary ? .93 : .87);
    else if (field.includes(query)) best = Math.max(best, field === primary ? .87 : .79);
    if (query.length > 1) {
      const similarity = dice(field, query);
      // Do not score truncated prefixes as though the entire title matched.
      const distance = Math.abs(field.length-query.length) < 5 ? damerauLevenshtein(field, query) : Math.max(field.length,query.length);
      const edit = 1 - distance / Math.max(field.length, query.length, 1);
      best = Math.max(best, similarity * .72, edit * .78);
      // Approximate substring matching: a typo in a short alias can still match a long title.
      if (query.length >= 3 && field.length > query.length) {
        let row = Array(field.length+1).fill(0);
        for(let i=1;i<=query.length;i++) {
          const next=[i];
          for(let j=1;j<=field.length;j++) next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(query[i-1]===field[j-1]?0:1));
          row=next;
        }
        best=Math.max(best,(1-Math.min(...row)/query.length)*.72);
      }
    }
  }
  const combined = normalizeText(fields.join(' '));
  if (combined.includes(query)) best = Math.max(best, .73);
  return Number(best.toFixed(4));
}

export function fuzzySearch(entries, query, options = {}) {
  const terms = String(query).trim().split(/\s+/).filter(Boolean).slice(0,8);
  const normalizedQuery = normalizeText(query);
  // A low edit-distance score is useful for short typos, but becomes noisy
  // for a long query against an unrelated title. Keep the tolerant .46 floor
  // for CJK typos while requiring a real Latin-word signal for English input.
  const threshold = normalizedQuery.length <= 2 ? .52 : .46;
  return entries
    .filter((entry) => !options.type || options.type === 'all' || entry.type === options.type)
    .map((entry) => {
      const score = Math.max(scoreEntry(entry, query), terms.length > 1 && terms.every(t => scoreEntry(entry,t)>=.65) ? .8 : 0);
      const fields = [entry.title, entry.originalTitle, ...(entry.aliases || [])].filter(Boolean).map(normalizeText);
      const latinTerms = terms.map(normalizeText).filter(term => /[a-z]/.test(term));
      // Do not let the edit-distance fallback return Chinese/Japanese titles
      // for an unrelated Latin query such as “SEVERANCE”. A direct or close
      // match in a title/alias remains fully supported (Frieren, romaji, etc.).
      const latinSignal = !latinTerms.length || latinTerms.some(term => fields.some(field => field.includes(term) || term.includes(field) || (/[a-z]/.test(field) && scoreEntry(entry, term) >= .65)));
      return { entry, score, latinSignal };
    })
    .filter((item) => !normalizedQuery || (item.score >= threshold && item.latinSignal))
    // Equal fuzzy scores follow catalogue chronology, never local import or
    // edit timestamps. Unknown premiere dates stay last and title supplies a
    // stable final order.
    .sort((a, b) => b.score - a.score || premiereStamp(b.entry) - premiereStamp(a.entry) || a.entry.title.localeCompare(b.entry.title, 'zh'));
}
