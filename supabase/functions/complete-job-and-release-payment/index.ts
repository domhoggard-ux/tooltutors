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
      .select("id, title, learner_id, tutor_id, status, payment_status, amount_paid_pence, stripe_payment_intent_id, tutor_payment_released, stripe_transfer_id")
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
      .select("id, full_name, stripe_account_id, stripe_onboarding_complete")
      .eq("id", job.tutor_id)
      .single();

    if (tutorError || !tutor) return json({ error: "Tutor profile not found." }, 404);
    if (!tutor.stripe_account_id || !tutor.stripe_onboarding_complete) {
      return json({ error: "The Tutor is not ready to receive Stripe transfers." }, 409);
    }

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
      const sourceChargeId = typeof latestCharge === "string"
        ? latestCharge
        : latestCharge?.id;

      if (!sourceChargeId) {
        return json({ error: "The source charge could not be found." }, 409);
      }

      const transfer = await stripe.transfers.create(
        {
          amount: tutorAmountPence,
          currency: "gbp",
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
        {
          idempotencyKey: `tooltutors_job_${job.id}_tutor_release_v1`,
        },
      );

      transferId = transfer.id;
    }

    const { data: learnerProfile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .single();

    const { data: existingReview } = await admin
      .from("reviews")
      .select("id")
      .eq("job_id", job.id)
      .maybeSingle();

    if (!existingReview) {
      const { error: reviewError } = await admin.from("reviews").insert({
        job_id: job.id,
        tutor_id: job.tutor_id,
        reviewer_name: learnerProfile?.full_name || "Learner",
        rating,
        comment,
      });
      if (reviewError) throw reviewError;
    }

    const now = new Date().toISOString();
    const { error: updateError } = await admin
      .from("job_requests")
      .update({
        status: "completed",
        tutor_payment_released: true,
        stripe_transfer_id: transferId,
        tutor_paid_at: now,
        tutor_payout_amount_pence: tutorAmountPence,
        platform_commission_pence: commissionPence,
      })
      .eq("id", job.id);

    if (updateError) throw updateError;

    return json({
      success: true,
      transferId,
      tutorAmountPence,
      commissionPence,
      message: "Job completed and Tutor payment released.",
    });
  } catch (error) {
    console.error("complete-job-and-release-payment failed:", error);
    return json({
      error: error instanceof Error ? error.message : "Unexpected payout error.",
    }, 500);
  }
});
