// Every function in this project is called from sahabaclub.github.io via
// supabase-js — this is the one CORS header set they all share.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
