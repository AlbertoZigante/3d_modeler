import { phase4PickNumber } from './format.js';
import { phase4MatrixFrom, phase4PickVector, phase4RotationMatrix, phase4TranslationFromMatrix } from './projection.js';

export function phase4BuildVisualParts(options = {}) {
  const rawPanels = Array.isArray(options.panels)
    ? options.panels
    : [];

  const resolvedPanels = Array.isArray(options.resolvedPanels)
    ? options.resolvedPanels
    : [];

  const resolvedById = new Map();

  resolvedPanels.forEach((panel, index) => {
    if (!panel) {
      return;
    }

    const id =
      panel.id ??
      panel.panelId ??
      panel.code ??
      rawPanels[index]?.id ??
      rawPanels[index]?.panelId ??
      null;

    if (id != null) {
      resolvedById.set(String(id), panel);
    }
  });

  return rawPanels.map((panel, index) => {
    const id =
      panel?.id ??
      panel?.panelId ??
      panel?.code ??
      `panel-${index + 1}`;

    const resolved =
      resolvedById.get(String(id)) ??
      resolvedPanels[index] ??
      {};

    const dimensions =
      resolved.dimensions ??
      resolved.size ??
      panel.dimensions ??
      panel.size ??
      {};

    const width = phase4PickNumber(
      dimensions.width ??
      resolved.width ??
      panel.width ??
      panel.w,
      1
    );

    const height = phase4PickNumber(
      dimensions.height ??
      resolved.height ??
      panel.height ??
      panel.h,
      1
    );

    const depth = phase4PickNumber(
      dimensions.depth ??
      dimensions.thickness ??
      resolved.depth ??
      resolved.thickness ??
      panel.depth ??
      panel.thickness ??
      panel.t,
      0.02
    );

    /*
     * Prefer the resolved modeller position.
     */
    let position =
      phase4PickVector(
        resolved.position,
        null
      ) ??
      phase4PickVector(
        resolved.translation,
        null
      ) ??
      phase4PickVector(
        resolved.origin,
        null
      ) ??
      phase4PickVector(
        resolved.center,
        null
      ) ??
      phase4PickVector(
        panel.position,
        null
      ) ??
      phase4PickVector(
        panel.translation,
        null
      ) ??
      phase4PickVector(
        panel.origin,
        null
      ) ??
      {
        x: 0,
        y: 0,
        z: 0,
      };

    const rawMatrix =
      resolved.matrix ??
      resolved.transform ??
      panel.matrix ??
      panel.transform ??
      null;

    const matrix =
      phase4MatrixFrom(rawMatrix);

    /*
     * If a 4x4 matrix already contains translation and no explicit
     * position exists, use its translation.
     */
    if (
      matrix &&
      matrix.length === 16 &&
      !phase4PickVector(resolved.position, null) &&
      !phase4PickVector(resolved.translation, null) &&
      !phase4PickVector(resolved.origin, null)
    ) {
      position =
        phase4TranslationFromMatrix(matrix) ??
        position;
    }

    const rotation =
      resolved.rotation ??
      resolved.orientation ??
      panel.rotation ??
      panel.orientation ??
      null;

    const rotationMatrix =
      matrix ??
      phase4RotationMatrix(rotation);

    return {
      id: String(id),

      raw: panel,
      resolved,

      code:
        panel.code ??
        resolved.code ??
        String(id),

      name:
        panel.name ??
        resolved.name ??
        String(id),

      role:
        panel.role ??
        resolved.role ??
        null,

      width: Math.max(width, 0.000001),
      height: Math.max(height, 0.000001),
      depth: Math.max(depth, 0.000001),

      position,

      rotation,
      matrix: rotationMatrix,

      /*
       * Keep original metadata available to the renderer.
       */
      thickness:
        phase4PickNumber(
          dimensions.thickness ??
          resolved.thickness ??
          panel.thickness,
          depth
        ),
    };
  });
}
