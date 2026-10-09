impo*t "jsr:@supabase/functions-js/edge*runtime.d.ts";
import Stripe from *npm:stripe@^16.0.0";
import { crea*eClient } from "jsr:@supabase/supa*ase-js@2";

const stripeSecretKey *
  Deno.env.get("STRIPE_SECRET_KEY*);

const webhookSecret =
  Deno.e*v.get("STRIPE_WEBHOOK_SECRET");

c*nst supabaseUrl =
  Deno.env.get("*UPABASE_URL");

const serviceRoleK*y =
  Deno.env.get("SUPABASE_SERVI*E_ROLE_KEY");

if (
  !stripeSecre*Key ||
  !webhookSecret ||
  !supa*aseUrl ||
  !serviceRoleKey
) {
  *hrow new Error(
    "Missing Strip* or Supabase webhook secrets.",
  *;
}

const stripe = new Stripe(
  *tripeSecretKey,
  {
    httpClient*
      Stripe.createFetchHttpClien*(),
  },
);

const cryptoProvider *
  Stripe.createSubtleCryptoProvid*r();

const adminClient = createCl*ent(
  supabaseUrl,
  serviceRoleK*y,
  {
    auth: {
      persistSe*sion: false,
      autoRefreshToke*: false,
    },
  },
);

function *extId(
  value:
    | string
    |*{ id?: string }
    | null
    | u*defined,
): string | null {
  if (*ypeof value === "string") {
    re*urn value;
  }

  if (
    value &*
    typeof value === "object" &&
*   typeof value.id === "string"
  * {
    return value.id;
  }

  ret*rn null;
}

function metadataInteg*r(
  value: string | undefined,
):*number | null {
  if (!value) {
  * return null;
  }

  const parsed * Number(value);

  return Number.i*Integer(parsed)
    ? parsed
    :*null;
}

function metadataNumber(
* value: string | undefined,
): num*er | null {
  if (!value) {
    re*urn null;
  }

  const parsed = Nu*ber(value);

  return Number.isFin*te(parsed)
    ? parsed
    : null*
}

async function processComplete*Checkout(
  session: Stripe.Checko*t.Session,
): Promise<void> {
  co*st jobId =
    session.metadata?.j*b_id;

  const learnerId =
    ses*ion.metadata?.learner_id;

  if (!*obId) {
    throw new Error(
     *"Checkout Session is missing job_i* metadata.",
    );
  }

  if (!le*rnerId) {
    throw new Error(
   *  "Checkout Session is missing lea*ner_id metadata.",
    );
  }

  /*
    Checkout can send completion *efore an asynchronous
    payment *ethod is fully paid. ToolTutors cu*rently
    accepts cards, so paid *s expected, but the check
    rema*ns important.
  */
  if (session.p*yment_status !== "paid") {
    con*ole.log(
      "Checkout completed*without paid status:",
      sessi*n.id,
      session.payment_status*
    );

    return;
  }

  const *aymentIntentId =
    textId(sessio*.payment_intent);

  if (!paymentI*tentId) {
    throw new Error(
   *  "The paid Checkout Session has n* PaymentIntent.",
    );
  }

  /**    Retrieve the full PaymentInten* and latest Charge so
    the data*ase records Stripe's authoritative*routing
    and application-fee re*erences.
  */
  const paymentInten* =
    await stripe.paymentIntents*retrieve(
      paymentIntentId,
 *    {
        expand: [
          *latest_charge",
        ],
      }*
    );

  const latestCharge =
  * typeof paymentIntent.latest_charg* === "object"
      ? paymentInten*.latest_charge
      : null;

  co*st chargeId =
    textId(paymentIn*ent.latest_charge);

  let applica*ionFeeId: string | null =
    null*

  if (
    latestCharge &&
    "*pplication_fee" in latestCharge
  * {
    applicationFeeId =
      te*tId(
        latestCharge.applicat*on_fee as
          | string
     *    | { id?: string }
          | *ull,
      );
  }

  const grossAm*untPence =
    session.amount_tota* ??
    metadataInteger(
      ses*ion.metadata
        ?.gross_amoun*_pence,
    );

  const commission*mountPence =
    paymentIntent
   *  .application_fee_amount ??
    m*tadataInteger(
      session.metad*ta
        ?.commission_amount_pen*e,
    );

  const tutorNetAmountP*nce =
    metadataInteger(
      s*ssion.metadata
        ?.tutor_net*amount_pence,
    ) ??
    (
     *grossAmountPence !== null &&
     *commissionAmountPence !== null
   *    ? grossAmountPence -
         *commissionAmountPence
        : nu*l
    );

  const commissionRate =*    metadataNumber(
      session.*etadata
        ?.commission_rate,*    );

  const connectedAccountId*=
    textId(
      paymentIntent.*ransfer_data
        ?.destination*
    ) ||
    session.metadata
   *  ?.connected_account_id ||
    nu*l;

  const invoiceId =
    textId*session.invoice);

  let hostedInv*iceUrl: string | null =
    null;
*  let invoicePdf: string | null =
*   null;

  /*
    invoice_creatio* causes Stripe to attach an invoic*
    to the successful Checkout Se*sion. Retrieve it to
    save its *osted and PDF links.
  */
  if (in*oiceId) {
    try {
      const in*oice =
        await stripe.invoic*s.retrieve(
          invoiceId,
 *      );

      hostedInvoiceUrl =*        invoice.hosted_invoice_url*||
        null;

      invoicePdf*=
        invoice.invoice_pdf ||
 *      null;
    } catch (invoiceEr*or) {
      /*
        Payment pro*essing must not fail merely becaus*
        invoice retrieval is temporarily unavailable.
      */
      console.error(
        "Invoice retrieval failed:",
        invoiceError,
      );
    }
  }

  const updateData: Record<
    string,
    unknown
  > = {
    status: "scheduled",
    payment_status: "paid",

    stripe_checkout_session_id:
      session.id,

    stripe_payment_intent_id:
      paymentIntent.id,

    stripe_charge_id:
      chargeId,

    stripe_application_fee_id:
      applicationFeeId,

    stripe_connected_account_id:
      connectedAccountId,

    stripe_invoice_id:
      invoiceId,

    stripe_invoice_url:
      hostedInvoiceUrl,

    stripe_invoice_pdf:
      invoicePdf,

    gross_amount_pence:
      grossAmountPence,

    commission_rate:
      commissionRate,

    commission_amount_pence:
      commissionAmountPence,

    tutor_net_amount_pence:
      tutorNetAmountPence,

    payment_currency:
      session.currency ||
      paymentIntent.currency ||
      "gbp",

    /*
      Keep the existing field temporarily in case the
      existing interface still reads it.
    */
    amount_paid_pence:
      grossAmountPence,

    paid_at:
      new Date(
        session.created * 1000,
      ).toISOString(),

    payment_recorded_at:
      new Date().toISOString(),

    commission_document_status:
      "pending",
  };

  const {
    data: updatedJob,
    error: updateError,
  } = await adminClient
    .from("job_requests")
    .update(updateData)
    .eq("id", jobId)
    .eq("learner_id", learnerId)
    .select("id")
    .maybeSingle();

  if (updateError) {
    throw updateError;
  }

  if (!updatedJob) {
    throw new Error(
      "No matching Learner job was updated.",
    );
  }

  console.log(
    "Payment recorded successfully:",
    {
      eventJobId: jobId,
      checkoutSessionId:
        session.id,
      paymentIntentId:
        paymentIntent.id,
      chargeId,
      applicationFeeId,
      connectedAccountId,
      invoiceId,
    },
  );
}

async function processExpiredCheckout(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const jobId =
    session.metadata?.job_id;

  if (!jobId) {
    return;
  }

  const {
    error,
  } = await adminClient
    .from("job_requests")
    .update({
      payment_status: "expired",
    })
    .eq("id", jobId)
    .eq(
      "stripe_checkout_session_id",
      session.id,
    )
    .neq(
      "payment_status",
      "paid",
    );

  if (error) {
    throw error;
  }
}

Deno.serve(async (
  req: Request,
): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(
      "Method not allowed",
      {
        status: 405,
      },
    );
  }

  const signature =
    req.headers.get(
      "stripe-signature",
    );

  if (!signature) {
    return new Response(
      "Missing Stripe signature",
      {
        status: 400,
      },
    );
  }

  /*
    Signature verification requires the untouched raw
    request body. Do not parse JSON before this step.
  */
  const rawBody =
    await req.text();

  let event: Stripe.Event;

  try {
    event =
      await stripe.webhooks
        .constructEventAsync(
          rawBody,
          signature,
          webhookSecret,
          undefined,
          cryptoProvider,
        );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Invalid signature";

    console.error(
      "Webhook signature verification failed:",
      message,
    );

    return new Response(
      `Webhook Error: ${message}`,
      {
        status: 400,
      },
    );
  }

  try {
    /*
      Stripe can retry an event. These updates are
      deliberately idempotent: the same Stripe
      references overwrite the same job record rather
      than creating another payment row.
    */
    if (
      event.type ===
      "checkout.session.completed"
    ) {
      await processCompletedCheckout(
        event.data.object as
          Stripe.Checkout.Session,
      );
    }

    if (
      event.type ===
      "checkout.session.async_payment_succeeded"
    ) {
      await processCompletedCheckout(
        event.data.object as
          Stripe.Checkout.Session,
      );
    }

    if (
      event.type ===
      "checkout.session.expired"
    ) {
      await processExpiredCheckout(
        event.data.object as
          Stripe.Checkout.Session,
      );
    }

    return new Response(
      JSON.stringify({
        received: true,
        eventId: event.id,
        eventType: event.type,
      }),
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/json",
        },
      },
    );
  } catch (error) {
    console.error(
      "Webhook processing failed:",
      {
        eventId: event.id,
        eventType: event.type,
        error,
      },
    );

    return new Response(
      "Webhook processing failed",
      {
        status: 500,
      },
    );
  }
});
