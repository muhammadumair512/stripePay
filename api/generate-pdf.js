// api/generate-pdf.js

const initStripe = require("stripe");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { promisify } = require("util");
const { pipeline } = require("stream");
const { PDFDocument } = require("pdf-lib");
const axiosRateLimit = require("axios-rate-limit");
const cloudinary = require("cloudinary").v2;
const nodemailer = require("nodemailer");
require("dotenv").config(); // For local dev; in production, Vercel handles env vars

// Load config
const config = require("../config.json");

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Create a rate-limited axios instance
const http = axiosRateLimit(axios.create(), { maxRPS: 80 });

// Promisify pipeline
const pipelineAsync = promisify(pipeline);

// Utility function to clear /tmp directories
function clearDirectory(directory) {
  if (fs.existsSync(directory)) {
    fs.readdirSync(directory).forEach((file) => {
      const curPath = path.join(directory, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        clearDirectory(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
  fs.mkdirSync(directory, { recursive: true });
}

async function downloadPdfs(urls, category) {
  const tmpDir = path.join("/tmp", category);

  // Clear existing directory
  clearDirectory(tmpDir);

  const downloadPromises = urls.map(async (url) => {
    const dest = path.resolve(tmpDir, `${url.invoice_number}.pdf`);

    const downloadWithRetry = async (attempt = 1) => {
      try {
        if (!url.invoice_pdf) {
          throw new Error(
            `Invoice PDF URL missing for invoice number: ${url.invoice_number}`
          );
        }
        const response = await http.get(url.invoice_pdf, {
          responseType: "stream",
        });
        await pipelineAsync(response.data, fs.createWriteStream(dest));
        console.log(`File downloaded: ${dest}`);
      } catch (error) {
        console.error(`Error downloading ${url.invoice_number}:`, error);
        if (attempt <= 5) {
          console.log(
            `Retrying download of ${url.invoice_number} (attempt ${attempt})`
          );
          await downloadWithRetry(attempt + 1);
        } else {
          console.error(
            `Failed to download ${url.invoice_number} after ${attempt} attempts`
          );
        }
      }
    };

    await downloadWithRetry();
  });

  try {
    await Promise.all(downloadPromises);
    console.log(`All ${category} files downloaded successfully.`);
    const files = fs.readdirSync(tmpDir);
    return files.map((file) => path.join(tmpDir, file));
  } catch (error) {
    console.error("Error downloading files:", error);
    throw error;
  }
}

async function mergePdfs(pdfPaths, outputPath) {
  const mergedPdf = await PDFDocument.create();
  for (const pdfPath of pdfPaths) {
    const pdfBytes = await fs.promises.readFile(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const copiedPages = await mergedPdf.copyPages(
      pdfDoc,
      pdfDoc.getPageIndices()
    );
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }

  const mergedPdfBytes = await mergedPdf.save();
  await fs.promises.writeFile(outputPath, mergedPdfBytes);

  console.log(`PDFs merged into ${outputPath}`);
}

async function createEmptyPdf(outputPath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  page.drawText("No data available for this category.");
  const pdfBytes = await pdfDoc.save();
  await fs.promises.writeFile(outputPath, pdfBytes);
  console.log(`Empty PDF created at ${outputPath}`);
}

async function getInvoicesList(stripe, gte, lte) {
  let starting_after;
  let invoices;
  let paidAndOpenLinks = [];
  let otherStatusLinks = [];

  try {
    do {
      invoices = await stripe.invoices.list({
        limit: 100,
        starting_after,
        created: { gte, lte },
      });

      if (!invoices.data || invoices.data.length === 0) {
        break;
      }

      invoices.data.forEach((invoice) => {
        const pdfLink = {
          invoice_pdf: invoice.invoice_pdf,
          invoice_number: invoice.number,
          amount_paid: invoice.amount_paid,
          amount_due: invoice.amount_due,
        };

        if (["paid", "open"].includes(invoice.status)) {
          paidAndOpenLinks.push(pdfLink);
        } else {
          otherStatusLinks.push(pdfLink);
        }
      });

      starting_after = invoices.data[invoices.data.length - 1].id;
    } while (invoices.has_more);

    return { paidAndOpenLinks, otherStatusLinks };
  } catch (error) {
    console.error("Error retrieving invoice list:", error);
    throw error;
  }
}

async function processInvoices(paidAndOpenLinks, otherStatusLinks, configKey, monthName, year) {
  const categories = [
    { name: "Paid_And_Open", links: paidAndOpenLinks },
    { name: "Other_Status", links: otherStatusLinks },
  ];

  let mergedPdfPaths = [];

  for (const category of categories) {
    const outputPath = path.join(
      "/tmp",
      `${configKey.toUpperCase()}-${category.name}-${monthName}-${year}.pdf`
    );

    if (category.links.length > 0) {
      const pdfPaths = await downloadPdfs(category.links, `${category.name.toLowerCase()}_${configKey}`);
      await mergePdfs(pdfPaths, outputPath);
    } else {
      // No invoices => create an empty PDF
      await createEmptyPdf(outputPath);
    }
    mergedPdfPaths.push(outputPath);
  }

  return mergedPdfPaths;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { year, month, email } = req.body;

  if (!year || !month || !email) {
    return res.status(400).json({ message: "Year, month, and email are required." });
  }

  const parsedYear = parseInt(year, 10);
  const parsedMonth = parseInt(month, 10) - 1; // zero-index month

  if (isNaN(parsedYear) || isNaN(parsedMonth)) {
    return res.status(400).json({ message: "Invalid year or month." });
  }

  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const monthName = monthNames[parsedMonth];
  const startDate = Math.floor(new Date(parsedYear, parsedMonth, 1).getTime() / 1000);
  const endDate = Math.floor(new Date(parsedYear, parsedMonth + 1, 0, 23, 59, 59, 999).getTime() / 1000);

  try {
    const configKeys = Object.keys(config);
    let allMergedPdfPaths = [];

    // Fetch and process invoices for each configKey
    for (const configKey of configKeys) {
      const stripe = initStripe(process.env[config[configKey]]);
      const { paidAndOpenLinks, otherStatusLinks } = await getInvoicesList(stripe, startDate, endDate);
      const mergedPdfPaths = await processInvoices(paidAndOpenLinks, otherStatusLinks, configKey, monthName, parsedYear);
      allMergedPdfPaths = allMergedPdfPaths.concat(mergedPdfPaths);
    }

    // Upload each merged PDF to Cloudinary, collect URLs
    let uploadedUrls = [];

    for (const pdfPath of allMergedPdfPaths) {
      const uploadResponse = await cloudinary.uploader.upload(pdfPath, {
        resource_type: "raw", // Since it's a PDF (non-image)
      });
      uploadedUrls.push(uploadResponse.secure_url);
    }

    // Setup Nodemailer with Gmail SMTP
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_EMAIL,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    // Email to user with PDF attachments
    const mailOptionsUser = {
      from: process.env.GMAIL_EMAIL,
      to: email,
      subject: `Your Invoices for ${monthName} ${parsedYear}`,
      text: `Please find attached your invoices for ${monthName} ${parsedYear}.`,
      attachments: allMergedPdfPaths.map((pdfPath) => ({
        filename: path.basename(pdfPath),
        path: pdfPath,
      })),
    };

    await transporter.sendMail(mailOptionsUser);
    console.log(`Email sent to user: ${email}`);

    // Email to admin with Cloudinary links
    const mailOptionsAdmin = {
      from: process.env.GMAIL_EMAIL,
      to: process.env.ADMIN_EMAIL,
      subject: `Invoices Generated for ${monthName} ${parsedYear}`,
      text: `Invoices have been generated and sent to ${email}.
      Uploaded PDF URLs:
      ${uploadedUrls.join("\n")}`,
    };

    await transporter.sendMail(mailOptionsAdmin);
    console.log(`Email sent to admin: ${process.env.ADMIN_EMAIL}`);

    return res.status(200).json({ message: "All data is sent to admin email." });
  } catch (error) {
    console.error("Error in processing request:", error);
    return res.status(500).json({ message: "Internal Server Error." });
  }
};
