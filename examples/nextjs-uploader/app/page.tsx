"use client";

import { useState } from "react";

export default function Home() {
  const [status, setStatus] = useState<string>("");
  const [downloadUrl, setDownloadUrl] = useState<string>("");

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus("Uploading…");
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) return setStatus("Upload failed");
    const { key } = await res.json();
    setStatus(`Uploaded: ${key}`);

    const signed = await fetch(`/api/presign?key=${encodeURIComponent(key)}`).then((r) => r.json());
    setDownloadUrl(signed.url);
  }

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>R2 Storage — Next.js uploader</h1>
      <input type="file" onChange={onUpload} />
      <p>{status}</p>
      {downloadUrl && (
        <p>
          <a href={downloadUrl} target="_blank" rel="noreferrer">
            Open signed download (1 hour)
          </a>
        </p>
      )}
    </main>
  );
}
