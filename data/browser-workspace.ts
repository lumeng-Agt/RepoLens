export const USAGE_GUIDE_STORAGE_KEY = "repolens:usage-guide:v1";

export function stageBrowserProgressClear(workspaceId?: string) {
  const localPrefix = workspaceId ? `repolens:${workspaceId}:` : "repolens:";
  const cookiePrefix = workspaceId
    ? `repolens_${workspaceId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}_`
    : "repolens_";
  const localEntries: [string, string][] = [];
  const cookieEntries: [string, string][] = [];
  for (const key of Object.keys(window.localStorage)) {
    if (
      !key.startsWith(localPrefix) &&
      key !== `repolens:reading-baseline:${workspaceId}` &&
      key !== `repolens:chat-ui:${workspaceId}`
    )
      continue;
    const value = window.localStorage.getItem(key);
    if (value !== null) localEntries.push([key, value]);
  }
  for (const part of document.cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name.startsWith(cookiePrefix)) cookieEntries.push([name, value.join("=")]);
  }
  const restore = () => {
    for (const [key, value] of localEntries) window.localStorage.setItem(key, value);
    for (const [name, value] of cookieEntries)
      document.cookie = `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
  };
  try {
    for (const [key] of localEntries) window.localStorage.removeItem(key);
    for (const [name] of cookieEntries) document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
    const remainingLocal = localEntries.some(([key]) => window.localStorage.getItem(key) !== null);
    const remainingCookies = cookieEntries.some(([name]) =>
      document.cookie.split(";").some((part) => part.trim().startsWith(`${name}=`))
    );
    if (remainingLocal || remainingCookies) throw new Error("浏览器中的阅读进度未能清除。");
  } catch (error) {
    try {
      restore();
    } catch {
      /* Keep the original clearing error and report it to the user. */
    }
    throw new Error(`无法清除浏览器中的阅读进度：${error instanceof Error ? error.message : String(error)}`);
  }
  return restore;
}
