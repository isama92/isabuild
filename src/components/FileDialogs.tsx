import { useId, useState } from "react";
import { Modal } from "./Modal";
import { rollbackDeletes, rollbackDescription, type FileTarget } from "../lib/fileActions";

// The two dialogs behind the status panel's context menu. Same shape as
// GitDialogs: presentational, given a target and two callbacks, with the store
// call and the failure modal left to the panel.

interface CommitFileDialogProps {
  target: FileTarget;
  /**
   * True when this path is in the staged *and* unstaged groups — staged, then
   * edited again. `git commit -- <path>` commits the working-tree version, so
   * that is worth saying before the click, not after.
   */
  alsoModified: boolean;
  onCommit: (message: string) => void;
  onClose: () => void;
}

export function CommitFileDialog({
  target,
  alsoModified,
  onCommit,
  onClose,
}: CommitFileDialogProps) {
  const [message, setMessage] = useState("");
  const messageId = useId();

  const trimmed = message.trim();
  const canCommit = trimmed !== "";

  function submit() {
    if (canCommit) onCommit(trimmed);
  }

  return (
    <Modal
      title={`Commit ${target.path}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="modal-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-button modal-button--primary"
            disabled={!canCommit}
            onClick={submit}
          >
            Commit
          </button>
        </>
      }
    >
      <label className="modal-label" htmlFor={messageId}>
        Message
      </label>
      {/* A textarea, not an input: git messages are a subject and a body, so
          Enter has to insert a newline here. Ctrl/Cmd+Enter commits instead. */}
      <textarea
        id={messageId}
        className="modal-input modal-textarea"
        value={message}
        rows={4}
        autoComplete="off"
        spellCheck
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <p className="modal-hint">
        {target.origPath
          ? `Only this rename is committed (${target.origPath} → ${target.path}). Anything else you have staged stays staged.`
          : "Only this file is committed. Anything else you have staged stays staged."}
      </p>
      {alsoModified && (
        <p className="modal-caution" role="status">
          This file has been changed again since you staged it. git commits the version in
          your working tree, not the one you staged.
        </p>
      )}
    </Modal>
  );
}

interface RollbackFileDialogProps {
  target: FileTarget;
  onRollback: () => void;
  onClose: () => void;
}

export function RollbackFileDialog({ target, onRollback, onClose }: RollbackFileDialogProps) {
  // Whether this deletes the file or restores it depends on the row, and the two
  // deserve different words on an irreversible action. Both the title and the body
  // come from the same helper as the backend's own question — does HEAD have this
  // path? — so the button can never disagree with the sentence above it.
  const deletes = rollbackDeletes(target);
  return (
    <Modal
      title={deletes ? `Delete ${target.path}?` : `Roll back ${target.path}?`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="modal-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-button modal-button--danger"
            onClick={onRollback}
          >
            {deletes ? "Delete" : "Roll back"}
          </button>
        </>
      }
    >
      <p className="modal-text">{rollbackDescription(target)}</p>
    </Modal>
  );
}
