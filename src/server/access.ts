/**
 * Who is allowed to talk to the API.
 *
 * The app can overwrite and delete media, and it has no password. Binding it
 * to every interface so it is reachable over Tailscale would otherwise hand
 * the whole LAN a button that re-encodes files in place.
 *
 * Tailscale always assigns addresses from the CGNAT range 100.64.0.0/10, so
 * allowing loopback plus that range means the tailnet works and the local
 * network does not.
 */

export interface ClientRule {
  /** Printable form, for the health check and logs. */
  text: string;
  matches: (ip: string) => boolean;
}

export const DEFAULT_ALLOWED_CLIENTS = ["127.0.0.1", "::1", "100.64.0.0/10"];

export class AccessRuleError extends Error {}

/** Strip the IPv6-mapped IPv4 prefix Node reports on dual-stack sockets. */
export function normaliseIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.startsWith("::ffff:")) return trimmed.slice("::ffff:".length);
  return trimmed;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

export function parseClientRule(entry: string): ClientRule {
  const text = entry.trim();
  if (!text) throw new AccessRuleError("Empty client rule.");

  if (text === "*") {
    return { text, matches: () => true };
  }

  if (text.includes("/")) {
    const [network, bitsRaw] = text.split("/");
    const base = ipv4ToInt(network ?? "");
    const bits = Number(bitsRaw);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      throw new AccessRuleError(`Not a valid IPv4 CIDR: ${text}`);
    }
    // A /0 mask cannot be produced by shifting, so special-case it.
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const network32 = (base & mask) >>> 0;
    return {
      text,
      matches: (ip) => {
        const value = ipv4ToInt(normaliseIp(ip));
        return value !== null && ((value & mask) >>> 0) === network32;
      },
    };
  }

  const exact = normaliseIp(text);
  return { text, matches: (ip) => normaliseIp(ip) === exact };
}

export function parseClientRules(entries: string[]): ClientRule[] {
  return entries.map(parseClientRule);
}

export function isClientAllowed(ip: string, rules: ClientRule[]): boolean {
  return rules.some((rule) => rule.matches(ip));
}

/** True when the bind address exposes the app beyond this machine. */
export function isExposedHost(host: string): boolean {
  return !["127.0.0.1", "::1", "localhost"].includes(host.trim());
}
