// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Resend } = require('resend');
const Stripe = require('stripe');
const crypto = require('crypto');
const { plaidClient } = require('./plaidClient');

const app = express();

app.use(cors());

/*
  Stripe webhook must use the untouched raw request body.
  Keep this route above express.json().
*/
app.post(
  "/stripe-webhook",
  express.raw({
    type: "application/json"
  }),
  async (req, res) => {
    const stripe = getStripeClient();

    const webhookSecret =
      process.env.STRIPE_WEBHOOK_SECRET || "";

    const signature =
      req.headers["stripe-signature"];

    if (!stripe || !webhookSecret) {
      console.error(
        "Stripe webhook received before Stripe backend configuration."
      );

      return res.status(500).json({
        error: "Stripe webhook is not configured."
      });
    }

    if (!signature) {
      return res.status(400).json({
        error: "Missing Stripe webhook signature."
      });
    }

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        webhookSecret
      );
    } catch (error) {
      console.error(
        "Stripe webhook signature verification failed:",
        error.message
      );

      return res.status(400).json({
        error: "Invalid Stripe webhook signature."
      });
    }

    try {
      if (
        event.type ===
        "checkout.session.completed"
      ) {
        const checkoutSession =
          event.data.object;

        if (
          checkoutSession.mode !==
          "subscription"
        ) {
          return res.json({
            received: true
          });
        }

        const subscriptionId =
          stripeSubscriptionId(
            checkoutSession.subscription
          );

        if (!subscriptionId) {
          throw new Error(
            "Checkout completion did not include a subscription ID."
          );
        }

        const subscription =
          await stripe.subscriptions.retrieve(
            subscriptionId
          );

        const metadata = {
          ...(checkoutSession.metadata || {}),
          ...(subscription.metadata || {})
        };

        await upsertBillingSubscription({
          userId: metadata.user_id || "",

          customerId: stripeCustomerId(
            checkoutSession.customer ||
            subscription.customer
          ),

          subscriptionId,

          planKey:
            metadata.plan_key || "none",

          subscriptionStatus:
            subscription.status || "not_started",

          trialEndsAt:
            stripeUnixTimestampToIso(
              subscription.trial_end
            ),

          currentPeriodEndsAt:
            stripeUnixTimestampToIso(
              subscription.current_period_end
            ),

          priceId:
            subscription.items?.data?.[0]
              ?.price?.id || "",

          checkoutSessionId:
            checkoutSession.id || ""
        });

        console.log(
          "Checkout subscription recorded:",
          subscriptionId
        );
      }

      if (
        event.type ===
          "customer.subscription.created" ||
        event.type ===
          "customer.subscription.updated" ||
        event.type ===
          "customer.subscription.deleted"
      ) {
        const subscription =
          event.data.object;

        const metadata =
          subscription.metadata || {};

        await upsertBillingSubscription({
          userId: metadata.user_id || "",

          customerId: stripeCustomerId(
            subscription.customer
          ),

          subscriptionId:
            subscription.id || "",

          planKey:
            metadata.plan_key || "none",

          subscriptionStatus:
            subscription.status || "not_started",

          trialEndsAt:
            stripeUnixTimestampToIso(
              subscription.trial_end
            ),

          currentPeriodEndsAt:
            stripeUnixTimestampToIso(
              subscription.current_period_end
            ),

          priceId:
            subscription.items?.data?.[0]
              ?.price?.id || ""
        });

        console.log(
          "Subscription status recorded:",
          subscription.id,
          subscription.status
        );
      }

      return res.json({
        received: true
      });

    } catch (error) {
      console.error(
        "Stripe webhook processing error:",
        error
      );

      return res.status(500).json({
        error:
          "Unable to process Stripe webhook event."
      });
    }
  }
);
app.use(express.json());

// Connect to Supabase Postgres via DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});
const resend = new Resend(
  process.env.RESEND_API_KEY
);

let stripeClient = null;

function getStripeClient() {
  const secretKey =
    process.env.STRIPE_SECRET_KEY || "";

  if (!secretKey) {
    return null;
  }

  if (!stripeClient) {
    stripeClient = new Stripe(secretKey);
  }

  return stripeClient;
}

const PLAID_TOKEN_ENCRYPTION_PREFIX =
  "enc:v1:";
function stripeUnixTimestampToIso(value) {
  const timestamp = Number(value || 0);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  return new Date(
    timestamp * 1000
  ).toISOString();
}

function billingPlanKey(value) {
  return [
    "monthly",
    "annual"
  ].includes(value)
    ? value
    : "none";
}

function billingSubscriptionStatus(value) {
  /*
    These are the statuses currently used by the app's
    duplicate-subscription guard. Other provider states are
    safely treated as not started until expanded later.
  */
  return [
    "trialing",
    "active",
    "past_due"
  ].includes(value)
    ? value
    : "not_started";
}

function stripeCustomerId(value) {
  if (typeof value === "string") {
    return value;
  }

  return String(value?.id || "");
}

function stripeSubscriptionId(value) {
  if (typeof value === "string") {
    return value;
  }

  return String(value?.id || "");
}

async function upsertBillingSubscription({
  userId,
  customerId = "",
  subscriptionId = "",
  planKey = "none",
  subscriptionStatus = "not_started",
  trialEndsAt = null,
  currentPeriodEndsAt = null,
  priceId = "",
  checkoutSessionId = ""
}) {
  if (!userId) {
    throw new Error(
      "A billing event did not include a user ID."
    );
  }

  await pool.query(
    `
    insert into public.billing_subscriptions (
      user_id,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_price_id,
      stripe_checkout_session_id,
      plan_key,
      subscription_status,
      trial_ends_at,
      current_period_ends_at,
      military_discount_applied,
      updated_at
    )
    values (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      false, now()
    )
    on conflict (user_id)
    do update set
      stripe_customer_id =
        excluded.stripe_customer_id,
      stripe_subscription_id =
        excluded.stripe_subscription_id,
      stripe_price_id =
        excluded.stripe_price_id,
      stripe_checkout_session_id =
        coalesce(
          excluded.stripe_checkout_session_id,
          stripe_checkout_session_id
        ),
        plan_key =
        excluded.plan_key,
      subscription_status =
        excluded.subscription_status,
      trial_ends_at =
        excluded.trial_ends_at,
      current_period_ends_at =
        excluded.current_period_ends_at,
      updated_at = now()
    `,
    [
      userId,
      customerId || null,
      subscriptionId || null,
      priceId || null,
      checkoutSessionId || null,
      billingPlanKey(planKey),
      billingSubscriptionStatus(
        subscriptionStatus
      ),
      trialEndsAt,
      currentPeriodEndsAt
    ]
  );
}
function getPlaidTokenEncryptionKey() {
  const secret =
    process.env.PLAID_TOKEN_ENCRYPTION_KEY || "";

  if (secret.length < 32) {
    throw new Error(
      "PLAID_TOKEN_ENCRYPTION_KEY is missing or too short."
    );
  }

  return crypto
    .createHash("sha256")
    .update(secret, "utf8")
    .digest();
}

