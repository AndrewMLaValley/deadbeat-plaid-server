// server.js
   // Description: Minimal Express server to handle Plaid link token creation
   // and public token exchange, storing linked accounts in Supabase.

   import express from "express";
   import cors from "cors";
   import bodyParser from "body-parser";
   import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
   import { createClient } from "@supabase/supabase-js";

   const app = express();
   app.use(cors());
   app.use(bodyParser.json());

   // Environment variables (to be set in Render)
   const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
   const PLAID_SECRET = process.env.PLAID_SECRET;
   const PLAID_ENV = process.env.PLAID_ENV || "sandbox";

   const SUPABASE_URL = process.env.SUPABASE_URL;
   const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

   // Initialize Plaid client
   const plaidConfig = new Configuration({
     basePath: PlaidEnvironments[PLAID_ENV],
     baseOptions: {
       headers: {
         "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
         "PLAID-SECRET": PLAID_SECRET
       }
     }
   });

   const plaidClient = new PlaidApi(plaidConfig);

   // Initialize Supabase client (service role, server-side only)
   const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

   // Helper: get Supabase user from JWT (same token your front-end uses)
   async function getUserFromJwt(jwt) {
     if (!jwt) return null;
     const { data, error } = await supabase.auth.getUser(jwt);
     if (error) {
       console.error("Supabase getUser error:", error);
       return null;
     }
     return data.user;
   }

   // Route: create Plaid link token
   app.post("/plaid-create-link-token", async (req, res) => {
     try {
       const authHeader = req.headers.authorization || "";
       const jwt = authHeader.replace("Bearer ", "");
       const user = await getUserFromJwt(jwt);

       if (!user) {
         return res.status(401).json({ error: "Not authenticated" });
       }

       const { tracker_id } = req.body;
       if (!tracker_id) {
         return res.status(400).json({ error: "tracker_id is required" });
       }

       const linkResponse = await plaidClient.linkTokenCreate({
         user: {
           client_user_id: user.id
         },
         client_name: "Deadbeat Tracker",
         products: ["transactions"],
         language: "en",
         country_codes: ["US"]
       });

       res.json({
         link_token: linkResponse.data.link_token,
         tracker_id
       });
     } catch (err) {
       console.error("plaid-create-link-token error:", err);
       res.status(500).json({ error: "Failed to create Plaid link token" });
     }
   });

   // Route: exchange public_token and store linked accounts
   app.post("/plaid-exchange-public-token", async (req, res) => {
     try {
       const authHeader = req.headers.authorization || "";
       const jwt = authHeader.replace("Bearer ", "");
       const user = await getUserFromJwt(jwt);

       if (!user) {
         return res.status(401).json({ error: "Not authenticated" });
       }

       const { public_token, tracker_id } = req.body;
       if (!public_token || !tracker_id) {
         return res.status(400).json({ error: "public_token and tracker_id are required" });
       }

       const exchangeResponse = await plaidClient.itemPublicTokenExchange({
         public_token
       });

       const accessToken = exchangeResponse.data.access_token;
       const itemId = exchangeResponse.data.item_id;

       const accountsResponse = await plaidClient.accountsGet({
         access_token: accessToken
       });

       const institutionName = "USAA"; // can refine later

       const inserts = accountsResponse.data.accounts.map((acct) => ({
         user_id: user.id,
         tracker_id,
         institution_name: institutionName,
         plaid_item_id: itemId,
         plaid_access_token: accessToken,
         plaid_account_id: acct.account_id,
         plaid_account_name: acct.name,
         plaid_account_mask: acct.mask,
         plaid_account_type: acct.type,
         plaid_account_subtype: acct.subtype
       }));

       const { error: insertError } = await supabase
         .from("linked_bank_accounts")
         .insert(inserts);

       if (insertError) {
         console.error("Insert linked_bank_accounts error:", insertError);
         return res.status(500).json({ error: "Failed to save linked accounts" });
       }

       res.json({
         success: true,
         item_id: itemId,
         accounts: accountsResponse.data.accounts
       });
     } catch (err) {
       console.error("plaid-exchange-public-token error:", err);
       res.status(500).json({ error: "Failed to exchange public token" });
     }
   });

   const PORT = process.env.PORT || 3000;
   app.listen(PORT, () => {
     console.log(`Plaid server listening on port ${PORT}`);
   });
