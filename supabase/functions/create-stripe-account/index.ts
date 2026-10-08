import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^22.0.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const appUrl = (Deno.env.get("APP_URL") || "https://tooltutors.co.uk").replace(/\/$/, "");
    const authorization = request.headers.get("Authorization");

    if (!stripeSecretKey) {
      throw new Error("Missing STRIPE_SECRET_KEY secret");
    }

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      throw new Error("Missing required Supabase environment variables");
    }

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Unauthorized" }, 401);
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
      },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("id, role, validation_status, stripe_account_id, email, full_name")
      .eq("id", user.id)
      .single();

    if (profileError) {
      throw profileError;
    }

    if (!profile || profile.role !== "tutor") {
      return jsonResponse({ error: "Only Tutor accounts can connect to Stripe" }, 403);
    }

    if (profile.validation_status !== "approved") {
      return jsonResponse({ error: "Tutor verification must be approved first" }, 403);
    }

    const stripe = new Stripe(stripeSecretKey);
    let stripeAccountId = profile.stripe_account_id as string | null;

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "GB",
        email: profile.email || user.email || undefined,
        business_type: "individual",
        business_profile: {
          product_description: "DIY mentoring and home project services through ToolTutors",
          url: appUrl,
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          supabase_user_id: user.id,
          platform: "ToolTutors",
        },
      });

      stripeAccountId = account.id;

      const { error: updateError } = await adminClient
        .from("profiles")
        .update({ stripe_account_id: stripeAccountId })
        .eq("id", user.id);

      if (updateError) {
        throw updateError;
      }
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${appUrl}/tutor.html?stripe_refresh=true`,
      return_url: `${appUrl}/tutor.html?stripe_return=true`,
      type: "account_onboarding",
    });

    return jsonResponse({ url: accountLink.url });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    console.error("create-stripe-account error:", error);
    return jsonResponse({ error: message }, 500);
  }
});
