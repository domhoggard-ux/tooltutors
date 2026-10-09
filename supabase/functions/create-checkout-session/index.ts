import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^16.0.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const COMMISSION_RATE_PERCENT = 10;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers*:
    "authorization, x-client-inf*, apikey, content-type",
  "Access*Control-Allow-Methods": "POST, OPT*ONS",
};

function json(
  body: R*cord<string, unknown>,
  status = *00,
): Response {
  return new Res*onse(JSON.stringify(body), {
    s*atus,
    headers: {
      ...cors*eaders,
      "Content-Type": "app*ication/json",
    },
  });
}

fun*tion poundsToPence(value: unknown)* number {
  const amount = Number(*alue);

  if (!Number.isFinite(amo*nt)) {
    return 0;
  }

  return*Math.round(amount * 100);
}

Deno.*erve(async (req: Request): Promise*Response> => {
  if (req.method ==* "OPTIONS") {
    return new Respo*se("ok", {
      headers: corsHead*rs,
    });
  }

  if (req.method *== "POST") {
    return json(
    * {
        error: "Method not allo*ed.",
      },
      405,
    );
 *}

  try {
    const stripeSecretK*y =
      Deno.env.get("STRIPE_SEC*ET_KEY");

    const supabaseUrl =*      Deno.env.get("SUPABASE_URL")*

    const anonKey =
      Deno.e*v.get("SUPABASE_ANON_KEY");

    c*nst serviceRoleKey =
      Deno.en*.get("SUPABASE_SERVICE_ROLE_KEY");*
    const appUrl = (
      Deno.e*v.get("APP_URL") ||
      "https://tooltutors.co.uk"
    ).replace(/\*$/, "");

    const authorization *
      req.headers.get("Authorizat*on");

    if (
      !stripeSecre*Key ||
      !supabaseUrl ||
     *!anonKey ||
      !serviceRoleKey
*   ) {
      throw new Error(
    *   "Missing required environment v*riables.",
      );
    }

    if *!authorization?.startsWith("Bearer*")) {
      return json(
        {*          error: "Unauthorised.",
*       },
        401,
      );
  * }

    let requestBody: {
      j*bId?: string;
    };

    try {
  *   requestBody = await req.json();*    } catch {
      return json(
 *      {
          error: "The requ*st body is invalid.",
        },
 *      400,
      );
    }

    con*t jobId =
      requestBody?.jobId*.trim();

    if (!jobId) {
      *eturn json(
        {
          er*or: "Missing jobId.",
        },
 *      400,
      );
    }

    con*t userClient = createClient(
     *supabaseUrl,
      anonKey,
      *
        global: {
          heade*s: {
            Authorization: au*horization,
          },
        }*

        auth: {
          persis*Session: false,
          autoRefr*shToken: false,
        },
      }*
    );

    const {
      data: u*erData,
      error: userError,
  * } = await userClient.auth.getUser*);

    const user = userData?.use*;

    if (userError || !user) {
 *    return json(
        {
       *  error: "Unauthorised.",
        *,
        401,
      );
    }

   *const admin = createClient(
      *upabaseUrl,
      serviceRoleKey,
*     {
        auth: {
          p*rsistSession: false,
          aut*RefreshToken: false,
        },
  *   },
    );

    const {
      da*a: job,
      error: jobError,
   *} = await admin
      .from("job_r*quests")
      .select(`
        i*,
        title,
        learner_i*,
        tutor_id,
        status*
        payment_status,
        s*ripe_checkout_session_id
      `)
*     .eq("id", jobId)
      .singl*();

    if (jobError || !job) {
 *    return json(
        {
       *  error: "Job not found.",
       *},
        404,
      );
    }

  * if (job.learner_id !== user.id) {*      return json(
        {
     *    error:
            "This is no* your job.",
        },
        40*,
      );
    }

    if (job.stat*s !== "pending_payment") {
      r*turn json(
        {
          err*r:
            "This job is not aw*iting payment.",
        },
      * 409,
      );
    }

    if (!job*tutor_id) {
      return json(
   *    {
          error:
           *"No Tutor is assigned.",
        }*
        400,
      );
    }

    *f (job.payment_status === "paid") *
      return json(
        {
    *     error:
            "This job *s already paid.",
        },
     *  409,
      );
    }

    const {*      data: offer,
      error: of*erError,
    } = await admin
     *.from("job_offers")
      .select(*
        id,
        offer_price,
*       tutor_id,
        status
  *   `)
      .eq("job_id", job.id)
*     .eq("tutor_id", job.tutor_id)*      .eq("status", "accepted")
  *   .single();

    if (offerError *| !offer) {
      return json(
   *    {
          error:
           *"Accepted offer not found.",
     *  },
        404,
      );
    }

*   const {
      data: tutor,
    * error: tutorError,
    } = await *dmin
      .from("profiles")
     *.select(`
        id,
        full*name,
        email,
        role,*        validation_status,
       *stripe_account_id,
        stripe_*nboarding_complete
      `)
      *eq("id", job.tutor_id)
      .sing*e();

    if (tutorError || !tutor* {
      return json(
        {
  *       error:
            "The ass*gned Tutor profile could not be fo*nd.",
        },
        404,
    * );
    }

    if (tutor.role !== *tutor") {
      return json(
     *  {
          error:
            "*he assigned account is not a Tutor*account.",
        },
        400,*      );
    }

    if (tutor.vali*ation_status !== "approved") {
   *  return json(
        {
         *error:
            "The assigned T*tor has not been approved.",
     *  },
        409,
      );
    }

*   if (
      !tutor.stripe_accoun*_id ||
      tutor.stripe_onboardi*g_complete !== true
    ) {
      *eturn json(
        {
          er*or:
            "The assigned Tuto* has not completed Stripe payout s*tup.",
        },
        409,
   *  );
    }

    const grossAmountP*nce =
      poundsToPence(offer.of*er_price);

    if (
      !Number*isInteger(grossAmountPence) ||
   *  grossAmountPence < 50
    ) {
  *   return json(
        {
        * error:
            "The agreed pr*ce is invalid.",
        },
      * 400,
      );
    }

    const co*missionAmountPence =
      Math.ro*nd(
        grossAmountPence *
   *    (
          COMMISSION_RATE_PERCENT /
          100
        ),
      );

    const tutorNetAmountPence =
      grossAmountPence -
      commissionAmountPence;

    if (
      commissionAmountPence < 0 ||
      tutorNetAmountPence < 1
    ) {
      return json(
        {
          error:
            "The payment split is invalid.",
        },
        400,
      );
    }

    const stripe = new Stripe(
      stripeSecretKey,
      {
        httpClient:
          Stripe.createFetchHttpClient(),
      },
    );

    /*
      Reuse an existing open Checkout Session where
      possible to prevent duplicate payment pages.
    */
    if (job.stripe_checkout_se*sion_id) {
      try {
        con*t existing =
          await strip*.checkout.sessions.retrieve(
     *      job.stripe_checkout_session_*d,
          );

        if (
    *     existing.status === "open" &&*          existing.url
        ) {*          return json({
          * url: existing.url,
            re*sed: true,
          });
        }*      } catch (error) {
        co*sole.warn(
          "Existing Che*kout Session could not be reused:"*
          error,
        );
     *}
    }

    const commonMetadata * {
      job_id: job.id,
      off*r_id: offer.id,
      learner_id: *ser.id,
      tutor_id: tutor.id,
*     connected_account_id:
       *tutor.stripe_account_id,
      gross_amount_pence:
        String(grossAmountPence),
      commission_rate:
        String(COMMISSION_RATE_PERCENT),
      commission_amount_pence:
        String(commissionAmountPence),
      tutor_net_amount_pence:
        String(tutorNetAmountPence),
    };

    const session =
      await stripe.checkout.sessions.create({
        mode: "payment",

        payment_method_types: [
          "card",
        ],

        customer_email:
          user.email || undefined,

        /*
          Stripe creates a paid invoice after successful
          Checkout and makes the invoice available in the
          Stripe Dashboard and to the customer.
        */
        invoice_creation: {
*         enabled: true,

         *invoice_data: {
            descri*tion:
              `Payment for $*job.title}`,

            metadata* commonMetadata,

            cust*m_fields: [
              {
                name: "ToolTutors job reference",
                value: job.id,
              },
            ]*

            footer:
            * "The underlying service is suppli*d by the Tutor. ToolTutors acts as*the Tutor's disclosed payment coll*ction agent.",
          },
      * },

        line_items: [
          {
            quantity: 1,

            price_data: {
              currency: "gbp",
              unit_amount:
                grossAmountPence,

              product_data: {
                name:
                  `ToolTutors: ${job.title}`,

                description:
                  "Agreed Tutor service arranged through ToolTutors.",
              },
            },
          },
        ],

        success_url:
          `${appUrl}/learner.html?payment_success=true&job_id=${job.id}`,

        cancel_url:
          `${appUrl}/learner.html?payment_cancelled=true&job_id=${job.id}`,

        metadata: commonMetadata,

        payment_intent_data: {
          /*
            The full amount is charged through the
            ToolTutors platform.

            Stripe transfers the remainder to the exact
            connected Tutor account and returns the 10%
            application fee to ToolTutors.
          */
          application_fee_amount:
            commissionAmountPence,

          transfer_data: {
            destination:
              tutor.stripe_account_id,
          },

          /*
            The connected Tutor is identified as the
            settlement merchant for the underlying
            service.
          */
          on_behalf_of:
        *   tutor.stripe_account_id,

     *    metadata: commonMetadata,
    *   },
      });

    if (!session.*rl) {
      throw new Error(
     *  "Stripe did not return a Checkou* URL.",
      );
    }

    const *
      error: updateError,
    } =*await admin
      .from("job_reque*ts")
      .update({
        payme*t_status:
          "checkout_crea*ed",

        stripe_checkout_sess*on_id:
          session.id,

    *   stripe_connected_account_id:
  *       tutor.stripe_account_id,

 *      gross_amount_pence:
        * grossAmountPence,

        commis*ion_rate:
          COMMISSION_RAT*_PERCENT,

        commission_amou*t_pence:
          commissionAmoun*Pence,

        tutor_net_amount_p*nce:
          tutorNetAmountPence*

        payment_currency:
      *   "gbp",
      })
      .eq("id",*job.id)
      .eq("learner_id", us*r.id);

    if (updateError) {
   *  throw updateError;
    }

    re*urn json({
      url: session.url,*      reused: false,
    });
  } c*tch (error) {
    console.error(
 *    "create-checkout-session faile*:",
      error,
    );

    retur* json(
      {
        error:
    *     error instanceof Error
      *     ? error.message
            :*"Unexpected payment error.",
     *},
      500,
    );
  }
});
