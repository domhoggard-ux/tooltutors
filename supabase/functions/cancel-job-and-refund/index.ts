import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^16.0.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const authorization = req.headers.get("Authorization");

    if (!stripeKey || !supabaseUrl || !anonKey || !serviceKey) {
      throw new Error("Missing required environment variables.");
    }
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Unauthorised." }, 401);

    const { jobId, reason } = await req.json();
    if (!jobId || typeof jobId !== "string") return json({ error: "Missing jobId." }, 400);
    const cancellationReason = typeof reason === "string" && reason.trim()
      ? reason.trim().slice(0, 450)
      : "Cancelled by Learner";

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: "Unauthorised." }, 401);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: job, error: jobError } = await admin
      .from("job_requests")
      .select("id, learner_id, status, payment_status, amount_paid_pence, stripe_payment_intent_id, stripe_transfer_id")
      .eq("id", jobId)
      .single();

    if (jobError || !job) return json({ error: "Job not found." }, 404);
    if (job.learner_id !== user.id) return json({ error: "This job does not belong to the signed-in Learner." }, 403);
    if (job.status !== "scheduled") return json({ error: "Only scheduled jobs can be cancelled through this flow." }, 409);
    if (job.payment_status !== "paid") return json({ error: "This scheduled job is not recorded as paid." }, 409);
    if (!job.stripe_payment_intent_id) return json({ error: "Stripe Payment Intent is missing." }, 409);
    if (job.stripe_transfer_id) return json({ error: "Tutor funds have already been transferred. Admin review is required." }, 409);

    const stripe = new Stripe(stripeKey, { httpClient: Stripe.createFetchHttpClient() });
    const paymentIntent = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id, {
      expand: ["latest_charge"],
    });
    const latestCharge = paymentIntent.latest_charge;
    const charge = typeof latestCharge === "string"
      ? await stripe.charges.retrieve(latestCharge)
      : latestCharge;

    if (!charge || charge.object !== "charge") return json({ error: "Stripe charge could not be found." }, 409);

    const refundablePence = charge.amount - charge.amount_refunded;
    if (refundablePence <= 0) return json({ error: "This payment has already been fully refunded." }, 409);

    const refund = await stripe.refunds.create(
      {
        payment_intent: job.stripe_payment_intent_id,
        amount: refundablePence,
        reason: "requested_by_customer",
        metadata: {
          job_id: job.id,
          learner_id: user.id,
          cancellation_reason: cancellationReason,
        },
      },
      { idempotencyKey: `cancel_job_${job.id}_refund_full` },
    );

    const now = new Date().toISOString();
    const { error: updateError } = await admin
      .from("job_requests")
      .update({
        status: "cancelled",
        payment_status: "refunded",
        refunded_amount_pence: charge.amount,
        stripe_refund_id: refund.id,
        refunded_at: now,
        refunded_by: user.id,
        cancellation_reason: cancellationReason,
        cancelled_at: now,
      })
      .eq("id", job.id)
      .eq("status", "scheduled");

    if (updateError) {
      console.error("Refund succeeded but job update failed", { jobId: job.id, refundId: refund.id, updateError });
      return json({
        error: "Stripe refund succeeded, but the job record could not be updated. Contact ToolTutors support.",
        refundId: refund.id,
      }, 500);
    }

    return json({
      success: true,
      jobId: job.id,
      refundId: refund.id,
      refundedPence: refundablePence,
      status: "cancelled",
      paymentStatus: "refunded",
    });
  } catch (error) {
    console.error("cancel-job-and-refund failed:", error);
    return json({ error: error instanceof Error ? error.message : "Unexpected cancellation error." }, 500);
  }
});
