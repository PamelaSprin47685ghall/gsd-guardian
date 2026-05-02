export function extractText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(part => part?.text || (typeof part === "string" ? part : "")).join("");
  }
  if (typeof value === "object") {
    return value.text || value.message || value.content || JSON.stringify(value);
  }
  return String(value);
}
