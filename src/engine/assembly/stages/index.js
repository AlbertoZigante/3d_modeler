/**
 * stages/ — the coarse order in which a person builds the furniture.
 *
 *   1. doors        door panels, hinge cups on the door, then the handle
 *   2. drawers      drawer boxes (runner halves on the box sides), drawer
 *                   fronts, then their handles
 *   3. guides       drawer guides (runner brackets) mounted on the
 *                   carcass side / shelf panels while those are still loose
 *   4. plinth       plinth frame / kickboards
 *   5. carcass      everything else: the actual furniture body
 *   6. integration  plinth fitted, drawers slid in, doors hung
 *
 * Nothing from a later stage is ever emitted before an earlier one.
 * Each stage lives in its own file and exports `run(ctx)`; the
 * orchestrator (../sequence.js) just calls them in STAGES order.
 */
import { runDoors } from './doors.js';
import { runDrawers } from './drawers.js';
import { runGuides } from './guides.js';
import { runPlinth } from './plinth.js';
import { runCarcass } from './carcass.js';
import { runIntegration } from './integration.js';

export const STAGES = [
  { id: 'doors', name: 'Doors & handles', run: runDoors },
  { id: 'drawers', name: 'Drawer boxes, fronts & handles', run: runDrawers },
  { id: 'guides', name: 'Drawer guides on carcass panels', run: runGuides },
  { id: 'plinth', name: 'Plinth', run: runPlinth },
  { id: 'carcass', name: 'Main carcass', run: runCarcass },
  { id: 'integration', name: 'Final integration', run: runIntegration },
];
