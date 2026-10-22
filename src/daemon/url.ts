/**
 * Deterministic resolution of the `goto` argument into an absolute URL.
 *
 * - `scheme:...` (http://x, about:blank, data:...) is used as-is.
 * - A bare host (`example.com`, `example.com/docs`, `localhost:3000`) gets a
 *   scheme: `https://`, except loopback hosts which get `http://` (local dev
 *   servers rarely speak TLS).
 * - Anything else (`/pricing`, `./a`, `pricing.html`, `docs/intro`, `?q=1`) is
 *   relative and resolves against the context's current http(s) URL.
 */
import { AtcError } from "../contracts/errors.js";

const HOST_WITH_PORT = /^[^/?#:@]+:\d+(?:[/?#]|$)/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

/** File extensions that make `name.ext` a relative path rather than a host. */
const FILE_EXTENSIONS = new Set([
  "html", "htm", "xhtml", "php", "asp", "aspx", "jsp", "cgi", "js", "mjs", "css", "json", "xml",
  "txt", "csv", "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "wasm", "map",
]);

/** True when `raw` is relative, i.e. resolving it requires the current page URL. */
export function isRelativeUrl(raw: string): boolean {
  const input = raw.trim();
  return input !== "" && !hasScheme(input) && bareHostOf(input) === undefined;
}

export function resolveGotoUrl(raw: string, base: string | undefined): string {
  const input = raw.trim();
  if (input === "") throw new AtcError("INVALID_ARGUMENT", "url must not be empty");
  if (hasScheme(input)) return parseAbsolute(input);
  const host = bareHostOf(input);
  if (host !== undefined) {
    const scheme = LOOPBACK_HOSTS.has(host.toLowerCase()) ? "http" : "https";
    return parseAbsolute(`${scheme}://${input}`);
  }
  if (base === undefined || !isHttpUrl(base)) {
    throw new AtcError(
      "INVALID_ARGUMENT",
      "relative url needs a context that is already on an http(s) page; pass an absolute url",
    );
  }
  return new URL(input, base).href;
}

export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function hasScheme(input: string): boolean {
  return SCHEME.test(input) && !HOST_WITH_PORT.test(input);
}

/** The hostname if `input` starts with a bare host, else undefined. */
function bareHostOf(input: string): string | undefined {
  if (/^[/.?#]/.test(input)) return undefined;
  const segment = input.split(/[/?#]/, 1)[0] ?? "";
  const hostname = segment.replace(/:\d+$/, "");
  if (HOST_WITH_PORT.test(input) || LOOPBACK_HOSTS.has(hostname.toLowerCase()) || IPV4.test(hostname)) {
    return hostname;
  }
  return looksLikeDomain(hostname) ? hostname : undefined;
}

function looksLikeDomain(hostname: string): boolean {
  const labels = hostname.split(".");
  const tld = labels[labels.length - 1] ?? "";
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false;
  return TLD.test(tld) && !FILE_EXTENSIONS.has(tld.toLowerCase());
}

function parseAbsolute(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    throw new AtcError("INVALID_ARGUMENT", "url is not a valid absolute URL");
  }
}
