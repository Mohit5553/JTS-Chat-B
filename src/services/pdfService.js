import fs from "fs";
import path from "path";

const uploadsDir = path.resolve(process.cwd(), "uploads/quotations");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

export async function generateQuotationPDF(quotation) {
    // Lazy-import pdfkit and sanitize-filename so server can start even if deps aren't installed.
    try {
        const { default: PDFDocument } = await import("pdfkit");
        const { default: sanitize } = await import("sanitize-filename");

        const filename = `${sanitize(quotation.quotationId)}.pdf`;
        const filePath = path.join(uploadsDir, filename);
        const doc = new PDFDocument({ size: "A4", margin: 50 });
        const stream = fs.createWriteStream(filePath);

        doc.pipe(stream);

        doc.fontSize(20).text(`Quotation: ${quotation.quotationId}`, { align: "left" });
        doc.moveDown();
        doc.fontSize(12).text(`Date: ${new Date(quotation.createdAt).toLocaleDateString()}`);
        doc.text(`Customer ID: ${quotation.customerId}`);
        doc.moveDown();

        doc.fontSize(14).text("Items:");
        doc.moveDown(0.5);

        const tableTop = doc.y;
        doc.fontSize(10);

        (quotation.items || []).forEach((item, idx) => {
            const y = tableTop + idx * 20;
            doc.text(item.description, 50, y);
            doc.text(String(item.quantity), 350, y, { width: 50, align: "right" });
            doc.text(String(item.price), 420, y, { width: 80, align: "right" });
            doc.text(String(item.total), 510, y, { width: 80, align: "right" });
        });

        doc.moveDown((quotation.items || []).length * 0.5 + 2);
        doc.fontSize(12).text(`Subtotal: ${quotation.subtotal}`, { align: "right" });
        doc.text(`Tax: ${quotation.tax || 0}`, { align: "right" });
        doc.text(`Total: ${quotation.total}`, { align: "right" });

        doc.end();

        return await new Promise((resolve, reject) => {
            stream.on("finish", () => resolve({ path: `/uploads/quotations/${filename}`, filePath }));
            stream.on("error", (err) => reject(err));
        });
    } catch (err) {
        console.error("generateQuotationPDF: missing optional dependency or error:", err.message || err);
        return null;
    }
}
