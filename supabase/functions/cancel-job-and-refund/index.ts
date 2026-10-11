import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^16.0.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const auth = req.headers.get("Authorization");

    if (!stripeKey || !url || !anon || !service) {
      throw new Error("Missing required environment variables.");
    }
    if (!auth?.startsWith("Bearer ")) {
      return reply({ error: "Unauthorised." }, 401);
    }

    const body = await req.json();
    const jobId = typeof body?.jobId === "string" ? body.jobId : "";
    const reason = typeof body?.reason === "string"
      ? body.reason.trim().slice(0, 450)
      : "";

    if (!jobId || reason.length < 5) {
      return reply({ error: "A job and cancellation reason are required." }, 400);
    }

    const userDb = createClient(url, anon, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: userError } = await userDb.auth.getUser();
    if (userError || !user) return reply({ error: "Unauthorised." }, 401);

    const admin = createClient(url, service, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: job, error: jobError } = await admin
      .from("job_requests")
      .select("id,learner_id,tutor_id,status,payment_status,stripe_payment_intent_id,stripe_transfer_id")
      .eq("id", jobId)
      .single();

    if (jobError || !job) return reply({ error: "Job not found." }, 404);

    const role = job.tutor_id === user.id
      ? "tutor"
      : job.learner_id === user.id
      ? "learner"
      : null;

    if (!role) {
      return reply({ error: "You are not authorised to cancel this job." }, 403);
    }
    if (job.status !== "scheduled" || job.payment_status !== "paid") {
      return reply({ error: "Only a paid, scheduled job can be cancelled and refunded." }, 409);
    }
    if (!job.stripe_payment_intent_id) {
      return reply({ error: "Stripe Payment Intent is missing." }, 409);
    }
    if (job.stripe_transfer_id) {
      return reply({ error: "Tutor funds have already been transferred. Admin review is required." }, 409);
    }

    const stripe = new Stripe(stripeKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });
    const pi = await stripe.paymentIntents.retrieve(
      job.stripe_payment_intent_id,
      { expand: ["latest_charge"] },
    );
    const charge = typeof pi.latest_charge === "string"
      ? await stripe.charges.retrieve(pi.latest_charge)
      : pi.latest_charge;

    if (!charge || charge.object !== "charge") {
      return reply({ error: "Stripe charge could not be found." }, 409);
    }

    const amount = charge.amount - charge.amount_refunded;
    if (amount <= 0) {
      return reply({ error: "This payment has already been fully refunded." }, 409);
    }

    const refund = await stripe.refunds.create(
      {
        payment_intent: job.stripe_payment_intent_id,
        amount,
        reason: "requested_by_customer",
        metadata: {
          job_id: job.id,
          cancelled_by: user.id,
          cancelled_by_role: role,
          cancellation_reason: reason,
        },
      },
      { idempotencyKey: `cancel_job_${job.id}_refund_full` },
    );

    const now = new Date().toISOString();

    const updatePayload = role === "tutor"
      ? {
          status: "open",
          payment_status: null,
          tutor_id: null,
          appointment_time: null,
          required_tools: null,
          amount_paid_pence: null,
          gross_amount_pence: null,
          payment_currency: null,
          paid_at: null,
          stripe_payment_intent_id: null,
          stripe_checkout_session_id: null,
          tutor_payment_released: false,
          stripe_transfer_id: null,
          tutor_paid_at: null,
          tutor_payout_amount_pence: null,
          platform_commission_pence: null,
          refunded_amount_pence: amount,
          stripe_refund_id: refund.id,
          refunded_at: now,
          refunded_by: user.id,
          cancellation_reason: reason,
          cancelled_at: now,
          cancelled_by: user.id,
          cancelled_by_role: role,
        }
      : {
          status: "cancelled",
          payment_status: "refunded",
          refunded_amount_pence: amount,
          stripe_refund_id: refund.id,
          refunded_at: now,
          refunded_by: user.id,
          cancellation_reason: reason,
          cancelled_at: now,
          cancelled_by: user.id,
          cancelled_by_role: role,
        };

    const { data: updatedJob, error: updateError } = await admin
      .from("job_requests")
      .update(updatePayload)
      .eq("id", job.id)
      .eq("status", "scheduled")
      .select("id,status,payment_status,tutor_id")
      .single();

    if (updateError || !updatedJob) {
      console.error("Refund succeeded but DB update failed", {
        jobId,
        refundId: refund.id,
        updateError,
      });
      return reply({
        error: "Stripe refund succeeded, but the job record could not be updated.",
        refundId: refund.id,
      }, 500);
    }

    if (role === "tutor") {
      const { error: offerError } = await admin
        .from("job_offers")
        .update({ status: "rejected" })
        .eq("job_id", job.id)
        .eq("tutor_id", user.id)
        .eq("status", "accepted");

      if (offerError) {
        console.error("Job reopened but Tutor offer reset failed", {
          jobId,
          tutorId: user.id,
          offerError,
        });
      }
    }

    return reply({
      success: true,
      jobId,
      refundId: refund.id,
      refundedPence: amount,
      cancelledByRole: role,
      reopenedToMarketplace: role === "tutor",
      paymentReset: role === "tutor",
    });
  } catch (error) {
    console.error("cancel-job-and-refund failed", error);
    return reply({
      error: error instanceof Error ? error.message : "Unexpected cancellation error.",
    }, 500);
  }
});
