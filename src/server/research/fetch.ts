import { scoreDomain, stripHtml } from "./providers";
import { log } from "@/server/logger";

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  domain: string;
  sourceQuality: number;
  truncated: boolean;
  fetchedAt: string;
}

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 20_000;

/** Blocks fetches at private and loopback addresses so a URL from a search result cannot be used to probe the host network. */
function assertPublicUrl(raw: string): URL {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Refusing to fetch non-HTTP URL: ${url.protocol}`);
  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "metadata.google.internal";
  if (blocked) throw new Error(`Refusing to fetch a private or loopback address: ${host}`);
  return url;
}

/**
 * Fetches a page and extracts readable text.
 *
 * Deliberately dependency-free: a heuristic content extractor is enough for
 * label pages, blog posts and press releases, and avoids shipping a headless
 * browser for what is mostly server-rendered HTML.
 */
export async function fetchPage(rawUrl: string, maxChars = 12_000): Promise<FetchedPage> {
  const url = assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "YuvixOS/0.1 (artist business research agent)",
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url.href}`);

    const contentType = res.headers.get("content-type") ?? "";
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) throw new Error(`Response too large (${buffer.byteLength} bytes)`);
    const body = new TextDecoder("utf-8", { fatal: false }).decode(buffer);

    let title = "";
    let text = "";

    if (contentType.includes("application/json")) {
      text = body.slice(0, maxChars);
      title = url.hostname;
    } else {
      title = stripHtml(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 300);
      // Prefer semantic containers; fall back to body.
      const main =
        body.match(/<article[\s\S]*?<\/article>/i)?.[0] ??
        body.match(/<main[\s\S]*?<\/main>/i)?.[0] ??
        body.match(/<body[\s\S]*?<\/body>/i)?.[0] ??
        body;
      text = stripHtml(main);
    }

    const { domain, quality } = scoreDomain(res.url || url.href);
    const truncated = text.length > maxChars;

    return {
      url: rawUrl,
      finalUrl: res.url || url.href,
      title,
      text: text.slice(0, maxChars),
      domain,
      sourceQuality: quality,
      truncated,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    log.warn("research.fetch.failed", { url: rawUrl, error: String(err) });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
