// test-supabase.js
import dotenv from 'dotenv';
dotenv.config();

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function testSupabase() {
  try {
    const { data, error } = await supabase.from("Quizzes").select("quiz_id").limit(1);
    console.log("Supabase response:", data, error);
  } catch (err) {
    console.error("Supabase error:", err);
  }
}

testSupabase();