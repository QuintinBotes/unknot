// A deliberately tiny JSON Schema subset validator for the MCP tool inputSchemas. It
// supports exactly what those schemas use (type, enum, pattern, min/max, lengths, items,
// properties, required, additionalProperties) so the server needs no dependency.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [path]
 * @returns {string[]} human-readable problems; empty when valid
 */
export function validateAgainst(value, schema, path = '$') {
  const errors = [];
  const t = typeOf(value);
  if (schema.type) {
    const ok = schema.type === 'integer' ? Number.isInteger(value) : schema.type === t;
    if (!ok) return [`${path}: expected ${schema.type}, got ${t}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (t === 'array') {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validateAgainst(v, schema.items, `${path}[${i}]`)));
  }
  if (t === 'object') {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}: missing required property ${key}`);
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) errors.push(...validateAgainst(v, props[k], `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unknown property ${k}`);
    }
  }
  return errors;
}
