import { describe, expect, it } from "vitest";
import { lemmaIdToLeanName, leanNameToLemmaId, LemmaIdSchema } from "../src/index.ts";

describe("lemma ids", () => {
  it("maps ids to lean names and back", () => {
    expect(lemmaIdToLeanName("L-circ-014")).toBe("L_circ_014");
    expect(leanNameToLemmaId("L_circ_014")).toBe("L-circ-014");
  });
  it("rejects malformed ids", () => {
    for (const bad of ["L", "L-", "l-circ-1", "L-Circ-1", "L-circ_1", "L-circ-1; rm -rf /", "L--x"]) {
      expect(LemmaIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
