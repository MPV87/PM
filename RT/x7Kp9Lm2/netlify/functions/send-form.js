// Datei: netlify/functions/send-form.js

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB pro Datei
const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return response(204, {});
  }

  if (event.httpMethod !== "POST") {
    return response(405, { message: "Method not allowed" });
  }

  const brevoApiKey = process.env.BREVO_API_KEY;
  const recipientEmail = process.env.FORM_RECIPIENT_EMAIL || "info@mp-vision.at";

  if (!brevoApiKey) {
    console.error("BREVO_API_KEY fehlt.");
    return response(500, { message: "Brevo API Key fehlt." });
  }

  try {
    const contentType = event.headers["content-type"] || event.headers["Content-Type"] || "";

    if (!contentType.includes("multipart/form-data")) {
      return response(400, { message: "Ungültiger Formulartyp. Erwartet wird multipart/form-data." });
    }

    const parsed = parseMultipartForm(event.body, contentType, event.isBase64Encoded);
    const fields = parsed.fields;
    const files = parsed.files;

    if ((fields.website || "").trim() !== "") {
      return response(200, { message: "Formular erfolgreich gesendet." });
    }

    const requiredFields = [
      "firstName",
      "lastName",
      "street",
      "postalCode",
      "city",
      "country",
      "phone",
      "email",
      "machine",
      "serialNumber",
      "problemDescription",
      "previousRepair",
      "sameProblem",
      "repairApprovalAmount",
      "ifExceeded",
      "serviceFeeConsent",
      "sealConsent",
      "privacyConsent"
    ];

    for (const field of requiredFields) {
      if (!String(fields[field] || "").trim()) {
        return response(400, { message: "Fehlendes Pflichtfeld: " + field });
      }
    }

    if (!isValidEmail(fields.email)) {
      return response(400, { message: "Bitte eine gültige E-Mail-Adresse eingeben." });
    }

    const attachments = [];

    for (const file of files) {
      if (!["purchaseDocument", "repairDocument"].includes(file.fieldName)) continue;
      if (!file.filename || file.content.length === 0) continue;

      if (file.content.length > MAX_FILE_SIZE) {
        return response(413, { message: "Ein Anhang ist zu groß. Maximal 5 MB pro Datei erlaubt." });
      }

      if (!ALLOWED_MIME_TYPES.has(file.contentType)) {
        return response(400, { message: "Nur PDF, JPG und PNG sind als Anhang erlaubt." });
      }

      attachments.push({
        name: sanitizeFilename(file.filename),
        content: file.content.toString("base64")
      });
    }

    const fullName = `${clean(fields.firstName)} ${clean(fields.lastName)}`.trim();

    const brevoPayload = {
      sender: {
        name: "KP Plattner GmbH",
        email: "office@kp-plattner.at"
      },
      to: [
        {
          email: recipientEmail
        }
      ],
      replyTo: {
        name: fullName,
        email: clean(fields.email)
      },
      subject: `Neue Zorr Powermatic Retoure: ${clean(fields.machine)} / ${clean(fields.serialNumber)}`,
      htmlContent: buildHtml(fields, attachments),
      textContent: buildText(fields, attachments)
    };

    if (attachments.length > 0) {
      brevoPayload.attachment = attachments;
    }

    const brevoResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": brevoApiKey
      },
      body: JSON.stringify(brevoPayload)
    });

    if (!brevoResponse.ok) {
      const errorText = await brevoResponse.text();
      console.error("Brevo Fehler:", errorText);
      return response(502, { message: "Brevo Fehler: " + errorText });
    }

    return response(200, { message: "Formular erfolgreich gesendet." });
  } catch (error) {
    console.error("Serverfehler:", error);
    return response(500, { message: "Serverfehler: " + error.message });
  }
};

