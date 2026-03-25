export function normalizeDomain(value = "") {
  try {
    const withProtocol = value.startsWith("http") ? value : `https://${value}`;
    return new URL(withProtocol).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return value.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  }
}

export function matchesWebsiteDomain(input, websiteDomain) {
  const source = normalizeDomain(input || "");
  const target = normalizeDomain(websiteDomain || "");
  return Boolean(source && target && (source === target || source.endsWith(`.${target}`)));
}
