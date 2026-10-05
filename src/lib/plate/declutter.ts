// Summit labels hang on a leader line above their summit. When two would
// collide, the later one's leader grows until it clears — so every label stays
// directly above its own summit and nothing is ever hidden. Client-safe.

export interface LabelBox {
  /** Summit x (labels are centred on it). */
  x: number;
  /** Where the leader line meets the summit. */
  anchorY: number;
  /** Label text block size. */
  w: number;
  h: number;
}

const GAP = 7;   // between the text block and the top of its leader
const PAD_X = 6; // horizontal breathing room
const PAD_Y = 4; // vertical breathing room

export function labelBox(l: LabelBox, lead: number) {
  const b = l.anchorY - lead - GAP;
  return { l: l.x - l.w / 2 - PAD_X, r: l.x + l.w / 2 + PAD_X, b, t: b - l.h };
}

/**
 * Leader length per label (same order as input). Lower summits are placed
 * first, so the tall summits' labels rise above the crowd rather than the
 * foothills' labels being pushed into the sky.
 */
export function declutter(labels: LabelBox[], base = 14, step = 6, maxSteps = 60): number[] {
  const leads = labels.map(() => base);
  const placed: ReturnType<typeof labelBox>[] = [];
  const order = labels.map((_, i) => i).sort((a, b) => labels[b].anchorY - labels[a].anchorY);
  for (const i of order) {
    let lead = base;
    for (let s = 0; s < maxSteps; s++) {
      const me = labelBox(labels[i], lead);
      if (!placed.some((o) => me.l < o.r && me.r > o.l && me.t < o.b + PAD_Y && me.b > o.t - PAD_Y)) break;
      lead += step;
    }
    leads[i] = lead;
    placed.push(labelBox(labels[i], lead));
  }
  return leads;
}
