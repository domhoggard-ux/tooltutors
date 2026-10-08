import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^16.0.0";
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

function normaliseUkPostcode(value: string): string {
  const compact = value
    .toUpperCase()
    .replace(/\s+/g, "");

  if (compact.length < 5) {
    return compact;
  }

  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

async function geocodePostcode(
  postcode: string,
): Promise<{
  latitude: number | null;
  longitude: number | null;
}> {
  try {
    const response = await fetch(
      `https://api.postcodes.io/postcodes/${
        encodeURIComponent(postcode)
      }`,
    );

    if (!response.ok) {
      console.error(
        "Postcodes.io returned:",
        response.status,
      );

      return {
        latitude: null,
        longitude: null,
      };
    }

    const data = await response.json();

    const latitude = Number(
      data?.result?.latitude,
    );

    const longitude = Number(
      data?.result?.longitude,
    );

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      return {
        latitude: null,
        longitude: null,
      };
    }

    return {
      latitude,
      longitude,
    };
  } catch (error) {
    console.error(
      "Postcode geocoding failed:",
      error,
    );

    return {
      latitude: null,
      longitude: null,
    };
  }
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
    } = await userClient.auth.getUser(
      accessToken,
    );

    if (userError || !userData?.user) {
      console.error(
        "Authentication error:",
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
        "Profile lookup failed:",
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
        addressSynced: false,
        phoneSynced: false,
        message:
          "No Stripe account is connected.",
      });
    }

    /*
      Stripe documents that a v2 Account ID can be
      retrieved through the v1 Accounts endpoint.

      This gives us the familiar v1 Account structure,
      including individual and company identity fields.
    */
    const stripe = new Stripe(
      stripeSecretKey,
      {
        httpClient:
          Stripe.createFetchHttpClient(),
      },
    );

    const account =
      await stripe.accounts.retrieve(
        profile.stripe_account_id,
      );

    if ("deleted" in account && account.deleted) {
      return jsonResponse(
        {
          error:
            "The connected Stripe account has been deleted.",
        },
        400,
      );
    }

    /*
      Prefer the individual identity because ToolTutors
      currently creates individual UK recipient accounts.

      Fall back to company and then business-profile data.
    */
    const individual =
      account.individual || null;

    const company =
      account.company || null;

    const address =
      individual?.address ||
      company?.address ||
      null;

    const phone = cleanText(
      individual?.phone ||
      company?.phone ||
      account.business_profile
        ?.support_phone ||
      null,
    );

    const addressLine1 = cleanText(
      address?.line1,
    );

    const addressLine2 = cleanText(
      address?.line2,
    );

    const city = cleanText(
      address?.city,
    );

    const rawPostcode = cleanText(
      address?.postal_code,
    );

    const country = cleanText(
      address?.country,
    );

    const postcode = rawPostcode
      ? normaliseUkPostcode(rawPostcode)
      : null;

    let latitude: number | null = null;
    let longitude: number | null = null;

    if (postcode) {
      const coordinates =
        await geocodePostcode(postcode);

      latitude = coordinates.latitude;
      longitude = coordinates.longitude;
    }

    /*
      The recipient transfer capability is what controls
      access to the Tutor marketplace in the current
      ToolTutors v2 recipient-account setup.
    */
    let capabilityStatus = "pending";

    try {
      const v2Response = await fetch(
        `https://api.stripe.com/v2/core/accounts/${
          encodeURIComponent(
            profile.stripe_account_id,
          )
        }?include[]=configuration.recipient`,
        {
          method: "GET",

          headers: {
            "Authorization":
              `Bearer ${stripeSecretKey}`,

            "Stripe-Version":
              "2026-09-30.preview",
          },
        },
      );

      const v2Account =
        await v2Response.json();

      if (v2Response.ok) {
        capabilityStatus =
          v2Account?.configuration
            ?.recipient?.capabilities
            ?.stripe_balance
            ?.stripe_transfers?.status ||
          v2Account?.configurations
            ?.recipient?.capabilities
            ?.stripe_balance
            ?.stripe_transfers?.status ||
          v2Account?.capabilities
            ?.stripe_balance
            ?.stripe_transfers?.status ||
          "pending";
      } else {
        console.error(
          "Stripe v2 status response:",
          v2Account,
        );
      }
    } catch (statusError) {
      console.error(
        "Stripe capability lookup failed:",
        statusError,
      );
    }

    const onboardingComplete =
      capabilityStatus === "active" ||
      profile.stripe_onboarding_complete === true;

    const addressComplete = Boolean(
      addressLine1 &&
      city &&
      postcode,
    );

    const coordinatesComplete = Boolean(
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      !(latitude === 0 && longitude === 0),
    );

    const updateData: Record<
      string,
      unknown
    > = {
      stripe_onboarding_complete:
        onboardingComplete,
    };

    if (phone) {
      updateData.phone = phone;
    }

    if (addressLine1) {
      updateData.address_line1 =
        addressLine1;
    }

    if (addressLine2) {
      updateData.address_line2 =
        addressLine2;
    }

    if (city) {
      updateData.city = city;
    }

    if (postcode) {
      updateData.postcode = postcode;
    }

    if (country) {
      updateData.country =
        country.toUpperCase();
    }

    /*
      Only overwrite the coordinates when geocoding
      returned genuine finite coordinates.

      This prevents null values becoming 0,0.
    */
    if (
      latitude !== null &&
      longitude !== null &&
      !(latitude === 0 && longitude === 0)
    ) {
      updateData.latitude = latitude;
      updateData.longitude = longitude;
    }

    if (addressComplete || phone) {
      updateData.stripe_address_synced_at =
        new Date().toISOString();
    }

    const {
      error: updateError,
    } = await adminClient
      .from("profiles")
      .update(updateData)
      .eq("id", user.id);

    if (updateError) {
      console.error(
        "Profile update failed:",
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
      "Stripe verification is still being processed.";

    if (
      onboardingComplete &&
      coordinatesComplete
    ) {
      message =
        "Stripe verification and marketplace location setup are complete.";
    } else if (
      onboardingComplete &&
      !addressComplete
    ) {
      message =
        "Stripe verification is complete, but Stripe did not return a complete address.";
    } else if (
      onboardingComplete &&
      addressComplete &&
      !coordinatesComplete
    ) {
      message =
        "The Stripe address was saved, but its postcode could not be mapped.";
    }

    return jsonResponse({
      complete: onboardingComplete,
      capabilityStatus,

      addressSynced:
        addressComplete &&
        coordinatesComplete,

      phoneSynced:
        Boolean(phone),

      postcodeFound:
        Boolean(postcode),

      coordinatesFound:
        coordinatesComplete,

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
