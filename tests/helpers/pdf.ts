/** Tiny generated PDF with a real xref and searchable synthetic text; no private fixtures. */
export function syntheticPdf(texts = ["Synthetic equipment manual", "Maintenance instructions"]) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${texts.map((_,i)=>`${4+i*2} 0 R`).join(" ")}] /Count ${texts.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let i=0;i<texts.length;i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`);
    const content = `BT /F1 16 Tf 30 350 Td (${texts[i]!.replace(/[()\\]/g,"\\$&")}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let pdf = "%PDF-1.7\n"; const offsets = [0];
  for(let i=0;i<objects.length;i++){ offsets.push(Buffer.byteLength(pdf)); pdf += `${i+1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,"0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
