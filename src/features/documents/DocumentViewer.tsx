"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FullscreenSurface, FullscreenButton } from "@/ui/FullscreenSurface";
import { Button, Dialog } from "@/ui";
import "pdfjs-dist/web/pdf_viewer.css";
import type { PDFDocumentProxy } from "pdfjs-dist";

export type PreviewDocument = { id: string; originalFilename?: string; caption?: string | null; mime?: string; hasWebCopy?: boolean };

/** Private files stay behind the session-authenticated attachment endpoint. */
export function DocumentPreview({ document, compact = false }: { document: PreviewDocument; compact?: boolean }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [mime, setMime] = useState(document.mime ?? "");
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState("");
  const pan = useRef<{x:number;y:number;left:number;top:number} | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.round(entries[0]?.contentRect.width ?? 0)));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const url = `/api/attachments/${encodeURIComponent(document.id)}`;
  useEffect(() => {
    if (document.mime) return;
    const controller = new AbortController();
    void fetch(url, { method: "HEAD", signal: controller.signal }).then(r => {
      if (!r.ok) throw new Error("Could not open this file. Try signing in again.");
      setMime(r.headers.get("content-type") ?? "");
    }).catch(e => { if (!controller.signal.aborted) setError(String(e.message)); });
    return () => controller.abort();
  }, [document.mime, url]);
  useEffect(() => {
    if (!mime.includes("pdf")) return;
    let cancelled = false;
    let destroy: (() => void) | undefined;
    void import("pdfjs-dist").then(async lib => {
      if (cancelled) return;
      lib.GlobalWorkerOptions.workerSrc = "/api/pdf-worker";
      const task = lib.getDocument({ url });
      destroy = () => { void task.destroy(); };
      const doc = await task.promise;
      if (!cancelled) setPdf(doc);
    }).catch(e => { if (!cancelled) setError(e.name === "PasswordException" ? "This PDF is password-protected. Download it to open with its password." : "This PDF could not be displayed. You can still download the original."); });
    return () => { cancelled = true; destroy?.(); };
  }, [mime, url]);
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let cancel: (() => void) | undefined;
    void pdf.getPage(page).then(async p => {
      if (cancelled || !canvas.current || !container.current || !textLayer.current || container.current.clientWidth <= 24) return;
      const base = p.getViewport({ scale: 1, rotation });
      const scale = Math.min(2, (container.current.clientWidth - 24) / base.width) * zoom;
      const viewport = p.getViewport({ scale, rotation });
      const target = canvas.current;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      target.width = Math.round(viewport.width * ratio);
      target.height = Math.round(viewport.height * ratio);
      target.style.width = `${viewport.width}px`;
      target.style.height = `${viewport.height}px`;
      const task = p.render({ canvas: target, viewport, transform: ratio === 1 ? undefined : [ratio,0,0,ratio,0,0] });
      cancel = () => task.cancel();
      await task.promise;
      if (!cancelled) setError("");
      if (cancelled || !textLayer.current) return;
      textLayer.current.replaceChildren();
      const lib = await import("pdfjs-dist");
      const content = await p.getTextContent();
      if (cancelled || !textLayer.current) return;
      textLayer.current.style.setProperty("--scale-factor", String(scale));
      await new lib.TextLayer({ textContentSource: content, container: textLayer.current, viewport }).render();
    }).catch(e => { if (!cancelled && e.name !== "RenderingCancelledException") setError("This page could not be rendered."); });
    return () => { cancelled = true; cancel?.(); };
  }, [pdf, page, zoom, rotation, width]);
  async function search() {
    if (!pdf || !query.trim()) return;
    setSearching(true); setSearchStatus("");
    try {
      for (let offset = 1; offset <= pdf.numPages; offset++) {
        const n = ((page + offset - 1) % pdf.numPages) + 1;
        const p = await pdf.getPage(n);
        const text = (await p.getTextContent()).items.map(i => "str" in i ? i.str : "").join(" ");
        if (text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) { setPage(n); setSearchStatus(`Found on page ${n}`); return; }
      }
      setSearchStatus("No matching text. Scanned pages may need OCR.");
    } catch {
      setSearchStatus("Text search could not read this document. You can still view its pages or download it.");
    } finally { setSearching(false); }
  }
  return <FullscreenSurface className="[&[data-fullscreen]]:z-[80]"><div ref={container} className="flex h-full min-w-0 flex-col rounded-lg border border-line bg-surface">
    {!compact && <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
      {pdf && <><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span className="text-xs">Page {page} / {pdf.numPages}</span><Button size="sm" disabled={page >= pdf.numPages} onClick={() => setPage(page + 1)}>Next</Button></>}
      <Button size="sm" onClick={() => setZoom(z => Math.max(.25, z - .25))} aria-label="Zoom out">−</Button><Button size="sm" onClick={() => setZoom(z => Math.min(4, z + .25))} aria-label="Zoom in">+</Button>
      <Button size="sm" onClick={() => setZoom(1)}>Fit width</Button><Button size="sm" onClick={() => setRotation(r => (r + 90) % 360)}>Rotate</Button><FullscreenButton />
      <a className="ml-auto text-sm underline" href={`${url}?download=1`} download={document.originalFilename}>Download</a>
      {pdf && <form className="flex w-full gap-2" onSubmit={e => { e.preventDefault(); void search(); }}><input aria-label="Find text in PDF" placeholder="Find in document" className="min-w-0 flex-1 rounded border border-line bg-surface px-2" value={query} onChange={e => setQuery(e.target.value)} /><Button size="sm" loading={searching} type="submit">Find next</Button><span role="status" className="text-xs">{searchStatus}</span></form>}
    </div>}
    {error && <p role="alert" className="p-3 text-sm text-overdue">{error} <a href={url} download className="underline">Download original</a></p>}
    <div className={compact ? "pointer-events-none max-h-56 overflow-hidden p-2" : "min-h-0 max-h-[70dvh] flex-1 overflow-auto p-2"}
      onPointerDown={event=>{if(!compact && mime.startsWith("image/") && zoom>1 && event.pointerType==="mouse"){event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);pan.current={x:event.clientX,y:event.clientY,left:event.currentTarget.scrollLeft,top:event.currentTarget.scrollTop};}}}
      onPointerMove={event=>{if(pan.current){event.currentTarget.scrollLeft=pan.current.left-event.clientX+pan.current.x;event.currentTarget.scrollTop=pan.current.top-event.clientY+pan.current.y;}}}
      onPointerUp={()=>{pan.current=null;}} onPointerCancel={()=>{pan.current=null;}}>
      {mime.startsWith("image/") ? <div>{ /* Private images use the authenticated route. */ }
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img onError={()=>setError("This image could not be displayed. Download the original to open it.")} draggable={false} src={document.hasWebCopy || mime.includes("heic") || mime.includes("heif") ? `${url}?v=web` : url} alt={document.caption ?? document.originalFilename ?? "Document"} style={{ width: `${zoom * 100}%`, maxWidth: "none", transform: `rotate(${rotation}deg)` }} /></div> : mime.includes("pdf") ? <div className="relative w-fit"><canvas ref={canvas} aria-label={`PDF page ${page}`} /><div ref={textLayer} className="textLayer" />{!pdf && !error && <p role="status">Loading PDF…</p>}</div> : !error && <p className="p-3 text-sm">{mime ? "Preview unavailable for this format." : "Loading document…"}</p>}
    </div>
  </div></FullscreenSurface>;
}

