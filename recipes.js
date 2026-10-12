function amount(value) {
  if (value.includes('/')) {
    const [top, bottom] = value.split('/').map(Number);
    return bottom ? top / bottom : null;
  }
  return Number(value);
}

function displayAmount(value) {
  const rounded = Math.round(value * 8) / 8;
  const whole = Math.floor(rounded);
  const fraction = Math.round((rounded - whole) * 8);
  const fractions = { 1: '1/8', 2: '1/4', 3: '3/8', 4: '1/2', 5: '5/8', 6: '3/4', 7: '7/8' };
  if (!fraction) return String(whole);
  return `${whole ? `${whole} ` : ''}${fractions[fraction]}`;
}

export function scaleIngredients(ingredients, originalServings, targetServings) {
  const factor = targetServings / originalServings;
  return ingredients
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*)(\d+(?:\.\d+)?|\d+\/\d+)(?:\s+(\d+\/\d+))?(\s+.*)$/);
      if (!match) return line;
      const quantity = amount(match[2]) + (match[3] ? amount(match[3]) : 0);
      if (!Number.isFinite(quantity)) return line;
      const scaled = quantity * factor;
      const rest = match[4].replace(
        /^(\s+)(cup|clove|tablespoon|teaspoon)s?\b/i,
        (_, space, unit) => `${space}${unit}${scaled === 1 ? '' : 's'}`,
      );
      return `${match[1]}${displayAmount(scaled)}${rest}`;
    })
    .join('\n');
}

const units = new Map([
  ['cup', 'cup'],
  ['cups', 'cup'],
  ['tbsp', 'tbsp'],
  ['tablespoon', 'tbsp'],
  ['tablespoons', 'tbsp'],
  ['tsp', 'tsp'],
  ['teaspoon', 'tsp'],
  ['teaspoons', 'tsp'],
  ['oz', 'oz'],
  ['ounce', 'oz'],
  ['ounces', 'oz'],
  ['lb', 'lb'],
  ['lbs', 'lb'],
  ['pound', 'lb'],
  ['pounds', 'lb'],
  ['g', 'g'],
  ['gram', 'g'],
  ['grams', 'g'],
  ['kg', 'kg'],
  ['ml', 'ml'],
  ['l', 'l'],
  ['clove', 'clove'],
  ['cloves', 'clove'],
]);

export function ingredientPart(line) {
  const match = line.trim().match(/^(\d+(?:\.\d+)?|\d+\/\d+)(?:\s+(\d+\/\d+))?\s+(.+)$/);
  if (!match) return null;
  const quantity = amount(match[1]) + (match[2] ? amount(match[2]) : 0);
  if (!Number.isFinite(quantity)) return null;
  const [first, ...rest] = match[3].trim().split(/\s+/);
  const unit = rest.length ? units.get(first.toLowerCase().replace(/\.$/, '')) : null;
  const name = unit ? rest.join(' ') : match[3].trim();
  const normalized = name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .replace(/\b([a-z]{3,})s\b$/, '$1');
  return { quantity, unit: unit || '', name, key: `${unit || ''}:${normalized}` };
}

export function aggregateIngredients(lines) {
  const combined = new Map();
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    const part = ingredientPart(line);
    const key = part?.key || `text:${line.toLowerCase()}`;
    if (combined.has(key)) {
      if (part) combined.get(key).quantity += part.quantity;
    } else {
      combined.set(key, part || { text: line });
    }
  }
  return [...combined.values()].map((part) => part.text || formatIngredient(part));
}

export function formatIngredient(part) {
  const plural = part.quantity !== 1;
  const unit =
    part.unit && !['tbsp', 'tsp', 'oz', 'lb', 'g', 'kg', 'ml', 'l'].includes(part.unit)
      ? `${part.unit}${plural ? 's' : ''}`
      : part.unit;
  const name =
    !unit && /^[a-z]+$/i.test(part.name) && plural && !part.name.endsWith('s')
      ? `${part.name}s`
      : part.name;
  return [displayAmount(part.quantity), unit, name].filter(Boolean).join(' ');
}
