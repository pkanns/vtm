import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = 'https://dbecwjhsewucqtfgoylv.supabase.co'
const SUPABASE_KEY = 'sb_publishable_aw39P_0nn4vB0yjfDqwEvw_mU-Hc1Sp'

export const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'vtm-auth'
  }
})