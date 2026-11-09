export function matchesShortcut(event: KeyboardEvent, binding: string) {
  const parts = binding
    .toLowerCase()
    .split("+")
    .map((p) => p.trim());
  const key = parts.pop();
  if (!key) return false;
  return (
    event.key.toLowerCase() === (key === "space" ? " " : key) &&
    event.ctrlKey === parts.some((p) => p === "control" || p === "ctrl") &&
    event.metaKey === parts.some((p) => p === "meta" || p === "cmd") &&
    event.shiftKey === parts.includes("shift") &&
    event.altKey === parts.includes("alt")
  );
}
export function validateShortcuts(shortcuts: Record<string, string>) {
  const seen = new Set<string>();
  for (const [action, binding] of Object.entries(shortcuts)) {
    if (!binding.trim()) throw new Error(`快捷键 ${action} 不能为空。`);
    const key = binding
      .toLowerCase()
      .replace(/ctrl/g, "control")
      .replace(/\s/g, "");
    if (seen.has(key)) throw new Error(`快捷键冲突：${binding}`);
    if (["alt+f4", "control+alt+delete", "meta", "control+l"].includes(key))
      throw new Error(`快捷键由系统保留：${binding}`);
    seen.add(key);
  }
}
