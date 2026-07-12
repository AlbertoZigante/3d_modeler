import React, { useRef, useEffect, useState, useCallback } from "react";
import * as THREE from "three";

/**
 * STAGE 0 — Minimal graph + single panel type
 * ------------------------------------------------------------
 * The point of this stage is NOT the 3D view. It's proving the
 * one-directional pipeline that everything else will build on:
 *
 *     graph (React state)  --->  Three.js mesh (view only)
 *
 * The panel "node" below is the seed of your constraint graph.
 * Right now every field is a literal (no formulas, no relations
 * to other panels) but the SHAPE of this object is exactly what
 * later stages extend — you'll add `spans_between`, `material`
 * as a Variant reference, `holes: []`, etc. without breaking
 * anything that reads from it today (like a BOM export).
 *
 * Units: all panel dimensions are stored in millimetres (mm),
 * since that's what your cut-list / supplier APIs expect. The
 * Three.js scene divides by 1000 only at render time — the
 * graph itself never stores "3D units."
 */

// ---------------------------------------------------------------
// Graph node factory. In later stages this becomes a proper
// class/type with an id generator, dependency list, dirty flag,
// etc. For Stage 0 it's intentionally just a plain object.
// ---------------------------------------------------------------
function createPanelNode() {
  return {
    id: "panel-1",
    type: "panel",
    width: 600, // mm
    height: 400, // mm
    thickness: 18, // mm
    material: "Melamine White 18mm",
    quantity: 1,
  };
}

const MM_TO_UNIT = 1 / 1000; // Three.js scene unit = 1 metre

