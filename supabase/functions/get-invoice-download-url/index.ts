import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const authorization = req.headers.get("Authorization");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error("Missing required environment variables.");
    }

    if (!authorization?.startsWith("Bearer ")) {
      return json({ error: "Unauthorised." }, 401);
    }

    const payload = await req.json();
    const invoiceId = typeof payload?.invoiceId === "string"
      ? payload.invoiceId.trim()
      : "";
    const jobId = typeof payload?.jobId === "string"
      ? payload.jobId.trim()
      : "";
    const documentType = typeof payload?.documentType === "string"
      ? payload.documentType.trim()
      : "";

    if (!invoiceId && (!jobId || !documentType)) {
      return json({
        error: "Provide invoiceId, or provide both jobId and documentType.",
      }, 400);
    }

    if (
      documentType &&
      ![
        "tutor_learner_invoice",
        "tooltutors_commission_invoice",
      ].includes(documentType)
    ) {
      return json({ error: "Unsupported invoice document type." }, 400);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authorization,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return json({ error: "Unauthorised." }, 401);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: requesterProfile, error: requesterProfileError } = await admin
      .from("profiles")
      .select("id, role")
      .eq("id", user.id)
      .single();

    if (requesterProfileError || !requesterProfile) {
      return json({ error: "Your profile could not be found." }, 403);
    }

    let invoiceQuery = admin
      .from("invoice_documents")
      .select(`
        id,
        job_id,
        document_type,
        document_number,
        document_status,
        storage_bucket,
        storage_path,
        job:job_requests!inner(
          id,
          learner_id,
          tutor_id,
          status
        )
      `);

    if (invoiceId) {
      invoiceQuery = invoiceQuery.eq("id", invoiceId);
    } else {
      invoiceQuery = invoiceQuery
        .eq("job_id", jobId)
        .eq("document_type", documentType);
    }

    const { data: invoice, error: invoiceError } = await invoiceQuery.single();

    if (invoiceError || !invoice) {
      return json({ error: "Invoice document not found." }, 404);
    }

    const linkedJob = Array.isArray(invoice.job)
      ? invoice.job[0]
      : invoice.job;

    if (!linkedJob) {
      return json({ error: "The related job could not be found." }, 404);
    }

    const isAdmin = requesterProfile.role === "admin";
    const isLearner = linkedJob.learner_id === user.id;
    const isTutor = linkedJob.tutor_id === user.id;

    if (!isAdmin && !isLearner && !isTutor) {
      return json({ error: "You do not have access to this invoice." }, 403);
    }

    if (
      invoice.document_type === "tooltutors_commission_invoice" &&
      !isAdmin &&
      !isTutor
    ) {
      return json({
        error: "The commission invoice is available only to the Tutor and Admin.",
      }, 403);
    }

    if (
      invoice.document_type === "tutor_learner_invoice" &&
      !isAdmin &&
      !isTutor &&
      !isLearner
    ) {
      return json({ error: "You do not have access to this invoice." }, 403);
    }

    if (
      invoice.document_status !== "generated" ||
      !invoice.storage_bucket ||
      !invoice.storage_path
    ) {
      return json({ error: "This invoice is not ready for download." }, 409);
    }

    const expiresInSeconds = 120;
    const { data: signedUrlData, error: signedUrlError } = await admin.storage
      .from(invoice.storage_bucket)
      .createSignedUrl(invoice.storage_path, expiresInSeconds, {
        download: `${invoice.document_number}.pdf`,
      });

    if (signedUrlError || !signedUrlData?.signedUrl) {
      throw signedUrlError || new Error("A signed download URL could not be created.");
    }

    return json({
      success: true,
      invoiceId: invoice.id,
      jobId: invoice.job_id,
      documentType: invoice.document_type,
      documentNumber: invoice.document_number,
      url: signedUrlData.signedUrl,
      expiresInSeconds,
    });
  } catch (error) {
    console.error("get-invoice-download-url failed:", error);
    return json({
      error: error instanceof Error
        ? error.message
        : "Unexpected invoice download error.",
    }, 500);
  }
});
