require('dotenv').config();
   const express = require('express');
   const cors = require('cors');
   const { Pool } = require('pg');
   const { plaidClient } = require('./plaidClient');

   const app = express();
   app.use(cors());
   app.use(express.json());

   // Connect to Supabase Postgres
   const pool = new Pool({
     connectionString: process.env.DATABASE_URL,
   });

   // Health check
   app.get('/', (req, res) => {
     res.json({ ok: true });
   });

   // Create a Plaid Link token
   app.post('/create-link-token', async (req, res) => {
     try {
       const authHeader = req.headers.authorization || '';
       const jwt = authHeader.replace('Bearer ', '').trim();

       if (!jwt) {
         return res.status(401).json({ error: 'Missing JWT' });
       }

       const { tracker_id } = req.body;
       if (!tracker_id) {
         return res.status(400).json({ error: 'tracker_id is required' });
       }

       const request = {
         user: {
           client_user_id: tracker_id,
         },
         client_name: 'Deadbeat Tracker',
         products: ['auth', 'transactions'],
         country_codes: ['US'],
         language: 'en',
       };

       const response = await plaidClient.linkTokenCreate(request);
       return res.json({ link_token: response.data.link_token });
     } catch (err) {
       console.error('create-link-token error', err.response?.data || err);
       return res.status(500).json({ error: 'Failed to create link token' });
     }
   });

   // Exchange public_token and store accounts
   app.post('/exchange-public-token', async (req, res) => {
     const authHeader = req.headers.authorization || '';
     const jwt = authHeader.replace('Bearer ', '').trim();
     if (!jwt) {
       return res.status(401).json({ error: 'Missing JWT' });
     }

     const { public_token, tracker_id } = req.body;
     if (!public_token || !tracker_id) {
       return res.status(400).json({ error: 'public_token and tracker_id are required' });
     }

     const client = await pool.connect();
     try {
       // 1) Exchange public_token
       const tokenResponse = await plaidClient.itemPublicTokenExchange({ public_token });
       const access_token = tokenResponse.data.access_token;
       const item_id = tokenResponse.data.item_id;

       // 2) Upsert into plaid_items
       await client.query(
         `
         insert into public.plaid_items (tracker_id, plaid_item_id, access_token)
         values ($1, $2, $3)
         on conflict (plaid_item_id) do update set access_token = excluded.access_token
         `,
         [tracker_id, item_id, access_token]
       );

       // 3) Get accounts from Plaid
       const accountsResponse = await plaidClient.accountsGet({ access_token });
       const { accounts } = accountsResponse.data;

       // 4) Upsert accounts into linked_accounts
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
           ]
         );
       }

       return res.json({ success: true });
     } catch (err) {
       console.error('exchange-public-token error', err.response?.data || err);
       return res.status(500).json({ error: 'Failed to exchange public token' });
     } finally {
       client.release();
     }
   });

   // Get linked accounts for a tracker
   app.get('/linked-accounts', async (req, res) => {
     const authHeader = req.headers.authorization || '';
     const jwt = authHeader.replace('Bearer ', '').trim();
     if (!jwt) {
       return res.status(401).json({ error: 'Missing JWT' });
     }

     const { tracker_id } = req.query;
     if (!tracker_id) {
       return res.status(400).json({ error: 'tracker_id is required' });
     }

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
         [tracker_id]
       );

       return res.json({ accounts: rows });
     } catch (err) {
       console.error('linked-accounts error', err);
       return res.status(500).json({ error: 'Failed to fetch linked accounts' });
     }
   });

   // Start server
   const PORT = process.env.PORT || 3000;
   app.listen(PORT, () => {
     console.log('Deadbeat Plaid server listening on port', PORT);
   });
