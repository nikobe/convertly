import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClientRules, isClientAllowed, parseClientRule, normaliseIp,
  isExposedHost, reachableUrls, DEFAULT_ALLOWED_CLIENTS, AccessRuleError,
} from "./access.ts";

const defaults = parseClientRules(DEFAULT_ALLOWED_CLIENTS);
const allowed = (ip: string) => isClientAllowed(ip, defaults);

test("the machine itself is always allowed", () => {
  assert.equal(allowed("127.0.0.1"), true);
  assert.equal(allowed("::1"), true);
  assert.equal(allowed("::ffff:127.0.0.1"), true, "dual-stack sockets report the mapped form");
});

test("Tailscale addresses are allowed", () => {
  assert.equal(allowed("100.71.126.16"), true);
  assert.equal(allowed("100.64.0.0"), true, "first address in the range");
  assert.equal(allowed("100.127.255.255"), true, "last address in the range");
  assert.equal(allowed("::ffff:100.71.126.16"), true);
});

test("the local network is not allowed", () => {
  // The whole point: reachable over the tailnet, not to anything on the LAN.
  for (const ip of ["192.168.1.50", "10.0.0.5", "172.16.4.9", "169.254.1.1"]) {
    assert.equal(allowed(ip), false, ip);
  }
});

test("addresses just outside the CGNAT range are rejected", () => {
  // 100.64.0.0/10 spans 100.64.0.0 to 100.127.255.255 — an off-by-one here
  // would quietly admit ordinary public addresses.
  assert.equal(allowed("100.63.255.255"), false);
  assert.equal(allowed("100.128.0.0"), false);
  assert.equal(allowed("100.200.1.1"), false);
});

test("a public address is rejected", () => {
  assert.equal(allowed("8.8.8.8"), false);
  assert.equal(allowed("1.1.1.1"), false);
});

test("an explicit host rule matches only that host", () => {
  const rules = parseClientRules(["192.168.1.20"]);
  assert.equal(isClientAllowed("192.168.1.20", rules), true);
  assert.equal(isClientAllowed("192.168.1.21", rules), false);
});

test("a wildcard opens it up, for someone who really means to", () => {
  const rules = parseClientRules(["*"]);
  assert.equal(isClientAllowed("8.8.8.8", rules), true);
});

test("nonsense rules are rejected at load rather than silently ignored", () => {
  // A typo that parsed as "allow nothing" would be a lockout; one that parsed
  // as "allow everything" would be worse.
  assert.throws(() => parseClientRule("100.64.0.0/33"), AccessRuleError);
  assert.throws(() => parseClientRule("100.64.0.0/abc"), AccessRuleError);
  assert.throws(() => parseClientRule("not-an-ip/10"), AccessRuleError);
  assert.throws(() => parseClientRule("999.1.1.1/8"), AccessRuleError);
  assert.throws(() => parseClientRule(""), AccessRuleError);
});

test("normaliseIp only strips the mapped prefix", () => {
  assert.equal(normaliseIp("::ffff:10.0.0.1"), "10.0.0.1");
  assert.equal(normaliseIp(" 10.0.0.1 "), "10.0.0.1");
  assert.equal(normaliseIp("::1"), "::1");
});

test("isExposedHost knows when the bind reaches beyond this machine", () => {
  assert.equal(isExposedHost("127.0.0.1"), false);
  assert.equal(isExposedHost("localhost"), false);
  assert.equal(isExposedHost("0.0.0.0"), true);
  assert.equal(isExposedHost("100.71.126.16"), true);
});

test("the built-in defaults are reachable but not open", () => {
  // These two settings only make sense together: binding every interface is
  // the default because the allowlist is what makes it safe. If either side
  // is ever loosened alone, this fails.
  assert.deepEqual(DEFAULT_ALLOWED_CLIENTS, ["127.0.0.1", "::1", "100.64.0.0/10"]);
  assert.equal(DEFAULT_ALLOWED_CLIENTS.includes("*"), false, "a broad bind with a wildcard allowlist is wide open");
  const rules = parseClientRules(DEFAULT_ALLOWED_CLIENTS);
  assert.equal(isClientAllowed("100.71.126.16", rules), true, "tailnet must work with no config");
  assert.equal(isClientAllowed("192.168.0.197", rules), false, "the LAN must not");
});

test("reachableUrls names the tailnet address so it need not be looked up", () => {
  const fake = {
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    en0: [{ family: "IPv4", internal: false, address: "192.168.0.197" }],
    utun4: [{ family: "IPv4", internal: false, address: "100.71.126.16" }],
    en1: [{ family: "IPv6", internal: false, address: "fe80::1" }],
  } as unknown as Parameters<typeof reachableUrls>[1];
  const urls = reachableUrls(8973, fake);
  assert.ok(urls.includes("http://localhost:8973/"));
  assert.ok(urls.some((u) => u.startsWith("http://100.71.126.16:8973/") && u.includes("tailnet")));
  assert.ok(urls.some((u) => u.startsWith("http://192.168.0.197:8973/") && !u.includes("tailnet")));
  assert.equal(urls.some((u) => u.includes("fe80")), false, "IPv6 link-local is noise");
});
