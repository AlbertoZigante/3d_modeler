/**
 * engine/assembly.js — ASSEMBLY SEQUENCING (Phase 1).
 *
 * Answers "in what order do you put this together" — the layer above
 * engine/hardware.js the way hardware.js sits above engine/joints.js:
 * geometry says where things meet, hardware says what holds them
 * together, this says in what ORDER a person actually does it.
 *
 * SCOPE OF THIS PHASE
 * --------------------
 * Pure sequencing only: a topological build order plus two real,
 * hand-written assembly rules (pre-install hardware before a panel
 * joins anything; hinge integration always last). NOT in this phase,
 * on purpose, matching the phased plan this was scoped against:
 *   - Ergonomics scoring (flip-count, two-person flags, cantilever
 *     detection) — a filter/annotation pass ON TOP of this sequence,
 *     not part of computing it.
 *   - Tool identification — trivial once steps exist (hardware kind ->
 *     tool), not needed to validate that the ORDER itself is right.
 *   - Any PDF/visual output.
 * Deliberately building and eyeballing plain step order first, before
 * spending any effort on rendering — same convention as validating
 * detectJoints() with printed output before building fasteners on top
 * of it.
 *
 * THE CORE INSIGHT: TWO KINDS OF EDGES
 * --------------------------------------
 * A Joint (corner_butt/t_butt/face_to_face — "structural" edges) means
 * two panels are RIGIDLY joined and belong in the same sub-assembly,
 * built up panel by panel. A FeatureJoint (drawer_slide/door_hinge —
 * "integration" edges) means two ALREADY-COMPLETE sub-assemblies get
 * connected to each other — you don't build a drawer box and a
 * carcass panel-by-panel as one interleaved sequence, you finish the
 * drawer box, finish the carcass, THEN slide one into the other. So:
 *
 *   1. Cluster panels into rigid sub-assemblies using ONLY structural
 *      joints (near_contact/edge_to_edge don't count either — neither
 *      is a real physical connection yet, see joints.js's own header).
 *   2. Order each cluster's own panels internally (a per-cluster
 *      topological walk).
 *   3. Only THEN schedule integration steps (drawer insertion, door
 *      hanging) — each one waits until BOTH of its clusters are fully
 *      built.
 *
 * PRE-INSTALL, UNIFIED ACROSS HINGES AND RUNNERS
 * ------------------------------------------------
 * The original plan called out "runners must be mounted before the
 * back panel closes the box" as its own special rule. Building this
 * revealed that's really a special case of a more general, more
 * defensible rule that ALSO covers hinges: hardware that fastens onto
 * a SINGLE panel (a runner's bracket on a carcass side; a hinge cup on
 * a door, or a hinge's mounting plate on ITS carcass side) should
 * always be installed while that panel is still separate and fully
 * accessible on both faces — i.e., before that panel's FIRST
 * structural joint, not "before some specific other panel". This
 * subsumes the back-panel-specific version of the rule entirely, so
 * that's the only version implemented here.
 *
 * KNOWN GAP — drawer front attachment isn't modeled as a joint yet.
 * A drawer front's connection to its drawer box (matched via
 * drawerBoxFrontId, not a Joint or FeatureJoint) has no detector, the
 * same way door hinges and drawer slides didn't until
 * detectFeatureJoints was built for them. Until that's added, a
 * drawer front panel with no other structural joints shows up as its
 * own unattached step — flagged, not silently dropped (see `kind:
 * 'unattached'` below) — same philosophy as findOrphanPanels.
 */
import { resolveConstraints } from '../modeller/snap.js';
import { detectJoints, detectFeatureJoints } from './joints.js';
import { buildHardwarePlan } from './hardware.js';

const STRUCTURAL_JOINT_TYPES = new Set(['corner_butt', 't_butt', 'face_to_face']);

// ---------------------------------------------------------------
// Connected components over the STRUCTURAL graph only
// ---------------------------------------------------------------
function computeClusters(panelIds, structuralJoints) {
  const adjacency = new Map(panelIds.map((id) => [id, new Set()]));
  structuralJoints.forEach((j) => {
    adjacency.get(j.panelA)?.add(j.panelB);
    adjacency.get(j.panelB)?.add(j.panelA);
  });

  const visited = new Set();
  const clusters = [];
  panelIds.forEach((startId) => {
    if (visited.has(startId)) return;
    const cluster = new Set();
    const queue = [startId];
    visited.add(startId);
    while (queue.length > 0) {
      const id = queue.shift();
      cluster.add(id);
      adjacency.get(id)?.forEach((neighborId) => {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push(neighborId);
        }
      });
    }
    clusters.push(cluster);
  });
  return clusters;
}

