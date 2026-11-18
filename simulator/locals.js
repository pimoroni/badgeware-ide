const PLACEHOLDER = /^local_(\d+)$/;

export function functionFor(tables, frame) {
  const functions = tables?.[frame.file];
  if (!Array.isArray(functions)) return null;
  return functions.find((entry) => entry.name === frame.name && entry.line === frame.first) ?? null;
}

export function nameLocals(variables, tables, frame) {
  const entry = functionFor(tables, frame);
  if (!entry || !Number.isInteger(entry.n_state) || !Array.isArray(entry.locals)) return variables;
  const firstLocalSlot = entry.n_state - entry.locals.length;
  return variables
    .flatMap((variable) => {
      const match = variable.name.match(PLACEHOLDER);
      if (!match) return [variable];
      const slot = Number(match[1]);
      if (slot < firstLocalSlot || slot >= entry.n_state) return [];
      const name = entry.locals[entry.n_state - 1 - slot];
      return [name ? { ...variable, name } : variable];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
