/** stdin: JSON array of [a, b] string pairs; stdout: JSON array of a.localeCompare(b) signs (-1 | 0 | 1). */
import { readFileSync } from 'node:fs';
const pairs = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(pairs.map(([a, b]) => Math.sign(a.localeCompare(b)))));
