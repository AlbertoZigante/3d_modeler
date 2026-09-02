/**
 * history.js
 *
 * Undo / redo infrastructure for the furniture modeller.
 *
 * This file deliberately does NOT know about:
 *   - `panels`
 *   - Three.js
 *   - rendering
 *   - selection
 *   - constraint resolution
 *
 * `modeller-main.js` will connect these commands to the actual model later.
 *
 * Design:
 *   - A command represents ONE USER ACTION.
 *   - Commands contain before/after state.
 *   - Undo restores `before`.
 *   - Redo restores `after`.
 *   - A new command after an undo clears the redo stack.
 *   - Continuous interactions (dragging, resizing, etc.) should create
 *     ONE command at mouse-up / commit time, not one command per frame.
 *   - CompositeCommand allows several low-level changes to become one
 *     user-visible undo step.
 *
 * Default history length is 20. This is intentionally larger than the
 * requested minimum of 10, but can be changed when creating HistoryManager.
 */


/* ================================================================
   Utilities
   ================================================================ */

function cloneValue(value) {
  if (value === undefined || value === null) return value;

  // structuredClone is preferable because model data can contain nested
  // objects and arrays. The JSON fallback is sufficient for the plain
  // data objects used by the modeller.
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
}


/* ================================================================
   Base command
   ================================================================ */

/**
 * Base class for all modeller commands.
 *
 * A command is intentionally independent from the model implementation.
 * `applyState` is supplied by modeller-main.js.
 */
export class ModelCommand {
  constructor({
    label,
    before,
    after,
    applyState,
  }) {
    if (!label) {
      throw new Error('A history command requires a label');
    }

    assertFunction(applyState, 'applyState');

    this.label = label;

    // Commands own their snapshots. This is important: if `panels` is
    // subsequently mutated, the history entry must not change with it.
    this.before = cloneValue(before);
    this.after = cloneValue(after);

    this._applyState = applyState;
  }

  execute() {
    this._applyState(cloneValue(this.after));
  }

  undo() {
    this._applyState(cloneValue(this.before));
  }

  redo() {
    this.execute();
  }
}


/* ================================================================
   Simple / named commands
   ================================================================ */

/**
 * These classes are intentionally thin.
 *
 * They give the history entries meaningful semantic names while sharing
 * the same before/after-state implementation.
 */

export class AddPanelCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Add panel' });
  }
}

export class DeletePanelCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Delete panel' });
  }
}

export class AddBoxCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Add box' });
  }
}

export class DeleteBoxCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Delete box' });
  }
}

export class MovePanelCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Move panel' });
  }
}

export class MoveGroupCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Move group' });
  }
}

export class ResizePanelCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Resize panel' });
  }
}

export class ChangeMaterialCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Change material' });
  }
}

export class ChangeGroupMaterialCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Change group material' });
  }
}

export class ChangeEdgeFitCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Change panel edge fit' });
  }
}

export class AddDoorCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Add door' });
  }
}

export class SetDoorHingeCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Change door hinge side' });
  }
}

export class DeleteDoorCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Delete door' });
  }
}

export class RenamePanelCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Rename panel' });
  }
}

export class GroupPanelsCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Group panels' });
  }
}

export class UngroupPanelsCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Ungroup panels' });
  }
}

export class AddShelfCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Add shelf' });
  }
}

export class DeleteShelfCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Delete shelf' });
  }
}

export class AddConstraintCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Add constraint' });
  }
}

export class RemoveConstraintCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Remove constraint' });
  }
}

export class UnlinkConstraintCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Unlink constraint' });
  }
}

export class HideBoxWallCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Hide box wall' });
  }
}

export class RestoreBoxWallCommand extends ModelCommand {
  constructor(options) {
    super({ ...options, label: 'Restore box wall' });
  }
}


/* ================================================================
   Composite command / transactions
   ================================================================ */

/**
 * Groups several commands into ONE undo/redo step.
 *
 * Useful for operations such as:
 *
 *   Add box
 *     -> create 6 walls
 *     -> create related data
 *
 * or:
 *
 *   Complex operation
 *     -> change panel A
 *     -> change panel B
 *     -> change panel C
 *
 * The individual commands still execute in order, but the user sees
 * one history entry.
 */
export class CompositeCommand {
  constructor(label, commands = []) {
    if (!label) {
      throw new Error('A composite command requires a label');
    }

    this.label = label;
    this.commands = [...commands];
  }

  add(command) {
    if (!command || typeof command.execute !== 'function' ||
        typeof command.undo !== 'function') {
      throw new TypeError('CompositeCommand.add() expects a command');
    }

    this.commands.push(command);
    return this;
  }

  execute() {
    for (const command of this.commands) {
      command.execute();
    }
  }

  undo() {
    // Reverse order is essential: undo the last change first.
    for (let i = this.commands.length - 1; i >= 0; i -= 1) {
      this.commands[i].undo();
    }
  }

  redo() {
    this.execute();
  }
}


/* ================================================================
   History manager
   ================================================================ */

