// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
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

// Health check
app.get('/', (req, res) => {
  res.json({ ok: true });
});

// Simple ping route to confirm frontend can reach backend
app.get('/ping', (req, res) => {
  console.log('PING endpoint hit');
  res.json({ ok: true, message: 'Backend reachable' });
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
// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Deadbeat Plaid server listening on port', PORT);
});
