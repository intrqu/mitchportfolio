import PDFDocument from "pdfkit";

type CertificateDetails = {
  code: string;
  amountCents: number;
  recipientName: string;
  message: string;
  issuedAt: Date;
};

export function createCertificatePdf(details: CertificateDetails): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.rect(0, 0, 612, 792).fill("#100e0d");
    doc.rect(28, 28, 556, 736).lineWidth(1).stroke("#79624c");
    doc.rect(40, 40, 532, 712).lineWidth(0.5).stroke("#233b2e");
    doc.fillColor("#a9bc9c").font("Times-Roman").fontSize(18).text("M I T C H   H A R S C H   T A T T O O", 65, 110, {
      align: "center"
    });
    doc.fillColor("#e8dfcb").font("Times-Roman").fontSize(42).text("GIFT CERTIFICATE", 60, 190, {
      align: "center",
      characterSpacing: 2
    });
    doc.moveTo(175, 255).lineTo(437, 255).lineWidth(1).stroke("#79624c");
    doc.fillColor("#c5bca8").font("Helvetica").fontSize(12).text("PRESENTED TO", 70, 292, {
      align: "center",
      characterSpacing: 2
    });
    doc.fillColor("#e8dfcb").font("Times-Roman").fontSize(30).text(details.recipientName, 65, 318, {
      align: "center"
    });
    doc.fillColor("#a9bc9c").font("Times-Roman").fontSize(44).text(
      new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(details.amountCents / 100),
      60,
      385,
      { align: "center" }
    );
    if (details.message) {
      doc.fillColor("#c5bca8").font("Times-Roman").fontSize(15).text(`"${details.message}"`, 90, 460, {
        align: "center",
        width: 432
      });
    }
    doc.fillColor("#c5bca8").font("Helvetica").fontSize(10).text("REDEMPTION CODE", 70, 555, {
      align: "center",
      characterSpacing: 2
    });
    doc.fillColor("#e8dfcb").font("Courier").fontSize(18).text(details.code, 65, 577, {
      align: "center",
      characterSpacing: 1
    });
    doc.fillColor("#c5bca8").font("Helvetica").fontSize(10).text(
      `Issued ${details.issuedAt.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}`,
      70,
      620,
      { align: "center" }
    );
    doc.fillColor("#c5bca8").font("Helvetica").fontSize(10).text(
      "Contact Mitch through mitchharschtattoo.com to book and present this code. Ask Mitch to apply the amount you wish to redeem; any remaining balance is tracked on the certificate.",
      100,
      675,
      { align: "center", width: 412, lineGap: 4 }
    );
    doc.end();
  });
}
