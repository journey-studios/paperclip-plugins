import React, { useEffect, useState } from "react";
import { useHostLocation, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";

type Preview = {
  downloadUrl: string;
  expiresAt: string;
  media: { sha256: string; width: number; height: number };
};

/** Same-origin Board API only: signed URLs stay in browser state, outside the plugin message bridge. */
export function SocialMediaPreviewPage({ context }: PluginPageProps) {
  const location = useHostLocation();
  const mediaId = new URLSearchParams(location.search).get("mediaId");
  const companyId = context.companyId;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setError("");
    if (!companyId || !mediaId || !/^[0-9a-f-]{36}$/i.test(mediaId)) {
      setError("Imagem ou empresa inválida.");
      return () => controller.abort();
    }
    const path = `/api/plugins/journey-studios.social-publisher/api/media/${encodeURIComponent(mediaId)}/preview?companyId=${encodeURIComponent(companyId)}`;
    void fetch(path, { credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403)
          throw new Error("Acesso reservado ao fundador. Abra com sua sessão do Paperclip.");
        if (!response.ok) throw new Error("Não foi possível carregar a imagem. Tente novamente.");
        const value = (await response.json()).data as Preview;
        if (!value?.media?.sha256 || new URL(value.downloadUrl).protocol !== "https:")
          throw new Error("Prévia indisponível.");
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Prévia indisponível.");
      });
    return () => controller.abort();
  }, [companyId, mediaId, reload]);

  return <section style={{ maxWidth: 800, margin: "0 auto" }}>
    <h1>Prévia da imagem</h1>
    {error ? <p role="alert">{error}</p> : null}
    {!preview && !error ? <p role="status">Carregando imagem…</p> : null}
    {preview ? <>
      <img src={preview.downloadUrl} referrerPolicy="no-referrer" alt="Imagem editorial do Tessel" style={{ display: "block", maxWidth: "100%", maxHeight: "70vh", objectFit: "contain" }} onError={() => { setPreview(null); setError("O acesso temporário expirou ou a imagem está indisponível. Atualize a prévia."); }} />
      <p>{preview.media.width} × {preview.media.height} · SHA-256 <code>{preview.media.sha256}</code></p>
      <p>Link temporário válido até {new Date(preview.expiresAt).toLocaleString()}.</p>
    </> : null}
    <button type="button" onClick={() => setReload((value) => value + 1)}>Atualizar imagem</button>
  </section>;
}