function parseMultipartForm(body, contentType, isBase64Encoded) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);

  if (!boundaryMatch) {
    throw new Error("Multipart boundary fehlt.");
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const buffer = Buffer.from(body || "", isBase64Encoded ? "base64" : "binary");
  const boundaryBuffer = Buffer.from(`--${boundary}`);

  const parts = splitBuffer(buffer, boundaryBuffer);
  const fields = {};
  const files = [];

  for (let part of parts) {
    if (part.length === 0) continue;

    if (part.slice(0, 2).toString() === "\r\n") {
      part = part.slice(2);
    }

    if (part.slice(0, 2).toString() === "--") continue;

    if (part.slice(-2).toString() === "\r\n") {
      part = part.slice(0, -2);
    }

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;

    const rawHeaders = part.slice(0, headerEnd).toString("utf8");
    const content = part.slice(headerEnd + 4);

    const dispositionMatch = rawHeaders.match(
      /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i
    );

    if (!dispositionMatch) continue;

    const fieldName = dispositionMatch[1];
    const filename = dispositionMatch[2];

    const contentTypeMatch = rawHeaders.match(/content-type:\s*([^\r\n]+)/i);
    const fileContentType = contentTypeMatch ? contentTypeMatch[1].trim().toLowerCase() : "";

    if (typeof filename === "string") {
      files.push({
        fieldName,
        filename,
        contentType: fileContentType,
        content
      });
    } else {
      fields[fieldName] = content.toString("utf8");
    }
  }

  return { fields, files };
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);

  while (index !== -1) {
    parts.push(buffer.slice(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }

  parts.push(buffer.slice(start));
  return parts;
}

function buildHtml(fields, attachments) {
  return `
    <h2>Neue Zorr Powermatic Retoure</h2>

    <h3>Kundeninformation</h3>
    <p><strong>Kundennummer:</strong> ${h(fields.customerNumber || "-")}</p>
    <p><strong>Firma:</strong> ${h(fields.company || "-")}</p>
    <p><strong>Name:</strong> ${h(fields.firstName)} ${h(fields.lastName)}</p>
    <p><strong>Adresse:</strong><br>
      ${h(fields.street)}<br>
      ${h(fields.postalCode)} ${h(fields.city)}<br>
      ${h(fields.country)}
    </p>
    <p><strong>Telefon:</strong> ${h(fields.phone)}</p>
    <p><strong>E-Mail:</strong> ${h(fields.email)}</p>

    <h3>Informationen zur Maschine</h3>
    <p><strong>Maschine:</strong> ${h(fields.machine)}</p>
    <p><strong>Seriennummer:</strong> ${h(fields.serialNumber)}</p>
    <p><strong>Kaufdatum:</strong> ${h(fields.purchaseDate || "-")}</p>
    <p><strong>Problembeschreibung:</strong><br>${h(fields.problemDescription).replace(/\n/g, "<br>")}</p>
    <p><strong>Bereits früher repariert:</strong> ${h(fields.previousRepair)}</p>
    <p><strong>Datum vorherige Reparatur:</strong> ${h(fields.previousRepairDate || "-")}</p>
    <p><strong>Dasselbe Problem:</strong> ${h(fields.sameProblem)}</p>

    <h3>Abwicklung der Reparatur</h3>
    <p><strong>Freigabe bis:</strong> ${h(fields.repairApprovalAmount)}</p>
    <p><strong>Bei Überschreitung:</strong> ${h(fields.ifExceeded)}</p>
    <p><strong>Pauschale akzeptiert:</strong> ${h(fields.serviceFeeConsent)}</p>
    <p><strong>Siegelbruch-Hinweis akzeptiert:</strong> ${h(fields.sealConsent)}</p>
    <p><strong>Datenschutz akzeptiert:</strong> ${h(fields.privacyConsent)}</p>

    <p><strong>Anhänge:</strong> ${
      attachments.length > 0 ? attachments.map((a) => h(a.name)).join(", ") : "Keine"
    }</p>
  `;
}

function buildText(fields, attachments) {
  return [
    "Neue Zorr Powermatic Retoure",
    "",
    "Kundeninformation",
    `Kundennummer: ${clean(fields.customerNumber || "-")}`,
    `Firma: ${clean(fields.company || "-")}`,
    `Name: ${clean(fields.firstName)} ${clean(fields.lastName)}`,
    `Adresse: ${clean(fields.street)}, ${clean(fields.postalCode)} ${clean(fields.city)}, ${clean(fields.country)}`,
    `Telefon: ${clean(fields.phone)}`,
    `E-Mail: ${clean(fields.email)}`,
    "",
    "Informationen zur Maschine",
    `Maschine: ${clean(fields.machine)}`,
    `Seriennummer: ${clean(fields.serialNumber)}`,
    `Kaufdatum: ${clean(fields.purchaseDate || "-")}`,
    `Problembeschreibung: ${clean(fields.problemDescription)}`,
    `Bereits früher repariert: ${clean(fields.previousRepair)}`,
    `Datum vorherige Reparatur: ${clean(fields.previousRepairDate || "-")}`,
    `Dasselbe Problem: ${clean(fields.sameProblem)}`,
    "",
    "Abwicklung der Reparatur",
    `Freigabe bis: ${clean(fields.repairApprovalAmount)}`,
    `Bei Überschreitung: ${clean(fields.ifExceeded)}`,
    `Pauschale akzeptiert: ${clean(fields.serviceFeeConsent)}`,
    `Siegelbruch-Hinweis akzeptiert: ${clean(fields.sealConsent)}`,
    `Datenschutz akzeptiert: ${clean(fields.privacyConsent)}`,
    "",
    `Anhänge: ${attachments.length > 0 ? attachments.map((a) => a.name).join(", ") : "Keine"}`
  ].join("\n");
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    },
    body: JSON.stringify(body)
  };
}

function clean(value) {
  return String(value || "").replace(/[\r\0]/g, "").trim();
}

function h(value) {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

function sanitizeFilename(filename) {
  const cleaned = String(filename || "anhang")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);

  return cleaned || "anhang";
}