// ---------------------------------------------------------------
// Per-cluster internal build order: start from the largest panel
// (the real-world "start with the main/base piece" convention), then
// repeatedly add whichever unplaced panel has the MOST structural
// joints to what's already placed — maximizing how supported each new
// panel is the moment it goes on, a stability heuristic that predates
// (and will later feed into) the formal ergonomics scoring pass.
// Ties broken by panel area (bigger first), then pieceCode/id for
// determinism.
// ---------------------------------------------------------------
function orderClusterPanels(clusterIds, structuralJoints, resolvedById, codeOf) {
  const jointsByPanel = new Map([...clusterIds].map((id) => [id, []]));
  structuralJoints.forEach((j) => {
    if (clusterIds.has(j.panelA) && clusterIds.has(j.panelB)) {
      jointsByPanel.get(j.panelA).push(j);
      jointsByPanel.get(j.panelB).push(j);
    }
  });

  const areaOf = (id) => {
    const r = resolvedById.get(id);
    return r ? r.width * r.height : 0;
  };
  const sortKey = (id) => [-areaOf(id), codeOf(id)];
  const compareSortKey = (a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    return ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
  };

  const remaining = new Set(clusterIds);
  const placed = [];
  const steps = []; // { newPanel, joints: Joint[] } — the anchor step has joints: []

  const anchor = [...remaining].sort(compareSortKey)[0];
  remaining.delete(anchor);
  placed.push(anchor);
  steps.push({ newPanel: anchor, joints: [] });

  while (remaining.size > 0) {
    let best = null;
    let bestJoints = null;
    remaining.forEach((candidateId) => {
      const connectingJoints = jointsByPanel.get(candidateId).filter(
        (j) => placed.includes(j.panelA) || placed.includes(j.panelB)
      );
      if (connectingJoints.length === 0) return; // not yet reachable from what's placed
      if (
        !best ||
        connectingJoints.length > bestJoints.length ||
        (connectingJoints.length === bestJoints.length && compareSortKey(candidateId, best) < 0)
      ) {
        best = candidateId;
        bestJoints = connectingJoints;
      }
    });

    if (!best) {
      // Disconnected within what should be one cluster — shouldn't
      // happen (computeClusters already guarantees connectivity), but
      // fail loudly rather than infinite-loop if it ever does.
      throw new Error('orderClusterPanels: cluster is not fully connected — this indicates a bug in computeClusters');
    }

    remaining.delete(best);
    placed.push(best);
    steps.push({ newPanel: best, joints: bestJoints });
  }

  return steps;
}

/**
 * @typedef {Object} AssemblyStep
 * @property {number} index - 1-based order in the final sequence
 * @property {'pre_install'|'join'|'integrate'|'unattached'} kind
 * @property {string[]} panelIds
 * @property {string[]} otherPanelIds - for 'join': the already-placed panels this step's new panel connects to; empty for every other kind (an 'integrate' step's panelIds already lists every panel involved on both sides)
 * @property {string[]} panelNames
 * @property {string[]} panelCodes
 * @property {string[]} jointIds - underlying Joint/FeatureJoint ids realized by this step
 * @property {object[]} hardware - matching entries from buildHardwarePlan (hinges/runners/fasteners), if any
 * @property {string} description
 */

/**
 * Builds a full assembly order for a design: sub-assemblies clustered
 * and internally ordered, hardware pre-installed before its panel's
 * first structural joint, integration steps (drawer insertion, door
 * hanging) scheduled only once both sides are complete, hinges always
 * last. Pure function — nothing persisted, safe to call fresh anytime,
 * same convention as buildJointsReport/buildHardwarePlan.
 *
 * @param {Array} panels - RAW graph (not resolved)
 * @returns {{ steps: AssemblyStep[], clusters: {panelIds:string[]}[] }}
 */
