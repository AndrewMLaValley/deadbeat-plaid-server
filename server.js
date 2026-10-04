// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Resend } = require('resend');
const { plaidClient } = require('./plaidClient');

const app = express();
app.use(cors());
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
app.post('/card-plaid-mapping', async (req, res) => {
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
app.get('/card-plaid-mappings', async (req, res) => {
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
app.post('/create-link-token', async (req, res) => {
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
app.post('/exchange-public-token', async (req, res) => {
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
      [tracker_id, item_id, access_token],
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
app.get('/linked-accounts', async (req, res) => {
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
app.post('/unlink-account', async (req, res) => {
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
        c.due_day
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
          `is required by ${formatAlertDate(cycle.trackerDeadline)}.`;
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
            <p><b>Actual Due Date:</b>
              ${formatAlertDate(cycle.dueDate)}
            </p>
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
// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Deadbeat Plaid server listening on port', PORT);
});
