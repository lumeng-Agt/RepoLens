export function isTrustedDesktopUrl(value, uiOrigin) {
  try {
    const target = new URL(value);
    const origin = new URL(uiOrigin);
    return target.origin === origin.origin && target.protocol === "http:" && ["127.0.0.1", "localhost"].includes(target.hostname);
  } catch { return false; }
}

export function isTrustedDesktopSender(event, mainWebContents, uiOrigin) {
  return event?.sender === mainWebContents
    && Boolean(event?.senderFrame)
    && event.senderFrame === event.sender.mainFrame
    && isTrustedDesktopUrl(event.senderFrame.url, uiOrigin);
}

export function isAllowedExternalLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password;
  } catch { return false; }
}
