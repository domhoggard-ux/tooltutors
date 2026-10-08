import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();

  return cleaned || null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const cleaned = cleanText(value);

    if (cleaned) {
      return cleaned;
    }
  }

  return null;
}

function readCapabilityStatus(account: any): string {
  return (
    account?.configuration?.recipient?.capabilities
      ?.stripe_balance?.stripe_transfers?.status ||
    account?.configuration?.recipient?.capabilities
      ?.stripe_transfers?.status ||
    account?.configurations?.recipient?.capabilities
      ?.stripe_balance?.stripe_transfers?.status ||
    account?.configurations?.recipient?.capabilities
      ?.stripe_transfers?.status ||
    account?.capabilities?.stripe_balance
      ?.stripe_transfers?.status ||
    account?.capabilities?.stripe_transfers?.status ||
    "pending"
  );
}

function extractIdentity(account: any) {
  const individual =
    account?.identity?.individual ||
    account?.individual ||
    account?.identity?.representative ||
    null;

  const business =
    account?.identity?.business_details ||
    account?.business_details ||
    account?.company ||
    null;

  const person =
    individual ||
    business ||
    account?.identity ||
    account;

  const address =
    person?.address ||
    business?.address ||
    account?.address ||
    account?.identity?.address ||
    null;

  const phone = firstText(
    person?.phone,
    person?.phone_number,
    person?.phone_numbers?.[0]?.phone_number,
    person?.phone_numbers?.[0]?.number,
    business?.phone,
    business?.phone_number,
    account?.phone,
    account?.phone_number,
    account?.contact_phone,
  );

  return {
    phone,

    addressLine1: firstText(
      address?.line1,
      address?.address_line1,
      address?.street,
    ),

    addressLine2: firstText(
      address?.line2,
      address?.address_line2,
    ),

    city: firstText(
      address?.city,
      address?.town,
      address?.locality,
    ),

    postcode: firstText(
      address?.postal_code,
      address?.postcode,
      address?.zip,
    ),

    country: firstText(
      address?.country,
      address?.country_code,
    ),
  };
}

function normaliseUkPostcode(postcode: string): string {
  return postcode
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^(.+)(\d[A-Z]{2})$/, "$1 $2");
}

