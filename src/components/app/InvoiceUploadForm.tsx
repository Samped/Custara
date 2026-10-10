"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function acceptedExtensions(accept: string) {
  return [...new Set([...accept.matchAll(/\.([a-z0-9]+)/gi)].map((match) => match[1].toLowerCase()))];
}

function acceptLabel(accept: string) {
  const labels = acceptedExtensions(accept).map((ext) => ext.toUpperCase());
  if (labels.length === 0) return "a file";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

function fileAllowed(file: File, accept: string) {
  const extensions = acceptedExtensions(accept);
  if (extensions.length === 0) return true;
  const name = file.name.toLowerCase();
  return extensions.some((ext) => name.endsWith(`.${ext}`));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Opens a file dialog, then uploads the chosen file as JSON/XHR
 * (no form post; avoids wallet-extension FormData crashes).
 */
export function InvoiceUploadForm({
  accept = ".json,.txt,.pdf,.csv,.tsv,application/json,text/plain,text/csv,application/pdf",
  buttonLabel = "Upload",
  className = "dash-upload",
  title = "Upload invoice",
}: {
  accept?: string;
  buttonLabel?: string;
  className?: string;
  title?: string;
}) {
  const router = useRouter();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  function closeDialog() {
    if (busy) return;
    setOpen(false);
    setFile(null);
    setDragOver(false);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
    triggerRef.current?.focus();
  }

  function chooseFile(next: File | undefined, extraCount = 0) {
    if (!next || busy) return;
    if (extraCount > 0) {
      setFile(null);
      setError("Upload one invoice at a time.");
      return;
    }
    if (!fileAllowed(next, accept)) {
      setFile(null);
      setError(`Use ${acceptLabel(accept)}.`);
      return;
    }
    setError(null);
    setFile(next);
  }

  async function uploadFile() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const contentBase64 = await fileToBase64(file);
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/app/upload-invoice");
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("X-Custara-Upload", "xhr");
        xhr.setRequestHeader("Accept", "application/json");
        xhr.withCredentials = true;
        xhr.onload = () => {
          let data: { ok?: boolean; redirectTo?: string; error?: string } = {};
          try {
            data = JSON.parse(xhr.responseText || "{}") as typeof data;
          } catch {
            reject(new Error(`Upload failed (${xhr.status})`));
            return;
          }
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new Error(data.error || `Upload failed (${xhr.status})`));
            return;
          }
          if (data.redirectTo) {
            setOpen(false);
            router.push(data.redirectTo);
            router.refresh();
            resolve();
            return;
          }
          reject(new Error("Upload succeeded but no redirect returned"));
        };
        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.send(
          JSON.stringify({
            fileName: file.name,
            contentType: file.type || "application/octet-stream",
            contentBase64,
          }),
        );
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function onDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const nodes = [
      ...dialogRef.current.querySelectorAll<HTMLElement>("button, [href], input, [tabindex]"),
    ].filter((node) => !node.hasAttribute("disabled") && node.tabIndex !== -1);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const dialog = open ? (
    <div className="upload-modal-root" onMouseDown={closeDialog}>
      <div
        ref={dialogRef}
        className="upload-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <div className="upload-modal-head">
          <div>
            <p className="dash-kicker">Inbox</p>
            <h2 id={titleId} className="upload-modal-title">
              {title}
            </h2>
            <p className="upload-modal-sub">{acceptLabel(accept)}</p>
          </div>
          <button type="button" className="upload-modal-close" onClick={closeDialog} disabled={busy} aria-label="Close">
            Close
          </button>
        </div>

        <div
          className={`upload-drop${dragOver ? " is-over" : ""}${file ? " has-file" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (event.currentTarget.contains(event.relatedTarget as Node)) return;
            setDragOver(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            const dropped = event.dataTransfer.files;
            chooseFile(dropped?.[0], Math.max(0, dropped.length - 1));
          }}
        >
          <span className="upload-drop-mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="22" height="22">
              <path
                d="M12 16V5m0 0 4 4m-4-4-4 4M5 19h14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <p className="upload-drop-title">{file ? file.name : "Drop a file here"}</p>
          <p className="upload-drop-meta">
            {file ? formatBytes(file.size) : "or choose one from your computer"}
          </p>
          <input
            ref={inputRef}
            type="file"
            name="file"
            accept={accept}
            disabled={busy}
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              const picked = event.target.files;
              chooseFile(picked?.[0], Math.max(0, (picked?.length || 0) - 1));
            }}
          />
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
            {file ? "Replace file" : "Choose file"}
          </button>
        </div>

        {error ? <p className="upload-modal-error">{error}</p> : null}

        <div className="upload-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={closeDialog} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void uploadFile()} disabled={busy || !file}>
            {busy ? "Uploading…" : buttonLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className={className}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => {
          setError(null);
          setFile(null);
          setOpen(true);
        }}
      >
        {busy ? "Uploading…" : buttonLabel}
      </button>
      {mounted && dialog ? createPortal(dialog, document.body) : null}
    </div>
  );
}
