/**
 * BOM engine.
 *
 * The BOM is always a derived projection of the graph, computed
 * on demand — never stored as its own document. Call
 * computeBom(panels) whenever current numbers are needed; there
 * is no cached/stale BOM state anywhere in the app.
 *
 * Stage 0/1: one aggregation (group by material + thickness),
 * which is also the natural grouping for cut-list sheet nesting
 * later. Structural validation, hardware line items, and pricing
 * history are additive layers for later stages — none of them
 * require changing this function's contract.
 */
export function computeBom(panels) {
  const groups = new Map();

  for (const p of panels) {
    const key = `${p.material}__${p.thickness}`;
    if (!groups.has(key)) {
      groups.set(key, {
        material: p.material,
        thickness: p.thickness,
        quantity: 0,
        areaM2: 0,
      });
    }
    const g = groups.get(key);
    g.quantity += p.quantity;
    g.areaM2 += (p.width * p.height * p.quantity) / 1_000_000;
  }

  return Array.from(groups.values());
}
