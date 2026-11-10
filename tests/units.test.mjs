/**
 * tests/units.test.mjs — the display-unit layer (mm / in) is graphic only:
 * conversions, 2-decimal mm rounding, protected material names.
 * Run with: node tests/units.test.mjs
 */
import { assert, assertEqual, section, report } from './helpers.mjs';

globalThis.__DM_UNIT = 'in';
const U = await import('../src/units/index.js');

section('units — text conversion (inches)', () => {
  assertEqual(U.convertText('closer than 5mm'), 'closer than 0.197 in', 'single value');
  assertEqual(U.convertText('418 × 700 × 18 mm'), '16.457 × 27.559 × 0.709 in', 'size list: every number converted');
  assertEqual(U.convertText('x:25.4 y:50.8 z:0 mm'), 'x:1 y:2 z:0 in', 'labelled axes');
  assertEqual(U.convertText('Gap (mm)'), 'Gap (in)', 'unit label');
  assertEqual(U.convertText('Gap between faces, in mm'), 'Gap between faces, in inches', '"in mm" reads correctly');
  assertEqual(U.convertText('Area 2.5 m²'), 'Area 2.5 m²', 'metres / areas untouched');
  U.protectNames(['Melamine White 18mm']);
  assertEqual(U.convertText('Melamine White 18mm (18mm)'), 'Melamine White 18mm (0.709 in)', 'material names are not measurements');
});

section('units — numbers (model stays mm, 2 decimals)', () => {
  assertEqual(U.displayToMm('1'), 25.4, '1 in = 25.4 mm');
  assertEqual(U.displayToMm('0.709'), 18.01, 'typed inches -> mm rounded to 2 decimals');
  assertEqual(U.displayToMm('1,5'), 38.1, 'comma decimal accepted');
  assert(Number.isNaN(U.displayToMm('abc')), 'garbage -> NaN');
  assertEqual(U.lengthToDisplay(18), '0.709', 'mm -> inches shown to 3 decimals');
  assertEqual(U.round2(123.456), 123.46, 'round2');
});

U.setUnit; // (setUnit needs a DOM; the switch itself is exercised in the browser)
report();
