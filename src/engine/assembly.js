/**
 * engine/assembly.js — compatibility entry point.
 *
 * The planner now lives in engine/assembly/ (one concern per file);
 * this re-export keeps existing imports (`./engine/assembly.js`) working.
 */
export * from './assembly/index.js';