async function geocodeUkPostcode(
  postcode: string,
): Promise<{
  latitude: number | null;
  longitude: number | null;
}> {
  const response = await fetch(
    `https://api.postcodes.io/postcodes/${
      encodeURIComponent(postcode)
    }`,
  );

  if (!response.ok) {
    console.error(
      "Postcode geocoding failed with status:",
      response.status,
    );

    return {
      latitude: null,
      longitude: null,
    };
  }

  const result = await response.json();

  const latitude = Number(result?.result?.latitude);
  const longitude = Number(result?.result?.longitude);

  return {
    latitude:
      Number.isFinite(latitude)
        ? latitude
        : null,

    longitude:
      Number.isFinite(longitude)
        ? longitude
        : null,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      {
        error: "Method not allowed.",
      },
      405,
    );
  }

  try {
    const stripeSecretKey =
      Deno.env.get("STRIPE_SECRET_KEY");

    const supabaseUrl =
      Deno.env.get("SUPABASE_URL");

    const supabaseAnonKey =
      Deno.env.get("SUPABASE_ANON_KEY");

    const supabaseServiceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    const authorization =
      req.headers.get("Authorization");

    if (
      !stripeSecretKey ||
      !supabaseUrl ||
      !supabaseAnonKey ||
      !supabaseServiceRoleKey
    ) {
      throw new Error(
        "Missing required environment variables.",
      );
    }

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse(
        {
          error: "Unauthorised.",
        },
        401,
      );
    }

    const accessToken = authorization
      .replace(/^Bearer\s+/i, "")
      .trim();

    const userClient = createClient(
      supabaseUrl,
      supabaseAnonKey,
      {
        global: {
          headers: {
            Authorization: authorization,
          },
        },

        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );

    const {
      data: userData,
      error: userError,
    } = await userClient.auth.getUser(accessToken);

    if (userError || !userData?.user) {
      console.error(
        "User authentication error:",
        userError,
      );

      return jsonResponse(
        {
          error:
            "Your login session could not be verified.",
        },
        401,
      );
    }

    const user = userData.user;

    const adminClient = createClient(
      supabaseUrl,
      supabaseServiceRoleKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );

    const {
      data: profile,
      error: profileError,
    } = await adminClient
      .from("profiles")
      .select(`
        id,
        role,
        stripe_account_id,
        stripe_onboarding_complete
      `)
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      console.error(
        "Tutor profile lookup error:",
        profileError,
      );

      return jsonResponse(
        {
          error: "Tutor profile not found.",
        },
        404,
      );
    }

    if (profile.role !== "tutor") {
      return jsonResponse(
        {
          error:
            "Only Tutor accounts can check Stripe status.",
        },
        403,
      );
    }

    if (!profile.stripe_account_id) {
      return jsonResponse({
        complete: false,
        capabilityStatus: "not_started",
        message:
          "No Stripe account has been connected yet.",
        addressSynced: false,
      });
    }

    /*
      Accounts v2 can return optional identity fields as null
      unless they are requested using include[].
    */
    const stripeUrl = new URL(
      `https://api.stripe.com/v2/core/accounts/${
        encodeURIComponent(profile.stripe_account_id)
      }`,
    );

    const includeFields = [
      "identity",
      "configuration.recipient",
      "requirements",
    ];

    for (const field of includeFields) {
      stripeUrl.searchParams.append(
        "include[]",
        field,
      );
    }

    const stripeResponse = await fetch(
      stripeUrl.toString(),
      {
        method: "GET",

        headers: {
          "Authorization":
            `Bearer ${stripeSecretKey}`,

          "Stripe-Version":
            "2026-09-30.preview",

          "Content-Type":
            "application/json",
        },
      },
    );

    const stripeAccount =
      await stripeResponse.json();

    if (!stripeResponse.ok) {
      console.error(
        "Stripe account retrieval failed:",
        stripeAccount,
      );

      return jsonResponse(
        {
          error:
            stripeAccount?.error?.message ||
            "Stripe account retrieval failed.",
        },
        stripeResponse.status,
      );
    }

    const capabilityStatus =
      readCapabilityStatus(stripeAccount);

    const onboardingComplete =
      capabilityStatus === "active";

    const identity =
      extractIdentity(stripeAccount);

    let latitude: number | null = null;
    let longitude: number | null = null;

    if (identity.postcode) {
      identity.postcode =
        normaliseUkPostcode(identity.postcode);

      const coordinates =
        await geocodeUkPostcode(identity.postcode);

      latitude = coordinates.latitude;
      longitude = coordinates.longitude;
    }

    const addressAvailable = Boolean(
      identity.addressLine1 &&
      identity.city &&
      identity.postcode,
    );

    const profileUpdate: Record<string, unknown> = {
      stripe_onboarding_complete:
        onboardingComplete,
    };

    if (identity.phone) {
      profileUpdate.phone = identity.phone;
    }

    if (identity.addressLine1) {
      profileUpdate.address_line1 =
        identity.addressLine1;
    }

    if (identity.addressLine2) {
      profileUpdate.address_line2 =
        identity.addressLine2;
    }

    if (identity.city) {
      profileUpdate.city = identity.city;
    }

    if (identity.postcode) {
      profileUpdate.postcode =
        identity.postcode;
    }

    if (identity.country) {
      profileUpdate.country =
        identity.country.toUpperCase();
    }

    if (latitude !== null) {
      profileUpdate.latitude = latitude;
    }

    if (longitude !== null) {
      profileUpdate.longitude = longitude;
    }

    if (
      identity.phone ||
      addressAvailable
    ) {
      profileUpdate.stripe_address_synced_at =
        new Date().toISOString();
    }

    const {
      error: updateError,
    } = await adminClient
      .from("profiles")
      .update(profileUpdate)
      .eq("id", user.id);

    if (updateError) {
      console.error(
        "Profile synchronisation error:",
        updateError,
      );

      return jsonResponse(
        {
          error:
            `Stripe was checked, but the Tutor profile could not be updated: ${updateError.message}`,
        },
        400,
      );
    }

    let message =
      "Stripe still needs more information.";

    if (
      onboardingComplete &&
      addressAvailable &&
      latitude !== null &&
      longitude !== null
    ) {
      message =
        "Stripe verification and marketplace location setup are complete.";
    } else if (
      onboardingComplete &&
      !addressAvailable
    ) {
      message =
        "Stripe verification is complete, but no complete address was returned.";
    } else if (
      onboardingComplete &&
      addressAvailable &&
      (
        latitude === null ||
        longitude === null
      )
    ) {
      message =
        "Stripe verification is complete, but the postcode could not be mapped.";
    }

    return jsonResponse({
      complete: onboardingComplete,
      capabilityStatus,
      addressSynced:
        addressAvailable &&
        latitude !== null &&
        longitude !== null,
      phoneSynced:
        Boolean(identity.phone),
      message,
    });
  } catch (error) {
    console.error(
      "check-stripe-account failed:",
      error,
    );

    const message =
      error instanceof Error
        ? error.message
        : "Unexpected Stripe status error.";

    return jsonResponse(
      {
        error: message,
      },
      500,
    );
  }
});
