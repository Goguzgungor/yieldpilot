import { describe, it, expect } from "vitest";
import { declutter, labelBox, type LabelBox } from "./declutter";

const overlaps = (a: ReturnType<typeof labelBox>, b: ReturnType<typeof labelBox>) =>
  a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

describe("declutter", () => {
  it("keeps the base leader for labels that do not collide", () => {
    const labels: LabelBox[] = [
      { x: 100, anchorY: 500, w: 80, h: 14 },
      { x: 400, anchorY: 500, w: 80, h: 14 },
    ];
    expect(declutter(labels)).toEqual([14, 14]);
  });

  it("raises the higher summit's label above a colliding lower one", () => {
    const labels: LabelBox[] = [
      { x: 100, anchorY: 520, w: 120, h: 14 },
      { x: 150, anchorY: 510, w: 120, h: 14 },
    ];
    const leads = declutter(labels);
    expect(leads[0]).toBe(14);
    expect(leads[1]).toBeGreaterThan(14);
  });

  it("leaves no two labels overlapping in a crowded row", () => {
    const labels: LabelBox[] = Array.from({ length: 9 }, (_, i) => ({ x: 80 + i * 60, anchorY: 600 - (i % 3) * 8, w: 130, h: 14 }));
    const leads = declutter(labels);
    const boxes = labels.map((l, i) => labelBox(l, leads[i]));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
  });
});
