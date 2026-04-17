import fs from "fs";
import path from "path";

const uploadsDir = path.resolve(process.cwd(), "uploads/quotations");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

export async function generateQuotationPDF(quotation) {
    // Lazy-import pdfkit and sanitize-filename so server can start even if deps aren't installed.
    // Accepts either a plain quotation object or a populated one. Will attempt to hydrate customer/website data.
    try {
        const { default: PDFDocument } = await import("pdfkit");
        const { default: sanitize } = await import("sanitize-filename");
        // Attempt to lazy-load mongoose models if IDs are present
        let Customer = null;
        let Website = null;
        try {
            const cmod = await import("../models/Customer.js");
            const wmod = await import("../models/Website.js");
            Customer = cmod.Customer;
            Website = wmod.Website;
        } catch (e) {
            // ignore model load errors
        }

        let customer = quotation.customer || null;
        let website = quotation.website || null;

        if (!customer && quotation.customerId && Customer) {
            try { customer = await Customer.findById(quotation.customerId).lean(); } catch (e) { /* ignore */ }
        }
        if (!website && quotation.websiteId && Website) {
            try { website = await Website.findById(quotation.websiteId).lean(); } catch (e) { /* ignore */ }
        }

        const companyName = (website && website.websiteName) || (process.env.SMTP_FROM || "")?.split("<")[0]?.trim() || "Your Company";

        const filename = `${sanitize(quotation.quotationId)}.pdf`;
        const filePath = path.join(uploadsDir, filename);
        const doc = new PDFDocument({ size: "A4", margin: 48 });
        const stream = fs.createWriteStream(filePath);

        doc.pipe(stream);

        // HEADER
        doc.fontSize(18).font("Helvetica-Bold").text(companyName, { align: "left" });
        doc.moveDown(0.25);
        doc.fontSize(10).font("Helvetica").fillColor("#444").text(website?.domain || "", { align: "left" });
        doc.moveDown(0.5);

        doc.fontSize(12).font("Helvetica-Bold").fillColor("#111").text(`Quotation / Receipt: ${quotation.quotationId}`);
        doc.fontSize(10).font("Helvetica").fillColor("#666").text(`Date: ${new Date(quotation.createdAt || Date.now()).toLocaleDateString()}`);

        // CUSTOMER & OWNER BLOCK
        doc.moveDown(0.5);
        const leftX = doc.page.margins.left;
        const rightX = doc.page.width - doc.page.margins.right - 200;
        doc.fontSize(10).font("Helvetica-Bold").text("Bill To:", leftX, doc.y);
        doc.fontSize(10).font("Helvetica").text(customer?.name || "-", leftX + 50, doc.y - 12);
        if (customer?.companyName) doc.text(customer.companyName, leftX + 50);
        if (customer?.email) doc.text(customer.email, leftX + 50);
        if (customer?.phone) doc.text(customer.phone, leftX + 50);

        doc.fontSize(10).font("Helvetica-Bold").text("Due / Valid Until:", rightX, doc.y - 36);
        doc.fontSize(10).font("Helvetica").text(quotation.validUntil ? new Date(quotation.validUntil).toLocaleDateString() : "N/A", rightX + 10, doc.y - 12);

        doc.moveDown(1);

        // ITEMS TABLE
        doc.fontSize(12).font("Helvetica-Bold").text("Items", { underline: true });
        doc.moveDown(0.5);

        const tableTop = doc.y;
        const colDesc = leftX;
        const colQty = leftX + 320;
        const colUnit = leftX + 380;
        const colTotal = leftX + 460;

        // Table header
        doc.fontSize(10).font("Helvetica-Bold").text("Description", colDesc, tableTop);
        doc.text("Qty", colQty, tableTop, { width: 40, align: "right" });
        doc.text("Unit", colUnit, tableTop, { width: 60, align: "right" });
        doc.text("Total", colTotal, tableTop, { width: 80, align: "right" });

        doc.moveDown(0.7);
        doc.font("Helvetica");

        const items = quotation.items || [];
        let y = doc.y;
        items.forEach((item, i) => {
            const desc = item.description || "";
            const qty = Number(item.quantity || 0);
            const unit = Number(item.price || 0);
            const total = Number(item.total || qty * unit);

            doc.fontSize(10).text(desc, colDesc, y, { width: 300 });
            doc.text(String(qty), colQty, y, { width: 40, align: "right" });
            doc.text(unit.toFixed(2), colUnit, y, { width: 60, align: "right" });
            doc.text(total.toFixed(2), colTotal, y, { width: 80, align: "right" });
            y += 18;
            if (y > doc.page.height - 120) {
                doc.addPage();
                y = doc.y;
            }
        });

        doc.y = y + 6;

        // Totals box
        const totalsX = colUnit;
        doc.moveTo(totalsX, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeOpacity(0.06).stroke();
        doc.moveDown(0.5);
        doc.fontSize(10).font("Helvetica").text("Subtotal", totalsX, doc.y, { width: 140, align: "left" });
        doc.text((quotation.subtotal || items.reduce((s, it) => s + (it.total || (it.quantity || 0) * (it.price || 0)), 0)).toFixed(2), colTotal, doc.y, { width: 80, align: "right" });
        doc.moveDown(0.6);
        doc.text("Tax", totalsX, doc.y, { width: 140, align: "left" });
        doc.text((quotation.tax || 0).toFixed(2), colTotal, doc.y, { width: 80, align: "right" });
        doc.moveDown(0.6);
        doc.font("Helvetica-Bold").text("Total", totalsX, doc.y, { width: 140, align: "left" });
        doc.text((quotation.total || 0).toFixed(2), colTotal, doc.y, { width: 80, align: "right" });

        doc.moveDown(2);
        if (quotation.terms) {
            doc.fontSize(9).font("Helvetica-Bold").text("Terms & Notes", leftX);
            doc.moveDown(0.3);
            doc.fontSize(9).font("Helvetica").text(quotation.terms, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
        }

        // Footer
        doc.moveTo(doc.page.margins.left, doc.page.height - 80).lineTo(doc.page.width - doc.page.margins.right, doc.page.height - 80).strokeOpacity(0.06).stroke();
        doc.fontSize(9).font("Helvetica").fillColor("#666").text(`${companyName} • Thank you for your business.`, doc.page.margins.left, doc.page.height - 70);
        doc.fontSize(8).text(`Generated: ${new Date().toLocaleString()}`, doc.page.margins.left, doc.page.height - 56);

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

export async function generateInvoicePDF(invoice) {
    try {
        const { default: PDFDocument } = await import("pdfkit");
        const { default: sanitize } = await import("sanitize-filename");

        const filename = `${sanitize(invoice.invoiceId || invoice._id)}.pdf`;
        const filePath = path.join(uploadsDir, filename);
        const doc = new PDFDocument({ size: "A4", margin: 48 });
        const stream = fs.createWriteStream(filePath);

        doc.pipe(stream);

        const companyName = invoice.companyName || (process.env.SMTP_FROM || "Your Company").split("<")[0].trim();

        doc.fontSize(18).font("Helvetica-Bold").text(companyName, { align: "left" });
        doc.moveDown(0.25);
        doc.fontSize(12).font("Helvetica-Bold").text(`Invoice: ${invoice.invoiceId || "-"}`);
        doc.fontSize(10).font("Helvetica").fillColor("#666").text(`Date: ${new Date(invoice.issuedAt || Date.now()).toLocaleDateString()}`);

        doc.moveDown(0.5);
        const leftX = doc.page.margins.left;
        const colDesc = leftX;
        const colQty = leftX + 320;
        const colUnit = leftX + 380;
        const colTotal = leftX + 460;

        doc.fontSize(12).font("Helvetica-Bold").text("Items", { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(10).font("Helvetica-Bold").text("Description", colDesc);
        doc.text("Qty", colQty, doc.y, { width: 40, align: "right" });
        doc.text("Unit", colUnit, doc.y, { width: 60, align: "right" });
        doc.text("Total", colTotal, doc.y, { width: 80, align: "right" });

        doc.moveDown(0.6);
        let y = doc.y;
        const items = invoice.items || [];
        items.forEach((item) => {
            doc.fontSize(10).font("Helvetica").text(item.description || "", colDesc, y, { width: 300 });
            doc.text(String(item.quantity || 0), colQty, y, { width: 40, align: "right" });
            doc.text(Number(item.price || 0).toFixed(2), colUnit, y, { width: 60, align: "right" });
            doc.text(Number(item.total || 0).toFixed(2), colTotal, y, { width: 80, align: "right" });
            y += 18;
            if (y > doc.page.height - 140) { doc.addPage(); y = doc.y; }
        });

        doc.y = y + 6;
        const totalsX = colUnit;
        doc.fontSize(10).font("Helvetica").text("Subtotal", totalsX, doc.y, { width: 140, align: "left" });
        doc.text((invoice.subtotal || 0).toFixed(2), colTotal, doc.y, { width: 80, align: "right" });
        doc.moveDown(0.5);
        doc.text("Tax", totalsX, doc.y, { width: 140, align: "left" });
        doc.text((invoice.tax || 0).toFixed(2), colTotal, doc.y, { width: 80, align: "right" });
        doc.moveDown(0.5);
        doc.font("Helvetica-Bold").text("Total", totalsX, doc.y, { width: 140, align: "left" });
        doc.text((invoice.total || 0).toFixed(2), colTotal, doc.y, { width: 80, align: "right" });

        doc.moveDown(1);
        if (invoice.notes) {
            doc.fontSize(9).font("Helvetica-Bold").text("Notes", leftX);
            doc.moveDown(0.3);
            doc.fontSize(9).font("Helvetica").text(invoice.notes, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
        }

        doc.moveTo(doc.page.margins.left, doc.page.height - 80).lineTo(doc.page.width - doc.page.margins.right, doc.page.height - 80).strokeOpacity(0.06).stroke();
        doc.fontSize(9).font("Helvetica").fillColor("#666").text(`${companyName} • Thank you for your business.`, doc.page.margins.left, doc.page.height - 70);

        doc.end();
        return await new Promise((resolve, reject) => {
            stream.on("finish", () => resolve({ path: `/uploads/quotations/${filename}`, filePath }));
            stream.on("error", (err) => reject(err));
        });
    } catch (err) {
        console.error("generateInvoicePDF error:", err.message || err);
        return null;
    }
}
