import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^16.0.0";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const INVOICE_BUCKET = "invoice_documents";
const TOOL_TUTORS = {
  name: "Tool Tutors",
  email: "accounts@ToolTutors.co.uk",
  addressLine1: "24 The Fairway",
  addressLine2: "",
  city: "Darlington",
  postcode: "DL1 1ES",
  country: "United Kingdom",
};

type AdminClient = ReturnType<typeof createClient>;

type InvoiceParty = {
  name: string;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postcode?: string | null;
  country?: string | null;
  vatRegistered?: boolean;
  vatNumber?: string | null;
};

type PdfInvoice = {
  documentType: "tutor_learner_invoice" | "tooltutors_commission_invoice";
  title: string;
  documentNumber: string;
  invoiceDate: string;
  supplyDate: string;
  supplier: InvoiceParty;
  customer: InvoiceParty;
  jobTitle: string;
  jobDescription?: string | null;
  netPence: number;
  vatPence: number;
  grossPence: number;
  vatRate: number | null;
  currency: string;
  footerNote: string;
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function dateOnly(value = new Date()): string {
  return value.toISOString().slice(0, 10);
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatMoney(pence: number, currency = "gbp"): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(pence / 100);
}

function pdfSafe(value: unknown): string {
  return String(value ?? "")
    .replaceAll("–", "-")
    .replaceAll("—", "-")
    .replaceAll("’", "'")
    .replaceAll("‘", "'")
    .replaceAll("“", '"')
    .replaceAll("”", '"')
    .replaceAll("…", "...")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

function wrapText(text: string, maxCharacters: number): string[] {
  const words = pdfSafe(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxCharacters && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function partyAddress(party: InvoiceParty): string[] {
  return [
    party.addressLine1,
    party.addressLine2,
    party.city,
    party.postcode,
    party.country,
  ].map((item) => pdfSafe(item)).filter(Boolean);
}

async function createInvoicePdf(invoice: PdfInvoice): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const orange = rgb(1, 0.42, 0.21);
  const navy = rgb(0.04, 0.10, 0.18);
  const muted = rgb(0.36, 0.42, 0.52);
  const pale = rgb(0.95, 0.96, 0.98);
  const width = page.getWidth();

  page.drawRectangle({ x: 0, y: 770, width, height: 72, color: navy });
  page.drawText("Tool", { x: 42, y: 798, size: 22, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Tutors", { x: 84, y: 798, size: 22, font: bold, color: orange });
  page.drawText(pdfSafe(invoice.title), { x: 42, y: 746, size: 19, font: bold, color: navy });
  page.drawText(pdfSafe(invoice.documentNumber), { x: 402, y: 748, size: 10, font: bold, color: muted });

  page.drawText("Invoice date", { x: 402, y: 724, size: 8, font: bold, color: muted });
  page.drawText(formatDate(invoice.invoiceDate), { x: 402, y: 710, size: 9, font: regular, color: navy });
  page.drawText("Supply date", { x: 402, y: 690, size: 8, font: bold, color: muted });
  page.drawText(formatDate(invoice.supplyDate), { x: 402, y: 676, size: 9, font: regular, color: navy });

  const drawParty = (heading: string, party: InvoiceParty, x: number) => {
    page.drawText(heading, { x, y: 705, size: 9, font: bold, color: orange });
    const partyNameLines = String(party.name ?? "")
      .split(/\r?\n/)
      .map((line) => pdfSafe(line).trim())
      .filter(Boolean)
      .slice(0, 2);
    let y = 685;
    for (const line of partyNameLines) {
      page.drawText(line, { x, y, size: 11, font: bold, color: navy });
      y -= 16;
    }
    if (!partyNameLines.length) y -= 16;
    for (const line of partyAddress(party)) {
      page.drawText(line, { x, y, size: 9, font: regular, color: muted });
      y -= 13;
    }
    if (party.email) {
      page.drawText(pdfSafe(party.email), { x, y, size: 9, font: regular, color: muted });
      y -= 13;
    }
    if (party.vatRegistered && party.vatNumber) {
      page.drawText(`VAT number: ${pdfSafe(party.vatNumber)}`, { x, y, size: 9, font: bold, color: navy });
    }
  };

  drawParty("SUPPLIER", invoice.supplier, 42);
  drawParty("CUSTOMER", invoice.customer, 232);

  page.drawRectangle({ x: 42, y: 480, width: 511, height: 34, color: pale });
  page.drawText("Description", { x: 54, y: 492, size: 9, font: bold, color: navy });
  page.drawText("Amount", { x: 485, y: 492, size: 9, font: bold, color: navy });

  page.drawText(pdfSafe(invoice.jobTitle), { x: 54, y: 458, size: 11, font: bold, color: navy });
  let descriptionY = 442;
  for (const line of wrapText(invoice.jobDescription || "Completed Tool Tutors job", 72).slice(0, 4)) {
    page.drawText(line, { x: 54, y: descriptionY, size: 9, font: regular, color: muted });
    descriptionY -= 13;
  }
  page.drawText(formatMoney(invoice.grossPence, invoice.currency), {
    x: 485,
    y: 458,
    size: 10,
    font: bold,
    color: navy,
  });

  page.drawLine({ start: { x: 332, y: 382 }, end: { x: 553, y: 382 }, thickness: 1, color: rgb(0.82, 0.84, 0.88) });
  const isCommissionInvoice = invoice.documentType === "tooltutors_commission_invoice";
  const totals = isCommissionInvoice
    ? [["Total", formatMoney(invoice.grossPence, invoice.currency)]]
    : [
        ["Net amount", formatMoney(invoice.netPence, invoice.currency)],
        [invoice.vatRate === null ? "VAT" : `VAT (${invoice.vatRate.toFixed(2).replace(".00", "")}%)`, formatMoney(invoice.vatPence, invoice.currency)],
        ["Total", formatMoney(invoice.grossPence, invoice.currency)],
      ];
  let totalsY = 358;
  totals.forEach(([label, amount], index) => {
    const isTotal = isCommissionInvoice || index === totals.length - 1;
    page.drawText(label, { x: 354, y: totalsY, size: isTotal ? 11 : 9, font: isTotal ? bold : regular, color: isTotal ? navy : muted });
    page.drawText(amount, { x: 485, y: totalsY, size: isTotal ? 11 : 9, font: bold, color: isTotal ? orange : navy });
    totalsY -= 24;
  });

  page.drawRectangle({ x: 42, y: 222, width: 511, height: 66, color: pale });
  let noteY = 268;
  for (const line of wrapText(invoice.footerNote, 92).slice(0, 4)) {
    page.drawText(line, { x: 54, y: noteY, size: 8.5, font: regular, color: muted });
    noteY -= 14;
  }

  page.drawText("Paid via Tool Tutors", { x: 42, y: 178, size: 10, font: bold, color: orange });
  page.drawText("This electronic document forms part of the permanent job and payment record.", {
    x: 42,
    y: 159,
    size: 8,
    font: regular,
    color: muted,
  });

  return await pdf.save();
}

async function getNextDocumentNumber(
  admin: AdminClient,
  documentType: "tutor_learner_invoice" | "tooltutors_commission_invoice",
): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = documentType === "tutor_learner_invoice" ? "TT-TUTOR" : "TT-COMM";
  const beginning = `${prefix}-${year}-`;

  const { data, error } = await admin
    .from("invoice_documents")
    .select("document_number")
    .like("document_number", `${beginning}%`)
    .order("document_number", { ascending: false })
    .limit(1);
  if (error) throw error;

  const previous = data?.[0]?.document_number || "";
  const previousNumber = Number(previous.slice(beginning.length));
  const nextNumber = Number.isInteger(previousNumber) && previousNumber > 0
    ? previousNumber + 1
    : 1;
  return `${beginning}${String(nextNumber).padStart(6, "0")}`;
}

async function ensureInvoiceDocument(
  admin: AdminClient,
  params: {
    job: Record<string, any>;
    documentType: "tutor_learner_invoice" | "tooltutors_commission_invoice";
    supplier: InvoiceParty & { profileId?: string | null };
    customer: InvoiceParty & { profileId?: string | null };
    grossPence: number;
    netPence: number;
    vatPence: number;
    vatRate: number | null;
    title: string;
    footerNote: string;
    completionDate: string;
  },
): Promise<{ documentNumber: string; storagePath: string; created: boolean }> {
  const { data: existing, error: existingError } = await admin
    .from("invoice_documents")
    .select("id, document_number, document_status, storage_path")
    .eq("job_id", params.job.id)
    .eq("document_type", params.documentType)
    .maybeSingle();
  if (existingError) throw existingError;

  if (existing?.document_status === "generated" && existing.storage_path) {
    return {
      documentNumber: existing.document_number,
      storagePath: existing.storage_path,
      created: false,
    };
  }

  let row = existing;
  if (!row) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const documentNumber = await getNextDocumentNumber(admin, params.documentType);
      const { data: inserted, error: insertError } = await admin
        .from("invoice_documents")
        .insert({
          job_id: params.job.id,
          document_type: params.documentType,
          document_number: documentNumber,
          document_status: "pending",
          currency: params.job.payment_currency || "gbp",
          invoice_date: params.completionDate,
          supply_date: params.completionDate,
          gross_amount_pence: params.grossPence,
          net_amount_pence: params.netPence,
          vat_amount_pence: params.vatPence,
          vat_rate: params.vatRate,
          supplier_profile_id: params.supplier.profileId || null,
          supplier_name: params.supplier.name,
          supplier_email: params.supplier.email || null,
          supplier_address_line1: params.supplier.addressLine1 || null,
          supplier_address_line2: params.supplier.addressLine2 || null,
          supplier_city: params.supplier.city || null,
          supplier_postcode: params.supplier.postcode || null,
          supplier_country: params.supplier.country || null,
          supplier_vat_registered: params.supplier.vatRegistered === true,
          supplier_vat_number: params.supplier.vatRegistered ? params.supplier.vatNumber || null : null,
          customer_profile_id: params.customer.profileId || null,
          customer_name: params.customer.name,
          customer_email: params.customer.email || null,
          customer_address_line1: params.customer.addressLine1 || null,
          customer_address_line2: params.customer.addressLine2 || null,
          customer_city: params.customer.city || null,
          customer_postcode: params.customer.postcode || null,
          customer_country: params.customer.country || null,
          job_title: params.job.title,
          job_description: params.job.description || null,
          job_type: params.job.job_type || null,
        })
        .select("id, document_number, document_status, storage_path")
        .single();

      if (!insertError && inserted) {
        row = inserted;
        break;
      }
      if (insertError?.code !== "23505") throw insertError;

      const { data: sameJob } = await admin
        .from("invoice_documents")
        .select("id, document_number, document_status, storage_path")
        .eq("job_id", params.job.id)
        .eq("document_type", params.documentType)
        .maybeSingle();
      if (sameJob) {
        row = sameJob;
        break;
      }
    }
  }

  if (!row) throw new Error(`Could not reserve ${params.documentType} number.`);

  try {
    const pdfBytes = await createInvoicePdf({
      documentType: params.documentType,
      title: params.title,
      documentNumber: row.document_number,
      invoiceDate: params.completionDate,
      supplyDate: params.completionDate,
      supplier: params.supplier,
      customer: params.customer,
      jobTitle: params.job.title,
      jobDescription: params.job.description,
      netPence: params.netPence,
      vatPence: params.vatPence,
      grossPence: params.grossPence,
      vatRate: params.vatRate,
      currency: params.job.payment_currency || "gbp",
      footerNote: params.footerNote,
    });

    const storagePath = `${params.job.id}/${row.document_number}.pdf`;
    const { error: uploadError } = await admin.storage
      .from(INVOICE_BUCKET)
      .upload(storagePath, pdfBytes, {
        contentType: "application/pdf",
        cacheControl: "3600",
        upsert: true,
      });
    if (uploadError) throw uploadError;

    const { error: updateError } = await admin
      .from("invoice_documents")
      .update({
        document_status: "generated",
        storage_bucket: INVOICE_BUCKET,
        storage_path: storagePath,
        generated_at: new Date().toISOString(),
        generation_error: null,
      })
      .eq("id", row.id);
    if (updateError) throw updateError;

    return { documentNumber: row.document_number, storagePath, created: true };
  } catch (error) {
    await admin
      .from("invoice_documents")
      .update({
        document_status: "failed",
        generation_error: error instanceof Error ? error.message : "Unknown PDF generation error.",
      })
      .eq("id", row.id);
    throw error;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const authorization = req.headers.get("Authorization");

    if (!stripeSecretKey || !supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error("Missing required environment variables.");
    }
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Unauthorised." }, 401);

    const payload = await req.json();
    const jobId = typeof payload?.jobId === "string" ? payload.jobId : "";
    const rating = Number(payload?.rating);
    const comment = typeof payload?.comment === "string" ? payload.comment.trim() : "";

    if (!jobId) return json({ error: "Missing jobId." }, 400);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return json({ error: "Rating must be between 1 and 5." }, 400);
    }
    if (!comment) return json({ error: "A review comment is required." }, 400);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: "Unauthorised." }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: job, error: jobError } = await admin
      .from("job_requests")
      .select("id, title, description, job_type, appointment_time, learner_id, tutor_id, status, payment_status, amount_paid_pence, payment_currency, stripe_payment_intent_id, tutor_payment_released, stripe_transfer_id")
      .eq("id", jobId)
      .single();

    if (jobError || !job) return json({ error: "Job not found." }, 404);
    if (job.learner_id !== user.id) return json({ error: "This is not your job." }, 403);
    if (!job.tutor_id) return json({ error: "No Tutor is assigned." }, 400);
    if (job.payment_status !== "paid") return json({ error: "Payment has not been confirmed." }, 409);
    if (job.status !== "scheduled" && job.status !== "completed") {
      return json({ error: "Only a scheduled job can be completed." }, 409);
    }

    const amountPaidPence = Number(job.amount_paid_pence);
    if (!Number.isInteger(amountPaidPence) || amountPaidPence < 1) {
      return json({ error: "The confirmed payment amount is missing." }, 409);
    }

    const tutorAmountPence = Math.round(amountPaidPence * 0.90);
    const commissionPence = amountPaidPence - tutorAmountPence;

    const { data: tutor, error: tutorError } = await admin
      .from("profiles")
      .select("id, full_name, company_name, email, address_line1, address_line2, city, postcode, country, stripe_account_id, stripe_onboarding_complete, vat_registered, vat_number, vat_rate, invoice_authority_agreed_at")
      .eq("id", job.tutor_id)
      .single();

    if (tutorError || !tutor) return json({ error: "Tutor profile not found." }, 404);
    if (!tutor.stripe_account_id || !tutor.stripe_onboarding_complete) {
      return json({ error: "The Tutor is not ready to receive Stripe transfers." }, 409);
    }
    if (!tutor.invoice_authority_agreed_at) {
      return json({ error: "The Tutor has not authorised invoice generation." }, 409);
    }
    if (!tutor.address_line1 || !tutor.city || !tutor.postcode) {
      return json({ error: "The Tutor invoice address is incomplete." }, 409);
    }
    if (tutor.vat_registered && (!tutor.vat_number || tutor.vat_rate === null)) {
      return json({ error: "The Tutor VAT details are incomplete." }, 409);
    }
    const tutorLegalName = String(tutor.full_name || "Tutor").trim() || "Tutor";
    const tutorCompanyName = String(tutor.company_name || "").trim() || null;
    const tutorInvoiceName = tutorCompanyName
      ? `${tutorCompanyName}\n${tutorLegalName}`
      : tutorLegalName;

    const { data: learner, error: learnerError } = await admin
      .from("profiles")
      .select("id, full_name, email, address_line1, address_line2, city, postcode, country")
      .eq("id", job.learner_id)
      .single();
    if (learnerError || !learner) return json({ error: "Learner profile not found." }, 404);

    const stripe = new Stripe(stripeSecretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    let transferId = job.stripe_transfer_id || null;
    if (!job.tutor_payment_released || !transferId) {
      if (!job.stripe_payment_intent_id) {
        return json({ error: "The Stripe Payment Intent is missing." }, 409);
      }
      const paymentIntent = await stripe.paymentIntents.retrieve(
        job.stripe_payment_intent_id,
        { expand: ["latest_charge"] },
      );
      const latestCharge = paymentIntent.latest_charge;
      const sourceChargeId = typeof latestCharge === "string" ? latestCharge : latestCharge?.id;
      if (!sourceChargeId) return json({ error: "The source charge could not be found." }, 409);

      const transfer = await stripe.transfers.create(
        {
          amount: tutorAmountPence,
          currency: job.payment_currency || "gbp",
          destination: tutor.stripe_account_id,
          source_transaction: sourceChargeId,
          transfer_group: `job_${job.id}`,
          description: `Tutor payment for ${job.title}`,
          metadata: {
            job_id: job.id,
            learner_id: job.learner_id,
            tutor_id: job.tutor_id,
            platform_commission_pence: String(commissionPence),
          },
        },
        { idempotencyKey: `tooltutors_job_${job.id}_tutor_release_v1` },
      );
      transferId = transfer.id;
    }

    const { data: existingReview } = await admin
      .from("reviews")
      .select("id")
      .eq("job_id", job.id)
      .maybeSingle();

    if (!existingReview) {
      const { error: reviewError } = await admin.from("reviews").insert({
        job_id: job.id,
        tutor_id: job.tutor_id,
        reviewer_name: learner.full_name || "Learner",
        rating,
        comment,
      });
      if (reviewError) throw reviewError;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const completionDate = dateOnly(now);

    const { error: updateError } = await admin
      .from("job_requests")
      .update({
        status: "completed",
        tutor_payment_released: true,
        stripe_transfer_id: transferId,
        tutor_paid_at: nowIso,
        tutor_payout_amount_pence: tutorAmountPence,
        platform_commission_pence: commissionPence,
      })
      .eq("id", job.id);
    if (updateError) throw updateError;

    const invoiceWarnings: string[] = [];
    const invoiceDocuments: Record<string, unknown>[] = [];

    try {
      const vatRegistered = tutor.vat_registered === true;
      const vatRate = vatRegistered ? Number(tutor.vat_rate) : null;
      const tutorNetPence = vatRegistered && vatRate !== null
        ? Math.round(amountPaidPence * 100 / (100 + vatRate))
        : amountPaidPence;
      const tutorVatPence = amountPaidPence - tutorNetPence;

      const tutorInvoice = await ensureInvoiceDocument(admin, {
        job,
        documentType: "tutor_learner_invoice",
        supplier: {
          profileId: tutor.id,
          name: tutorInvoiceName,
          email: tutor.email,
          addressLine1: tutor.address_line1,
          addressLine2: tutor.address_line2,
          city: tutor.city,
          postcode: tutor.postcode,
          country: tutor.country,
          vatRegistered,
          vatNumber: vatRegistered ? tutor.vat_number : null,
        },
        customer: {
          profileId: learner.id,
          name: learner.full_name,
          email: learner.email,
          addressLine1: learner.address_line1,
          addressLine2: learner.address_line2,
          city: learner.city,
          postcode: learner.postcode,
          country: learner.country,
        },
        grossPence: amountPaidPence,
        netPence: tutorNetPence,
        vatPence: tutorVatPence,
        vatRate,
        title: "Invoice issued on the Tutor's behalf",
        footerNote: vatRegistered
          ? "This invoice was generated by Tool Tutors on behalf of the Tutor. The Tutor remains the supplier and is responsible for the VAT shown."
          : "This invoice was generated by Tool Tutors on behalf of the Tutor. The Tutor is not VAT registered and no VAT has been charged.",
        completionDate,
      });
      invoiceDocuments.push({ type: "tutor_learner_invoice", ...tutorInvoice });
    } catch (error) {
      console.error("Tutor invoice generation failed:", error);
      invoiceWarnings.push(error instanceof Error ? error.message : "Tutor invoice generation failed.");
    }

    try {
      const commissionInvoice = await ensureInvoiceDocument(admin, {
        job,
        documentType: "tooltutors_commission_invoice",
        supplier: {
          profileId: null,
          name: TOOL_TUTORS.name,
          email: TOOL_TUTORS.email,
          addressLine1: TOOL_TUTORS.addressLine1,
          addressLine2: TOOL_TUTORS.addressLine2,
          city: TOOL_TUTORS.city,
          postcode: TOOL_TUTORS.postcode,
          country: TOOL_TUTORS.country,
          vatRegistered: false,
          vatNumber: null,
        },
        customer: {
          profileId: tutor.id,
          name: tutorInvoiceName,
          email: tutor.email,
          addressLine1: tutor.address_line1,
          addressLine2: tutor.address_line2,
          city: tutor.city,
          postcode: tutor.postcode,
          country: tutor.country,
        },
        grossPence: commissionPence,
        netPence: commissionPence,
        vatPence: 0,
        vatRate: null,
        title: "Tool Tutors Commission Invoice",
        footerNote: "Tool Tutors is not VAT registered. No VAT has been charged. This invoice records the 10% platform commission retained for the completed job.",
        completionDate,
      });
      invoiceDocuments.push({ type: "tooltutors_commission_invoice", ...commissionInvoice });
    } catch (error) {
      console.error("Commission invoice generation failed:", error);
      invoiceWarnings.push(error instanceof Error ? error.message : "Commission invoice generation failed.");
    }

    return json({
      success: true,
      transferId,
      tutorAmountPence,
      commissionPence,
      invoiceDocuments,
      invoiceWarnings,
      message: invoiceWarnings.length
        ? "Job completed and Tutor payment released. One or more invoice documents need attention."
        : "Job completed, Tutor payment released and invoice documents generated.",
    });
  } catch (error) {
    console.error("complete-job-and-release-payment failed:", error);
    return json({
      error: error instanceof Error ? error.message : "Unexpected payout error.",
    }, 500);
  }
});
