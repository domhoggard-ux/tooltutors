import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^22.0.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const STRIPE_V2_VERSION = "2026-09-30.preview";

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

async function createRecipientAccountV2(params: {
  stripeSecretKey: string;
  email: string;
  displayName: string;
  userId: string;
}): Promise<string> {
  const response = await fetch("https://api.stripe.com/v2/core/accounts", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${params.stripeSecretKey}`,
      "Content-Type": "application/json",
      "Stripe-Version": STRIPE_V2_VERSION,
    },
    body: JSON.stringify({
      contact_email: params.email,
      display_name: params.displayName,
      dashboard: "express",
      identity: {
        country: "gb",
        entity_type: "individual",
      },
      configuration: {
        recipient: {
          capabilities: {
            _balance: {
              _transfers: {
                requested: true,
              },
            },
          },
        },
      },
      defaults: {
        currency: "gbp",
        locales: ["en-GB"],
        responsibilities: {
          fees_collector: "application",
          losses_collector: "application",
        },
      },
      metadata: {
        supabase_user_id: params.userId,
        platform: "ToolTutors",
      },
      include: [
        "configuration.recipient",
        "identity",
        "requirements",
      ],
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    const errorMessage =
      payload?.error?.message ||
      payload?.error ||
      "Stripe could not create the connected account.";
    throw new Error(errorMessage);
  }

  if (!payload?.id || typeof payload.id !== "string") {
    throw new Error("Stripe did not return a connected account ID.");
  }

  return payload.id;
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
      throw new Error("Missing STRIPE_SECRET_KEY secret.");
    }

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      throw new Error("Missing required Supabase environment variables.");
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
      return jsonResponse({ error: "Only Tutor accounts can connect to Stripe." }, 403);
    }

    if (profile.validation_status !== "approved") {
      return jsonResponse({ error: "Tutor verification must be approved first." }, 403);
    }

    const accountEmail = profile.email || user.email;
    if (!accountEmail) {
      return jsonResponse({ error: "The Tutor profile needs an email address." }, 400);
    }

    let stripeAccountId = profile.stripe_account_id as string | null;

    if (!stripeAccountId) {
      stripeAccountId = await createRecipientAccountV2({
        stripeSecretKey,
        email: accountEmail,
        displayName: profile.full_name || "ToolTutors Tutor",
        userId: user.id,
      });

      const { error: updateError } = await adminClient
        .from("profiles")
        .update({ stripe_account_id: stripeAccountId })
        .eq("id", user.id);

      if (updateError) {
        throw updateError;
      }
    }

    const stripe = new Stripe(stripeSecretKey);
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${appUrl}/tutor.html?stripe_refresh=true`,
      return_url: `${appUrl}/tutor.html?stripe_return=true`,
      type: "account_onboarding",
      collection_options: {
        fields: "eventually_due",
        future_requirements: "include",
      },
    });

    return jsonResponse({ url: accountLink.url });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    console.error("create-stripe-account error:", error);
    return jsonResponse({ error: message }, 500);
  }
});