export class HistoryManager {
  constructor({ maxHistory = 20, onChange = null } = {}) {
    if (!Number.isInteger(maxHistory) || maxHistory < 1) {
      throw new TypeError('maxHistory must be an integer >= 1');
    }

    if (onChange !== null && typeof onChange !== 'function') {
      throw new TypeError('onChange must be a function or null');
    }

    this.maxHistory = maxHistory;

    this.undoStack = [];
    this.redoStack = [];

    this._onChange = onChange;
    this._transaction = null;   
  }

  setOnChange(onChange) {
    if (onChange !== null && typeof onChange !== 'function') {
      throw new TypeError('onChange must be a function or null');
    }
    this._onChange = onChange;
  } 

  /**
   * Execute a new user command.
   *
   * New edits always invalidate redo history.
   */
  record(command) {
    this._assertCommand(command);

    if (this._transaction) {
      this._transaction.add(command);
      return command;
    }

    this.undoStack.push(command);
    this.redoStack.length = 0;

    this._trimUndoStack();
    this._notify();

    return command;
  }

  /**
   * Undo one user action.
   */
  undo() {
    if (!this.canUndo()) return false;

    const command = this.undoStack.pop();

    command.undo();

    this.redoStack.push(command);

    this._notify();

    return true;
  }

  /**
   * Redo one previously undone action.
   */
  redo() {
    if (!this.canRedo()) return false;

    const command = this.redoStack.pop();

    command.redo();

    this.undoStack.push(command);

    this._trimUndoStack();
    this._notify();

    return true;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  /**
   * Number of currently available undo steps.
   */
  get undoCount() {
    return this.undoStack.length;
  }

  /**
   * Number of currently available redo steps.
   */
  get redoCount() {
    return this.redoStack.length;
  }

  /**
   * Most recent undo command, or null.
   */
  get lastUndoCommand() {
    return this.undoStack.length
      ? this.undoStack[this.undoStack.length - 1]
      : null;
  }

  /**
   * Most recent redo command, or null.
   */
  get lastRedoCommand() {
    return this.redoStack.length
      ? this.redoStack[this.redoStack.length - 1]
      : null;
  }

  /**
   * Clears all history.
   *
   * Useful when loading an existing furniture file. You generally do not
   * want the user to undo into a model that existed before the load.
   */
  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._transaction = null;

    this._notify();
  }

  /**
   * Begin collecting commands into one user-visible history entry.
   *
   * Example:
   *
   *   history.beginTransaction('Duplicate cabinet');
   *   history.execute(command1);
   *   history.execute(command2);
   *   history.execute(command3);
   *   history.commitTransaction();
   */
  beginTransaction(label) {
    if (!label) {
      throw new Error('A transaction requires a label');
    }

    if (this._transaction) {
      throw new Error('A history transaction is already open');
    }

    this._transaction = new CompositeCommand(label);

    return this._transaction;
  }

  /**
   * Finish the current transaction.
   *
   * An empty transaction is ignored.
   */
  commitTransaction() {
    if (!this._transaction) {
      throw new Error('No history transaction is open');
    }

    const transaction = this._transaction;
    this._transaction = null;

    if (transaction.commands.length === 0) {
      return false;
    }

    this.undoStack.push(transaction);
    this.redoStack.length = 0;

    this._trimUndoStack();
    this._notify();

    return true;
  }

  /**
   * Cancel a transaction and undo all commands that were executed inside it.
   *
   * Useful when an operation is rejected or cancelled.
   */
  cancelTransaction() {
    if (!this._transaction) {
      throw new Error('No history transaction is open');
    }

    const transaction = this._transaction;
    this._transaction = null;

    transaction.undo();

    this._notify();

    return true;
  }

  isTransactionOpen() {
    return this._transaction !== null;
  }

  /**
   * Useful for debugging / development tools.
   *
   * Returns labels only, not mutable command objects.
   */
  getHistoryInfo() {
    return {
      undo: this.undoStack.map((command) => command.label),
      redo: this.redoStack.map((command) => command.label),
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      maxHistory: this.maxHistory,
      transactionOpen: this.isTransactionOpen(),
    };
  }

  _assertCommand(command) {
    if (
      !command ||
      typeof command.execute !== 'function' ||
      typeof command.undo !== 'function'
    ) {
      throw new TypeError(
        'HistoryManager.execute() expects a command with execute() and undo()'
      );
    }
  }

  _trimUndoStack() {
    while (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
  }

  _notify() {
    if (this._onChange) {
      this._onChange(this);
    }
  }
}


/* ================================================================
   Optional helper for creating a model-state command
   ================================================================ */

/**
 * Convenience function for the later modeller-main.js integration.
 *
 * Example:
 *
 *   const command = createStateCommand({
 *     CommandClass: MovePanelCommand,
 *     before: oldState,
 *     after: newState,
 *     applyState: (state) => {
 *       panels = state;
 *       renderAll();
 *     }
 *   });
 */
export function createStateCommand({
  CommandClass = ModelCommand,
  before,
  after,
  applyState,
}) {
  return new CommandClass({
    before,
    after,
    applyState,
  });
}


/* ================================================================
   Default history instance
   ================================================================ */

/**
 * A single shared history instance is convenient for the modeller.
 *
 * `modeller-main.js` can import this as:
 *
 *   import { history } from './modeller/history.js';
 *
 * The default is 20 user actions, giving more than the requested
 * minimum of 10 undo steps.
 */
export const history = new HistoryManager({
  maxHistory: 20,
});