export function buildAssemblySequence(panels) {
  const resolved = resolveConstraints(panels);
  const resolvedById = new Map(resolved.map((r) => [r.id, r]));
  const nameById = new Map(resolved.map((r) => [r.id, r.name || r.id]));
  const pieceCodeById = new Map(panels.map((p) => [p.id, p.pieceCode]));
  const codeOf = (id) => pieceCodeById.get(id) ?? nameById.get(id) ?? id;

  const { joints } = detectJoints(resolved);
  const featureJoints = detectFeatureJoints(panels);
  const hardwarePlan = buildHardwarePlan(panels);

  // A closed door, or a drawer box sized to fit snugly in its opening,
  // is often geometrically FLUSH against panels it merely rests near
  // (zero reveal gap against the carcass Top/Bottom/Back, say) — which
  // detectJoints correctly classifies as a real corner_butt/t_butt/
  // face_to_face contact, but that contact is incidental to the
  // panel's position, not a screw connection. The only real mechanical
  // links for these panels are their FeatureJoints (door_hinge /
  // drawer_slide — see engine/joints.js) plus, for a drawer box, its
  // OWN internal joints to its own sibling panels (which ARE real
  // screwed connections). Without this filter, a door or drawer box
  // would wrongly get clustered into the same rigid sub-assembly as
  // the carcass it merely sits against, "assembled" via confirmat
  // screws that don't exist. This is the same "geometric contact !=
  // physical connection" distinction the whole joints/hardware
  // architecture was built around — just showing up in a place
  // detectJoints/buildHardwarePlan don't currently guard against
  // themselves (a latent inaccuracy in their own fastener suggestions
  // for a door or a snug drawer box, worth fixing there too — flagged,
  // not fixed here, to keep this file's own scope to sequencing).
  const rawById = new Map(panels.map((p) => [p.id, p]));
  const isSameRigidUnit = (aId, bId) => {
    const a = rawById.get(aId);
    const b = rawById.get(bId);
    if (!a || !b) return true;
    if (a.isDoor || b.isDoor) return false; // a door never rigidly joins anything — only its hinge FeatureJoint is real
    if (a.isDrawerFront || b.isDrawerFront) return false; // front attachment isn't modeled as a joint yet — see this file's known-gap note
    if (a.isDrawerBoxPanel || b.isDrawerBoxPanel) {
      // A drawer box's OWN corners are real joints; contact with
      // anything outside its own drawer (the carcass, another drawer)
      // is incidental, not structural.
      return a.isDrawerBoxPanel && b.isDrawerBoxPanel && a.drawerBoxFrontId === b.drawerBoxFrontId;
    }
    return true; // ordinary carcass/shelf panels
  };
  const structuralJoints = joints.filter((j) => STRUCTURAL_JOINT_TYPES.has(j.type) && isSameRigidUnit(j.panelA, j.panelB));
  const integrationPanelIds = new Set(featureJoints.flatMap((j) => [j.panelA, j.panelB]));
  const visiblePanelIds = resolved.filter((p) => !p.hidden).map((p) => p.id);
  const clusters = computeClusters(visiblePanelIds, structuralJoints);

  // pre-install hardware, keyed by which panel it must precede
  const preInstallByPanel = new Map(); // panelId -> hardwarePlan entry[]
  const addPreInstall = (panelId, entry) => {
    if (!preInstallByPanel.has(panelId)) preInstallByPanel.set(panelId, []);
    preInstallByPanel.get(panelId).push(entry);
  };
  hardwarePlan.hinges.forEach((h) => {
    addPreInstall(h.panelA, h); // the door itself
    addPreInstall(h.panelB, h); // the carcass boundary panel's mounting plate — see file header's unification note
  });
  hardwarePlan.runners.forEach((r) => {
    addPreInstall(r.panelA, r); // drawer box side
    addPreInstall(r.panelB, r); // carcass side bracket
  });

  const steps = [];
  let stepIndex = 1;
  const pushStep = (partial) => {
    steps.push({
      index: stepIndex++,
      panelNames: partial.panelIds.map((id) => nameById.get(id) ?? '?'),
      panelCodes: partial.panelIds.map((id) => codeOf(id)),
      ...partial,
    });
  };

  // Sort clusters biggest-first (panel count, then total area) — the
  // real-world "start with the main carcass, not a side sub-assembly"
  // convention. Deterministic tie-break on the first panel's code.
  const clusterList = clusters
    .map((cluster) => ({ ids: cluster, order: orderClusterPanels(cluster, structuralJoints, resolvedById, codeOf) }))
    .sort((a, b) => {
      if (b.ids.size !== a.ids.size) return b.ids.size - a.ids.size;
      const areaOf = (ids) => [...ids].reduce((sum, id) => {
        const r = resolvedById.get(id);
        return sum + (r ? r.width * r.height : 0);
      }, 0);
      return areaOf(b.ids) - areaOf(a.ids);
    });

  // --- Structural phase: every cluster, panel by panel -------------
  clusterList.forEach(({ order }) => {
    order.forEach(({ newPanel, joints: connectingJoints }) => {
      const pre = preInstallByPanel.get(newPanel);
      if (pre) {
        pre.forEach((hw) => {
          pushStep({
            kind: 'pre_install',
            panelIds: [newPanel],
            otherPanelIds: [],
            jointIds: [],
            hardware: [hw],
            description: `Fit ${hw.hardware.brand ?? 'Generic'} ${hw.hardware.series ?? hw.hardware.kind} hardware (${hw.displayId}) to ${codeOf(newPanel)} before it joins anything else.`,
          });
        });
      }

      if (connectingJoints.length === 0) {
        // The anchor panel of a cluster with more than one panel — no
        // joint yet, just the starting point everything else attaches to.
        const clusterHasOtherPanels = order.length > 1;
        const hasKnownFutureRole = pre || integrationPanelIds.has(newPanel);
        let description;
        if (clusterHasOtherPanels) {
          description = `Start with ${codeOf(newPanel)} as the base for this sub-assembly.`;
        } else if (hasKnownFutureRole) {
          // A door or drawer-box side that has no structural joint of
          // its own (see movablePanelIds above) but IS accounted for
          // later, via a pre_install step just emitted and/or an
          // integrate step further down — not a gap, just a panel
          // that's built/prepped standalone until it's hung or slid in.
          description = `Set ${codeOf(newPanel)} aside, ready for its hinge/runner step later.`;
        } else {
          // A true gap: no structural joint, no hardware, no feature
          // joint at all — see this file's known-gap note (e.g. a
          // drawer front, whose attachment isn't modeled as a joint yet).
          description = `Place ${codeOf(newPanel)} — no structural joint or hardware association found for it yet (see this file's known-gap note).`;
        }
        pushStep({
          kind: clusterHasOtherPanels || hasKnownFutureRole ? 'join' : 'unattached',
          panelIds: [newPanel],
          otherPanelIds: [],
          jointIds: [],
          hardware: [],
          description,
        });
      } else {
        const fastenerEntries = hardwarePlan.fasteners.filter((f) => connectingJoints.some((j) => j.id === f.jointId));
        const otherPanelIds = [...new Set(connectingJoints.flatMap((j) => [j.panelA, j.panelB]).filter((id) => id !== newPanel))];
        pushStep({
          kind: 'join',
          panelIds: [newPanel],
          otherPanelIds,
          jointIds: connectingJoints.map((j) => j.id),
          hardware: fastenerEntries,
          description: `Attach ${codeOf(newPanel)} to ${otherPanelIds.map(codeOf).join(', ')} (${connectingJoints.map((j) => j.type).join(', ')}).`,
        });
      }
    });
  });

  // --- Integration phase: drawer insertions, then hinges last ------
  const clusterOfPanel = new Map();
  clusterList.forEach(({ ids }) => ids.forEach((id) => clusterOfPanel.set(id, ids)));

  const slideJoints = featureJoints.filter((j) => j.kind === 'drawer_slide');
  const slideGroups = new Map(); // drawer-box cluster (as a Set) -> its slide FeatureJoints
  slideJoints.forEach((j) => {
    const cluster = clusterOfPanel.get(j.panelA);
    if (!slideGroups.has(cluster)) slideGroups.set(cluster, []);
    slideGroups.get(cluster).push(j);
  });
  slideGroups.forEach((groupJoints) => {
    const runnerEntries = hardwarePlan.runners.filter((r) => groupJoints.some((j) => j.id === `${r.panelA}:${r.panelB}:slide`));
    const drawerPanelIds = [...new Set(groupJoints.map((j) => j.panelA))];
    const carcassPanelIds = [...new Set(groupJoints.map((j) => j.panelB))];
    pushStep({
      kind: 'integrate',
      panelIds: [...drawerPanelIds, ...carcassPanelIds],
      otherPanelIds: [],
      jointIds: groupJoints.map((j) => j.id),
      hardware: runnerEntries,
      description: `Slide the drawer box (${drawerPanelIds.map(codeOf).join(', ')}) into the carcass on its runners (${carcassPanelIds.map(codeOf).join(', ')}).`,
    });
  });

  const hingeJoints = featureJoints.filter((j) => j.kind === 'door_hinge');
  hingeJoints.forEach((j) => {
    const hingeEntries = hardwarePlan.hinges.filter((h) => `${h.panelA}:hinge` === j.id);
    pushStep({
      kind: 'integrate',
      panelIds: [j.panelA, j.panelB],
      otherPanelIds: [],
      jointIds: [j.id],
      hardware: hingeEntries,
      description: `Hang ${codeOf(j.panelA)} on ${codeOf(j.panelB)} using the pre-fitted hinges.`,
    });
  });

  return { steps, clusters: clusterList.map(({ ids }) => ({ panelIds: [...ids] })) };
}

/**
 * Plain-text rendering of a sequence — for exactly the "print and
 * eyeball the order before building anything visual" step this phase
 * was scoped to.
 *
 * @param {ReturnType<typeof buildAssemblySequence>} sequence
 * @returns {string[]}
 */
export function formatAssemblySequenceLines(sequence) {
  return sequence.steps.map((s) => {
    const hwSuffix = s.hardware.length > 0 ? `  [hardware: ${s.hardware.map((h) => h.displayId).join(', ')}]` : '';
    return `${String(s.index).padStart(2, '0')}. (${s.kind})  ${s.description}${hwSuffix}`;
  });
}
