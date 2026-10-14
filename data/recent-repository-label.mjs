/**
 * @typedef {object} RecentRepositoryTarget
 * @property {string} kind
 * @property {string} location
 * @property {string} [requestedRef]
 * @property {string} [resolvedRef]
 * @property {string} [commit]
 * @property {string} [subdirectory]
 */

/** @param {RecentRepositoryTarget} recent */
export function recentRepositoryOpenLocation(recent) {
  if (recent.kind !== "github" || !recent.resolvedRef) return recent.location;
  const resolvedRef = recent.resolvedRef;
  const isNamedRef = /^refs\/(?:heads|tags)\//.test(resolvedRef);
  const isCommit = /^[0-9a-f]{40,64}$/i.test(resolvedRef);
  if (!isNamedRef && !isCommit) return recent.location;
  let url;
  try { url = new URL(recent.location); } catch { return recent.location; }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password) return recent.location;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return recent.location;
  let owner;
  let repository;
  try {
    owner = decodeURIComponent(segments[0]);
    repository = decodeURIComponent(segments[1]);
  } catch { return recent.location; }
  const ref = isCommit && /^[0-9a-f]{40,64}$/i.test(recent.commit ?? "") ? recent.commit : resolvedRef;
  const targetSegments = [...ref.split("/"), ...(recent.subdirectory ?? "").split("/").filter(Boolean)];
  if (targetSegments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"))) return recent.location;
  return ["https://github.com", encodeURIComponent(owner), encodeURIComponent(repository), "tree", ...targetSegments.map(encodeURIComponent)].join("/");
}

/** @param {RecentRepositoryTarget} recent */
export function recentRepositoryTargetLabel(recent) {
  if (recent.kind !== "github") return recent.location;

  const resolvedRef = recent.resolvedRef ?? recent.requestedRef;
  const isCommit = Boolean(resolvedRef && /^[0-9a-f]{40}$/i.test(resolvedRef))
    || (!resolvedRef && Boolean(recent.requestedRef && /^[0-9a-f]{40}$/i.test(recent.requestedRef)));
  const refLabel = isCommit
    ? `提交 ${(resolvedRef ?? recent.requestedRef ?? recent.commit ?? "").slice(0, 12)}`
    : resolvedRef?.startsWith("refs/tags/")
      ? `标签 ${resolvedRef.slice("refs/tags/".length)}`
      : resolvedRef
        ? `分支 ${resolvedRef.replace(/^refs\/heads\//, "")}`
        : "默认分支";

  return recent.subdirectory ? `${refLabel} · ${recent.subdirectory}` : refLabel;
}
