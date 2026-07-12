/**
 * Inspector panel — renders and edits whichever node is currently
 * selected. Pure DOM, no framework, no direct graph mutation: it
 * only calls the callbacks it's given, so main.js stays the single
 * place that actually changes `panels`.
 *
 * The Transform section mirrors what the gizmo does in the 3D
 * view: `offset` (mm, delta from the auto-layout position) and
 * `rotation` (degrees) are editable directly here, and "Reset
 * transform" zeroes both — which is exactly "restore the original
 * position", since offset/rotation are deltas from that position,
 * not absolute coordinates.
 */
export function renderProperties(
  container,
  {
    selectedPanel,
    onFieldChange,
    onTransformFieldChange,
    onResetTransform,
    onSetOrientation,
    onCreateBox,
    onRemove,
  }
) {
  if (!selectedPanel) {
    container.innerHTML = `<div class="empty-state">No panel selected</div>`;
    return;
  }

  // Orientation is read back from rotation.x, rounded to the nearest
  // 90° — this is a preset convenience layered on the same rotation
  // field the gizmo already writes to, not a separate piece of state.
  const rx = (((Math.round(selectedPanel.rotation.x / 90) * 90) % 360) + 360) % 360;
  const isVertical = rx === 0 || rx === 180;
  const isHorizontal = rx === 90 || rx === 270;

  container.innerHTML = `
    <div class="section-title">Node: ${selectedPanel.id}</div>

    <div class="section-title">Panel type</div>
    <div class="type-toggle">
      <button class="type-btn ${isVertical ? 'active' : ''}" data-orientation="vertical">Vertical panel</button>
      <button class="type-btn ${isHorizontal ? 'active' : ''}" data-orientation="horizontal">Horizontal panel</button>
    </div>
    <button class="box-preset-btn" id="create-box-btn">+ Box (4 sides + back, open front)</button>

    <div class="dims-row">
      ${numberFieldHTML('Width', 'width', selectedPanel.width, 'mm', { min: 1 })}
      ${numberFieldHTML('Height', 'height', selectedPanel.height, 'mm', { min: 1 })}
      ${numberFieldHTML('Thickness', 'thickness', selectedPanel.thickness, 'mm', { min: 1 })}
    </div>
    <div class="field-row">
      <label>Material</label>
      <input type="text" value="${selectedPanel.material}" id="material-field" class="field-input" />
    </div>
    ${numberFieldHTML('Quantity', 'quantity', selectedPanel.quantity, 'pc', { min: 1 })}
    <button class="remove-btn" id="remove-btn">Remove panel</button>

    <div class="divider"></div>
    <div class="section-title">Transform (from gizmo)</div>

    <div class="transform-grid">
      ${axisFieldHTML('offset', 'x', selectedPanel.offset.x)}
      ${axisFieldHTML('offset', 'y', selectedPanel.offset.y)}
      ${axisFieldHTML('offset', 'z', selectedPanel.offset.z)}
    </div>
    <div class="transform-label">Position offset (mm)</div>

    <div class="transform-grid">
      ${axisFieldHTML('rotation', 'x', selectedPanel.rotation.x)}
      ${axisFieldHTML('rotation', 'y', selectedPanel.rotation.y)}
      ${axisFieldHTML('rotation', 'z', selectedPanel.rotation.z)}
    </div>
    <div class="transform-label">Rotation (degrees)</div>

    <button class="reset-btn" id="reset-transform-btn">Reset to original position</button>
  `;

  container.querySelectorAll('.dim-field').forEach((input) => {
    input.addEventListener('change', (e) => {
      const field = e.target.dataset.field;
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v > 0) {
        onFieldChange(field, v);
      } else {
        e.target.value = selectedPanel[field];
      }
    });
  });

  container.querySelector('#material-field').addEventListener('change', (e) => {
    onFieldChange('material', e.target.value);
  });

  container.querySelectorAll('.transform-field').forEach((input) => {
    input.addEventListener('change', (e) => {
      const group = e.target.dataset.group; // 'offset' | 'rotation'
      const axis = e.target.dataset.axis;   // 'x' | 'y' | 'z'
      const v = Number(e.target.value);
      if (Number.isFinite(v)) {
        onTransformFieldChange(group, axis, v);
      } else {
        e.target.value = selectedPanel[group][axis];
      }
    });
  });

  container.querySelectorAll('.type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      onSetOrientation(btn.dataset.orientation);
    });
  });

  container.querySelector('#create-box-btn').addEventListener('click', onCreateBox);

  container.querySelector('#reset-transform-btn').addEventListener('click', onResetTransform);
  container.querySelector('#remove-btn').addEventListener('click', onRemove);
}

function numberFieldHTML(label, field, value, unit, { min } = {}) {
  return `
    <div class="field-row">
      <label>${label}</label>
      <div class="field-input-wrap">
        <input type="number" ${min != null ? `min="${min}"` : ''} value="${value}" data-field="${field}" class="field-input dim-field" />
        <span class="field-unit">${unit}</span>
      </div>
    </div>`;
}

function axisFieldHTML(group, axis, value) {
  return `
    <div class="transform-field-wrap">
      <span class="axis-label axis-${axis}">${axis.toUpperCase()}</span>
      <input type="number" step="any" value="${Number(value).toFixed(1)}"
        data-group="${group}" data-axis="${axis}"
        class="field-input transform-field" />
    </div>`;
}
