const PLACEHOLDER = /^local_(\d+)$/;

export function localNamesFor(tables, frame) {
  const functions = tables?.[frame.file];
  if (!Array.isArray(functions)) return null;
  return functions.find((entry) => entry.name === frame.name && entry.line === frame.first)?.locals ?? null;
}

export function nameLocals(variables, tables, frame) {
  const names = localNamesFor(tables, frame);
  if (!names) return variables;
  return variables
    .map((variable) => {
      const match = variable.name.match(PLACEHOLDER);
      const name = match ? names[Number(match[1])] : null;
      return name ? { ...variable, name } : variable;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
