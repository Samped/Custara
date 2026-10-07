"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

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

/**
 * Button-only upload: click opens the OS file picker, then uploads via JSON/XHR
 * (no visible file input; avoids wallet-extension FormData crashes).
 */
export function InvoiceUploadForm({
  accept = ".json,.txt,.pdf,.csv,.tsv,application/json,text/plain,text/csv,application/pdf",
  buttonLabel = "Upload",
  className = "dash-upload",
}: {
  accept?: string;
  buttonLabel?: string;
  className?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function uploadFile(file: File) {
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

  return (
    <div className={className}>
      <input
        ref={inputRef}
        type="file"
        name="file"
        accept={accept}
        disabled={busy}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void uploadFile(file);
        }}
      />
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "Uploading…" : buttonLabel}
      </button>
      {error ? <p className="mt-1.5 w-full text-[0.72rem] text-danger">{error}</p> : null}
    </div>
  );
}
