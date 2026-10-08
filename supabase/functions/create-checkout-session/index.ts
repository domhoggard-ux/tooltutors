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
    const appUrl = (Deno.env.get("APP_URL") || "https://tooltutors.co.uk").replace(/\/$/, "");
    const authorization = req.headers.get("Authorization");

    if (!stripeSecretKey || !supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error("Missing required environment variables.");
    }
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Unauthorised." }, 401);

    const { jobId } = await req.json();
    if (!jobId) return json({ error: "Missing jobId." }, 400);

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
      .select("id, title, learner_id, tutor_id, status, payment_status, stripe_checkout_session_id")
      .eq("id", jobId)
      .single();

    if (jobError || !job) return json({ error: "Job not found." }, 404);
    if (job.learner_id !== user.id) return json({ error: "This is not your job." }, 403);
    if (job.status !== "pending_payment") return json({ error: "This job is not awaiting payment." }, 409);
    if (!job.tutor_id) return json({ error: "No Tutor is assigned." }, 400);
    if (job.payment_status === "paid") return json({ error: "This job is already paid." }, 409);

    const { data: offer, error: offerError } = await admin
      .from("job_offers")
      .select("offer_price")
      .eq("job_id", job.id)
      .eq("tutor_id", job.tutor_id)
      .eq("status", "accepted")
      .single();

    if (offerError || !offer) return json({ error: "Accepted offer not found." }, 404);

    const amountInPence = Math.round(Number(offer.offer_price) * 100);
    if (!Number.isInteger(amountInPence) || amountInPence < 50) {
      return json({ error: "The agreed price is invalid." }, 400);
    }

    const stripe = new Stripe(stripeSecretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    if (job.stripe_checkout_session_id) {
      try {
        const existing = await stripe.checkout.sessions.retrieve(job.stripe_checkout_session_id);
        if (existing.status === "open" && existing.url) return json({ url: existing.url });
      } catch (error) {
        console.warn("Existing Checkout Session could not be reused:", error);
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: user.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "gbp",
          unit_amount: amountInPence,
          product_data: {
            name: `ToolTutors: ${job.title}`,
            description: "Secure payment for the agreed ToolTutors appointment.",
          },
        },
      }],
      success_url: `${appUrl}/learner.html?payment_success=true&job_id=${job.id}`,
      cancel_url: `${appUrl}/learner.html?payment_cancelled=true&job_id=${job.id}`,
      metadata: {
        job_id: job.id,
        learner_id: user.id,
        tutor_id: job.tutor_id,
      },
      payment_intent_data: {
        metadata: {
          job_id: job.id,
          learner_id: user.id,
          tutor_id: job.tutor_id,
        },
      },
    });

    const { error: updateError } = await admin
      .from("job_requests")
      .update({
        payment_status: "checkout_created",
        stripe_checkout_session_id: session.id,
      })
      .eq("id", job.id);

    if (updateError) throw updateError;
    return json({ url: session.url });
  } catch (error) {
    console.error("create-checkout-session failed:", error);
    return json({ error: error instanceof Error ? error.message : "Unexpected payment error." }, 500);
  }
});
