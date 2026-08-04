import { describe, it, expect } from "vitest";
import {
  ENDPOINTS,
  CATEGORIES,
  getEndpointsByCategory,
  getCategoryById,
} from "../../src/client/endpoints.js";

describe("ENDPOINTS", () => {
  it("has 31 endpoints", () => {
    expect(ENDPOINTS).toHaveLength(31);
  });

  it("all endpoints have required fields", () => {
    for (const ep of ENDPOINTS) {
      expect(ep.path).toBeTruthy();
      expect(ep.path).toMatch(/^\/svc\/apis\//);
      expect(ep.description).toBeTruthy();
      expect(ep.descriptionKo).toBeTruthy();
      expect(ep.category).toBeTruthy();
      expect(ep.requestFields).toEqual([
        { name: "basDd", type: "string", required: true },
      ]);
      expect(ep.responseFields.length).toBeGreaterThan(0);
    }
  });

  it("all endpoint categories are valid", () => {
    const validCategories = CATEGORIES.map((c) => c.id);
    for (const ep of ENDPOINTS) {
      expect(validCategories).toContain(ep.category);
    }
  });
});

describe("CATEGORIES", () => {
  it("has 7 categories", () => {
    expect(CATEGORIES).toHaveLength(7);
  });

  it("each category has a probe endpoint", () => {
    for (const cat of CATEGORIES) {
      expect(cat.probeEndpoint).toMatch(/^\/svc\/apis\//);
    }
  });

  it("probe endpoints exist in ENDPOINTS", () => {
    for (const cat of CATEGORIES) {
      const found = ENDPOINTS.find((ep) => ep.path === cat.probeEndpoint);
      expect(found).toBeDefined();
    }
  });
});

describe("getEndpointsByCategory", () => {
  it("returns 5 index endpoints", () => {
    expect(getEndpointsByCategory("index")).toHaveLength(5);
  });

  it("returns 8 stock endpoints", () => {
    expect(getEndpointsByCategory("stock")).toHaveLength(8);
  });

  it("returns 3 etp endpoints", () => {
    expect(getEndpointsByCategory("etp")).toHaveLength(3);
  });

  it("returns 3 bond endpoints", () => {
    expect(getEndpointsByCategory("bond")).toHaveLength(3);
  });

  it("returns 6 derivative endpoints", () => {
    expect(getEndpointsByCategory("derivative")).toHaveLength(6);
  });

  it("returns 3 commodity endpoints", () => {
    expect(getEndpointsByCategory("commodity")).toHaveLength(3);
  });

  it("returns 3 esg endpoints", () => {
    expect(getEndpointsByCategory("esg")).toHaveLength(3);
  });
});

describe("getCategoryById", () => {
  it("returns category for valid id", () => {
    const cat = getCategoryById("stock");
    expect(cat?.code).toBe("sto");
    expect(cat?.nameKo).toBe("주식");
  });

  it("returns undefined for invalid id", () => {
    const cat = getCategoryById("invalid" as never);
    expect(cat).toBeUndefined();
  });
});
