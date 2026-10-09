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
    const amountPence = Number(payload?.amountPence);
    const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";

    if (!jobId) return json({ error: "Missing jobId." }, 400);
    if (!Number.isInteger(amountPence) || amountPence <= 0) {
      return json({ error: "Refund amount must be a positive whole number of pence." }, 400);
    }
    if (!reason) return json({ error: "A refund reason is required." }, 400);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: "Unauthorised." }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: adminProfile, error: adminError } = await admin
      .from("profiles")
      .select("id, role")
      .eq("id", user.id)
      .single();
    if (adminError || adminProfile?.role !== "admin") {
      return json({ error: "Administrator access required." }, 403);
    }

    const { data: job, error: jobError } = await admin
      .from("job_requests")
      .select("id, title, status, payment_status, amount_paid_pence, stripe_payment_intent_id, stripe_transfer_id, tutor_payment_released, tutor_payout_amount_pence, refunded_amount_pence")
      .eq("id", jobId)
      .single();

    if (jobError || !job) return json({ error: "Job not found." }, 404);
    if (job.payment_status !== "paid" && job.payment_status !== "partially_refunded") {
      return json({ error: "This job does not have a refundable paid payment." }, 409);
    }
    if (!job.stripe_payment_intent_id) {
      return json({ error: "The Stripe Payment Intent is missing." }, 409);
    }

    const grossPence = Number(job.amount_paid_pence);
    if (!Number.isInteger(grossPence) || grossPence <= 0) {
      return json({ error: "The paid amount is missing or invalid." }, 409);
    }

    const stripe = new Stripe(stripeSecretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    const paymentIntent = await stripe.paymentIntents.retrieve(
      job.stripe_payment_intent_id,
      { expand: ["latest_charge"] },
    );
    const latestCharge = paymentIntent.latest_charge;
    const charge = typeof latestCharge === "string"
      ? await stripe.charges.retrieve(latestCharge)
      : latestCharge;

    if (!charge || charge.object !== "charge") {
      return json({ error: "The Stripe charge could not be found." }, 409);
    }

    const alreadyRefundedPence = charge.amount_refunded || 0;
    const refundablePence = charge.amount - alreadyRefundedPence;
    if (amountPence > refundablePence) {
      return json({
        error: `Only ${refundablePence} pence remains refundable.`,
        refundablePence,
      }, 409);
    }

    const operationKey = `job_${job.id}_refund_total_${alreadyRefundedPence + amountPence}`;

    // Refund the Learner first. Stripe returns the same refund on a safe retry.
    const refund = await stripe.refunds.create(
      {
        payment_intent: job.stripe_payment_intent_id,
        amount: amountPence,
        reason: "requested_by_customer",
        metadata: {
          job_id: job.id,
          admin_id: user.id,
          admin_reason: reason.slice(0, 450),
        },
      },
      { idempotencyKey: `${operationKey}_learner` },
    );

    let transferReversalId: string | null = null;
    let reversedPence = 0;

    if (job.stripe_transfer_id) {
      const transfer = await stripe.transfers.retrieve(job.stripe_transfer_id);
      const tutorSharePence = Number(job.tutor_payout_amount_pence) || Math.round(grossPence * 0.90);
      const targetTotalReversal = Math.min(
        transfer.amount,
        Math.round(((alreadyRefundedPence + amountPence) / grossPence) * tutorSharePence),
      );
      reversedPence = Math.max(0, targetTotalReversal - transfer.amount_reversed);

      if (reversedPence > 0) {
        const reversal = await stripe.transfers.createReversal(
          job.stripe_transfer_id,
          {
            amount: reversedPence,
            metadata: {
              job_id: job.id,
              refund_id: refund.id,
              admin_id: user.id,
            },
          },
          { idempotencyKey: `${operationKey}_tutor_reversal` },
        );
        transferReversalId = reversal.id;
      }
    }

    const totalRefundedPence = alreadyRefundedPence + amountPence;
    const fullyRefunded = totalRefundedPence >= charge.amount;
    const now = new Date().toISOString();

    const updatePayload: Record<string, unknown> = {
      status: fullyRefunded ? "refunded" : "payment_review",
      payment_status: fullyRefunded ? "refunded" : "partially_refunded",
      issue_status: fullyRefunded ? "refunded" : "partially_refunded",
      issue_admin_notes: reason,
      issue_resolved_at: now,
      issue_resolved_by: user.id,
      refunded_amount_pence: totalRefundedPence,
      stripe_refund_id: refund.id,
      refunded_at: now,
      refunded_by: user.id,
    };
    if (transferReversalId) {
      updatePayload.stripe_transfer_reversal_id = transferReversalId;
    }

    const { error: updateError } = await admin
      .from("job_requests")
      .update(updatePayload)
      .eq("id", job.id);

    if (updateError) {
      console.error("Stripe refund succeeded but database update failed", {
        jobId: job.id,
        refundId: refund.id,
        transferReversalId,
        updateError,
      });
      return json({
        error: "Stripe refund succeeded, but the database record could not be updated. Reconcile this job manually.",
        refundId: refund.id,
        transferReversalId,
      }, 500);
    }

    return json({
      success: true,
      jobId: job.id,
      refundId: refund.id,
      refundStatus: refund.status,
      refundedThisRequestPence: amountPence,
      totalRefundedPence,
      fullyRefunded,
      transferReversalId,
      reversedThisRequestPence: reversedPence,
    });
  } catch (error) {
    console.error("admin-refund-payment failed:", error);
    return json({
      error: error instanceof Error ? error.message : "Unexpected refund error.",
    }, 500);
  }
});
