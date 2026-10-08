import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const STRIPE_API_VERSION = "2026-09-30.preview";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const authorization = request.headers.get("Authorization");

    if (!stripeSecretKey) {
      throw new Error("Missing STRIPE_SECRET_KEY.");
    }

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      throw new Error("One or more required Supabase environment variables are missing.");
    }

    if (!authorization || !authorization.startsWith("Bearer ")) {
      return jsonResponse({ error: "Your login session was not included. Please sign in again." }, 401);
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authorization,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      console.error("Stripe status authentication failed:", userError);
      return jsonResponse({ error: "Your login session could not be verified. Please sign in again." }, 401);
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("id, role, validation_status, stripe_account_id, stripe_onboarding_complete")
      .eq("id", user.id)
      .single();

    if (profileError) {
      console.error("Stripe status profile lookup failed:", profileError);
      return jsonResponse({ error: `Tutor profile lookup failed: ${profileError.message}` }, 400);
    }

    if (!profile) {
      return jsonResponse({ error: "Tutor profile not found." }, 404);
    }

    if (profile.role !== "tutor") {
      return jsonResponse({ error: "Only Tutor accounts can check Stripe onboarding." }, 403);
    }

    if (!profile.stripe_account_id) {
      return jsonResponse({
        complete: false,
        capabilityStatus: "not_requested",
        requirements: [],
        futureRequirements: [],
        message: "No Stripe account has been connected yet.",
      });
    }

    const stripeUrl = new URL(
      `https://api.stripe.com/v2/core/accounts/${encodeURIComponent(profile.stripe_account_id)}`,
    );
    stripeUrl.searchParams.append(
  "include[0]",
  "configuration.recipient",
);

stripeUrl.searchParams.append(
  "include[1]",
  "requirements",
);

stripeUrl.searchParams.append(
  "include[2]",
  "future_requirements",
);

stripeUrl.searchParams.append(
  "include[3]",
  "defaults",
);

    const stripeResponse = await fetch(stripeUrl.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
    });

    const account = await stripeResponse.json();

    if (!stripeResponse.ok) {
      const stripeMessage = account?.error?.message || account?.error || "Stripe could not retrieve this account.";
      throw new Error(stripeMessage);
    }

    const transferCapability =
      account?.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers || null;
    const capabilityStatus = transferCapability?.status || "pending";
    const capabilityStatusDetails = transferCapability?.status_details || [];
    const onboardingComplete = capabilityStatus === "active";

    const { error: updateError } = await adminClient
      .from("profiles")
      .update({ stripe_onboarding_complete: onboardingComplete })
      .eq("id", user.id);

    if (updateError) {
      console.error("Stripe status profile update failed:", updateError);
      return jsonResponse({
        error: `Stripe status was retrieved, but the profile could not be updated: ${updateError.message}`,
      }, 400);
    }

    let message = "Stripe onboarding still needs more information.";
    if (capabilityStatus === "active") {
      message = "Stripe onboarding is complete and the Tutor can receive transfers.";
    } else if (capabilityStatus === "pending") {
      message = "Stripe information has been submitted and is being reviewed.";
    } else if (capabilityStatus === "restricted") {
      message = "Stripe requires more information before transfers can be enabled.";
    }

    return jsonResponse({
      complete: onboardingComplete,
      capabilityStatus,
      capabilityStatusDetails,
      requirements: account?.requirements || [],
      futureRequirements: account?.future_requirements || [],
      message,
    });
  } catch (error) {
    console.error("Check Stripe account function failed:", error);
    const errorMessage = error instanceof Error
      ? error.message
      : "An unexpected Stripe status error occurred.";
    return jsonResponse({ error: errorMessage }, 500);
  }
});
