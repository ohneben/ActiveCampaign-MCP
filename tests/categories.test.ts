import { describe, it, expect } from "vitest";
import { categoryFor, safetyBucket, CATEGORIES, CATEGORY_OVERRIDES } from "../src/categories.js";

describe("categoryFor", () => {
  it("defaults sensibly by HTTP method", () => {
    expect(categoryFor("some-unlisted-get", "get").id).toBe("read");
    expect(categoryFor("some-unlisted-post", "post").id).toBe("create");
    expect(categoryFor("some-unlisted-put", "put").id).toBe("update");
    expect(categoryFor("some-unlisted-patch", "patch").id).toBe("update");
    expect(categoryFor("some-unlisted-delete", "delete").id).toBe("delete");
  });

  it("applies curated overrides for nuanced operations", () => {
    expect(categoryFor("sync-a-contacts-data", "post").id).toBe("upsert");
    expect(categoryFor("create_match_all_request", "post").id).toBe("query");
    expect(categoryFor("createBroadcast", "post").id).toBe("send");
    expect(categoryFor("Send a WhatsApp Template Message", "post").id).toBe("send");
    expect(categoryFor("create-contact-tag", "post").id).toBe("link");
    expect(categoryFor("remove-a-contacts-tag", "delete").id).toBe("unlink");
    expect(categoryFor("bulk-delete-accounts", "delete").id).toBe("bulk_delete");
    expect(categoryFor("bulk-delete-variables", "delete").id).toBe("bulk_delete");
  });

  it("keeps read/write/destructive buckets consistent with annotations", () => {
    for (const meta of Object.values(CATEGORIES)) {
      const bucket = safetyBucket(meta.id);
      if (bucket === "read") expect(meta.annotations.readOnlyHint).toBe(true);
      if (bucket === "destructive") expect(meta.annotations.destructiveHint).toBe(true);
      if (bucket === "write") {
        expect(meta.annotations.readOnlyHint).toBe(false);
        expect(meta.annotations.destructiveHint).toBe(false);
      }
    }
  });

  it("every category has a 🟢/🟡/🔴 banner", () => {
    for (const meta of Object.values(CATEGORIES)) {
      expect(meta.banner).toMatch(/^(🟢|🟡|🔴)/);
    }
  });

  it("every override maps to a real category id", () => {
    for (const id of Object.values(CATEGORY_OVERRIDES)) {
      expect(CATEGORIES[id]).toBeDefined();
    }
  });
});