function encryptPlaidAccessToken(accessToken) {
  const token = String(accessToken || "");

  if (!token) {
    throw new Error(
      "Cannot encrypt an empty Plaid access token."
    );
  }

  if (token.startsWith(
    PLAID_TOKEN_ENCRYPTION_PREFIX
  )) {
    return token;
  }

  const key = getPlaidTokenEncryptionKey();

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    PLAID_TOKEN_ENCRYPTION_PREFIX.slice(0, -1),
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

function decryptPlaidAccessToken(storedToken) {
  const token = String(storedToken || "");

  if (!token) {
    throw new Error(
      "Plaid access token is missing."
    );
  }

  /*
    Temporary backward compatibility:
    existing tokens remain usable until the protected
    migration encrypts them.
  */
  if (!token.startsWith(
    PLAID_TOKEN_ENCRYPTION_PREFIX
  )) {
    return token;
  }

  const parts = token.split(":");

  if (parts.length !== 5) {
    throw new Error(
      "Stored Plaid access token format is invalid."
    );
  }

  const key = getPlaidTokenEncryptionKey();

  const iv = Buffer.from(
    parts[2],
    "base64url"
  );

  const authTag = Buffer.from(
    parts[3],
    "base64url"
  );

  const ciphertext = Buffer.from(
    parts[4],
    "base64url"
  );

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}
async function requireVerifiedTrackerMember(
  req,
  res,
  next
) {
  try {
    const authHeader =
      req.headers.authorization || "";

    const accessToken = authHeader
      .replace(/^Bearer\s+/i, "")
      .trim();

    if (!accessToken) {
      return res.status(401).json({
        error: "Missing authorization token",
      });
    }

    const trackerId =
      req.body?.tracker_id ||
      req.query?.tracker_id ||
      "";

    if (!trackerId) {
      return res.status(400).json({
        error: "tracker_id is required",
      });
    }

    if (
      !process.env.SUPABASE_URL ||
      !process.env.SUPABASE_PUBLISHABLE_KEY
    ) {
      return res.status(500).json({
        error:
          "Supabase authentication is not configured " +
          "on the backend.",
      });
    }

    const userResponse = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/user`,
      {
        method: "GET",
        headers: {
          "apikey":
            process.env.SUPABASE_PUBLISHABLE_KEY,
          "Authorization":
            `Bearer ${accessToken}`,
        },
      }
    );

    if (!userResponse.ok) {
      return res.status(401).json({
        error: "Invalid or expired authorization token",
      });
    }

    const user = await userResponse.json();

    if (!user?.id) {
      return res.status(401).json({
        error:
          "Authenticated user information was not returned.",
      });
    }

    const membershipResult = await pool.query(
      `
      select 1
      from public.tracker_members
      where tracker_id = $1
        and user_id = $2
      limit 1
      `,
      [
        trackerId,
        user.id,
      ]
    );

    if (!membershipResult.rows.length) {
      return res.status(403).json({
        error:
          "You do not have access to this tracker.",
      });
    }

    req.authenticatedUserId = user.id;
    req.authenticatedTrackerId = trackerId;

    next();

  } catch (error) {
    console.error(
      "Tracker authorization middleware error:",
      error
    );

    return res.status(500).json({
      error:
        "Unable to verify tracker authorization.",
    });
  }
}

function stripePlanConfig(planKey) {
  const plans = {
    monthly: {
      priceId:
        process.env.STRIPE_MONTHLY_PRICE_ID || ""
    },

    annual: {
      priceId:
        process.env.STRIPE_ANNUAL_PRICE_ID || ""
    }
  };

  return plans[planKey] || null;
}

app.post(
  "/create-subscription-checkout",
  requireVerifiedTrackerMember,
  async (req, res) => {
    try {
      const stripe = getStripeClient();

      if (!stripe) {
        return res.status(503).json({
          error:
            "Stripe billing is not configured on the backend."
        });
      }

      const {
        tracker_id,
        plan_key
      } = req.body;

      const plan = stripePlanConfig(plan_key);

      if (!plan?.priceId) {
        return res.status(400).json({
          error:
            "Choose a valid monthly or annual subscription plan."
        });
      }

      const appBaseUrl = String(
        process.env.APP_BASE_URL || ""
      )
        .trim()
        .replace(/\/+$/, "");

      if (!/^https:\/\//i.test(appBaseUrl)) {
        return res.status(500).json({
          error:
            "The application return URL is not configured."
        });
      }

      /*
        Do not create duplicate trialing or active subscriptions.
        Subscription management will be added later for existing users.
      */
      const { rows: existingSubscriptions } =
        await pool.query(
          `
          select subscription_status
          from public.billing_subscriptions
          where user_id = $1
          limit 1
          `,
          [req.authenticatedUserId]
        );

      const existingStatus =
        existingSubscriptions[0]?.subscription_status;

      if (
        [
          "trialing",
          "active",
          "past_due"
        ].includes(existingStatus)
      ) {
        return res.status(409).json({
          error:
            "An active subscription already exists for this account."
        });
      }

      const checkoutSession =
        await stripe.checkout.sessions.create({
          mode: "subscription",

          line_items: [
            {
              price: plan.priceId,
              quantity: 1
            }
          ],

  /*
  Checkout displays the promo-code field during secure
  payment setup. The payment provider validates submitted
  promotion codes—not the browser app.
*/
          allow_promotion_codes: true,

          /*
            Collect payment details during the trial so the
            subscription can continue after the seven-day trial.
          */
          payment_method_collection: "always",

          subscription_data: {
            trial_period_days: 7,

            metadata: {
              user_id:
                req.authenticatedUserId,

              tracker_id:
                tracker_id,

              plan_key:
                plan_key
            }
          },

          metadata: {
            user_id:
              req.authenticatedUserId,

            tracker_id:
              tracker_id,

            plan_key:
              plan_key
          },

          success_url:
            `${appBaseUrl}/?checkout=success&session_id=` +
            `{CHECKOUT_SESSION_ID}`,

          cancel_url:
            `${appBaseUrl}/?checkout=canceled`
        });

      return res.json({
        checkout_url: checkoutSession.url
      });

    } catch (error) {
      console.error(
        "Create Stripe Checkout session error:",
        error
      );

      return res.status(500).json({
        error:
          "Unable to start secure subscription checkout."
      });
    }
  }
);

// Health check
app.get('/', (req, res) => {
  res.json({ ok: true });
});

// Simple ping route to confirm frontend can reach backend
app.get('/ping', (req, res) => {
  console.log('PING endpoint hit');
  res.json({ ok: true, message: 'Backend reachable' });
});
// Notification configuration check
app.get('/notification-config', (req, res) => {
  const resendConfigured =
    !!process.env.RESEND_API_KEY;

  const senderConfigured =
    !!process.env.RESEND_FROM_EMAIL;

  const jobSecretConfigured =
    !!process.env.NOTIFICATION_JOB_SECRET;

  return res.json({
    ok: true,
    resend_configured: resendConfigured,
    sender_configured: senderConfigured,
    notification_job_secret_configured:
      jobSecretConfigured,
  });
});

// Send a protected test email through Resend
app.post('/send-test-notification-email', async (req, res) => {
  const jobSecret =
    req.headers['x-notification-job-secret'];

  if (
    !jobSecret ||
    jobSecret !== process.env.NOTIFICATION_JOB_SECRET
  ) {
    return res.status(401).json({
      error: 'Unauthorized notification job request',
    });
  }

  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      error: 'email is required',
    });
  }

  try {
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: [email],
      subject: 'Deadbeat Tracker — Email Notification Test',
      html: `
        <h2>Deadbeat Tracker Email Test</h2>
        <p>
          Your Resend email notification configuration is working.
        </p>
        <p>
          Minimum-payment alerts will be sent from this address
          after the scheduled notification job is added.
        </p>
      `,
    });

    if (error) {
      console.error('Resend test email error:', error);

      return res.status(500).json({
        error: 'Resend failed to send the test email',
        details: error,
      });
    }

    return res.json({
      success: true,
      message: 'Test email sent',
      resend_id: data?.id || null,
    });

  } catch (err) {
    console.error('send-test-notification-email error:', err);

    return res.status(500).json({
      error: 'Unexpected test-email failure',
      details: err.message || String(err),
    });
  }
});
// Trace route to help debugging connectivity
app.get('/trace', (req, res) => {
  console.log('TRACE endpoint hit');
  res.json({
    ok: true,
    message: 'Trace endpoint reached',
    time: new Date().toISOString(),
    host: req.headers.host || null,
    userAgent: req.headers['user-agent'] || null,
  });
});

// Map a credit card to a linked bank account
app.post(
  '/card-plaid-mapping',
  requireVerifiedTrackerMember,
  async (req, res) => {
  console.log('CARD-PLAID-MAPPING endpoint hit');

  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace('Bearer ', '').trim();
  if (!jwt) {
    console.log('CARD-PLAID-MAPPING missing JWT');
    return res.status(401).json({ error: 'Missing JWT' });
  }

  const { tracker_id, card_id, linked_account_id } = req.body;
  if (!tracker_id || !card_id || !linked_account_id) {
    console.log('CARD-PLAID-MAPPING missing fields', {
      trackerIdPresent: !!tracker_id,
      cardIdPresent: !!card_id,
      linkedAccountIdPresent: !!linked_account_id,
    });
    return res.status(400).json({ error: 'tracker_id, card_id, and linked_account_id are required' });
  }

  const client = await pool.connect();
  try {
    console.log('CARD-PLAID-MAPPING: upserting for card_id', card_id, 'linked_account_id', linked_account_id);

    // Strategy: one mapping per card.
    // If a card already has a mapping, update it to the new linked_account_id.
    await client.query(
      `
      insert into public.card_plaid_mappings (tracker_id, card_id, linked_account_id)
      values ($1, $2, $3)
      on conflict (card_id) do update set
        tracker_id = excluded.tracker_id,
        linked_account_id = excluded.linked_account_id
      `,
      [tracker_id, card_id, linked_account_id],
    );

    console.log('CARD-PLAID-MAPPING: success for card_id', card_id);
    return res.json({ success: true });
  } catch (err) {
    console.error('card-plaid-mapping error FULL:', err);
    return res.status(500).json({
      error: 'Failed to save card mapping',
      details: err.message || String(err),
    });
  } finally {
    client.release();
  }
});

// Get card → linked account mappings for a tracker
app.get(
  '/card-plaid-mappings',
  requireVerifiedTrackerMember,
  async (req, res) => {
  console.log('CARD-PLAID-MAPPINGS endpoint hit');

  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace('Bearer ', '').trim();
  if (!jwt) {
    console.log('CARD-PLAID-MAPPINGS missing JWT');
    return res.status(401).json({ error: 'Missing JWT' });
  }

  const { tracker_id } = req.query;
  if (!tracker_id) {
    console.log('CARD-PLAID-MAPPINGS missing tracker_id');
    return res.status(400).json({ error: 'tracker_id is required' });
  }

  const client = await pool.connect();
  try {
    console.log('CARD-PLAID-MAPPINGS: fetching for tracker_id', tracker_id);

    const { rows } = await client.query(
      `
      select
        id,
        tracker_id,
        card_id,
        linked_account_id,
        created_at
      from public.card_plaid_mappings
      where tracker_id = $1
      `,
      [tracker_id],
    );

    console.log('CARD-PLAID-MAPPINGS: found', rows.length, 'mappings');
    return res.json({ mappings: rows });
  } catch (err) {
    console.error('card-plaid-mappings error FULL:', err);
    return res.status(500).json({
      error: 'Failed to fetch card mappings',
      details: err.message || String(err),
    });
  } finally {
    client.release();
  }
});

// Create a Plaid Link token
app.post(
  '/create-link-token',
  requireVerifiedTrackerMember,
  async (req, res) => {
  console.log('CREATE-LINK-TOKEN endpoint hit');

  try {
    const authHeader = req.headers.authorization || '';
    const jwt = authHeader.replace('Bearer ', '').trim();

    if (!jwt) {
      console.log('CREATE-LINK-TOKEN missing JWT');
      return res.status(401).json({ error: 'Missing JWT' });
    }

    const { tracker_id } = req.body;
    if (!tracker_id) {
      console.log('CREATE-LINK-TOKEN missing tracker_id');
      return res.status(400).json({ error: 'tracker_id is required' });
    }

    console.log('CREATE-LINK-TOKEN for tracker_id:', tracker_id);

    const request = {
      user: { client_user_id: tracker_id },
      client_name: 'Deadbeat Tracker',
      products: ['auth', 'transactions'],
      country_codes: ['US'],
      language: 'en',
    };

    const response = await plaidClient.linkTokenCreate(request);
    console.log('CREATE-LINK-TOKEN success');

    return res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('create-link-token error FULL:', err);
    if (err.response && err.response.data) {
      console.error('create-link-token error RESPONSE DATA:', err.response.data);
    }
    return res.status(500).json({
      error: 'Failed to create link token',
      details: err.response?.data || err.message || String(err),
    });
  }
});

// Exchange public_token and store accounts
app.post(
  '/exchange-public-token',
  requireVerifiedTrackerMember,
  async (req, res) => {
  console.log('EXCHANGE-PUBLIC-TOKEN endpoint hit');

  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace('Bearer ', '').trim();
  if (!jwt) {
    console.log('EXCHANGE-PUBLIC-TOKEN missing JWT');
    return res.status(401).json({ error: 'Missing JWT' });
  }

  const { public_token, tracker_id } = req.body;
  if (!public_token || !tracker_id) {
    console.log('EXCHANGE-PUBLIC-TOKEN missing fields', {
      publicTokenPresent: !!public_token,
      trackerIdPresent: !!tracker_id,
    });
    return res.status(400).json({ error: 'public_token and tracker_id are required' });
  }

  console.log('EXCHANGE-PUBLIC-TOKEN for tracker_id:', tracker_id);

  const client = await pool.connect();
  try {
    console.log('EXCHANGE-PUBLIC-TOKEN: calling itemPublicTokenExchange');
    const tokenResponse = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = tokenResponse.data.access_token;
    const item_id = tokenResponse.data.item_id;
    console.log('EXCHANGE-PUBLIC-TOKEN: got item_id', item_id);

    console.log('EXCHANGE-PUBLIC-TOKEN: upserting into plaid_items');
    await client.query(
      `
      insert into public.plaid_items (tracker_id, plaid_item_id, access_token)
      values ($1, $2, $3)
      on conflict (plaid_item_id) do update set access_token = excluded.access_token
      `,
[
  tracker_id,
  item_id,
  encryptPlaidAccessToken(access_token),
],
    );

    console.log('EXCHANGE-PUBLIC-TOKEN: calling accountsGet');
    const accountsResponse = await plaidClient.accountsGet({ access_token });
    const { accounts } = accountsResponse.data;
    console.log('EXCHANGE-PUBLIC-TOKEN: received', accounts.length, 'accounts');

    console.log('EXCHANGE-PUBLIC-TOKEN: upserting into linked_accounts');
    for (const acct of accounts) {
      const {
        account_id,
        name,
        mask,
        official_name,
        subtype,
        type,
        balances,
      } = acct;

      const current_balance = balances.current;
      const available_balance = balances.available;

      await client.query(
        `
        insert into public.linked_accounts (
          tracker_id,
          plaid_item_id,
          plaid_account_id,
          institution_name,
          plaid_account_name,
          plaid_account_mask,
          plaid_account_type,
          plaid_account_subtype,
          current_balance,
          available_balance
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (plaid_account_id) do update set
          institution_name = excluded.institution_name,
          plaid_account_name = excluded.plaid_account_name,
          plaid_account_mask = excluded.plaid_account_mask,
          plaid_account_type = excluded.plaid_account_type,
          plaid_account_subtype = excluded.plaid_account_subtype,
          current_balance = excluded.current_balance,
          available_balance = excluded.available_balance
        `,
        [
          tracker_id,
          item_id,
          account_id,
          official_name || name || null,
          name || official_name || 'Account',
          mask || null,
          type || null,
          subtype || null,
          current_balance,
          available_balance,
        ],
      );
    }

    console.log('EXCHANGE-PUBLIC-TOKEN: success for tracker_id', tracker_id);
    return res.json({ success: true });
  } catch (err) {
    console.error('exchange-public-token error FULL:', err);
    if (err.response && err.response.data) {
      console.error('exchange-public-token error RESPONSE DATA:', err.response.data);
    }
    return res.status(500).json({
      error: 'Failed to exchange public token',
      details: err.response?.data || err.message || String(err),
    });
  } finally {
    client.release();
  }
});

// Get linked accounts for a tracker
app.get(
  '/linked-accounts',
  requireVerifiedTrackerMember,
  async (req, res) => {
  console.log('LINKED-ACCOUNTS endpoint hit');

  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace('Bearer ', '').trim();
  if (!jwt) {
    console.log('LINKED-ACCOUNTS missing JWT');
    return res.status(401).json({ error: 'Missing JWT' });
  }

  const { tracker_id } = req.query;
  if (!tracker_id) {
    console.log('LINKED-ACCOUNTS missing tracker_id');
    return res.status(400).json({ error: 'tracker_id is required' });
  }

  console.log('LINKED-ACCOUNTS for tracker_id:', tracker_id);

  try {
    const { rows } = await pool.query(
      `
      select
        id,
        tracker_id,
        plaid_item_id,
        plaid_account_id,
        institution_name,
        plaid_account_name,
        plaid_account_mask,
        plaid_account_type,
        plaid_account_subtype,
        current_balance,
        available_balance
      from public.linked_accounts
      where tracker_id = $1
      order by institution_name, plaid_account_name
      `,
      [tracker_id],
    );

    console.log('LINKED-ACCOUNTS: found', rows.length, 'accounts');
    return res.json({ accounts: rows });
  } catch (err) {
    console.error('linked-accounts error FULL:', err);
    return res.status(500).json({
      error: 'Failed to fetch linked accounts',
      details: err.message || String(err),
    });
  }
});
// Unlink one linked Plaid account from a tracker
app.post(
  '/unlink-account',
  requireVerifiedTrackerMember,
  async (req, res) => {
  console.log('UNLINK-ACCOUNT endpoint hit');

  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace('Bearer ', '').trim();

  if (!jwt) {
    console.log('UNLINK-ACCOUNT missing JWT');
    return res.status(401).json({ error: 'Missing JWT' });
  }

  const { tracker_id, linked_account_id } = req.body;

  if (!tracker_id || !linked_account_id) {
    console.log('UNLINK-ACCOUNT missing fields', {
      trackerIdPresent: !!tracker_id,
      linkedAccountIdPresent: !!linked_account_id,
    });

    return res.status(400).json({
      error: 'tracker_id and linked_account_id are required',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const accountResult = await client.query(
      `
      select
        id,
        tracker_id,
        plaid_item_id,
        plaid_account_id,
        institution_name,
        plaid_account_name,
        plaid_account_mask
      from public.linked_accounts
      where id = $1
        and tracker_id = $2
      for update
      `,
      [linked_account_id, tracker_id],
    );

    if (!accountResult.rows.length) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'Linked Plaid account not found for this tracker',
      });
    }

    const linkedAccount = accountResult.rows[0];

    // Remove any card → Plaid account mappings first.
    // This prevents stale mappings from referencing the removed account.
    await client.query(
      `
      delete from public.card_plaid_mappings
      where tracker_id = $1
        and linked_account_id = $2
      `,
      [tracker_id, linked_account_id],
    );

    // Remove the linked account from this tracker.
    await client.query(
      `
      delete from public.linked_accounts
      where id = $1
        and tracker_id = $2
      `,
      [linked_account_id, tracker_id],
    );

    await client.query('COMMIT');

    console.log(
      'UNLINK-ACCOUNT success:',
      linkedAccount.institution_name,
      linkedAccount.plaid_account_name,
    );

    return res.json({
      success: true,
      unlinked_account_id: linked_account_id,
      account: {
        institution_name: linkedAccount.institution_name,
        plaid_account_name: linkedAccount.plaid_account_name,
        plaid_account_mask: linkedAccount.plaid_account_mask,
      },
    });

  } catch (err) {
    await client.query('ROLLBACK');

    console.error('unlink-account error FULL:', err);

    return res.status(500).json({
      error: 'Failed to unlink linked Plaid account',
      details: err.message || String(err),
    });

  } finally {
    client.release();
  }
});
function getTimeZoneParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);

  const values = {};

  parts.forEach(part => {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  });

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function shiftCalendarDate(dateParts, daysToShift) {
  const date = new Date(
    Date.UTC(
      dateParts.year,
      dateParts.month - 1,
      dateParts.day + daysToShift
    )
  );

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function getDaysInMonth(year, month) {
  return new Date(
    Date.UTC(year, month, 0)
  ).getUTCDate();
}

function formatDateKey(dateParts) {
  return [
    String(dateParts.year).padStart(4, "0"),
    String(dateParts.month).padStart(2, "0"),
    String(dateParts.day).padStart(2, "0"),
  ].join("-");
}

function compareCalendarDates(left, right) {
  const leftKey = formatDateKey(left);
  const rightKey = formatDateKey(right);

  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;

  return 0;
}

function formatAlertDate(dateParts) {
  const date = new Date(
    Date.UTC(
      dateParts.year,
      dateParts.month - 1,
      dateParts.day
    )
  );

  return date.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatEmailMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value || 0));
}

function getPaymentCycleDates(localNow, dueDay) {
  const safeDueDay = Math.min(
    Math.max(Number(dueDay || 1), 1),
    getDaysInMonth(localNow.year, localNow.month)
  );

  const dueDate = {
    year: localNow.year,
    month: localNow.month,
    day: safeDueDay,
  };

  const previousDueDate = shiftCalendarDate(
    dueDate,
    -Math.max(
      28,
      getDaysInMonth(
        dueDate.month === 1
          ? dueDate.year - 1
          : dueDate.year,
        dueDate.month === 1
          ? 12
          : dueDate.month - 1
      )
    )
  );

  const trackerDeadline = shiftCalendarDate(
    dueDate,
    -3
  );

  const finalReminderDate = shiftCalendarDate(
    dueDate,
    -1
  );

  return {
    dueDate,
    previousDueDate,
    trackerDeadline,
    finalReminderDate,
  };
}

async function writeNotificationLog({
  trackerId,
  cardId,
  userId,
  dueDate,
  alertType,
  amountDue,
  recipientEmail,
  deliveryStatus,
  providerMessageId = null,
  errorMessage = null,
}) {
  await pool.query(
    `
    insert into public.minimum_payment_notifications (
      tracker_id,
      card_id,
      user_id,
      due_date,
      alert_type,
      amount_due,
      recipient_email,
      sent_at,
      delivery_status,
      provider_message_id,
      error_message
    )
    values (
      $1, $2, $3, $4, $5, $6, $7,
      case when $8 = 'sent' then now() else null end,
      $8, $9, $10
    )
    on conflict (
      tracker_id,
      card_id,
      user_id,
      due_date,
      alert_type
    )
    do update set
      amount_due = excluded.amount_due,
      recipient_email = excluded.recipient_email,
      sent_at = case
        when excluded.delivery_status = 'sent'
        then now()
        else public.minimum_payment_notifications.sent_at
      end,
      delivery_status = excluded.delivery_status,
      provider_message_id = excluded.provider_message_id,
      error_message = excluded.error_message
    `,
    [
      trackerId,
      cardId,
      userId,
      dueDate,
      alertType,
      amountDue,
      recipientEmail,
      deliveryStatus,
      providerMessageId,
      errorMessage,
    ]
  );
}

// Protected notification-processing route.
// This will be called later by a Render Cron Job.
app.post('/run-minimum-payment-notifications', async (req, res) => {
  const jobSecret =
    req.headers['x-notification-job-secret'];

  if (
    !jobSecret ||
    jobSecret !== process.env.NOTIFICATION_JOB_SECRET
  ) {
    return res.status(401).json({
      error: 'Unauthorized notification job request',
    });
  }

  if (
    !process.env.RESEND_API_KEY ||
    !process.env.RESEND_FROM_EMAIL
  ) {
    return res.status(500).json({
      error: 'Resend notification configuration is incomplete',
    });
  }

  const now = new Date();

  const summary = {
    processed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  try {
    const { rows: preferences } = await pool.query(
      `
      select
        np.tracker_id,
        np.user_id,
        np.email_address,
        np.timezone,
        c.id as card_id,
c.name as card_name,
c.minimum_payment,
c.due_day,
c.starting_balance
      from public.notification_preferences np
      join public.cards c
        on c.tracker_id = np.tracker_id
      where np.email_enabled = true
        and c.minimum_payment > 0
        and c.due_day is not null
      `
    );

    for (const preference of preferences) {
      summary.processed += 1;
      const { rows: balanceRows } =
        await pool.query(
          `
          select greatest(
            0,
            $3::numeric +
            coalesce(
              sum(
                case
                  when entry.entry_type = 'expense'
                    and not (
                      coalesce(
                        entry.is_auto_late_fee,
                        false
                      )
                      and coalesce(
                        entry.late_fee_canceled,
                        false
                      )
                    )
                  then coalesce(entry.amount, 0)

                  when entry.entry_type = 'payment'
                  then -coalesce(entry.amount, 0)

                  else 0
                end
              ),
              0
            )
          ) as current_balance

          from public.entries as entry

          where entry.tracker_id = $1
            and entry.card_id = $2
          `,
          [
            preference.tracker_id,
            preference.card_id,
            Number(preference.starting_balance || 0),
          ]
        );

      const currentBalance = Number(
        balanceRows[0]?.current_balance || 0
      );

      if (currentBalance <= 0) {
        summary.skipped += 1;

        summary.details.push({
          card: preference.card_name,
          status: "skipped",
          reason: "No card balance due",
        });

        continue;
      }
      const timezone =
        preference.timezone || "UTC";

      const localNow = getTimeZoneParts(
        now,
        timezone
      );

      const cycle = getPaymentCycleDates(
        localNow,
        preference.due_day
      );

      const dueDateKey = formatDateKey(
        cycle.dueDate
      );

      const previousDueDateKey = formatDateKey(
        cycle.previousDueDate
      );

      const { rows: paymentRows } = await pool.query(
        `
        select amount
        from public.entries
        where tracker_id = $1
          and card_id = $2
          and entry_type = 'payment'
          and entry_date >= $3
          and entry_date <= $4
        `,
        [
          preference.tracker_id,
          preference.card_id,
          previousDueDateKey,
          dueDateKey,
        ]
      );

      const paymentsRecorded = paymentRows.reduce(
        (sum, row) => sum + Number(row.amount || 0),
        0
      );

      const amountDue = Math.max(
        0,
        Number(preference.minimum_payment || 0) -
        paymentsRecorded
      );

      if (amountDue <= 0) {
        summary.skipped += 1;
        continue;
      }
const { rows: canceledLateFeeRows } =
  await pool.query(
    `
    select id
    from public.entries
    where tracker_id = $1
      and card_id = $2
      and is_auto_late_fee = true
      and late_fee_due_date = $3
      and late_fee_canceled = true
    limit 1
    `,
    [
      preference.tracker_id,
      preference.card_id,
      dueDateKey,
    ]
  );

if (canceledLateFeeRows.length) {
  summary.skipped += 1;

  summary.details.push({
    card: preference.card_name,
    status: "skipped",
    reason:
      "Late fee canceled for this payment cycle",
  });

  continue;
}
      const localDate = {
        year: localNow.year,
        month: localNow.month,
        day: localNow.day,
      };

      const redConditionReached =
        compareCalendarDates(
          localDate,
          cycle.trackerDeadline
        ) >= 0;

      const finalReminderWindow =
        compareCalendarDates(
          localDate,
          cycle.finalReminderDate
        ) === 0 &&
        localNow.hour === 8 &&
        localNow.minute < 30;

      let alertType = null;
      let subject = null;
      let heading = null;
      let message = null;

      if (redConditionReached) {
        alertType = 'red_condition';

        subject =
          `Payment Required — ${preference.card_name}`;

        heading =
          'Minimum Payment Required';

                message =
          `A minimum payment of ${formatEmailMoney(amountDue)} ` +
          `is due by ${formatAlertDate(cycle.dueDate)}.`;
      }

      if (finalReminderWindow) {
        alertType = 'final_8am_reminder';

        subject =
          `Final Payment Reminder — ${preference.card_name}`;

        heading =
          'Payment Due Tomorrow';

        message =
          `A minimum payment of ${formatEmailMoney(amountDue)} ` +
          `remains due before the card due date of ` +
          `${formatAlertDate(cycle.dueDate)}.`;
      }

      if (!alertType) {
        summary.skipped += 1;
        continue;
      }

      const { rows: existingNotifications } =
        await pool.query(
          `
          select id, delivery_status
          from public.minimum_payment_notifications
          where tracker_id = $1
            and card_id = $2
            and user_id = $3
            and due_date = $4
            and alert_type = $5
          limit 1
          `,
          [
            preference.tracker_id,
            preference.card_id,
            preference.user_id,
            dueDateKey,
            alertType,
          ]
        );

      if (
        existingNotifications.length &&
        existingNotifications[0].delivery_status === 'sent'
      ) {
        summary.skipped += 1;
        continue;
      }

      try {
        const { data, error } = await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL,
          to: [preference.email_address],
          subject,
          html: `
            <h2>${heading}</h2>
            <p>${message}</p>
            <p><b>Card:</b> ${preference.card_name}</p>
            
            <p>
              Please verify the payment amount and due date
              against the card issuer statement.
            </p>
          `,
        });

        if (error) {
          throw new Error(
            error.message ||
            'Resend did not send the notification'
          );
        }

        await writeNotificationLog({
          trackerId: preference.tracker_id,
          cardId: preference.card_id,
          userId: preference.user_id,
          dueDate: dueDateKey,
          alertType,
          amountDue,
          recipientEmail: preference.email_address,
          deliveryStatus: 'sent',
          providerMessageId: data?.id || null,
        });

        summary.sent += 1;

        summary.details.push({
          card: preference.card_name,
          alert_type: alertType,
          status: 'sent',
        });

      } catch (emailError) {
        await writeNotificationLog({
          trackerId: preference.tracker_id,
          cardId: preference.card_id,
          userId: preference.user_id,
          dueDate: dueDateKey,
          alertType,
          amountDue,
          recipientEmail: preference.email_address,
          deliveryStatus: 'failed',
          errorMessage:
            emailError.message || String(emailError),
        });

        summary.failed += 1;

        summary.details.push({
          card: preference.card_name,
          alert_type: alertType,
          status: 'failed',
          error:
            emailError.message || String(emailError),
        });
      }
    }

    return res.json({
      success: true,
      summary,
    });

  } catch (error) {
    console.error(
      'run-minimum-payment-notifications error:',
      error
    );

    return res.status(500).json({
      error:
        'Failed to process minimum-payment notifications',
      details: error.message || String(error),
    });
  }
});
// ============================================================
// BACKEND BUILD 1.1 — PLAID TRANSACTION SYNC AND RECURRING
// TRANSFER BANK MATCHING
// ============================================================

function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function currentUtcCompletionMonth() {
  return `${utcDateKey(new Date()).slice(0, 7)}-01`;
}

function scheduledDateForCurrentMonth(chargeDay) {
  const now = new Date();

  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();

  const lastDayOfMonth = new Date(
    Date.UTC(year, monthIndex + 1, 0)
  ).getUTCDate();

  const safeDay = Math.min(
    Math.max(Number(chargeDay || 1), 1),
    lastDayOfMonth
  );

  return new Date(
    Date.UTC(year, monthIndex, safeDay)
  );
}

function addUtcDays(date, days) {
  const nextDate = new Date(date.getTime());

  nextDate.setUTCDate(
    nextDate.getUTCDate() + days
  );

  return nextDate;
}

async function storePlaidTransaction(
  trackerId,
  plaidItemId,
  transaction
) {
  await pool.query(
    `
    insert into public.plaid_transactions (
      tracker_id,
      plaid_item_id,
      plaid_account_id,
      plaid_transaction_id,
      pending_transaction_id,
      transaction_date,
      authorized_date,
      name,
      merchant_name,
      amount,
      iso_currency_code,
      pending,
      raw_transaction,
      updated_at
    )
    values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      $10, $11, $12, $13::jsonb, now()
    )
    on conflict (plaid_transaction_id)
    do update set
      tracker_id = excluded.tracker_id,
      plaid_item_id = excluded.plaid_item_id,
      plaid_account_id = excluded.plaid_account_id,
      pending_transaction_id =
        excluded.pending_transaction_id,
      transaction_date = excluded.transaction_date,
      authorized_date = excluded.authorized_date,
      name = excluded.name,
      merchant_name = excluded.merchant_name,
      amount = excluded.amount,
      iso_currency_code = excluded.iso_currency_code,
      pending = excluded.pending,
      raw_transaction = excluded.raw_transaction,
      updated_at = now()
    `,
    [
      trackerId,
      plaidItemId,
      transaction.account_id,
      transaction.transaction_id,
      transaction.pending_transaction_id || null,
      transaction.date || null,
      transaction.authorized_date || null,
      transaction.name || null,
      transaction.merchant_name || null,
      Number(transaction.amount || 0),
      transaction.iso_currency_code || null,
      transaction.pending === true,
      JSON.stringify(transaction),
    ]
  );
}

async function removePlaidTransaction(
  plaidTransactionId
) {
  if (!plaidTransactionId) return;

  await pool.query(
    `
    delete from public.plaid_transactions
    where plaid_transaction_id = $1
    `,
    [plaidTransactionId]
  );
}

async function syncPlaidItemTransactions(item) {
let cursor = item.transactions_cursor || null;
let hasMore = true;

const accessToken =
  decryptPlaidAccessToken(
    item.access_token
  );

  let pagesProcessed = 0;
  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;

  while (hasMore) {
    const request = {
      access_token: accessToken,
    };

    if (cursor) {
      request.cursor = cursor;
    }

    const response =
      await plaidClient.transactionsSync(request);

    const data = response.data;

    const added = data.added || [];
    const modified = data.modified || [];
    const removed = data.removed || [];

    for (const transaction of added) {
      await storePlaidTransaction(
        item.tracker_id,
        item.plaid_item_id,
        transaction
      );

      addedCount += 1;
    }

    for (const transaction of modified) {
      await storePlaidTransaction(
        item.tracker_id,
        item.plaid_item_id,
        transaction
      );

      modifiedCount += 1;
    }

    for (const removedTransaction of removed) {
      await removePlaidTransaction(
        removedTransaction.transaction_id
      );

      removedCount += 1;
    }

    cursor = data.next_cursor;
    hasMore = data.has_more === true;
    pagesProcessed += 1;
  }

  await pool.query(
    `
    update public.plaid_items
    set
      transactions_cursor = $2,
      transactions_sync_initialized_at =
        coalesce(
          transactions_sync_initialized_at,
          now()
        ),
      transactions_last_synced_at = now(),
      transactions_sync_error = null
    where plaid_item_id = $1
    `,
    [
      item.plaid_item_id,
      cursor,
    ]
  );

  return {
    pages_processed: pagesProcessed,
    added: addedCount,
    modified: modifiedCount,
    removed: removedCount,
  };
}

async function recordPlaidSyncFailure(
  plaidItemId,
  error
) {
  await pool.query(
    `
    update public.plaid_items
    set transactions_sync_error = $2
    where plaid_item_id = $1
    `,
    [
      plaidItemId,
      error?.message || String(error),
    ]
  );
}

async function matchRecurringTransfersFromBank() {
  const today = new Date();

  const todayKey = utcDateKey(today);

  const completionMonth =
    currentUtcCompletionMonth();

  /*
    A bank-linked recurring transfer is eligible only when:
    - it is active;
    - bank matching is explicitly enabled;
    - it is mapped to a locally saved Plaid-backed bank account;
    - it has not already been completed this calendar month.
  */
  const { rows: recurringTransfers } =
    await pool.query(
      `
      select
        recurring.id as recurring_charge_id,
        recurring.tracker_id,
        recurring.card_id,
        recurring.amount as recurring_amount,
        recurring.charge_day,
        recurring.bank_match_description,

        linked.plaid_account_id

      from public.card_recurring_charges as recurring

      join public.bank_accounts as bank
        on bank.id = recurring.bank_account_id

      join public.linked_accounts as linked
        on linked.id::text =
          bank.plaid_linked_account_id

      left join public.recurring_transfer_completions
        as completion
        on completion.recurring_charge_id =
             recurring.id
        and completion.completion_month = $1

      where recurring.active is distinct from false
        and recurring.bank_match_enabled = true
        and recurring.bank_account_id is not null
        and completion.id is null
      `,
      [completionMonth]
    );

  const summary = {
    eligible: recurringTransfers.length,
    matched: 0,
    skipped_not_due: 0,
    skipped_outside_window: 0,
    skipped_ambiguous: 0,
    skipped_no_match: 0,
    errors: [],
  };

  for (const recurring of recurringTransfers) {
    try {
      const scheduledDate =
        scheduledDateForCurrentMonth(
          recurring.charge_day
        );

      const scheduledDateKey =
        utcDateKey(scheduledDate);

      /*
        Do not evaluate a transfer until the day after its
        scheduled date. This matches the app's green-to-amber
        behavior.
      */
      if (todayKey <= scheduledDateKey) {
        summary.skipped_not_due += 1;
        continue;
      }

      /*
        To avoid incorrectly confirming an older unrelated
        transaction, consider only the scheduled date through
        five days afterward.
      */
      const latestMatchDate = addUtcDays(
        scheduledDate,
        5
      );

      const latestMatchDateKey = utcDateKey(
        latestMatchDate
      );

      if (todayKey > latestMatchDateKey) {
        summary.skipped_outside_window += 1;
        continue;
      }

      const description = String(
        recurring.bank_match_description || ""
      ).trim();

      /*
        A high-confidence candidate must:
        - come from the selected Plaid account;
        - be posted, not pending;
        - fall in the allowed date window;
        - match the amount to the cent;
        - match optional description text, if supplied.
      */
      const { rows: candidates } =
        await pool.query(
          `
          select
            plaid_transaction_id,
            transaction_date,
            name,
            merchant_name,
            amount
          from public.plaid_transactions
          where tracker_id = $1
            and plaid_account_id = $2
            and pending = false
            and transaction_date >= $3
            and transaction_date <= $4
           and amount > 0
and abs(amount - $5) < 0.01
            and (
              $6 = ''
              or coalesce(name, '') ilike
                '%' || $6 || '%'
              or coalesce(merchant_name, '') ilike
                '%' || $6 || '%'
            )
          order by transaction_date asc
          limit 2
          `,
          [
            recurring.tracker_id,
            recurring.plaid_account_id,
            scheduledDateKey,
            latestMatchDateKey,
            Number(recurring.recurring_amount || 0),
            description,
          ]
        );

      if (!candidates.length) {
        summary.skipped_no_match += 1;
        continue;
      }

      /*
        More than one matching transaction means the match is
        uncertain. Leave the item amber for manual confirmation.
      */
      if (candidates.length !== 1) {
        summary.skipped_ambiguous += 1;
        continue;
      }

      const candidate = candidates[0];

      const insertResult = await pool.query(
        `
        insert into public.recurring_transfer_completions (
          tracker_id,
          card_id,
          recurring_charge_id,
          completion_month,
          completed_on,
          confirmation_source,
          bank_transaction_id
        )
        values ($1, $2, $3, $4, $5, 'bank', $6)
        on conflict (
          recurring_charge_id,
          completion_month
        )
        do nothing
        `,
        [
          recurring.tracker_id,
          recurring.card_id,
          recurring.recurring_charge_id,
          completionMonth,
          candidate.transaction_date,
          candidate.plaid_transaction_id,
        ]
      );

      if (insertResult.rowCount === 1) {
        summary.matched += 1;

        console.log(
          "Recurring transfer bank-confirmed:",
          {
            recurring_charge_id:
              recurring.recurring_charge_id,
            plaid_transaction_id:
              candidate.plaid_transaction_id,
          }
        );
      }

    } catch (error) {
      console.error(
        "Recurring transfer match error:",
        error
      );

      summary.errors.push(
        error?.message || String(error)
      );
    }
  }

  return summary;
}
// ============================================================
// BACKEND BUILD 1.2 — AUTOMATIC LATE-FEE EVALUATION
// ============================================================

function currentUtcDateParts() {
  const now = new Date();

  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
  };
}

async function evaluateAutomaticLateFees() {
  const today = currentUtcDateParts();

  const automaticFeesEnabled =
    process.env.AUTO_LATE_FEES_ENABLED === "true";

  const summary = {
    enabled: automaticFeesEnabled,
    cards_reviewed: 0,
    eligible: 0,
    created: 0,
    skipped_not_overdue: 0,
    skipped_no_balance: 0,
    skipped_minimum_covered: 0,
    skipped_fee_canceled: 0,
    skipped_fee_exists: 0,
    errors: [],
    candidates: [],
  };

  const { rows: cards } = await pool.query(
    `
    select
      card.id,
      card.tracker_id,
      card.name,
      card.minimum_payment,
      card.due_day,
      card.late_fee_amount,
      card.starting_balance,

      tracker.owner_id as created_by,

      greatest(
        0,
        coalesce(card.starting_balance, 0) +
        coalesce(
          sum(
            case
              when entry.entry_type = 'expense'
                and not (
                  coalesce(
                    entry.is_auto_late_fee,
                    false
                  )
                  and coalesce(
                    entry.late_fee_canceled,
                    false
                  )
                )
              then coalesce(entry.amount, 0)

              when entry.entry_type = 'payment'
              then -coalesce(entry.amount, 0)

              else 0
            end
          ),
          0
        )
      ) as current_balance

    from public.cards as card

    join public.trackers as tracker
      on tracker.id = card.tracker_id

    left join public.entries as entry
      on entry.card_id = card.id

    where coalesce(card.minimum_payment, 0) > 0
      and card.due_day is not null
      and coalesce(card.late_fee_amount, 0) > 0

    group by
      card.id,
      tracker.owner_id
    `
  );

  for (const card of cards) {
    try {
      summary.cards_reviewed += 1;

      const currentBalance =
        Number(card.current_balance || 0);

      if (currentBalance <= 0) {
        summary.skipped_no_balance += 1;
        continue;
      }

      const cycle = getPaymentCycleDates(
        today,
        card.due_day
      );

      const dueDateKey = formatDateKey(
        cycle.dueDate
      );

      /*
        A late fee becomes eligible only on the calendar day
        after the card's actual due date.
      */
      if (
        compareCalendarDates(
          today,
          cycle.dueDate
        ) <= 0
      ) {
        summary.skipped_not_overdue += 1;
        continue;
      }

      const previousDueDateKey = formatDateKey(
        cycle.previousDueDate
      );

      const { rows: paymentRows } =
        await pool.query(
          `
          select amount
          from public.entries
          where tracker_id = $1
            and card_id = $2
            and entry_type = 'payment'
            and entry_date >= $3
            and entry_date <= $4
          `,
          [
            card.tracker_id,
            card.id,
            previousDueDateKey,
            dueDateKey,
          ]
        );

      const paymentsRecorded = paymentRows.reduce(
        (sum, payment) =>
          sum + Number(payment.amount || 0),
        0
      );

      const minimumPayment =
        Number(card.minimum_payment || 0);

      const shortfall = Math.max(
        0,
        minimumPayment - paymentsRecorded
      );

      if (shortfall <= 0) {
        summary.skipped_minimum_covered += 1;
        continue;
      }

      /*
        A canceled late fee remains the permanent override for
        this specific card and due-date cycle.
      */
      const { rows: canceledFeeRows } =
        await pool.query(
          `
          select id
          from public.entries
          where card_id = $1
            and is_auto_late_fee = true
            and late_fee_due_date = $2
            and late_fee_canceled = true
          limit 1
          `,
          [
            card.id,
            dueDateKey,
          ]
        );

      if (canceledFeeRows.length) {
        summary.skipped_fee_canceled += 1;
        continue;
      }

      const { rows: existingFeeRows } =
        await pool.query(
          `
          select id
          from public.entries
          where card_id = $1
            and is_auto_late_fee = true
            and late_fee_due_date = $2
          limit 1
          `,
          [
            card.id,
            dueDateKey,
          ]
        );

      if (existingFeeRows.length) {
        summary.skipped_fee_exists += 1;
        continue;
      }

      summary.eligible += 1;

      const feeDateKey = formatDateKey(
        shiftCalendarDate(
          cycle.dueDate,
          1
        )
      );

      const candidate = {
        card_name: card.name,
        fee_amount:
          Number(card.late_fee_amount || 0),
        payment_shortfall: shortfall,
        actual_due_date: dueDateKey,
        fee_date: feeDateKey,
      };

      summary.candidates.push(candidate);

      /*
        Dry-run mode is the default. No fee is created unless
        AUTO_LATE_FEES_ENABLED is explicitly set to true.
      */
      if (!automaticFeesEnabled) {
        continue;
      }

      const { rowCount } = await pool.query(
        `
        insert into public.entries (
          tracker_id,
          card_id,
          created_by,
          entry_type,
          merchant,
          amount,
          entry_date,
          category,
          notes,
          cash_moved,
          is_auto_late_fee,
          late_fee_due_date,
          late_fee_canceled
        )
        values (
          $1, $2, $3,
          'expense',
          $4, $5, $6,
          'Fees',
          $7,
          false,
          true,
          $8,
          false
        )
        on conflict do nothing
        `,
        [
          card.tracker_id,
          card.id,
          card.created_by,
          `Late Fee — ${card.name}`,
          Number(card.late_fee_amount || 0),
          feeDateKey,
          `Automatically recorded after the minimum ` +
            `payment remained unpaid for the due date ` +
            `${dueDateKey}.`,
          dueDateKey,
        ]
      );

      if (rowCount === 1) {
        summary.created += 1;
      }

    } catch (error) {
      console.error(
        "Automatic late-fee evaluation error:",
        error
      );

      summary.errors.push(
        error?.message || String(error)
      );
    }
  }

  return summary;
}
// ============================================================
// BACKEND SECURITY BUILD 1.5 — PLAID TOKEN ENCRYPTION MIGRATION
// ============================================================

app.post(
  "/migrate-plaid-access-token-encryption",
  async (req, res) => {
    const migrationSecret =
      req.headers[
        "x-plaid-token-migration-secret"
      ];

    if (
      !migrationSecret ||
      migrationSecret !==
        process.env.PLAID_TOKEN_MIGRATION_SECRET
    ) {
      return res.status(401).json({
        error:
          "Unauthorized Plaid token migration request.",
      });
    }

    const summary = {
      reviewed: 0,
      migrated: 0,
      already_encrypted: 0,
      failed: 0,
      errors: [],
    };

    try {
      const { rows: items } = await pool.query(
        `
        select
          plaid_item_id,
          access_token
        from public.plaid_items
        where access_token is not null
        `
      );

      for (const item of items) {
        summary.reviewed += 1;

        try {
          const storedToken = String(
            item.access_token || ""
          );

          if (storedToken.startsWith(
            PLAID_TOKEN_ENCRYPTION_PREFIX
          )) {
            summary.already_encrypted += 1;
            continue;
          }

          const encryptedToken =
            encryptPlaidAccessToken(
              storedToken
            );

          await pool.query(
            `
            update public.plaid_items
            set access_token = $2
            where plaid_item_id = $1
            `,
            [
              item.plaid_item_id,
              encryptedToken,
            ]
          );

          summary.migrated += 1;

        } catch (error) {
          summary.failed += 1;

          summary.errors.push(
            error?.message || String(error)
          );

          console.error(
            "Plaid token migration error:",
            {
              plaid_item_id:
                item.plaid_item_id,
              error:
                error?.message || String(error),
            }
          );
        }
      }

      return res.json({
        success: true,
        summary,
      });

    } catch (error) {
      console.error(
        "Plaid token migration route error:",
        error
      );

      return res.status(500).json({
        error:
          "Plaid token migration failed.",
        details:
          error?.message || String(error),
      });
    }
  }
);
/*
  Protected daily job.

  It intentionally accepts no tracker ID from a browser or user.
  The job syncs server-stored Plaid Items, then performs only
  high-confidence recurring-transfer matches.
*/
app.post(
  "/run-recurring-transfer-bank-match",
  async (req, res) => {
    const jobSecret =
      req.headers[
        "x-recurring-transfer-job-secret"
      ];

    if (
      !jobSecret ||
      jobSecret !==
        process.env.RECURRING_TRANSFER_JOB_SECRET
    ) {
      return res.status(401).json({
        error:
          "Unauthorized recurring-transfer job request",
      });
    }

    const summary = {
      items_processed: 0,
      items_failed: 0,
      item_results: [],
      matches: null,
    late_fees: null,
      };

    try {
      const { rows: plaidItems } =
        await pool.query(
          `
          select
            tracker_id,
            plaid_item_id,
            access_token,
            transactions_cursor
          from public.plaid_items
          order by created_at asc
          `
        );

      for (const item of plaidItems) {
        try {
          const itemResult =
            await syncPlaidItemTransactions(item);

          summary.items_processed += 1;

          summary.item_results.push({
            plaid_item_id: item.plaid_item_id,
            status: "synced",
            ...itemResult,
          });

        } catch (error) {
          summary.items_failed += 1;

          await recordPlaidSyncFailure(
            item.plaid_item_id,
            error
          );

          summary.item_results.push({
            plaid_item_id: item.plaid_item_id,
            status: "failed",
            error:
              error?.message || String(error),
          });

          console.error(
            "Plaid transaction sync failed:",
            item.plaid_item_id,
            error
          );
        }
      }

      summary.matches =
        await matchRecurringTransfersFromBank();
summary.late_fees =
  await evaluateAutomaticLateFees();
      return res.json({
        success: true,
        summary,
      });

    } catch (error) {
      console.error(
        "run-recurring-transfer-bank-match error:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to run recurring-transfer bank match",
        details:
          error?.message || String(error),
      });
    }
  }
);
// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Deadbeat Plaid server listening on port', PORT);
});
