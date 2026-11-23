import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface ProductionCertificateDetails {
  orderRef: string;
  redemptionCode: string;
  recipientName: string;
  message: string;
  amountCents: number;
  issuedAt: string;
}

function printable(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\x20-\x7e]/g, "?");
}

function wrapText(
  text: string,
  maximumWidth: number,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  fontSize: number
): string[] {
  const words = printable(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maximumWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    for (const character of word) {
      const segment = line + character;
      if (font.widthOfTextAtSize(segment, fontSize) > maximumWidth && line) {
        lines.push(line);
        line = character;
      } else {
        line = segment;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function createProductionCertificatePdf(
  details: ProductionCertificateDetails
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(`Gift Certificate ${details.orderRef}`);
  document.setAuthor("Mitch Harsch Tattoo");
  document.setSubject("Digital gift certificate");
  const page = document.addPage([612, 792]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.86, 0.83, 0.78);
  const muted = rgb(0.68, 0.65, 0.61);
  const background = rgb(0.055, 0.05, 0.05);

  page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: background });
  page.drawRectangle({
    x: 28, y: 28, width: 556, height: 736,
    borderWidth: 2, borderColor: rgb(0.35, 0.3, 0.27)
  });
  page.drawText("MITCH HARSCH TATTOO", {
    x: 72, y: 654, size: 17, font: bold, color: ink
  });
  page.drawText("DIGITAL GIFT CERTIFICATE", {
    x: 72, y: 624, size: 11, font: regular, color: muted
  });
  page.drawLine({
    start: { x: 72, y: 600 }, end: { x: 540, y: 600 },
    thickness: 1, color: rgb(0.35, 0.3, 0.27)
  });
  page.drawText(`VALUE: $${(details.amountCents / 100).toFixed(2)} CAD`, {
    x: 72, y: 550, size: 24, font: bold, color: ink
  });
  page.drawText(`FOR: ${printable(details.recipientName)}`, {
    x: 72, y: 508, size: 14, font: regular, color: ink, maxWidth: 468
  });
  if (details.message) {
    page.drawText("PERSONAL MESSAGE", { x: 72, y: 460, size: 9, font: bold, color: muted });
    const wrappedMessage = wrapText(details.message, 468, regular, 12);
    const messageLines = wrappedMessage.slice(0, 7);
    if (wrappedMessage.length > 7) {
      while (messageLines[6] &&
             regular.widthOfTextAtSize(`${messageLines[6]}...`, 12) > 468) {
        messageLines[6] = messageLines[6].slice(0, -1);
      }
      messageLines[6] = `${messageLines[6]}...`;
    }
    page.drawText(messageLines.join("\n"), {
      x: 72, y: 435, size: 12, font: regular, color: ink, lineHeight: 17
    });
  }
  const codeY = details.message ? 300 : 360;
  page.drawText(`REDEMPTION CODE: ${details.redemptionCode}`, {
    x: 72, y: codeY, size: 12, font: bold, color: ink
  });
  page.drawText(`ISSUED: ${details.issuedAt.slice(0, 10)}  |  ORDER: ${details.orderRef}`, {
    x: 72, y: codeY - 30, size: 9, font: regular, color: muted
  });
  page.drawText("REDEMPTION INSTRUCTIONS", {
    x: 72, y: codeY - 84, size: 10, font: bold, color: ink
  });
  page.drawText("Present this certificate to Mitch Harsch Tattoo when booking.", {
    x: 72, y: codeY - 106, size: 10, font: regular, color: muted, maxWidth: 468
  });
  return document.save({ useObjectStreams: true });
}
