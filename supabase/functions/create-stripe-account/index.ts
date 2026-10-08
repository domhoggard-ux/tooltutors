import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "npm:stripe@^13.0.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY.");
}

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing Supabase environment variables.");
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers*:
    "authorization, x-client-inf*, apikey, content-type",
  "Access*Control-Allow-Methods": "POST, OPT*ONS",
};

function jsonResponse(
 *body: Record<string, unknown>,
  s*atus = 200,
): Response {
  return*new Response(JSON.stringify(body),*{
    status,
    headers: {
     *...corsHeaders,
      "Content-Typ*": "application/json",
    },
  })*
}

serve(async (req: Request): Pr*mise<Response> => {
  if (req.meth*d === "OPTIONS") {
    return new *esponse("ok", {
      status: 200,*      headers: corsHeaders,
    })*
  }

  if (req.method !== "POST")*{
    return jsonResponse(
      {*error: "Method not allowed." },
  *   405,
    );
  }

  try {
    co*st authorizationHeader = req.heade*s.get("Authorization");

    if (!*uthorizationHeader) {
      return*jsonResponse(
        { error: "Mi*sing Authorization header." },
   *    401,
      );
    }

    const*accessToken = authorizationHeader.*eplace(/^Bearer\s+/i, "").trim();
*    if (!accessToken) {
      retu*n jsonResponse(
        { error: "*issing access token." },
        4*1,
      );
    }

    const supab*seClient = createClient(
      sup*baseUrl,
      supabaseAnonKey,
  *   {
        global: {
          h*aders: {
            Authorization* `Bearer ${accessToken}`,
        * },
        },
        auth: {
   *      persistSession: false,
     *    autoRefreshToken: false,
     *    detectSessionInUrl: false,
   *    },
      },
    );

    const *
      data: userData,
      error* userError,
    } = await supabase*lient.auth.getUser(accessToken);

*   if (userError || !userData?.use*) {
      console.error("Stripe on*oarding authentication error:", us*rError);

      return jsonRespons*(
        {
          error: "Your*login session could not be verifie*. Please sign in again.",
        *,
        401,
      );
    }

   *const user = userData.user;

    c*nst {
      data: profile,
      e*ror: profileError,
    } = await s*pabaseClient
      .from("profiles*)
      .select(
        "id, emai*, full_name, role, validation_stat*s, stripe_account_id",
      )
   *  .eq("id", user.id)
      .single*);

    if (profileError) {
      *onsole.error("Profile retrieval er*or:", profileError);

      return*jsonResponse(
        {
          *rror: `Unable to retrieve Tutor pr*file: ${profileError.message}`,
  *     },
        400,
      );
    *

    if (!profile) {
      return*jsonResponse(
        { error: "Tu*or profile was not found." },
    *   404,
      );
    }

    if (pr*file.role !== "tutor") {
      ret*rn jsonResponse(
        { error: *Only Tutor accounts can set up Str*pe payouts." },
        403,
     *);
    }

    if (profile.validati*n_status !== "approved") {
      r*turn jsonResponse(
        {
     *    error:
            "Your Tutor*account must be approved before se*ting up payouts.",
        },
    *   403,
      );
    }

    let st*ipeAccountId = profile.stripe_acco*nt_id;

    if (!stripeAccountId) *
      const account = await strip*.accounts.create({
        type: "*xpress",
        email: profile.em*il || user.email || undefined,
   *    business_profile: {
          *ame: profile.full_name || "ToolTut*rs Tutor",
          product_descr*ption:
            "DIY tutoring, *entorship and home project service* through ToolTutors",
        },
 *      capabilities: {
          ca*d_payments: {
            requeste*: true,
          },
          tra*sfers: {
            requested: tr*e,
          },
        },
       *metadata: {
          supabase_use*_id: user.id,
          platform: *ToolTutors",
        },
      });
*      stripeAccountId = account.id*

      const { error: updateError*} = await supabaseClient
        .*rom("profiles")
        .update({
*         stripe_account_id: stripe*ccountId,
          stripe_onboard*ng_complete: false,
        })
   *    .eq("id", user.id);

      if *updateError) {
        console.err*r("Stripe account save error:", up*ateError);

        return jsonRes*onse(
          {
            erro*:
              `Stripe account wa* created, but could not be saved: *{updateError.message}`,
          *,
          400,
        );
      *
    }

    const requestOrigin = *eq.headers.get("origin");
    cons* siteOrigin =
      requestOrigin *&
      (
        requestOrigin.st*rtsWith("https://") ||
        req*estOrigin.startsWith("http://localhost")
      )
        ? requestOri*in
        : "https://tooltutors.co.uk";

    const accountLink = awa*t stripe.accountLinks.create({
   *  account: stripeAccountId,
      *efresh_url:
        `${siteOrigin}*tutor.html?stripe_refresh=true`,
 *    return_url:
        `${siteOri*in}/tutor.html?stripe_return=true`*
      type: "account_onboarding",*    });

    return jsonResponse({*      url: accountLink.url,
      *ccountId: stripeAccountId,
    });*  } catch (error) {
    const erro*Message =
      error instanceof E*ror
        ? error.message
      * : "An unexpected Stripe onboardin* error occurred.";

    console.er*or("Create Stripe account error:",*error);

    return jsonResponse(
*     { error: errorMessage },
    * 500,
    );
  }
});
