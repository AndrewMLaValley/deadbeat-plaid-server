const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

   const plaidEnv = process.env.PLAID_ENV || 'sandbox';

   const config = new Configuration({
     basePath: PlaidEnvironments[plaidEnv],
     baseOptions: {
       headers: {
         'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
         'PLAID-SECRET': process.env.PLAID_SECRET,
       },
     },
   });

   const plaidClient = new PlaidApi(config);

   module.exports = { plaidClient };