export default function PanelModelerStage0() {
  const [panel, setPanel] = useState(createPanelNode);

  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const meshRef = useRef(null);

  // Camera orbit state (manual, since OrbitControls isn't
  // importable in this environment — a small custom controller
  // is plenty for Stage 0).
  const orbitRef = useRef({ theta: 0.8, phi: 1.1, radius: 2.2 });
  const dragRef = useRef({ dragging: false, lastX: 0, lastY: 0 });

  // -------------------------------------------------------------
  // One-time scene setup. This runs once — the render loop reads
  // meshRef/orbitRef every frame, it never re-reads React state
  // directly, keeping "render" cleanly separate from "graph".
  // -------------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f4f2);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 100);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    rendererRef.current = renderer;
    mount.appendChild(renderer.domElement);

    // Lighting — flat, functional, not a design centerpiece here
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(3, 5, 4);
    scene.add(dir);

    // Ground grid for spatial reference
    const grid = new THREE.GridHelper(4, 20, 0xcccccc, 0xe3e3e0);
    scene.add(grid);

    // Edges-only box to make panel thickness legible at small scale
    const edgesMat = new THREE.LineBasicMaterial({ color: 0x2b2b28 });
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0xe8e4da,
      roughness: 0.85,
      metalness: 0.02,
    });

    const geometry = new THREE.BoxGeometry(1, 1, 1); // placeholder, resized below
    const mesh = new THREE.Mesh(geometry, boxMat);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      edgesMat
    );
    mesh.add(edges);
    scene.add(mesh);
    meshRef.current = mesh;

    // ---- manual orbit controls (drag to rotate, wheel to zoom) ----
    const dom = renderer.domElement;

    const onPointerDown = (e) => {
      dragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY };
    };
    const onPointerUp = () => {
      dragRef.current.dragging = false;
    };
    const onPointerMove = (e) => {
      if (!dragRef.current.dragging) return;
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      orbitRef.current.theta -= dx * 0.005;
      orbitRef.current.phi = Math.min(
        Math.max(orbitRef.current.phi - dy * 0.005, 0.15),
        Math.PI - 0.15
      );
    };
    const onWheel = (e) => {
      e.preventDefault();
      orbitRef.current.radius = Math.min(
        Math.max(orbitRef.current.radius + e.deltaY * 0.001, 0.6),
        6
      );
    };

    dom.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointermove", onPointerMove);
    dom.addEventListener("wheel", onWheel, { passive: false });

    let raf;
    const animate = () => {
      const { theta, phi, radius } = orbitRef.current;
      camera.position.set(
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.cos(theta)
      );
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("wheel", onWheel);
      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, []);

  // -------------------------------------------------------------
  // THE RECONCILER (Stage 0 version)
  // This is the seam that matters most architecturally: whenever
  // the graph node changes, we regenerate the mesh's geometry.
  // In later stages this same effect — "diff graph, patch mesh" —
  // is what scales to dozens of nodes with dirty-flag propagation.
  // Here it's simple because there's only one node.
  // -------------------------------------------------------------
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const w = panel.width * MM_TO_UNIT;
    const h = panel.height * MM_TO_UNIT;
    const t = panel.thickness * MM_TO_UNIT;

    mesh.geometry.dispose();
    mesh.geometry = new THREE.BoxGeometry(w, h, t);

    // rebuild edge overlay to match new geometry
    const oldEdges = mesh.children[0];
    if (oldEdges) {
      oldEdges.geometry.dispose();
      mesh.remove(oldEdges);
    }
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: 0x2b2b28 })
    );
    mesh.add(edges);
  }, [panel.width, panel.height, panel.thickness]);

  // -------------------------------------------------------------
  // Graph mutation helper. Every field edit goes through here —
  // this is the ONLY way the panel node changes. There is no path
  // from the 3D view back into this state; the view is read-only.
  // -------------------------------------------------------------
  const updateField = useCallback((field, value) => {
    setPanel((prev) => ({ ...prev, [field]: value }));
  }, []);

  const numberField = (label, field, unit = "mm") => (
    <label style={styles.fieldRow}>
      <span style={styles.fieldLabel}>{label}</span>
      <div style={styles.fieldInputWrap}>
        <input
          type="number"
          value={panel[field]}
          min={1}
          onChange={(e) => {
            const v = Number(e.target.value);
            updateField(field, Number.isFinite(v) && v > 0 ? v : panel[field]);
          }}
          style={styles.fieldInput}
        />
        <span style={styles.fieldUnit}>{unit}</span>
      </div>
    </label>
  );

  // Simple derived "BOM" — exactly one line for exactly one node.
  // This is the projection your BOM engine will generalize later.
  const bomLine = {
    material: panel.material,
    thickness: panel.thickness,
    width: panel.width,
    height: panel.height,
    quantity: panel.quantity,
    areaM2: ((panel.width * panel.height) / 1_000_000).toFixed(3),
  };

  return (
    <div style={styles.app}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Panel Modeller</span>
        <span style={styles.headerStage}>Stage 0 · single node</span>
      </div>

      <div style={styles.body}>
        <div ref={mountRef} style={styles.viewport} />

        <div style={styles.panel}>
          <div style={styles.panelSectionTitle}>Node: {panel.id}</div>
          {numberField("Width", "width")}
          {numberField("Height", "height")}
          {numberField("Thickness", "thickness")}

          <label style={styles.fieldRow}>
            <span style={styles.fieldLabel}>Material</span>
            <input
              type="text"
              value={panel.material}
              onChange={(e) => updateField("material", e.target.value)}
              style={{ ...styles.fieldInput, width: "100%" }}
            />
          </label>

          {numberField("Quantity", "quantity", "pc")}

          <div style={styles.divider} />

          <div style={styles.panelSectionTitle}>BOM (derived, live)</div>
          <table style={styles.bomTable}>
            <tbody>
              <tr>
                <td style={styles.bomKey}>Material</td>
                <td style={styles.bomVal}>{bomLine.material}</td>
              </tr>
              <tr>
                <td style={styles.bomKey}>Dimensions</td>
                <td style={styles.bomVal}>
                  {bomLine.width} × {bomLine.height} × {bomLine.thickness} mm
                </td>
              </tr>
              <tr>
                <td style={styles.bomKey}>Quantity</td>
                <td style={styles.bomVal}>{bomLine.quantity}</td>
              </tr>
              <tr>
                <td style={styles.bomKey}>Area / panel</td>
                <td style={styles.bomVal}>{bomLine.areaM2} m²</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const styles = {
  app: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 560,
    fontFamily:
      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    background: "#faf9f7",
    color: "#26251f",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    padding: "12px 16px",
    borderBottom: "1px solid #e4e1d8",
  },
  headerTitle: { fontSize: 15, fontWeight: 600, letterSpacing: 0.1 },
  headerStage: { fontSize: 12, color: "#847e6d" },
  body: { display: "flex", flex: 1, minHeight: 0 },
  viewport: { flex: 1, minWidth: 0 },
  panel: {
    width: 260,
    borderLeft: "1px solid #e4e1d8",
    padding: 16,
    overflowY: "auto",
    background: "#fff",
  },
  panelSectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: "#847e6d",
    marginBottom: 10,
  },
  fieldRow: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    marginBottom: 12,
  },
  fieldLabel: { fontSize: 12, color: "#55503f" },
  fieldInputWrap: { display: "flex", alignItems: "center", gap: 6 },
  fieldInput: {
    flex: 1,
    padding: "6px 8px",
    fontSize: 13,
    border: "1px solid #d9d5c9",
    borderRadius: 4,
    outline: "none",
  },
  fieldUnit: { fontSize: 11, color: "#a49d89", width: 20 },
  divider: { height: 1, background: "#e4e1d8", margin: "8px 0 14px" },
  bomTable: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  bomKey: { color: "#847e6d", padding: "4px 0", verticalAlign: "top" },
  bomVal: { textAlign: "right", padding: "4px 0", fontWeight: 500 },
};
