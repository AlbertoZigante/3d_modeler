import { panelRole } from './roles.js';

// ---------------------------------------------------------------
// Connected components over the STRUCTURAL graph only
// ---------------------------------------------------------------
export function computeClusters(panelIds, structuralJoints) {
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

/**
 * Decides whether two panels belong to the SAME rigid sub-assembly.
 *
 * A closed door, or a drawer box sized to fit snugly in its opening,
 * is often geometrically FLUSH against panels it merely rests near
 * (zero reveal gap against the carcass Top/Bottom/Back, say) — which
 * detectJoints correctly classifies as a real corner_butt/t_butt/
 * face_to_face contact, but that contact is incidental to the
 * panel's position, not a screw connection. The only real mechanical
 * links for these panels are their FeatureJoints (door_hinge /
 * drawer_slide — see engine/joints.js) plus, for a drawer box, its
 * OWN internal joints to its own sibling panels (which ARE real
 * screwed connections). Without this filter, a door or drawer box
 * would wrongly get clustered into the same rigid sub-assembly as
 * the carcass it merely sits against, "assembled" via confirmat
 * screws that don't exist. This is the same "geometric contact !=
 * physical connection" distinction the whole joints/hardware
 * architecture was built around.
 *
 * The plinth follows the same rule: it is built as its own frame
 * (plinth panels only join other plinth panels) and is fitted to the
 * finished carcass in the integration phase, see stages/integration.js.
 *
 * @param {Map<string, object>} rawById - RAW (unresolved) panels by id
 * @returns {(aId: string, bId: string) => boolean}
 */
export function makeIsSameRigidUnit(rawById) {
  return (aId, bId) => {
    const a = rawById.get(aId);
    const b = rawById.get(bId);
    if (!a || !b) return true;
    if (a.isDoor || b.isDoor) return false; // a door never rigidly joins anything — only its hinge FeatureJoint is real
    if (a.isDrawerFront || b.isDrawerFront) return false; // front attachment isn't modeled as a joint yet — see the known-gap note in sequence.js
    if (a.isDrawerBoxPanel || b.isDrawerBoxPanel) {
      // A drawer box's OWN corners are real joints; contact with
      // anything outside its own drawer (the carcass, another drawer)
      // is incidental, not structural.
      return a.isDrawerBoxPanel && b.isDrawerBoxPanel && a.drawerBoxFrontId === b.drawerBoxFrontId;
    }
    const aPlinth = panelRole(a) === 'plinth';
    const bPlinth = panelRole(b) === 'plinth';
    if (aPlinth || bPlinth) return aPlinth && bPlinth; // plinth frame is its own unit; carcass contact is incidental
    return true; // ordinary carcass/shelf panels
  };
}