export function DocumentLink({ document, children, className, gallery }: { document: PreviewDocument; children?: ReactNode; className?: string; gallery?: PreviewDocument[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(document);
  const index = gallery?.findIndex(d => d.id === selected.id) ?? -1;
  return <><button type="button" className={className ?? "text-left text-sm font-medium text-accent-text underline"} onClick={() => { setSelected(document); setOpen(true); }}>{children ?? document.caption ?? document.originalFilename ?? "View document"}</button>
    <Dialog open={open} onOpenChange={setOpen} title={selected.caption ?? selected.originalFilename ?? "Document"} description="Preview, search and download this household document." size="lg" className="!max-w-5xl">
      {gallery && gallery.length > 1 && <div className="mb-2 flex gap-2"><Button size="sm" disabled={index <= 0} onClick={() => setSelected(gallery[index - 1]!)}>Previous file</Button><span>{index + 1} / {gallery.length}</span><Button size="sm" disabled={index >= gallery.length - 1} onClick={() => setSelected(gallery[index + 1]!)}>Next file</Button></div>}
      {open && <DocumentPreview key={selected.id} document={selected} />}
    </Dialog></>;
}

/** Defer PDF parsing until its thumbnail actually approaches the visible scroll area. */
export function DocumentThumbnail({ document }: { document: PreviewDocument }) {
  const root = useRef<HTMLDivElement>(null); const [visible,setVisible] = useState(false);
  useEffect(()=>{
    if(!root.current)return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:"100px"});
    observer.observe(root.current);return()=>observer.disconnect();
  },[]);
  return <div ref={root} className="h-36 w-full overflow-hidden rounded border border-line bg-surface-2" aria-hidden="true">{visible ? <DocumentPreview document={document} compact /> : <span className="block p-3 text-xs text-ink-3">Preview</span>}</div>;
}
