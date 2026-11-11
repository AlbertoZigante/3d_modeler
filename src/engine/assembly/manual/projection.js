export function phase4ProjectPoint(point, camera) {
  return {
    x:
      point.x * camera.rightX +
      point.y * camera.rightY +
      point.z * camera.rightZ,

    y:
      point.x * camera.upX +
      point.y * camera.upY +
      point.z * camera.upZ,

    depth:
      point.x * camera.depthX +
      point.y * camera.depthY +
      point.z * camera.depthZ,
  };
}

export function phase4BuildPanelCorners(part) {
  const w = part.width;
  const h = part.height;
  const d = part.depth;

  /*
   * Local panel coordinate system:
   *
   * X = width
   * Y = height
   * Z = thickness/depth
   */
  const localCorners = [
    { x: 0, y: 0, z: 0 },
    { x: w, y: 0, z: 0 },
    { x: w, y: h, z: 0 },
    { x: 0, y: h, z: 0 },

    { x: 0, y: 0, z: d },
    { x: w, y: 0, z: d },
    { x: w, y: h, z: d },
    { x: 0, y: h, z: d },
  ];

  return localCorners.map(point =>
    phase4TransformPoint(
      point,
      part.matrix,
      part.position
    )
  );
}

export function phase4PickVector(value, fallback = null) {
  if (Array.isArray(value)) {
    if (value.length >= 3) {
      const x = Number(value[0]);
      const y = Number(value[1]);
      const z = Number(value[2]);

      if (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(z)
      ) {
        return { x, y, z };
      }
    }
  }

  if (value && typeof value === 'object') {
    const x = Number(
      value.x ??
      value.X ??
      value[0]
    );

    const y = Number(
      value.y ??
      value.Y ??
      value[1]
    );

    const z = Number(
      value.z ??
      value.Z ??
      value[2]
    );

    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(z)
    ) {
      return { x, y, z };
    }
  }

  return fallback;
}

export function phase4MatrixFrom(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  if (value.length === 9) {
    return value.map(Number);
  }

  if (value.length === 16) {
    return value.map(Number);
  }

  return null;
}

export function phase4TranslationFromMatrix(matrix) {
  if (!Array.isArray(matrix)) {
    return null;
  }

  if (matrix.length === 16) {
    const values = matrix.map(Number);

    if (values.every(Number.isFinite)) {
      return {
        x: values[12],
        y: values[13],
        z: values[14],
      };
    }
  }

  return null;
}

export function phase4RotationMatrix(rotation) {
  if (!rotation) {
    return [
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ];
  }

  /*
   * Already a 3x3 matrix.
   */
  if (Array.isArray(rotation) && rotation.length === 9) {
    return rotation.map(Number);
  }

  /*
   * A 4x4 transform matrix.
   */
  if (Array.isArray(rotation) && rotation.length === 16) {
    const m = rotation.map(Number);

    return [
      m[0], m[1], m[2],
      m[4], m[5], m[6],
      m[8], m[9], m[10],
    ];
  }

  /*
   * Quaternion:
   * [x, y, z, w]
   */
  if (Array.isArray(rotation) && rotation.length === 4) {
    const x = Number(rotation[0]);
    const y = Number(rotation[1]);
    const z = Number(rotation[2]);
    const w = Number(rotation[3]);

    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(z) &&
      Number.isFinite(w)
    ) {
      return phase4QuaternionToMatrix(x, y, z, w);
    }
  }

  /*
   * Quaternion object.
   */
  if (
    rotation &&
    typeof rotation === 'object' &&
    Number.isFinite(Number(rotation.w))
  ) {
    return phase4QuaternionToMatrix(
      Number(rotation.x ?? 0),
      Number(rotation.y ?? 0),
      Number(rotation.z ?? 0),
      Number(rotation.w)
    );
  }

  /*
   * Euler object.
   */
  if (rotation && typeof rotation === 'object') {
    const x = Number(
      rotation.x ??
      rotation.X ??
      rotation.rx ??
      rotation.pitch ??
      0
    );

    const y = Number(
      rotation.y ??
      rotation.Y ??
      rotation.ry ??
      rotation.yaw ??
      0
    );

    const z = Number(
      rotation.z ??
      rotation.Z ??
      rotation.rz ??
      rotation.roll ??
      0
    );

    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(z)
    ) {
      return phase4EulerToMatrix(x, y, z);
    }
  }

  return [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ];
}

export function phase4QuaternionToMatrix(x, y, z, w) {
  const length = Math.hypot(x, y, z, w) || 1;

  x /= length;
  y /= length;
  z /= length;
  w /= length;

  const xx = x * x;
  const yy = y * y;
  const zz = z * z;

  const xy = x * y;
  const xz = x * z;
  const yz = y * z;

  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  return [
    1 - 2 * (yy + zz),
    2 * (xy - wz),
    2 * (xz + wy),

    2 * (xy + wz),
    1 - 2 * (xx + zz),
    2 * (yz - wx),

    2 * (xz - wy),
    2 * (yz + wx),
    1 - 2 * (xx + yy),
  ];
}

export function phase4EulerToMatrix(x, y, z) {
  /*
   * Accept degrees if values clearly exceed a normal radian
   * range. Otherwise treat values as radians.
   */
  const convert = value =>
    Math.abs(value) > Math.PI * 2
      ? value * Math.PI / 180
      : value;

  x = convert(x);
  y = convert(y);
  z = convert(z);

  const cx = Math.cos(x);
  const sx = Math.sin(x);

  const cy = Math.cos(y);
  const sy = Math.sin(y);

  const cz = Math.cos(z);
  const sz = Math.sin(z);

  /*
   * Rz * Ry * Rx
   */
  return [
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,

    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,

    -sy,
    cy * sx,
    cy * cx,
  ];
}

export function phase4TransformPoint(point, matrix, position) {
  const x = point.x;
  const y = point.y;
  const z = point.z;

  let tx;
  let ty;
  let tz;

  if (matrix.length === 16) {
    /*
     * Column-major 4x4 matrix.
     */
    tx =
      matrix[0] * x +
      matrix[4] * y +
      matrix[8] * z +
      matrix[12];

    ty =
      matrix[1] * x +
      matrix[5] * y +
      matrix[9] * z +
      matrix[13];

    tz =
      matrix[2] * x +
      matrix[6] * y +
      matrix[10] * z +
      matrix[14];

    return {
      x: tx,
      y: ty,
      z: tz,
    };
  }

  /*
   * 3x3 rotation + explicit position.
   */
  tx =
    matrix[0] * x +
    matrix[1] * y +
    matrix[2] * z;

  ty =
    matrix[3] * x +
    matrix[4] * y +
    matrix[5] * z;

  tz =
    matrix[6] * x +
    matrix[7] * y +
    matrix[8] * z;

  return {
    x: tx + (position?.x ?? 0),
    y: ty + (position?.y ?? 0),
    z: tz + (position?.z ?? 0),
  };
}
