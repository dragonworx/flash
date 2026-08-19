// tests/users.test.ts — fsapi/users.ts. Most assertions here are
// environment-tolerant on purpose: the whole point of this module is to
// degrade gracefully on machines with no useful /etc/passwd (LDAP/SSSD), so
// the tests only pin down the two guarantees that must hold everywhere —
// the numeric fallback, and the os.userInfo() seed for the current user.

import { describe, expect, it } from "bun:test";
import { userInfo } from "node:os";
import { groupName, userName } from "../src/fsapi/users.ts";

describe("userName", () => {
  it("resolves the current process's own uid, seeded from os.userInfo()", () => {
    const me = userInfo();
    expect(userName(me.uid)).toBe(me.username);
  });

  it("falls back to the numeric uid when it is not in any known source", () => {
    expect(userName(999_999_999)).toBe("999999999");
  });
});

describe("groupName", () => {
  it("falls back to the numeric gid when it is not in /etc/group", () => {
    expect(groupName(999_999_999)).toBe("999999999");
  });
});
