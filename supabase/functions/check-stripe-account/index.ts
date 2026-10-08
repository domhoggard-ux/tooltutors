import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const STRIPE_API_VERSION = "2026-09-30.preview";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function normaliseUkPostcode(value: string): string {
  const compact = value.toUpperCase().replace(/\s+/g, "");
  if (compact.length < 5) return compact;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function hasUsableCoordinates(latitude: unknown, longitude: unknown): boolean {
  const lat = Number(latitude);
  const lon = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
}

async function geocodeUkPostcode(postcode: string): Promise<{ latitude: number | null; longitude: number | null }> {
  try {
    const response = await fetch(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`,
      { headers: { Accept: "application/json" } },
    );

    if (!response.ok) {
      console.error("Postcode lookup failed:", response.status);
      return { latitude: null, longitude: null };
    }

    const payload = await response.json();
    const latitude = Number(payload?.result?.latitude);
    const longitude = Number(payload?.result?.longitude);

    return {
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
    };
  } catch (error) {
    console.error("Postcode lookup error:", error);
    return { latitude: null, longitude: null };
  }
}

function choosePerson(persons: any[]): any | null {
  if (!Array.isArray(persons) || persons.length === 0) return null;

  return persons.find((person) => person?.relationship?.representative === true)
    || persons.find((person) => person?.address?.postal_code)
    || persons.find((person) =>
      Array.isArray(person?.additional_addresses)
      && person.additional_addresses.some((address: any) => address?.postal_code)
    )
    || persons[0];
}

function chooseAddress(person: any): any | null {
  if (person?.address?.postal_code) return person.address;

  const registeredAddress = Array.isArray(person?.additional_addresses)
    ? person.additional_addresses.find((address: any) =>
      address?.purpose === "registered" && address?.postal_code
    )
    : null;

  if (registeredAddress) return registeredAddress;

  return Array.isArray(person?.additional_addresses)
    ? person.additional_addresses.find((address: any) => address?.postal_code) || null
    : null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const authorization = req.headers.get("Authorization");

    if (!stripeSecretKey || !supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      throw new Error("Missing required environment variables.");
    }

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Unauthorised." }, 401);
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Unauthorised." }, 401);

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("id, role, stripe_account_id, stripe_onboarding_complete, latitude, longitude")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) return jsonResponse({ error: "Tutor profile not found." }, 404);
    if (profile.role !== "tutor") return jsonResponse({ error: "Tutor account required." }, 403);

    if (!profile.stripe_account_id) {
      return jsonResponse({
        complete: false,
        capabilityStatus: "not_started",
        addressSynced: false,
        phoneSynced: false,
        message: "No Stripe account is connected.",
      });
    }

    const accountId = encodeURIComponent(profile.stripe_account_id);
    const stripeHeaders = {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Stripe-Version": STRIPE_API_VERSION,
      Accept: "application/json",
    };

    // Keep the already-working payout status check independent from address retrieval.
    const accountUrl = new URL(`https://api.stripe.com/v2/core/accounts/${accountId}`);
    accountUrl.searchParams.set("include[0]", "configuration.recipient");

    const accountResponse = await fetch(accountUrl.toString(), {
      method: "GET",
      headers: stripeHeaders,
    });
    const account = await accountResponse.json();

    if (!accountResponse.ok) {
      return jsonResponse(
        { error: account?.error?.message || "Stripe account retrieval failed." },
        accountResponse.status,
      );
    }

    const capabilityStatus =
      account?.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status
      || account?.configuration?.recipient?.capabilities?.stripe_transfers?.status
      || "pending";

    const onboardingComplete = capabilityStatus === "active";

    // Persons v2 contains the individual's residential address and phone number.
    let person: any | null = null;
    let address: any | null = null;
    let phone: string | null = null;

    try {
      const personsUrl = new URL(`https://api.stripe.com/v2/core/accounts/${accountId}/persons`);
      personsUrl.searchParams.set("limit", "20");

      const personsResponse = await fetch(personsUrl.toString(), {
        method: "GET",
        headers: stripeHeaders,
      });
      const personsPayload = await personsResponse.json();

      if (personsResponse.ok) {
        person = choosePerson(personsPayload?.data || []);
        address = chooseAddress(person);
        phone = cleanText(person?.phone);
      } else {
        console.error("Stripe Persons lookup failed:", personsPayload?.error?.message || personsResponse.status);
      }
    } catch (personError) {
      console.error("Stripe Persons lookup error:", personError);
    }

    const addressLine1 = cleanText(address?.line1);
    const addressLine2 = cleanText(address?.line2);
    const city = cleanText(address?.city) || cleanText(address?.town);
    const rawPostcode = cleanText(address?.postal_code);
    const postcode = rawPostcode ? normaliseUkPostcode(rawPostcode) : null;
    const country = cleanText(address?.country);

    let latitude: number | null = null;
    let longitude: number | null = null;

    if (postcode && (!hasUsableCoordinates(profile.latitude, profile.longitude))) {
      const coordinates = await geocodeUkPostcode(postcode);
      latitude = coordinates.latitude;
      longitude = coordinates.longitude;
    }

    const updateData: Record<string, unknown> = {
      stripe_onboarding_complete: onboardingComplete,
    };

    if (phone) updateData.phone = phone;
    if (addressLine1) updateData.address_line1 = addressLine1;
    if (addressLine2) updateData.address_line2 = addressLine2;
    if (city) updateData.city = city;
    if (postcode) updateData.postcode = postcode;
    if (country) updateData.country = country.toUpperCase();

    if (latitude !== null && longitude !== null && hasUsableCoordinates(latitude, longitude)) {
      updateData.latitude = latitude;
      updateData.longitude = longitude;
    }

    const addressFound = Boolean(addressLine1 && city && postcode);
    if (addressFound || phone) updateData.stripe_address_synced_at = new Date().toISOString();

    const { error: updateError } = await adminClient
      .from("profiles")
      .update(updateData)
      .eq("id", user.id);

    if (updateError) {
      return jsonResponse({ error: `Tutor profile update failed: ${updateError.message}` }, 400);
    }

    const finalCoordinatesAvailable = hasUsableCoordinates(
      latitude ?? profile.latitude,
      longitude ?? profile.longitude,
    );

    let message = "Stripe verification is still being processed.";
    if (onboardingComplete && addressFound && finalCoordinatesAvailable) {
      message = "Stripe verification and marketplace location setup are complete.";
    } else if (onboardingComplete && !addressFound) {
      message = "Stripe verification is complete, but Stripe did not return a complete Person address.";
    } else if (onboardingComplete && addressFound && !finalCoordinatesAvailable) {
      message = "The Stripe address was saved, but the postcode could not be mapped.";
    }

    return jsonResponse({
      complete: onboardingComplete,
      capabilityStatus,
      addressSynced: addressFound && finalCoordinatesAvailable,
      phoneSynced: Boolean(phone),
      coordinatesFound: finalCoordinatesAvailable,
      message,
    });
  } catch (error) {
    console.error("check-stripe-account failed:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unexpected Stripe status error." },
      500,
    );
  }
});
